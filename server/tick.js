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

  // 3.5 Cooperation events (food sharing, group gathering, guard duty)
  try {
    const { getState, getRelationships } = require('./world');
    const coopEvents = processCooperation(worldId, state, getRelationships(worldId));
    tickEvents.push(...coopEvents);
  } catch(err) { console.error('[Tick] Coop error:', err.message); }

  // 3.6 Process governance tick (elections timeout, renewals)
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
const { getRelationships } = require('./world');

// ── Cooperation system ─────────────────────────────────────────────
function processCooperation(worldId, state, rels) {
  const events = [];
  const agents = Object.values(state.agents).filter(a => a.status === 'alive');
  const used = new Set(); // agents already acted in coop this tick

  // 1. Food sharing: agent with OK hunger near a starving friend/close/lovers
  for (const giver of agents) {
    if (used.has(giver.id)) continue;
    const giverH = giver.needs.hunger || 0;
    if (giverH < 35) continue; // giver too hungry to share

    for (const receiver of agents) {
      if (receiver.id === giver.id) continue;
      if (used.has(receiver.id)) continue;
      const recH = receiver.needs.hunger || 0;
      if (recH > 20) continue; // receiver not desperate enough

      const dist = Math.abs(giver.position.x - receiver.position.x) +
                   Math.abs(giver.position.y - receiver.position.y);
      if (dist > 2) continue;

      const key = [giver.id, receiver.id].sort().join('::');
      const rel = rels && rels.get(key);
      const level = rel ? getRelLevel(rel.score) : 'stranger';
      if (!['friends','close','lovers'].includes(level)) continue;

      // Share food!
      giver.needs.hunger = Math.max(10, giverH - 18);
      receiver.needs.hunger = Math.min(60, recH + 28);
      used.add(giver.id); used.add(receiver.id);

      const desc = level === 'lovers'
        ? pick([
            `${giver.name}将自己仅剩的食物递给${receiver.name}，轻声说："你先吃"`,
            `${giver.name}看见${receiver.name}虚弱的样子，毫不犹豫地分出了自己的食物`,
          ])
        : pick([
            `${giver.name}发现${receiver.name}已经快撑不住了，悄悄把食物分了过去`,
            `"拿着。" ${giver.name}没有多说，把食物放到了${receiver.name}手里`,
            `${giver.name}见${receiver.name}饥寒交迫，将食物一分为二`,
          ]);
      events.push({ type: 'food_share', participants: [giver.id, receiver.id], description: desc });
      // Relationship boost
      if (rel) { rel.score = Math.min(100, rel.score + 8); }
      break;
    }
  }

  // 2. Group gathering: 3+ agents within 2 cells of each other
  const positions = agents.map(a => a.position);
  for (let i = 0; i < agents.length; i++) {
    const anchor = agents[i];
    const group = agents.filter(a =>
      Math.abs(a.position.x - anchor.position.x) <= 2 &&
      Math.abs(a.position.y - anchor.position.y) <= 2
    );
    if (group.length >= 3) {
      // Only fire once per tick (use a flag)
      if (state._groupTalkTick === state.tick) break;
      state._groupTalkTick = state.tick;

      const names = group.slice(0,3).map(a => a.name);
      const desc = pick([
        `${names[0]}、${names[1]}与${names[2]}围坐在一起，低声商量着接下来怎么办`,
        `草原上聚起了一小群人——${names.join('、')}。他们分享着各自的发现`,
        `${names[0]}说："我们应该一起行动。" ${names[1]}和${names[2]}沉默片刻，点了点头`,
        `${group.length}人不约而同地聚集到了一起，彼此的存在带来了一丝温暖`,
      ]);
      events.push({ type: 'group_gathering', participants: group.map(a=>a.id), description: desc });
      break;
    }
  }

  // 3. Guard duty: partner resting, other stands guard
  for (const guard of agents) {
    if (used.has(guard.id)) continue;
    const guardH = guard.needs.hunger || 0;
    if (guardH < 25) continue;

    for (const resting of agents) {
      if (resting.id === guard.id) continue;
      const key = [guard.id, resting.id].sort().join('::');
      const rel = rels && rels.get(key);
      if (!rel || !rel.partnered) continue;

      const dist = Math.abs(guard.position.x - resting.position.x) +
                   Math.abs(guard.position.y - resting.position.y);
      if (dist > 1) continue;
      if (state._guardTick === state.tick) break;
      state._guardTick = state.tick;
      used.add(guard.id);

      const desc = pick([
        `${guard.name}静静地守在${resting.name}身旁，让对方安心休息`,
        `${resting.name}闭上眼睛，知道${guard.name}在旁边守着——这就足够了`,
        `${guard.name}背对着${resting.name}，默默注视着草原的远处`,
      ]);
      events.push({ type: 'guard_duty', participants: [guard.id, resting.id], description: desc });
      break;
    }
  }

  return events;
}

function getRelLevel(score) {
  if (score >= 90) return 'lovers';
  if (score >= 70) return 'close';
  if (score >= 45) return 'friends';
  if (score >= 20) return 'acquaintance';
  return 'stranger';
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

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
