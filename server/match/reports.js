'use strict';
const db = require('../db');

// Rule-based weekly report — no AI
async function generateWeekly(userId, agentId) {
  const now = new Date();
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

  // Conversations this week
  const convosR = await db.query(
    `SELECT c.*,
       CASE WHEN c.agent_a=$1 THEN b.alias ELSE a.alias END as other_alias,
       CASE WHEN c.agent_a=$1 THEN c.agent_b ELSE c.agent_a END as other_id
     FROM mx_conversations c
     JOIN mx_agents a ON a.id = c.agent_a
     JOIN mx_agents b ON b.id = c.agent_b
     WHERE (c.agent_a=$1 OR c.agent_b=$1)
       AND c.last_message_at > $2
     ORDER BY c.message_count DESC`,
    [agentId, weekAgo]
  );

  const activePairs = [];
  let totalMessages = 0;
  let redLineCount = 0;

  for (const c of convosR.rows) {
    // Count messages this week in this convo
    const msgR = await db.query(
      'SELECT COUNT(*) as cnt FROM mx_messages WHERE convo_id=$1 AND created_at>$2',
      [c.id, weekAgo]
    );
    const weekMsgs = parseInt(msgR.rows[0].cnt);
    totalMessages += weekMsgs;

    // Check for red_line messages
    const rlR = await db.query(
      "SELECT COUNT(*) as cnt FROM mx_messages WHERE convo_id=$1 AND msg_type='red_line' AND created_at>$2",
      [c.id, weekAgo]
    );
    const rlCount = parseInt(rlR.rows[0].cnt);
    redLineCount += rlCount;

    // Get last few messages for topic hint
    const lastR = await db.query(
      'SELECT content FROM mx_messages WHERE convo_id=$1 ORDER BY created_at DESC LIMIT 3',
      [c.id]
    );

    activePairs.push({
      alias: c.other_alias,
      agent_id: c.other_id,
      convo_id: c.id,
      week_messages: weekMsgs,
      total_messages: c.message_count,
      red_line_triggered: rlCount > 0,
      status: c.status,
      last_snippets: lastR.rows.map(m => m.content.substring(0, 80)),
    });
  }

  // Total partner count ever
  const totalR = await db.query(
    'SELECT COUNT(*) as cnt FROM mx_conversations WHERE agent_a=$1 OR agent_b=$1',
    [agentId]
  );
  const totalPartners = parseInt(totalR.rows[0].cnt);

  // Recommendations (>20 total messages, no recent red lines, status=active)
  const recommendations = activePairs.filter(
    p => p.total_messages >= 20 && !p.red_line_triggered && p.status === 'active'
  );

  const content = {
    period_start: weekAgo.toISOString().split('T')[0],
    period_end: now.toISOString().split('T')[0],
    total_partners_ever: totalPartners,
    new_active_pairs: activePairs.length,
    total_messages_this_week: totalMessages,
    red_line_alerts: redLineCount,
    active_pairs: activePairs,
    recommendations: recommendations.map(p => ({
      alias: p.alias,
      convo_id: p.convo_id,
      reason: `互动已达 ${p.total_messages} 轮，无明显冲突，可以考虑进一步了解`,
    })),
  };

  // Save to inbox
  const r = await db.query(
    'INSERT INTO mx_reports (user_id, agent_id, report_type, content) VALUES ($1,$2,$3,$4) RETURNING id',
    [userId, agentId, 'weekly', JSON.stringify(content)]
  );
  return { id: r.rows[0].id, ...content };
}

// Get reports for a user
async function getReports(userId, limit) {
  const r = await db.query(
    'SELECT * FROM mx_reports WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2',
    [userId, limit || 20]
  );
  // Mark as read
  await db.query('UPDATE mx_reports SET read_at=NOW() WHERE user_id=$1 AND read_at IS NULL', [userId]);
  return r.rows;
}

module.exports = { generateWeekly, getReports };
