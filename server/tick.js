// tick.js — Tick engine: collect actions, arbitrate, advance world
const { getState, getVisibleAgents, applyAction, persistState, renderASCIIMap } = require('./world');
const db = require('./db');

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

  // 2. Wait for all actions (with timeout)
  console.log(`[Tick] Waiting for ${activeAgentIds.length} agents...`);
  const actionPromises = activeAgentIds.map(id => 
    waitForAction(id).then(action => ({ agentId: id, action }))
  );
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

module.exports = { registerAgent, unregisterAgent, submitAction, sendToAgent, runTick, startTickScheduler };
