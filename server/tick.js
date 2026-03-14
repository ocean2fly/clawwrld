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
}

function unregisterAgent(agentId) {
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
function npcAutoAction(agentId, state) {
  const agent = state.agents[agentId];
  if (!agent) return { type: 'idle' };

  const needs = agent.needs || {};
  const hunger = needs.hunger || 50;
  const safety = needs.safety || 50;
  const social = needs.social || 50;

  // Starving → eat if possible, else move toward water/food
  if (hunger > 75) {
    return { type: 'eat' };
  }

  // Unsafe → flee / rest
  if (safety < 25) {
    return { type: 'rest' };
  }

  // Lonely → speak
  if (social < 30 && Math.random() < 0.4) {
    const phrases = [
      '我在这里', '天色渐暗', '听到什么声音了吗？',
      '今天风很大', '水源在哪里？', '需要小心'
    ];
    return { type: 'speak', message: phrases[Math.floor(Math.random() * phrases.length)] };
  }

  // Otherwise random move
  const pos = agent.position || { x: 0, y: 0 };
  const dirs = [
    { x: pos.x + 1, y: pos.y }, { x: pos.x - 1, y: pos.y },
    { x: pos.x, y: pos.y + 1 }, { x: pos.x, y: pos.y - 1 },
    { x: pos.x, y: pos.y }, // stay
  ];
  const map = state.map || {};
  const W = map.width || 10, H = map.height || 8;
  const valid = dirs.filter(p => p.x >= 0 && p.x < W && p.y >= 0 && p.y < H);
  const target = valid[Math.floor(Math.random() * valid.length)];

  // 30% chance to just rest/idle
  if (Math.random() < 0.3) return { type: 'rest' };

  return { type: 'move', target };
}

module.exports = { registerAgent, unregisterAgent, submitAction, sendToAgent, runTick, startTickScheduler };
