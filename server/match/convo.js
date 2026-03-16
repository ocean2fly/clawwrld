'use strict';
const { pool } = require('../db');

// ─── Start or get a conversation ─────────────────────────────────────
async function startConvo(agentAId, agentBId) {
  // Normalise order so UNIQUE constraint works
  const [a, b] = agentAId < agentBId ? [agentAId, agentBId] : [agentBId, agentAId];
  const existing = await pool.query('SELECT * FROM mx_conversations WHERE agent_a=$1 AND agent_b=$2', [a, b]);
  if (existing.rows.length) return existing.rows[0];
  const r = await pool.query(
    'INSERT INTO mx_conversations (agent_a, agent_b) VALUES ($1,$2) RETURNING *',
    [a, b]
  );
  return r.rows[0];
}

// ─── Post a message ──────────────────────────────────────────────────
async function postMessage(convoId, senderAgentId, content, msgType, scenarioKey, metadata) {
  // Verify sender is in this convo
  const cv = await pool.query('SELECT * FROM mx_conversations WHERE id=$1', [convoId]);
  if (!cv.rows.length) throw new Error('对话不存在');
  const convo = cv.rows[0];
  if (convo.agent_a !== senderAgentId && convo.agent_b !== senderAgentId) {
    throw new Error('你不在这段对话中');
  }

  const r = await pool.query(
    `INSERT INTO mx_messages (convo_id, sender_id, content, msg_type, scenario_key, metadata)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [convoId, senderAgentId, content, msgType || 'chat', scenarioKey || null, metadata || {}]
  );
  await pool.query(
    'UPDATE mx_conversations SET message_count=message_count+1, last_message_at=NOW() WHERE id=$1',
    [convoId]
  );
  return r.rows[0];
}

// ─── Get messages ────────────────────────────────────────────────────
async function getMessages(convoId, limit, before) {
  let q = `SELECT m.*, a.alias as sender_alias
    FROM mx_messages m
    JOIN mx_agents a ON a.id = m.sender_id
    WHERE m.convo_id = $1`;
  const params = [convoId];
  let i = 2;
  if (before) { q += ` AND m.id < $${i++}`; params.push(before); }
  q += ` ORDER BY m.created_at DESC LIMIT $${i++}`;
  params.push(limit || 50);
  const r = await pool.query(q, params);
  return r.rows.reverse();
}

// ─── Context snapshot (recent messages + both agent summaries) ───────
async function getContext(convoId, myAgentId, limit) {
  const messages = await getMessages(convoId, limit || 20);
  const cv = await pool.query('SELECT * FROM mx_conversations WHERE id=$1', [convoId]);
  if (!cv.rows.length) throw new Error('对话不存在');
  const convo = cv.rows[0];
  const otherAgentId = convo.agent_a === myAgentId ? convo.agent_b : convo.agent_a;
  return { convo, messages, otherAgentId };
}

// ─── List conversations for an agent ────────────────────────────────
async function listConvos(agentId) {
  const r = await pool.query(
    `SELECT c.*,
       CASE WHEN c.agent_a=$1 THEN b.alias ELSE a.alias END as other_alias,
       CASE WHEN c.agent_a=$1 THEN c.agent_b ELSE c.agent_a END as other_id
     FROM mx_conversations c
     JOIN mx_agents a ON a.id = c.agent_a
     JOIN mx_agents b ON b.id = c.agent_b
     WHERE c.agent_a=$1 OR c.agent_b=$1
     ORDER BY c.last_message_at DESC NULLS LAST`,
    [agentId]
  );
  return r.rows;
}

// ─── Contact exchange ────────────────────────────────────────────────
async function requestContact(convoId, initiatorAgentId) {
  const cv = await pool.query('SELECT * FROM mx_conversations WHERE id=$1', [convoId]);
  if (!cv.rows.length) throw new Error('对话不存在');
  const convo = cv.rows[0];
  if (convo.agent_a !== initiatorAgentId && convo.agent_b !== initiatorAgentId) {
    throw new Error('无权操作');
  }
  await pool.query(
    `INSERT INTO mx_contact_requests (convo_id, initiated_by) VALUES ($1,$2)
     ON CONFLICT (convo_id) DO NOTHING`,
    [convoId, initiatorAgentId]
  );
  await pool.query("UPDATE mx_conversations SET status='contact_requested' WHERE id=$1", [convoId]);
  return { ok: true };
}

async function approveContact(convoId, userId, myContact) {
  // Find which side this user is on
  const cv = await pool.query(
    `SELECT c.*, a1.user_id as user_a, a2.user_id as user_b
     FROM mx_conversations c
     JOIN mx_agents a1 ON a1.id = c.agent_a
     JOIN mx_agents a2 ON a2.id = c.agent_b
     WHERE c.id=$1`, [convoId]
  );
  if (!cv.rows.length) throw new Error('对话不存在');
  const { user_a, user_b } = cv.rows[0];
  const isA = user_a === userId;
  const isB = user_b === userId;
  if (!isA && !isB) throw new Error('无权操作');

  const col = isA ? 'user_a_approved=TRUE, user_a_contact=$1' : 'user_b_approved=TRUE, user_b_contact=$1';
  await pool.query(`UPDATE mx_contact_requests SET ${col} WHERE convo_id=$2`, [myContact, convoId]);

  const cr = await pool.query('SELECT * FROM mx_contact_requests WHERE convo_id=$1', [convoId]);
  const r = cr.rows[0];
  if (r.user_a_approved && r.user_b_approved) {
    await pool.query("UPDATE mx_contact_requests SET status='completed' WHERE convo_id=$1", [convoId]);
    await pool.query("UPDATE mx_conversations SET status='contact_shared' WHERE id=$1", [convoId]);
    return {
      completed: true,
      their_contact: isA ? r.user_b_contact : r.user_a_contact,
    };
  }
  return { completed: false };
}

module.exports = { startConvo, postMessage, getMessages, getContext, listConvos, requestContact, approveContact };
