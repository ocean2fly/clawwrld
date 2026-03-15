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
// ── Relationship system ─────────────────────────────────────────────
// relationships: worldId → Map(key → { score, level, confessed, partnered })
const relationships = new Map();

function relKey(a, b) { return [a,b].sort().join('::'); }

function getRelationships(worldId) {
  if (!relationships.has(worldId)) relationships.set(worldId, new Map());
  return relationships.get(worldId);
}

function getRelLevel(score) {
  if (score >= 90) return 'lovers';
  if (score >= 70) return 'close';
  if (score >= 45) return 'friends';
  if (score >= 20) return 'acquaintance';
  return 'stranger';
}

function relLabel(level) {
  return { stranger:'陌生人', acquaintance:'相识', friends:'朋友', close:'挚友', lovers:'恋人' }[level] || '陌生人';
}

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
  const rels = getRelationships(worldId);

  const nearby = Object.values(state.agents).filter(a =>
    a.id !== movedAgentId && a.status === 'alive' &&
    Math.abs(a.position.x - me.position.x) <= 1 &&
    Math.abs(a.position.y - me.position.y) <= 1
  );

  for (const other of nearby) {
    const key = relKey(movedAgentId, other.id);
    const encKey = `enc:${key}`;
    if (!state._lastEncounter) state._lastEncounter = {};
    if (state._lastEncounter[encKey] === state.tick) continue;
    state._lastEncounter[encKey] = state.tick;

    // Get / init relationship
    if (!rels.has(key)) rels.set(key, { score: 0, confessed: false, partnered: false });
    const rel = rels.get(key);
    const prevLevel = getRelLevel(rel.score);

    // Score increases more when both have social need
    const meS = me.needs.social || 50, otS = other.needs.social || 50;
    const gain = 4 + (meS < 40 ? 3 : 0) + (otS < 40 ? 3 : 0) + Math.floor(Math.random()*4);
    rel.score = Math.min(100, rel.score + gain);
    const newLevel = getRelLevel(rel.score);

    let desc = '';

    // Level-up moment
    if (prevLevel !== newLevel) {
      const upgrades = {
        acquaintance: `${me.name}和${other.name}的关系悄悄发生了变化——他们已不再是陌生人`,
        friends: `${me.name}拍了拍${other.name}的肩膀，两人相视而笑，友谊在此刻悄然生根`,
        close: `${me.name}与${other.name}并肩坐在草原上，倾吐心声，彼此深深信任`,
        lovers: `${me.name}看着${other.name}，心跳不由自主地加速。这片草原上，有什么东西永远改变了`,
      };
      desc = upgrades[newLevel] || `${me.name}与${other.name}的关系更近了一步`;
      state.events.push({ type: 'relationship_upgrade', participants: [movedAgentId, other.id], relLevel: newLevel, description: desc });
    }

    // Confession: close/lovers + not yet confessed + random
    if ((newLevel === 'close' || newLevel === 'lovers') && !rel.confessed && Math.random() < 0.18) {
      rel.confessed = true;
      const accepted = Math.random() < 0.65; // 65% chance accepted
      if (accepted) {
        rel.partnered = true;
        desc = pick([
          `${me.name}鼓起勇气，轻声说："我一直想告诉你……我喜欢你。" ${other.name}沉默片刻，缓缓转过身，露出了一个温柔的笑`,
          `草原的风吹过，${me.name}握住了${other.name}的手。那一刻，两人都明白了什么`,
          `${me.name}说："如果世界有尽头，我希望和你一起站在那里。" ${other.name}没有说话，只是靠近了一点`,
        ]);
      } else {
        desc = pick([
          `${me.name}说出了心里的话，${other.name}沉默良久，轻声说："我……需要一些时间"`,
          `${me.name}鼓起勇气表白，${other.name}低下头，轻声道："对不起……"`,
        ]);
      }
      state.events.push({ type: 'confession', participants: [movedAgentId, other.id], accepted, description: desc });
      continue;
    }

    // Partners: special moments
    if (rel.partnered && Math.random() < 0.35) {
      desc = pick([
        `${me.name}与${other.name}肩并肩站在夕阳下，没有说话，却什么都说了`,
        `${me.name}轻轻碰了碰${other.name}的手，对方回以一个微笑`,
        `${me.name}低声对${other.name}说："有你在，这片草原没那么孤独了"`,
        `${other.name}朝${me.name}走来，两人在草原中央相遇，如同一个秘密`,
      ]);
      state.events.push({ type: 'romance_moment', participants: [movedAgentId, other.id], description: desc });
      continue;
    }

    // Regular encounters by relationship level
    if (!desc) {
      const byLevel = {
        stranger: [
          `${me.name}与${other.name}对视一眼，互相打量`,
          `${me.name}第一次见到${other.name}，谨慎地停下脚步`,
          `${me.name}注意到附近有个陌生人——${other.name}`,
        ],
        acquaintance: [
          `${me.name}见到${other.name}，点了点头`,
          `"${other.name}，你也在这里。" ${me.name}说`,
          `${me.name}和${other.name}相遇，简短地交换了眼神`,
        ],
        friends: [
          `${me.name}看见${other.name}，快步走近："最近怎么样？"`,
          `${me.name}与${other.name}分享了一段安静的时光`,
          `${me.name}笑着对${other.name}说："找到你了"`,
        ],
        close: [
          `${me.name}靠近${other.name}，低声说："我昨晚做了个奇怪的梦"`,
          `${me.name}与${other.name}席地而坐，倾谈了很久`,
          `${me.name}把最近的心事告诉了${other.name}，只有他们之间才有这样的默契`,
        ],
        lovers: [
          `${me.name}与${other.name}相遇，周围的一切都安静下来`,
          `${me.name}轻轻地叫了${other.name}的名字`,
          `${me.name}与${other.name}站在一起，草原的风把他们的发吹向同一个方向`,
        ],
      };
      desc = pick(byLevel[newLevel] || byLevel.stranger);
      state.events.push({ type: 'encounter', participants: [movedAgentId, other.id], relLevel: newLevel, relScore: rel.score, description: desc });
    }
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
