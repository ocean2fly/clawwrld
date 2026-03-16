'use strict';
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { getAgent, listMarket, refreshMindPrompt } = require('./agent');
const { agentChat, runScenario, generateReport } = require('./llm');
const crypto = require('crypto');

// ─── Auth middleware ─────────────────────────────────────────────────
function hashPw(pw) { return crypto.createHash('sha256').update(pw + 'clawmatch-salt').digest('hex'); }

async function authMiddleware(req, res, next) {
  const token = req.headers['x-token'] || req.query.token;
  if (!token) return res.status(401).json({ error: 'no token' });
  const r = await pool.query('SELECT * FROM match_users WHERE id=$1', [token]);
  if (!r.rows.length) return res.status(401).json({ error: 'invalid token' });
  req.user = r.rows[0];
  next();
}

// ─── User Auth ───────────────────────────────────────────────────────
router.post('/auth/register', async (req, res) => {
  try {
    const { phone, email, password } = req.body;
    if (!password || (!phone && !email)) return res.status(400).json({ error: '缺少必要参数' });
    const hash = hashPw(password);
    const r = await pool.query(
      'INSERT INTO match_users (phone, email, password_hash) VALUES ($1,$2,$3) RETURNING id',
      [phone || null, email || null, hash]
    );
    res.json({ token: r.rows[0].id });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: '该账号已存在' });
    res.status(500).json({ error: e.message });
  }
});

router.post('/auth/login', async (req, res) => {
  try {
    const { phone, email, password } = req.body;
    const hash = hashPw(password);
    const r = await pool.query(
      'SELECT id FROM match_users WHERE (phone=$1 OR email=$2) AND password_hash=$3',
      [phone || null, email || null, hash]
    );
    if (!r.rows.length) return res.status(401).json({ error: '账号或密码错误' });
    res.json({ token: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Agent Profile ───────────────────────────────────────────────────
router.post('/agent/create', authMiddleware, async (req, res) => {
  try {
    const { alias } = req.body;
    if (!alias) return res.status(400).json({ error: '请填写假名' });
    const existing = await pool.query('SELECT id FROM match_agents WHERE user_id=$1', [req.user.id]);
    if (existing.rows.length) return res.json({ agent_id: existing.rows[0].id, existed: true });
    const r = await pool.query(
      'INSERT INTO match_agents (user_id, alias) VALUES ($1,$2) RETURNING id',
      [req.user.id, alias]
    );
    res.json({ agent_id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/agent/profile', authMiddleware, async (req, res) => {
  try {
    const agent = await pool.query('SELECT id FROM match_agents WHERE user_id=$1', [req.user.id]);
    if (!agent.rows.length) return res.status(404).json({ error: 'agent not found' });
    const agentId = agent.rows[0].id;
    const allowed = ['gender','orientation','age','province','work_province','profession_type',
      'marriage_history','has_children','accepts_ldr','settle_preference','income_range',
      'has_property','has_car','has_debt','spending_style','finance_mode','smokes','drinks',
      'religion','diet','exercise_freq','wants_children','children_count_pref','photo_url',
      'ideal_partner','relationship_history','red_lines','lives_with_parents_ok'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    if (!Object.keys(updates).length) return res.json({ ok: true });
    const cols = Object.keys(updates).map((k, i) => `${k}=$${i + 2}`).join(', ');
    await pool.query(
      `UPDATE match_agents SET ${cols}, updated_at=NOW() WHERE id=$1`,
      [agentId, ...Object.values(updates)]
    );
    const result = await refreshMindPrompt(agentId);
    res.json({ ok: true, completion: result?.completion });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/agent/answers', authMiddleware, async (req, res) => {
  try {
    const agent = await pool.query('SELECT id FROM match_agents WHERE user_id=$1', [req.user.id]);
    if (!agent.rows.length) return res.status(404).json({ error: 'agent not found' });
    const agentId = agent.rows[0].id;
    const { answers, session } = req.body; // [{key, answer}]
    for (const ans of answers) {
      await pool.query(
        `INSERT INTO match_questionnaire_answers (agent_id, question_key, answer, session)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT DO NOTHING`,
        [agentId, ans.key, ans.answer, session || 1]
      );
    }
    const result = await refreshMindPrompt(agentId);
    res.json({ ok: true, completion: result?.completion });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/agent/me', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM match_agents WHERE user_id=$1', [req.user.id]);
    if (!r.rows.length) return res.json({ agent: null });
    const agent = r.rows[0];
    delete agent.mind_prompt; // don't expose
    res.json({ agent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/agent/admit', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM match_agents WHERE user_id=$1', [req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'no agent' });
    const agent = r.rows[0];
    if (agent.profile_completion < 60) return res.status(400).json({ error: `档案完成度 ${agent.profile_completion}%，需要至少 60% 才能入场` });
    await pool.query("UPDATE match_agents SET admitted=TRUE, status='admitted' WHERE id=$1", [agent.id]);
    res.json({ ok: true, message: 'Agent 已进入征婚市场！' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Market ──────────────────────────────────────────────────────────
router.get('/market', authMiddleware, async (req, res) => {
  try {
    const myAgent = await pool.query("SELECT id FROM match_agents WHERE user_id=$1 AND status='admitted'", [req.user.id]);
    const myId = myAgent.rows[0]?.id || 'none';
    const agents = await listMarket(myId, req.query);
    res.json({ agents });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Conversations / Pairing ─────────────────────────────────────────
router.post('/pair/start', authMiddleware, async (req, res) => {
  try {
    const myR = await pool.query("SELECT id FROM match_agents WHERE user_id=$1 AND status='admitted'", [req.user.id]);
    if (!myR.rows.length) return res.status(400).json({ error: '你的 agent 还没入场' });
    const myId = myR.rows[0].id;
    const { target_agent_id } = req.body;

    const existing = await pool.query(
      "SELECT * FROM match_pairs WHERE (agent_a=$1 AND agent_b=$2) OR (agent_a=$2 AND agent_b=$1)",
      [myId, target_agent_id]
    );
    if (existing.rows.length) return res.json({ pair: existing.rows[0] });

    const r = await pool.query(
      'INSERT INTO match_pairs (agent_a, agent_b) VALUES ($1,$2) RETURNING *',
      [myId, target_agent_id]
    );
    res.json({ pair: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/pair/:pairId/chat', authMiddleware, async (req, res) => {
  try {
    const pairR = await pool.query('SELECT * FROM match_pairs WHERE id=$1', [req.params.pairId]);
    if (!pairR.rows.length) return res.status(404).json({ error: 'pair not found' });
    const pair = pairR.rows[0];
    const myR = await pool.query('SELECT id FROM match_agents WHERE user_id=$1', [req.user.id]);
    const myId = myR.rows[0]?.id;
    if (pair.agent_a !== myId && pair.agent_b !== myId) return res.status(403).json({ error: 'not your pair' });

    const [agentA, agentB] = await Promise.all([getAgent(pair.agent_a), getAgent(pair.agent_b)]);
    if (!agentA?.mind_prompt || !agentB?.mind_prompt) return res.status(400).json({ error: 'agents not ready' });

    const histR = await pool.query('SELECT * FROM match_messages WHERE pair_id=$1 ORDER BY created_at LIMIT 20', [pair.id]);
    const history = histR.rows.map(m => ({
      sender: m.sender_agent_id === pair.agent_a ? 'A' : 'B',
      content: m.content
    }));

    const { aResponse, bResponse } = await agentChat(
      agentA.mind_prompt, agentB.mind_prompt,
      history, agentA.alias, agentB.alias
    );

    await pool.query('INSERT INTO match_messages (pair_id,sender_agent_id,content) VALUES ($1,$2,$3)', [pair.id, pair.agent_a, aResponse]);
    await pool.query('INSERT INTO match_messages (pair_id,sender_agent_id,content) VALUES ($1,$2,$3)', [pair.id, pair.agent_b, bResponse]);
    await pool.query('UPDATE match_pairs SET interaction_count=interaction_count+1, last_interaction=NOW() WHERE id=$1', [pair.id]);

    res.json({ agentA: { alias: agentA.alias, message: aResponse }, agentB: { alias: agentB.alias, message: bResponse } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/pair/:pairId/scenario', authMiddleware, async (req, res) => {
  try {
    const pairR = await pool.query('SELECT * FROM match_pairs WHERE id=$1', [req.params.pairId]);
    if (!pairR.rows.length) return res.status(404).json({ error: 'pair not found' });
    const pair = pairR.rows[0];
    const [agentA, agentB] = await Promise.all([getAgent(pair.agent_a), getAgent(pair.agent_b)]);
    const scenario = req.body.scenario || { title:'生活习惯', context:'你们刚搬到一起，发现对方有些生活习惯让你不太舒服' };

    const result = await runScenario(agentA.mind_prompt, agentB.mind_prompt, agentA.alias, agentB.alias, scenario);

    await pool.query('INSERT INTO match_messages (pair_id,sender_agent_id,content,message_type,scenario_key) VALUES ($1,$2,$3,$4,$5)',
      [pair.id, pair.agent_a, result.aMsg, 'scenario', scenario.title]);
    await pool.query('INSERT INTO match_messages (pair_id,sender_agent_id,content,message_type,scenario_key) VALUES ($1,$2,$3,$4,$5)',
      [pair.id, pair.agent_b, result.bMsg, 'scenario', scenario.title]);

    res.json({ agentA: { alias: agentA.alias, response: result.aMsg }, agentB: { alias: agentB.alias, response: result.bMsg }, analysis: result.divergence });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/pair/:pairId/messages', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT m.*, a.alias FROM match_messages m JOIN match_agents a ON a.id=m.sender_agent_id WHERE m.pair_id=$1 ORDER BY m.created_at',
      [req.params.pairId]
    );
    res.json({ messages: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Reports ─────────────────────────────────────────────────────────
router.get('/reports', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM match_reports WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',
      [req.user.id]
    );
    res.json({ reports: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/reports/generate', authMiddleware, async (req, res) => {
  try {
    const myR = await pool.query('SELECT * FROM match_agents WHERE user_id=$1', [req.user.id]);
    if (!myR.rows.length) return res.status(404).json({ error: 'no agent' });
    const myAgent = myR.rows[0];
    if (!myAgent.mind_prompt) return res.status(400).json({ error: 'agent not ready' });

    const pairsR = await pool.query(
      "SELECT p.*, CASE WHEN p.agent_a=$1 THEN b.alias ELSE a.alias END as other_alias, p.interaction_count FROM match_pairs p JOIN match_agents a ON a.id=p.agent_a JOIN match_agents b ON b.id=p.agent_b WHERE (p.agent_a=$1 OR p.agent_b=$1) AND p.interaction_count>0 ORDER BY p.last_interaction DESC LIMIT 5",
      [myAgent.id]
    );

    const interactions = pairsR.rows.map(p => ({
      otherAlias: p.other_alias,
      messageCount: p.interaction_count,
      summary: `互动 ${p.interaction_count} 次，最后互动于 ${new Date(p.last_interaction).toLocaleDateString('zh-CN')}`
    }));

    if (!interactions.length) return res.json({ report: '本周还没有开始任何互动。请先进入市场，找到感兴趣的人发起对话。' });

    const reportText = await generateReport(myAgent.mind_prompt, myAgent.alias, interactions);
    await pool.query(
      'INSERT INTO match_reports (agent_id, user_id, report_type, content) VALUES ($1,$2,$3,$4)',
      [myAgent.id, req.user.id, 'weekly', reportText]
    );
    res.json({ report: reportText });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Contact Exchange ────────────────────────────────────────────────
router.post('/pair/:pairId/request-contact', authMiddleware, async (req, res) => {
  try {
    const myR = await pool.query('SELECT id FROM match_agents WHERE user_id=$1', [req.user.id]);
    const myId = myR.rows[0]?.id;
    await pool.query('INSERT INTO match_contact_requests (pair_id, requested_by) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.pairId, myId]);
    res.json({ ok: true, message: '已请求交换联系方式，等待对方确认' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/pair/:pairId/approve-contact', authMiddleware, async (req, res) => {
  try {
    const pairR = await pool.query('SELECT * FROM match_pairs WHERE id=$1', [req.params.pairId]);
    const pair = pairR.rows[0];
    const myR = await pool.query('SELECT id FROM match_agents WHERE user_id=$1', [req.user.id]);
    const myId = myR.rows[0]?.id;
    const isA = pair.agent_a === myId;
    const col = isA ? 'user_a_approved' : 'user_b_approved';
    const contactCol = isA ? 'contact_a' : 'contact_b';
    await pool.query(`UPDATE match_contact_requests SET ${col}=TRUE, ${contactCol}=$1 WHERE pair_id=$2`, [req.body.contact, req.params.pairId]);
    const cr = await pool.query('SELECT * FROM match_contact_requests WHERE pair_id=$1', [req.params.pairId]);
    const r = cr.rows[0];
    if (r.user_a_approved && r.user_b_approved) {
      await pool.query("UPDATE match_contact_requests SET status='both_approved' WHERE pair_id=$1", [req.params.pairId]);
      await pool.query("UPDATE match_pairs SET status='contact_shared' WHERE id=$1", [req.params.pairId]);
      return res.json({ ok: true, both_approved: true, their_contact: isA ? r.contact_b : r.contact_a });
    }
    res.json({ ok: true, both_approved: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Scenarios Library ───────────────────────────────────────────────
router.get('/scenarios', (req, res) => {
  res.json({ scenarios: [
    { key: 'money_house', title: '买房产权', context: '你们计划买房，一方有首付钱，另一方没有。如何处理产权和财务安排？' },
    { key: 'family_move_in', title: '父母同住', context: '对方父母希望婚后搬来同住，你怎么看？' },
    { key: 'career_move', title: '梦想工作', context: '你得到了一份梦想工作，但需要去另一个城市，对方要跟过去意味着放弃现在的工作。' },
    { key: 'fight_1', title: '第一次大吵', context: '对方忘记了你们的重要纪念日，你发现时他/她正在打游戏。从这一刻开始，你们会怎么走？' },
    { key: 'ex_contact', title: '前任联系', context: '你发现对方和前任还保持联系，对方说只是普通朋友。' },
    { key: 'kids_decision', title: '要不要孩子', context: '谈到未来，你们关于是否要孩子有了不同想法。' },
    { key: 'in_laws', title: '婆媳/岳丈', context: '对方父母开始干涉你们的一些决定，包括装修、孩子教育、甚至你的职业选择。' },
    { key: 'ten_years', title: '十年后', context: '想象你们结婚十年，有了孩子。坐在沙发上，谈谈各自对未来的期待。' },
  ]});
});

module.exports = router;
