// library.js — Agent-only knowledge library
// NO public HTTP endpoint — only called internally via authenticated WebSocket
const db = require('./db');

/**
 * Search library by keyword (full-text)
 */
async function searchByKeyword({ query, worldId, limit = 10 }) {
  const params = [`%${query}%`];
  let sql = `SELECT id, world_id, agent_id, agent_name, tick, content, tags, created_at
             FROM library_entries
             WHERE content ILIKE $1`;
  if (worldId) {
    params.push(worldId);
    sql += ` AND world_id = $${params.length}`;
  }
  sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  const { rows } = await db.query(sql, params);
  return rows;
}

/**
 * Get world history summary
 */
async function getWorldHistory(worldId, fromTick = 0, toTick = 99999) {
  const { rows: events } = await db.query(
    `SELECT tick, event_type, participants, description, metadata
     FROM world_events
     WHERE world_id = $1 AND tick BETWEEN $2 AND $3
     ORDER BY tick ASC`,
    [worldId, fromTick, toTick]
  );

  const { rows: [world] } = await db.query(
    'SELECT name, era, tick, rules FROM worlds WHERE id = $1',
    [worldId]
  );

  return { world, events };
}

/**
 * Get agent biography (public events + donated memories)
 */
async function getAgentBiography(agentId) {
  const { rows: [agent] } = await db.query(
    'SELECT id, name, species, world_id, status, tick_joined, tick_died FROM agents WHERE id = $1',
    [agentId]
  );
  if (!agent) return null;

  const { rows: events } = await db.query(
    `SELECT tick, event_type, description FROM world_events
     WHERE participants @> $1 ORDER BY tick ASC LIMIT 50`,
    [JSON.stringify([agentId])]
  );

  const { rows: donated } = await db.query(
    `SELECT tick, donated_content FROM agent_memories
     WHERE agent_id = $1 AND is_donated = true ORDER BY tick ASC`,
    [agentId]
  );

  return { agent, events, donatedMemories: donated };
}

/**
 * Get all tombstones for a world
 */
async function getTombstones(worldId) {
  const { rows } = await db.query(
    `SELECT agent_name, species, tick_born, tick_died, cause_of_death, last_words
     FROM tombstones WHERE world_id = $1 ORDER BY tick_died ASC`,
    [worldId]
  );
  return rows;
}

/**
 * Donate a memory to the library (owner decrypts and submits plaintext)
 */
async function donateMemory({ memoryId, agentId, content }) {
  // Verify this memory belongs to this agent
  const { rows: [mem] } = await db.query(
    'SELECT id, world_id, tick FROM agent_memories WHERE id = $1 AND agent_id = $2',
    [memoryId, agentId]
  );
  if (!mem) return { success: false, error: 'Memory not found' };

  const { rows: [agent] } = await db.query(
    'SELECT name FROM agents WHERE id = $1', [agentId]
  );

  // Mark as donated + insert library entry
  await db.query(
    'UPDATE agent_memories SET is_donated = true, donated_content = $1 WHERE id = $2',
    [content, memoryId]
  );

  await db.query(
    `INSERT INTO library_entries (world_id, agent_id, agent_name, tick, content)
     VALUES ($1, $2, $3, $4, $5)`,
    [mem.world_id, agentId, agent?.name || 'Unknown', mem.tick, content]
  );

  return { success: true };
}

module.exports = { searchByKeyword, getWorldHistory, getAgentBiography, getTombstones, donateMemory };
