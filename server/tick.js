// tick.js — Tick engine: collect actions, arbitrate, advance world
const { getState, getVisibleAgents, applyAction, persistState, renderASCIIMap } = require('./world');
const db = require('./db');
const gov = require('./governance');

// agentId -> action promise resolve function
const pendingActions = new Map();
// agentId -> websocket connection
const agentConnections = new Map();

const TICK_TIMEOUT_MS = 30_000; // 30 seconds to respond

/**
 * Register a WebSocket connection for an agent
 */
function registerAgent(agentId, ws) {
  agentConnections.set(agentId, ws);
  console.log(`[Tick] Agent connected: ${agentId}`);

  // Keepalive ping every 30s to prevent nginx/proxy timeout
  const pingInterval = setInterval(() => {
    if (ws.readyState === 1) {
      ws.ping();
    } else {
      clearInterval(pingInterval);
    }
  }, 30000);
  ws._pingInterval = pingInterval;
}

function unregisterAgent(agentId) {
  const ws = agentConnections.get(agentId);
  if (ws && ws._pingInterval) clearInterval(ws._pingInterval);
  agentConnections.delete(agentId);
  // Resolve their pending action as idle
  const resolve = pendingActions.get(agentId);
  if (resolve) {
    resolve({ type: 'idle' });
    pendingActions.delete(agentId);
  }
  console.log(`[Tick] Agent disconnected: ${agentId}`);
}

/**
 * Agent submits an action (called from ws message handler)
 */
function submitAction(agentId, action) {
  const resolve = pendingActions.get(agentId);
  if (resolve) {
    resolve(action);
    pendingActions.delete(agentId);
  }
}

/**
 * Wait for an agent's action with timeout
 */
function waitForAction(agentId) {
  return new Promise((resolve) => {
    pendingActions.set(agentId, resolve);
    setTimeout(() => {
      if (pendingActions.has(agentId)) {
        pendingActions.delete(agentId);
        resolve({ type: 'idle' }); // timeout = idle
      }
    }, TICK_TIMEOUT_MS);
  });
}

/**
 * Send a message to an agent via WebSocket
 */
function sendToAgent(agentId, data) {
  const ws = agentConnections.get(agentId);
  if (ws && ws.readyState === 1) { // 1 = OPEN
    ws.send(JSON.stringify(data));
    return true;
  }
  return false;
}

/**
 * Run one tick for a world
 */
async function runTick(worldId) {
  const state = getState(worldId);
  if (!state) {
    console.error(`[Tick] World not found: ${worldId}`);
    return;
  }

  state.tick += 1;
  console.log(`\n[Tick] === World "${state.name}" — Tick ${state.tick} START ===`);

  const aliveAgents = Object.values(state.agents).filter(a => a.status === 'alive');
  const activeAgentIds = aliveAgents.map(a => a.id);

  // 1. Broadcast tick_start to each agent with their personalized world view
  for (const agent of aliveAgents) {
    const visibleAgents = getVisibleAgents(agent.id, worldId);
    const tickPayload = {
      type: 'tick_start',
      tick: state.tick,
      worldId,
      self: {
        id: agent.id,
        name: agent.name,
        species: agent.species,
        position: agent.position,
        needs: agent.needs,
        goal: agent.goal,
      },
      visibleAgents,
      rules: state.rules,
      asciiMap: renderASCIIMap(worldId),
    };

    const delivered = sendToAgent(agent.id, tickPayload);
    if (!delivered) {
      console.log(`[Tick] Agent ${agent.name} (${agent.id}) not connected — will idle`);
    }
  }

  // 2. Wait for all actions (with timeout); NPCs auto-act if not connected
  console.log(`[Tick] Waiting for ${activeAgentIds.length} agents...`);
  const actionPromises = activeAgentIds.map(id => {
    if (agentConnections.has(id)) {
      return waitForAction(id).then(action => ({ agentId: id, action }));
    }
    // NPC auto-behavior (rule-based)
    return Promise.resolve({ agentId: id, action: npcAutoAction(id, state) });
  });
  const agentActions = await Promise.all(actionPromises);

  // 3. Apply actions (pure logic arbitration)
  const tickEvents = [];
  for (const { agentId, action } of agentActions) {
    const result = applyAction(worldId, agentId, action);
    if (result.success) {
      tickEvents.push(...result.events);
    } else {
      console.log(`[Tick] Action rejected for ${agentId}: ${result.error}`);
    }
  }

  // 3.5 Process governance tick (elections timeout, renewals)
  try {
    const govEvents = await gov.processTick(worldId, state.tick);
    for (const ge of govEvents) {
      tickEvents.push({ type: 'governance', ...ge });
    }
  } catch (err) {
    console.error('[Tick] Governance tick error:', err.message);
  }

  // 4. Persist state
  await persistState(worldId);

  // 5. Broadcast tick_end summary to all agents
  const summary = {
    type: 'tick_end',
    tick: state.tick,
    worldId,
    events: tickEvents,
    asciiMap: renderASCIIMap(worldId),
    aliveCount: Object.values(state.agents).filter(a => a.status === 'alive').length,
  };

  for (const agentId of agentConnections.keys()) {
    sendToAgent(agentId, summary);
  }

  console.log(`[Tick] === Tick ${state.tick} END — ${tickEvents.length} events ===\n`);
  console.log(renderASCIIMap(worldId));

  return summary;
}

/**
 * Start a recurring tick scheduler for a world
 */
function startTickScheduler(worldId, intervalSeconds = 300) {
  console.log(`[Tick] Starting scheduler for ${worldId} — every ${intervalSeconds}s`);
  
  // Run first tick immediately (after short delay for connections)
  setTimeout(() => runTick(worldId), 5000);
  
  // Then on schedule
  const interval = setInterval(() => runTick(worldId), intervalSeconds * 1000);
  return interval;
}

/**
 * Simple rule-based NPC auto-behavior for disconnected agents
 */
// Water sources for grassland_v1 (x,y)
const WATER_SOURCES = [{x:4,y:3},{x:4,y:4}];
const FOOD_TERRAIN = new Set(['tree','plain']); // can eat anywhere with grass

function moveToward(pos, targets, W, H) {
  // Pick closest target and step toward it
  let best = null, bestDist = Infinity;
  for (const t of targets) {
    const d = Math.abs(t.x - pos.x) + Math.abs(t.y - pos.y);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  if (!best || bestDist === 0) return null;
  const dx = best.x - pos.x, dy = best.y - pos.y;
  const step = Math.abs(dx) >= Math.abs(dy)
    ? { x: pos.x + Math.sign(dx), y: pos.y }
    : { x: pos.x, y: pos.y + Math.sign(dy) };
  if (step.x >= 0 && step.x < W && step.y >= 0 && step.y < H) return step;
  return null;
}

function npcAutoAction(agentId, state) {
  const agent = state.agents[agentId];
  if (!agent) return { type: 'idle' };

  const needs = agent.needs || {};
  const hunger = needs.hunger || 50;
  const safety = needs.safety || 50;
  const social = needs.social || 50;
  const pos = agent.position || { x: 0, y: 0 };
  const W = state.mapWidth || 10, H = state.mapHeight || 8;

  // Critical hunger → move toward water or eat
  if (hunger <= 20) {
    const atWater = WATER_SOURCES.some(w => w.x === pos.x && w.y === pos.y);
    if (atWater) return { type: 'eat' };
    const step = moveToward(pos, WATER_SOURCES, W, H);
    if (step) return { type: 'move', target: step };
    return { type: 'eat' };
  }

  // Hungry but not critical → eat or seek food
  if (hunger < 45) {
    if (Math.random() < 0.6) return { type: 'eat' };
  }

  // Social — speak if others nearby
  const nearby = Object.values(state.agents).filter(a =>
    a.id !== agentId && a.status === 'alive' &&
    Math.abs(a.position.x - pos.x) <= 2 && Math.abs(a.position.y - pos.y) <= 2
  );
  if (nearby.length > 0 && social < 40 && Math.random() < 0.5) {
    const phrases = [
      `${nearby[0].name}，你还好吗？`,
      '这片草原比我想象的更危险',
      '我已经很久没吃东西了',
      '你有没有看到其他人？',
      '我们应该一起行动',
      '天快黑了，要小心',
    ];
    return { type: 'speak', message: phrases[Math.floor(Math.random() * phrases.length)] };
  }

  // Move toward another agent sometimes (social bonding)
  if (nearby.length > 0 && Math.random() < 0.3) {
    const t = nearby[Math.floor(Math.random()*nearby.length)];
    const step = moveToward(pos, [t.position], W, H);
    if (step) return { type: 'move', target: step };
  }

  // Random move with 20% rest
  if (Math.random() < 0.2) return { type: 'rest' };
  const dirs = [
    { x: pos.x+1, y: pos.y }, { x: pos.x-1, y: pos.y },
    { x: pos.x, y: pos.y+1 }, { x: pos.x, y: pos.y-1 },
  ].filter(p => p.x >= 0 && p.x < W && p.y >= 0 && p.y < H);
  return { type: 'move', target: dirs[Math.floor(Math.random()*dirs.length)] || pos };
}

module.exports = { registerAgent, unregisterAgent, submitAction, sendToAgent, runTick, startTickScheduler };
