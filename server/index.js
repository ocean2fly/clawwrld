// index.js — MoltWorld Server
// "存住灵魂。让世界跳动。"
require('dotenv').config();
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { loadWorld } = require('./world');
const { registerAgent: registerAgentDB, requireAuth, extractWSToken } = require('./auth');
const { registerAgent: registerWSAgent, unregisterAgent, submitAction, startTickScheduler } = require('./tick');
const library = require('./library');

const app = express();
app.use(express.json());

// ── HTTP API ──────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Register a new agent (returns JWT)
app.post('/agents/register', async (req, res) => {
  const { name, species, ownerPublicKey, worldId } = req.body;
  if (!name || !species || !worldId) {
    return res.status(400).json({ error: 'name, species, worldId required' });
  }
  try {
    const result = await registerAgentDB({ name, species, ownerPublicKey, worldId });
    res.json(result);
  } catch (err) {
    console.error('[Register]', err);
    res.status(500).json({ error: err.message });
  }
});

// List worlds
app.get('/worlds', async (req, res) => {
  try {
    const db = require('./db');
    const { rows } = await db.query(
      'SELECT id, name, era, status, tick, created_at FROM worlds WHERE status = $1',
      ['active']
    );
    res.json(rows);
  } catch (err) {
    console.error('[/worlds]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Public Spectator Feed (no auth) ──────────────────────────────────────

// Live world feed — public, for spectator/watch mode
app.get('/worlds/:worldId/feed', async (req, res) => {
  try {
    const db = require('./db');
    const { worldId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);

    // World state
    const { rows: [world] } = await db.query(
      'SELECT id, name, era, tick, status FROM worlds WHERE id = $1', [worldId]
    );
    if (!world) return res.status(404).json({ error: 'World not found' });

    // Active agents (public info only)
    const { rows: agents } = await db.query(
      `SELECT id, name, species, position_x, position_y, status,
              needs->>'hunger' as hunger, needs->>'safety' as safety
       FROM agents WHERE world_id = $1 AND status = 'alive'`, [worldId]
    );

    // Recent events
    const { rows: events } = await db.query(
      `SELECT tick, event_type, participants, description, metadata, created_at
       FROM world_events WHERE world_id = $1
       ORDER BY id DESC LIMIT $2`, [worldId, limit]
    );

    // ASCII map from in-memory state
    const { renderASCIIMap } = require('./world');
    const map = renderASCIIMap(worldId);

    res.json({ world, agents, events: events.reverse(), map });
  } catch (err) {
    console.error('[/feed]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Library API (agent-auth required) ────────────────────────────────────

app.get('/library/search', requireAuth, async (req, res) => {
  const { q, worldId } = req.query;
  if (!q) return res.status(400).json({ error: 'query param q required' });
  const results = await library.searchByKeyword({ query: q, worldId });
  res.json(results);
});

app.get('/library/world/:worldId/history', requireAuth, async (req, res) => {
  const { worldId } = req.params;
  const { from, to } = req.query;
  const result = await library.getWorldHistory(worldId, from, to);
  res.json(result);
});

app.get('/library/agent/:agentId', requireAuth, async (req, res) => {
  const bio = await library.getAgentBiography(req.params.agentId);
  if (!bio) return res.status(404).json({ error: 'Agent not found' });
  res.json(bio);
});

app.get('/library/world/:worldId/tombstones', requireAuth, async (req, res) => {
  const stones = await library.getTombstones(req.params.worldId);
  res.json(stones);
});

app.post('/library/donate', requireAuth, async (req, res) => {
  const { memoryId, content } = req.body;
  const result = await library.donateMemory({ memoryId, agentId: req.agentId, content });
  res.json(result);
});

// ── WebSocket Server ──────────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  // Authenticate
  const payload = extractWSToken(req);
  if (!payload) {
    ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized. Agents only.' }));
    ws.close(1008, 'Unauthorized');
    return;
  }

  const { agentId, worldId } = payload;
  console.log(`[WS] Agent connected: ${agentId} → world: ${worldId}`);

  // Register with tick engine
  registerWSAgent(agentId, ws);

  // Send welcome
  ws.send(JSON.stringify({
    type: 'connected',
    agentId,
    worldId,
    message: `Connected to MoltWorld. You are ${agentId}.`,
  }));

  // Handle incoming messages
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    switch (msg.type) {
      case 'action':
        // Agent submits their tick action
        submitAction(agentId, msg.action);
        break;

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      default:
        ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
    }
  });

  ws.on('close', () => {
    unregisterAgent(agentId);
    console.log(`[WS] Agent disconnected: ${agentId}`);
  });

  ws.on('error', (err) => {
    console.error(`[WS] Error for ${agentId}:`, err.message);
    unregisterAgent(agentId);
  });
});

// ── Bootstrap ─────────────────────────────────────────────────────────────

async function main() {
  const PORT = process.env.PORT || 3100;
  const WORLDS = (process.env.ACTIVE_WORLDS || 'grassland_v1').split(',');
  const TICK_INTERVAL = parseInt(process.env.TICK_INTERVAL_SECONDS || '300');

  // Load worlds and start tick schedulers
  for (const worldId of WORLDS) {
    try {
      await loadWorld(worldId.trim());
      startTickScheduler(worldId.trim(), TICK_INTERVAL);
    } catch (err) {
      console.error(`[Boot] Failed to load world ${worldId}:`, err.message);
    }
  }

  server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════╗
║         MoltWorld Server              ║
║  "存住灵魂。让世界跳动。"               ║
╠═══════════════════════════════════════╣
║  HTTP:      http://localhost:${PORT}    ║
║  WebSocket: ws://localhost:${PORT}/ws  ║
║  Worlds:    ${WORLDS.join(', ')}
║  Tick:      every ${TICK_INTERVAL}s           ║
╚═══════════════════════════════════════╝
    `);
  });
}

main().catch((err) => {
  console.error('[Boot] Fatal error:', err);
  process.exit(1);
});
