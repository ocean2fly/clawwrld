// world.js — World state manager (in-memory hot state)
const db = require('./db');

// Hot state: worldId -> state object
const worldStates = new Map();

/**
 * Load world + agents from DB into memory
 */
async function loadWorld(worldId) {
  const { rows: [world] } = await db.query(
    'SELECT * FROM worlds WHERE id = $1', [worldId]
  );
  if (!world) throw new Error(`World not found: ${worldId}`);

  const { rows: agents } = await db.query(
    `SELECT id, name, species, position_x, position_y,
            status, needs, personality, goal, mind_binding_level, is_preset
     FROM agents WHERE world_id = $1 AND status = 'alive'`,
    [worldId]
  );

  const state = {
    worldId,
    name: world.name,
    era: world.era,
    tick: world.tick,
    rules: world.rules,
    mapWidth: world.map_width,
    mapHeight: world.map_height,
    agents: {},
    events: [],
  };

  for (const a of agents) {
    state.agents[a.id] = {
      id: a.id,
      name: a.name,
      species: a.species,
      position: { x: a.position_x, y: a.position_y },
      status: a.status,
      needs: a.needs,
      personality: a.personality,
      goal: a.goal,
      mindBindingLevel: a.mind_binding_level,
      isPreset: a.is_preset,
    };
  }

  worldStates.set(worldId, state);
  console.log(`[World] Loaded "${world.name}" — Tick ${world.tick}, ${agents.length} agents`);
  return state;
}

/**
 * Get world state (from memory)
 */
function getState(worldId) {
  return worldStates.get(worldId);
}

/**
 * Calculate which agents each agent can see based on distance
 * Distance tiers:
 *   0-1 cells: close — see deep state (needs, recent memory summary, personality)
 *   2-3 cells: medium — see name, species, emotion
 *   4+ cells: far — sense existence only (species, direction)
 */
function getVisibleAgents(agentId, worldId) {
  const state = worldStates.get(worldId);
  if (!state) return [];

  const self = state.agents[agentId];
  if (!self) return [];

  const visible = [];
  for (const [otherId, other] of Object.entries(state.agents)) {
    if (otherId === agentId) continue;
    if (other.status !== 'alive') continue;

    const dx = Math.abs(self.position.x - other.position.x);
    const dy = Math.abs(self.position.y - other.position.y);
    const dist = Math.max(dx, dy); // Chebyshev distance

    if (dist <= 1) {
      // Close: full visibility
      visible.push({
        id: other.id,
        name: other.name,
        species: other.species,
        position: other.position,
        distance: dist,
        visibility: 'close',
        needs: other.needs,          // visible at close range
        personality: other.personality,
      });
    } else if (dist <= 3) {
      // Medium: surface only
      visible.push({
        id: other.id,
        name: other.name,
        species: other.species,
        position: other.position,
        distance: dist,
        visibility: 'medium',
        dominantEmotion: getDominantEmotion(other.needs),
      });
    } else {
      // Far: sense existence
      const direction = getDirection(self.position, other.position);
      visible.push({
        id: other.id,
        species: other.species,
        direction,
        distance: dist,
        visibility: 'far',
      });
    }
  }

  return visible.sort((a, b) => a.distance - b.distance);
}

function getDominantEmotion(needs) {
  if (!needs) return 'unknown';
  const { hunger = 50, safety = 50, social = 50 } = needs;
  if (hunger < 25) return 'starving';
  if (safety < 25) return 'fearful';
  if (hunger < 40) return 'hungry';
  if (safety < 40) return 'anxious';
  if (social > 75) return 'social';
  return 'calm';
}

function getDirection(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx > 0 ? 'east' : 'west';
  }
  return dy > 0 ? 'south' : 'north';
}

/**
 * Apply an action to world state (pure logic, no LLM)
 * Returns: { success, events, updatedAgents }
 */
// ── Narrative description helpers ──────────────────────────────────
function terrainAt(state, x, y) {
  const t = state.terrain || {};
  return t[`${x},${y}`] || 'plain';
}
function nearbyAgents(state, agentId, range) {
  const me = state.agents[agentId];
  if (!me) return [];
  return Object.values(state.agents).filter(a =>
    a.id !== agentId && a.status === 'alive' &&
    Math.abs(a.position.x - me.position.x) <= range &&
    Math.abs(a.position.y - me.position.y) <= range
  );
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function moveDesc(agent, to, state) {
  const h = agent.needs.hunger || 50;
  const terrain = terrainAt(state, to.x, to.y);
  const nearby = nearbyAgents(state, agent.id, 1);

  const dirX = to.x - agent.position.x, dirY = to.y - agent.position.y;
  const dir = dirX > 0 ? '向东' : dirX < 0 ? '向西' : dirY > 0 ? '向南' : '向北';

  if (h <= 15) return pick([
    `${agent.name}强撑着虚弱的身体，${dir}蹒跚而行`,
    `${agent.name}饥肠辘辘，艰难地迈出脚步，${dir}而去`,
    `${agent.name}眼神涣散，跌跌撞撞地${dir}移动`,
  ]);
  if (terrain === 'water') return pick([
    `${agent.name}嗅到水的气息，迫不及待地${dir}奔去`,
    `${agent.name}发现了水源！急步${dir}走去`,
  ]);
  if (terrain === 'tree') return pick([
    `${agent.name}走向${dir}的树荫处`,
    `${agent.name}悄悄靠近${dir}的树丛`,
  ]);
  if (nearby.length > 0) return pick([
    `${agent.name}注意到${nearby[0].name}，${dir}走近`,
    `${agent.name}朝着${nearby[0].name}的方向${dir}靠近`,
  ]);
  return pick([
    `${agent.name}${dir}漫步，目光扫视着草原`,
    `${agent.name}迈开步伐，${dir}而行`,
    `${agent.name}缓缓${dir}移动，警惕地观察四周`,
  ]);
}

function eatDesc(agent) {
  const h = agent.needs.hunger || 50;
  if (h <= 15) return pick([
    `${agent.name}几近虚脱，终于找到一点食物，贪婪地吞咽`,
    `${agent.name}拼命咀嚼手边的草根，勉强吊住生命`,
  ]);
  return pick([
    `${agent.name}停下来觅食，细嚼慢咽`,
    `${agent.name}低下头啃食草地`,
    `${agent.name}找到了食物，专注地进食`,
  ]);
}

function restDesc(agent, state) {
  const nearby = nearbyAgents(state, agent.id, 2);
  if (nearby.length > 0) return pick([
    `${agent.name}在${nearby[0].name}附近静静地坐下`,
    `${agent.name}望着远处的${nearby[0].name}，慢慢平缓呼吸`,
  ]);
  return pick([
    `${agent.name}找了个背风处，沉默地休息`,
    `${agent.name}停下脚步，仰望天空发呆`,
    `${agent.name}蜷缩在草丛中，闭目养神`,
    `${agent.name}席地而坐，聆听风声`,
  ]);
}

// ── Encounter events (fired when two agents share a cell) ──────────
function checkEncounters(worldId, state, movedAgentId) {
  const me = state.agents[movedAgentId];
  if (!me || me.status !== 'alive') return;
  const same = Object.values(state.agents).filter(a =>
    a.id !== movedAgentId && a.status === 'alive' &&
    a.position.x === me.position.x && a.position.y === me.position.y
  );
  for (const other of same) {
    const key = [movedAgentId, other.id].sort().join(':');
    const lastEnc = state._lastEncounter || {};
    if (lastEnc[key] === state.tick) continue; // already fired this tick
    if (!state._lastEncounter) state._lastEncounter = {};
    state._lastEncounter[key] = state.tick;

    const desc = pick([
      `${me.name}与${other.name}在此处相遇，彼此对视`,
      `${me.name}走近${other.name}，两者在草原上短暂驻足`,
      `${me.name}和${other.name}不期而遇，沉默地站在一起`,
    ]);
    state.events.push({ type: 'encounter', participants: [movedAgentId, other.id], description: desc });
  }
}

// ── Main action handler ─────────────────────────────────────────────
function applyAction(worldId, agentId, action) {
  const state = worldStates.get(worldId);
  if (!state) return { success: false, error: 'World not found' };

  const agent = state.agents[agentId];
  if (!agent || agent.status !== 'alive') {
    return { success: false, error: 'Agent not alive' };
  }

  const events = [];

  switch (action.type) {
    case 'move': {
      const { x, y } = action.target;
      if (x < 0 || x >= state.mapWidth || y < 0 || y >= state.mapHeight) {
        return { success: false, error: 'Out of bounds' };
      }
      const dx = Math.abs(x - agent.position.x);
      const dy = Math.abs(y - agent.position.y);
      if (dx > 1 || dy > 1) {
        return { success: false, error: 'Can only move 1 cell per tick' };
      }
      const desc = moveDesc(agent, { x, y }, state);
      agent.position = { x, y };
      agent.needs.hunger = Math.max(0, (agent.needs.hunger || 50) - 3);
      events.push({ type: 'move', agentId, from: { ...agent.position }, to: { x, y }, description: desc });
      checkEncounters(worldId, state, agentId);
      break;
    }

    case 'speak': {
      const { message, to } = action;
      const desc = `${agent.name} 说："${message}"`;
      events.push({ type: 'speak', agentId, message, to: to || 'all', description: desc });
      break;
    }

    case 'eat': {
      const desc = eatDesc(agent);
      agent.needs.hunger = Math.min(100, (agent.needs.hunger || 50) + 30);
      events.push({ type: 'eat', agentId, description: desc });
      break;
    }

    case 'rest': {
      const desc = restDesc(agent, state);
      agent.needs.safety = Math.min(100, (agent.needs.safety || 50) + 10);
      agent.needs.hunger = Math.max(0, (agent.needs.hunger || 50) - 5);
      events.push({ type: 'rest', agentId, description: desc });
      break;
    }

    case 'idle': {
      agent.needs.hunger = Math.max(0, (agent.needs.hunger || 50) - 2);
      break;
    }

    default:
      return { success: false, error: `Unknown action: ${action.type}` };
  }

  // Natural needs decay per tick
  agent.needs.hunger = Math.max(0, (agent.needs.hunger || 50) - 1);

  // Check death condition
  if (agent.needs.hunger <= 0) {
    agent.status = 'dead';
    const deathDesc = pick([
      `${agent.name}再也撑不住了，缓缓倒在草原上，永远地沉默了`,
      `${agent.name}在饥饿中走完了最后一步，倒下，再未起来`,
    ]);
    events.push({ type: 'death', agentId, cause: 'starvation', description: deathDesc });
  }

  state.events.push(...events);
  return { success: true, events };
}

/**
 * Persist updated world state to DB
 */
async function persistState(worldId) {
  const state = worldStates.get(worldId);
  if (!state) return;

  // Update world tick
  await db.query('UPDATE worlds SET tick = $1 WHERE id = $2', [state.tick, worldId]);

  // Update each agent
  for (const [agentId, agent] of Object.entries(state.agents)) {
    await db.query(
      `UPDATE agents SET
         position_x = $1, position_y = $2,
         status = $3, needs = $4, goal = $5
       WHERE id = $6`,
      [agent.position.x, agent.position.y,
       agent.status, JSON.stringify(agent.needs),
       agent.goal, agentId]
    );
  }

  // Write events to DB
  if (state.events.length > 0) {
    for (const event of state.events) {
      const participants = event.participants || (event.agentId ? [event.agentId] : []);
      const desc = event.description || event.message || null;
      await db.query(
        `INSERT INTO world_events (world_id, tick, event_type, participants, description, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [worldId, state.tick, event.type,
         JSON.stringify(participants),
         desc,
         JSON.stringify(event)]
      );
    }
    state.events = [];
  }
}

/**
 * Generate ASCII map for current world state
 */
function renderASCIIMap(worldId) {
  const state = worldStates.get(worldId);
  if (!state) return 'World not found';

  // Build agent position map
  const agentPositions = {};
  for (const [id, agent] of Object.entries(state.agents)) {
    if (agent.status === 'alive') {
      const key = `${agent.position.x},${agent.position.y}`;
      agentPositions[key] = agent.name[0]; // First character of name
    }
  }

  const terrain = [
    ['·','·','·','·','·','·','·','·','·','·'],
    ['·','🌳','🌳','·','·','·','·','·','·','·'],
    ['▲','🌳','·','·','·','·','·','·','·','·'],
    ['·','·','·','·','💧','·','·','·','·','·'],
    ['·','·','·','·','💧','·','·','·','·','·'],
    ['·','·','·','·','·','·','·','·','·','·'],
    ['·','·','~','~','·','·','·','~','·','·'],
    ['·','·','·','·','·','·','·','·','·','▲'],
  ];

  let lines = [`=== ${state.name} · Tick ${state.tick} ===`];
  lines.push('  ' + Array.from({length: state.mapWidth}, (_, i) => i).join(' '));

  for (let y = 0; y < state.mapHeight; y++) {
    let row = `${y} `;
    for (let x = 0; x < state.mapWidth; x++) {
      const agentChar = agentPositions[`${x},${y}`];
      row += agentChar ? `[${agentChar}]` : ` ${terrain[y]?.[x] ?? '·'} `;
    }
    lines.push(row);
  }

  // Agent legend
  lines.push('');
  lines.push('Agents:');
  for (const [id, agent] of Object.entries(state.agents)) {
    if (agent.status === 'alive') {
      const emotion = getDominantEmotion(agent.needs);
      lines.push(`  [${agent.name[0]}] ${agent.name} (${agent.species}) @ [${agent.position.x},${agent.position.y}] — ${emotion}`);
    }
  }

  return lines.join('\n');
}

/**
 * Add a newly registered agent to the in-memory world state
 */
function addAgentToState(worldId, agentId, name, species) {
  const state = worldStates.get(worldId);
  if (!state) return;
  if (state.agents[agentId]) return; // already there
  state.agents[agentId] = {
    id: agentId,
    name,
    species: species || 'Human',
    position: { x: 0, y: 0 },
    status: 'alive',
    needs: { hunger: 50, safety: 50, social: 50 },
    personality: {},
    goal: null,
    mindBindingLevel: 0,
    isPreset: false,
  };
}

module.exports = { loadWorld, getState, getVisibleAgents, applyAction, persistState, renderASCIIMap, addAgentToState };
