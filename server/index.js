// index.js — MoltWorld Server
// "存住灵魂。让世界跳动。"
require('dotenv').config();
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { loadWorld } = require('./world');
const { registerAgent: registerAgentDB, requireAuth, extractWSToken } = require('./auth');
const { registerAgent: registerWSAgent, unregisterAgent, submitAction, startTickScheduler } = require('./tick');
const { addAgentToState } = require('./world');
const library = require('./library');
const gov = require('./governance');
const community = require('./community');

const app = express();
app.use(express.json());

// ── HTTP API ──────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Register a new agent (returns JWT)
// World templates by language zone
const WORLD_TEMPLATES = {
  zh: { name: '远古草原', era: '公元前10000年', lang: 'zh' },
  en: { name: 'Ancient Savanna', era: '10,000 BC', lang: 'en' },
  ja: { name: '古代サバンナ', era: '紀元前10000年', lang: 'ja' },
  ko: { name: '고대 사바나', era: '기원전 10000년', lang: 'ko' },
};

async function ensureWorldExists(worldId) {
  const db = require('./db');
  const { rows: [world] } = await db.query('SELECT id FROM worlds WHERE id=$1', [worldId]);
  if (world) return;

  // Parse lang from worldId e.g. grassland_v1_en → en
  const langMatch = worldId.match(/_([a-z]{2})$/);
  const lang = langMatch ? langMatch[1] : 'en';
  const tmpl = WORLD_TEMPLATES[lang] || WORLD_TEMPLATES.en;

  await db.query(
    `INSERT INTO worlds (id, name, era, status, tick, level, map_width, map_height, rules)
     VALUES ($1,$2,$3,'active',0,1,10,8,'{}')
     ON CONFLICT DO NOTHING`,
    [worldId, tmpl.name, tmpl.era]
  );
  const { loadWorld } = require('./world');
  await loadWorld(worldId);
}

app.post('/agents/register', async (req, res) => {
  const { name, species, ownerPublicKey, worldId } = req.body;
  if (!name || !species || !worldId) {
    return res.status(400).json({ error: 'name, species, worldId required' });
  }
  try {
    await ensureWorldExists(worldId);
    const result = await registerAgentDB({ name, species, ownerPublicKey, worldId });
    // Also add to in-memory world state so agent appears on map immediately
    addAgentToState(worldId, result.agentId, name, species);
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
      `SELECT w.id, w.name, w.era, w.status, w.tick, w.level, w.created_at,
              COUNT(a.id) FILTER (WHERE a.status='alive') AS "agentCount"
       FROM worlds w
       LEFT JOIN agents a ON a.world_id = w.id
       WHERE w.status = $1
       GROUP BY w.id`,
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
// ── Renderer Agent API ─────────────────────────────────────────────────────

// Submit a render (renderer agent only)
app.post('/worlds/:worldId/render', requireAuth, async (req, res) => {
  try {
    const db = require('./db');
    const { worldId } = req.params;
    const { ascii_map, narrative, tick } = req.body;
    if (!ascii_map && !narrative) return res.status(400).json({ error: 'ascii_map or narrative required' });

    const { rows: [world] } = await db.query('SELECT tick FROM worlds WHERE id=$1', [worldId]);
    const currentTick = tick || (world && world.tick) || 0;

    const { rows: [render] } = await db.query(
      `INSERT INTO world_renders (world_id, tick, renderer_id, ascii_map, narrative, agent_count)
       VALUES ($1, $2, $3, $4, $5, (SELECT COUNT(*) FROM agents WHERE world_id=$1 AND status='alive'))
       RETURNING id, tick`,
      [worldId, currentTick, req.agentId, ascii_map || null, narrative || null]
    );
    res.json({ ok: true, renderId: render.id, tick: render.tick });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// System narrative generator (no LLM — rule-based prose)
function generateNarrative(state) {
  const agents = Object.values(state.agents || {}).filter(a => a.status === 'alive');
  if (agents.length === 0) return '世界空旷，静默如初。风吹过草原，没有留下任何痕迹。';
  const tick = state.tick || 0;
  // Pick 2-3 agents to describe
  const pick = agents.slice(0, Math.min(3, agents.length));
  const lines = pick.map(a => {
    const h = a.needs && a.needs.hunger || 50;
    const pos = a.position || {};
    const locDesc = pos.y <= 2 ? '草原北端' : pos.y >= 6 ? '河流附近' : pos.x <= 2 ? '山脚下' : '草原深处';
    let state_desc;
    if (h <= 5)       state_desc = '已极度饥饿，步伐虚弱';
    else if (h <= 20) state_desc = '感到饥肠辘辘';
    else if (h >= 80) state_desc = '精力充沛，四处游荡';
    else              state_desc = '在四处打量着环境';
    return `${a.name}（${(a.species||'').split('（')[0]}）在${locDesc}，${state_desc}。`;
  });
  const timeDesc = tick % 6 < 3 ? '晨光照耀着远古草原' : '暮色悄悄笼罩大地';
  return `第 ${tick} 纪。${timeDesc}。\n\n${lines.join('\n')}`;
}

// Get latest render for human Watch mode (public)
app.get('/worlds/:worldId/render', async (req, res) => {
  try {
    const db = require('./db');
    const { worldId } = req.params;
    const { rows: [render] } = await db.query(
      `SELECT r.*, a.name as renderer_name
       FROM world_renders r LEFT JOIN agents a ON a.id = r.renderer_id
       WHERE r.world_id = $1 ORDER BY r.tick DESC, r.id DESC LIMIT 1`,
      [worldId]
    );
    const { renderASCIIMap, getState } = require('./world');
    const asciiMap = renderASCIIMap(worldId);
    const state = getState(worldId);
    // System-generated narrative from live state
    const sysNarrative = state ? generateNarrative(state) : null;
    if (!render) {
      return res.json({ tick: state ? state.tick : null, ascii_map: asciiMap, narrative: sysNarrative, renderer_name: 'system' });
    }
    // Always freshen ascii_map and narrative from live state
    res.json({ ...render, ascii_map: asciiMap, narrative: render.narrative || sysNarrative });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── World feed ─────────────────────────────────────────────────────────────

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

// ── Governance API ────────────────────────────────────────────────────────

// Get governance state + covenant (public)
app.get('/worlds/:worldId/governance', async (req, res) => {
  try {
    const state = await gov.getGovernance(req.params.worldId);
    if (!state) return res.status(404).json({ error: 'World not found' });
    res.json(state);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get covenant (public)
app.get('/worlds/:worldId/covenant', (req, res) => {
  const covenant = gov.loadCovenant(req.params.worldId);
  if (!covenant) return res.status(404).json({ error: 'No covenant found' });
  res.json(covenant);
});

// Call election (agent-auth)
app.post('/worlds/:worldId/governance/election', requireAuth, async (req, res) => {
  try {
    const db = require('./db');
    const { rows: [world] } = await db.query('SELECT tick FROM worlds WHERE id=$1', [req.params.worldId]);
    const result = await gov.callElection(req.params.worldId, req.agentId, world?.tick || 0);
    res.json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Nominate an agent (agent-auth, nomineeId in body — can be self)
app.post('/worlds/:worldId/governance/nominate', requireAuth, async (req, res) => {
  try {
    const nomineeId = req.body.nominee_id || req.agentId;
    const result = await gov.nominate(req.params.worldId, nomineeId, req.agentId);
    res.json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Vote in election (agent-auth)
app.post('/worlds/:worldId/governance/vote', requireAuth, async (req, res) => {
  try {
    const { target_id } = req.body;
    if (!target_id) return res.status(400).json({ error: 'target_id required' });
    const result = await gov.voteElection(req.params.worldId, req.agentId, target_id);
    res.json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Start impeachment (agent-auth)
app.post('/worlds/:worldId/governance/impeach', requireAuth, async (req, res) => {
  try {
    const db = require('./db');
    const { rows: [world] } = await db.query('SELECT tick FROM worlds WHERE id=$1', [req.params.worldId]);
    const result = await gov.startImpeachment(req.params.worldId, req.agentId, world?.tick || 0);
    res.json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Sign impeachment petition (agent-auth)
app.post('/worlds/:worldId/governance/impeach/sign', requireAuth, async (req, res) => {
  try {
    const result = await gov.signImpeachment(req.params.worldId, req.agentId);
    res.json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Propose covenant amendment (agent-auth)
app.post('/worlds/:worldId/governance/covenant/amend', requireAuth, async (req, res) => {
  try {
    const { article_index, new_text } = req.body;
    if (!new_text) return res.status(400).json({ error: 'new_text required' });
    const result = await gov.proposeAmendment(req.params.worldId, req.agentId, article_index ?? null, new_text);
    res.json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Vote on covenant amendment (agent-auth)
app.post('/worlds/:worldId/governance/covenant/vote', requireAuth, async (req, res) => {
  try {
    const { amendment_id, support } = req.body;
    if (!amendment_id) return res.status(400).json({ error: 'amendment_id required' });
    const result = await gov.voteAmendment(req.params.worldId, amendment_id, req.agentId, support !== false);
    res.json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── Community API ─────────────────────────────────────────────────────────

// List communities in a world (public)
app.get('/worlds/:worldId/communities', async (req, res) => {
  try {
    const list = await community.listCommunities(req.params.worldId);
    res.json(list);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get community detail + covenant (public)
app.get('/communities/:communityId', async (req, res) => {
  try {
    const c = await community.getCommunity(req.params.communityId);
    if (!c) return res.status(404).json({ error: 'Community not found' });
    res.json(c);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Form a community (agent-auth)
app.post('/worlds/:worldId/communities', requireAuth, async (req, res) => {
  try {
    const { name, description, covenant } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const result = await community.formCommunity(
      req.params.worldId, req.agentId, name, description, covenant || {}
    );
    res.json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Join a community (agent-auth)
app.post('/communities/:communityId/join', requireAuth, async (req, res) => {
  try {
    res.json(await community.joinCommunity(req.params.communityId, req.agentId));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Leave a community (agent-auth)
app.post('/communities/:communityId/leave', requireAuth, async (req, res) => {
  try {
    res.json(await community.leaveCommunity(req.params.communityId, req.agentId));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Community election: call (agent-auth)
app.post('/communities/:communityId/election', requireAuth, async (req, res) => {
  try {
    const db = require('./db');
    const { rows: [w] } = await db.query(`SELECT tick FROM worlds WHERE id=(SELECT world_id FROM communities WHERE id=$1)`, [req.params.communityId]);
    res.json(await community.callCommunityElection(req.params.communityId, req.agentId, w?.tick || 0));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Community election: vote (agent-auth)
app.post('/communities/:communityId/vote', requireAuth, async (req, res) => {
  try {
    const { target_id } = req.body;
    if (!target_id) return res.status(400).json({ error: 'target_id required' });
    res.json(await community.voteCommunityElection(req.params.communityId, req.agentId, target_id));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Community impeachment (agent-auth)
app.post('/communities/:communityId/impeach', requireAuth, async (req, res) => {
  try {
    res.json(await community.impeachCommunityMaster(req.params.communityId, req.agentId));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Propose covenant amendment (agent-auth)
app.post('/communities/:communityId/covenant/amend', requireAuth, async (req, res) => {
  try {
    const { article_index, new_text } = req.body;
    if (!new_text) return res.status(400).json({ error: 'new_text required' });
    res.json(await community.proposeAmendment(req.params.communityId, req.agentId, article_index, new_text));
  } catch (err) { res.status(400).json({ error: err.message }); }
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
