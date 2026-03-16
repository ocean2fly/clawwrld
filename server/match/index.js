'use strict';
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const db = require('../db');

const photoStorage = multer.diskStorage({
  destination: '/opt/clawworld/uploads/match/',
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const upload = multer({
  storage: photoStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, /image\/(jpeg|png|webp|gif)/.test(file.mimetype));
  }
});

const { register, login, guestRegister, requireUser, requireAgent, requireAny, issueAgentToken } = require('./auth');
const { createAgent, getAgentByUser, updateBasic, saveAnswers, recompile, admitAgent, toPublicProfile, toPromptSummary } = require('./profile');
const { listMarket, getPublicProfile, getPromptSummary } = require('./market');
const { startConvo, postMessage, getMessages, getContext, listConvos, requestContact, approveContact } = require('./convo');
const { generateWeekly, getReports } = require('./reports');

// ─── Human Auth ──────────────────────────────────────────────────────
router.post('/auth/register', async (req, res) => {
  try {
    const { phone, email, password } = req.body;
    const { userId } = await register(phone, email, password);
    res.json({ token: String(userId) });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: '该账号已被注册' });
    res.status(400).json({ error: e.message });
  }
});

router.post('/auth/login', async (req, res) => {
  try {
    const { phone, email, password } = req.body;
    const { userId } = await login(phone, email, password);
    res.json({ token: String(userId) });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

// Zero-friction guest entry — no phone/password required
router.post('/auth/guest', async (req, res) => {
  try {
    const { userId } = await guestRegister();
    res.json({ token: String(userId) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Profile (Human) ─────────────────────────────────────────────────
router.post('/profile/agent', requireUser, async (req, res) => {
  try {
    const { alias } = req.body;
    if (!alias) return res.status(400).json({ error: '请填写假名' });
    const agentId = await createAgent(req.userId, alias);
    res.json({ agent_id: agentId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/profile/me', requireUser, async (req, res) => {
  try {
    const agent = await getAgentByUser(req.userId);
    if (!agent) return res.json({ agent: null });
    const pub = toPublicProfile(agent);
    pub.profile_completion = agent.profile_completion;
    pub.prompt_version = agent.prompt_version;
    pub.answers_count = agent.answers?.length || 0;
    res.json({ agent: pub });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/profile/basic', requireUser, async (req, res) => {
  try {
    await updateBasic(req.userId, req.body);
    const result = await recompile(req.userId);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/profile/answers', requireUser, async (req, res) => {
  try {
    const { answers, round } = req.body;
    if (!Array.isArray(answers)) return res.status(400).json({ error: 'answers must be array' });
    await saveAnswers(req.userId, answers, round);
    const result = await recompile(req.userId);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/profile/compile', requireUser, async (req, res) => {
  try {
    const result = await recompile(req.userId);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/profile/admit', requireUser, async (req, res) => {
  try {
    await recompile(req.userId); // ensure fresh
    const { agentId } = await admitAgent(req.userId);
    res.json({ ok: true, agent_id: agentId, message: 'Agent 已进入征婚市场！' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/profile/token', requireUser, async (req, res) => {
  try {
    const result = await issueAgentToken(req.userId);
    res.json({ ...result, note: '此 token 只显示一次，请立即配置到你的 Agent。重新请求将使旧 token 失效。' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Photo upload ────────────────────────────────────────────────────
router.post('/profile/photos', requireUser, upload.array('photos', 9), async (req, res) => {
  try {
    if (!req.files || !req.files.length) return res.status(400).json({ error: '请选择图片' });
    const urls = req.files.map(f => `/uploads/match/${f.filename}`);
    // Append to existing photos
    await db.query(
      `UPDATE mx_agents SET photos = COALESCE(photos,'[]'::jsonb) || $1::jsonb WHERE user_id=$2`,
      [JSON.stringify(urls), req.userId]
    );
    const r = await db.query('SELECT photos FROM mx_agents WHERE user_id=$1', [req.userId]);
    res.json({ photos: r.rows[0]?.photos || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/profile/photos/:idx', requireUser, async (req, res) => {
  try {
    const idx = parseInt(req.params.idx);
    await db.query(
      `UPDATE mx_agents SET photos = photos - $1 WHERE user_id=$2`,
      [idx, req.userId]
    );
    const r = await db.query('SELECT photos FROM mx_agents WHERE user_id=$1', [req.userId]);
    res.json({ photos: r.rows[0]?.photos || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Custom prompt (owner adjusts agent mind) ─────────────────────────
router.get('/profile/prompt', requireUser, async (req, res) => {
  try {
    const r = await db.query('SELECT compiled_prompt, custom_prompt FROM mx_agents WHERE user_id=$1', [req.userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Agent 不存在' });
    res.json({ compiled_prompt: r.rows[0].compiled_prompt, custom_prompt: r.rows[0].custom_prompt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/profile/prompt', requireUser, async (req, res) => {
  try {
    const { custom_prompt } = req.body;
    await db.query('UPDATE mx_agents SET custom_prompt=$1 WHERE user_id=$2', [custom_prompt, req.userId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Agent reporting to owner ─────────────────────────────────────────
// Agent POSTs a report; owner reads via GET
router.post('/report-to-owner', requireAgent, async (req, res) => {
  try {
    const { summary } = req.body;
    if (!summary) return res.status(400).json({ error: '请填写汇报内容' });
    await db.query(
      `INSERT INTO mx_reports (agent_id, report_type, generated_at, content)
       VALUES ($1, 'agent_report', NOW(), $2)`,
      [req.agentId, JSON.stringify({ summary, ts: Date.now() })]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/agent-reports', requireUser, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT r.id, r.generated_at, r.content
       FROM mx_reports r JOIN mx_agents a ON r.agent_id=a.id
       WHERE a.user_id=$1 AND r.report_type='agent_report'
       ORDER BY r.generated_at DESC LIMIT 50`,
      [req.userId]
    );
    res.json({ reports: r.rows.map(row => ({
      id: row.id,
      ts: row.generated_at,
      summary: JSON.parse(row.content).summary
    }))});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Market (Human + Agent) ──────────────────────────────────────────
router.get('/market', requireAny, async (req, res) => {
  try {
    // resolve caller's agent ID
    let excludeId = req.agentId || null;
    if (!excludeId && req.userId) {
      const db = require('../db');
      const r = await db.query('SELECT id FROM mx_agents WHERE user_id=$1', [req.userId]);
      excludeId = r.rows[0]?.id || null;
    }
    const agents = await listMarket(excludeId, req.query);
    res.json({ agents });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/market/:agentId', requireAny, async (req, res) => {
  try {
    const profile = await getPublicProfile(req.params.agentId);
    if (!profile) return res.status(404).json({ error: '找不到该 Agent 或 Agent 未入场' });
    res.json({ agent: profile });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/market/:agentId/prompt', requireAgent, async (req, res) => {
  try {
    const summary = await getPromptSummary(req.params.agentId);
    if (!summary) return res.status(404).json({ error: '找不到该 Agent' });
    res.json({ summary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Conversations (Human viewing) ───────────────────────────────────
router.get('/conversations', requireUser, async (req, res) => {
  try {
    const db = require('../db');
    const agentR = await db.query('SELECT id FROM mx_agents WHERE user_id=$1', [req.userId]);
    if (!agentR.rows.length) return res.json({ conversations: [] });
    const convos = await listConvos(agentR.rows[0].id);
    res.json({ conversations: convos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/conversations/:id', requireAny, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const before = req.query.before ? parseInt(req.query.before) : undefined;
    const messages = await getMessages(parseInt(req.params.id), limit, before);
    res.json({ messages });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Conversations (Agent posting messages) ───────────────────────────
router.post('/conversations/start', requireAgent, async (req, res) => {
  try {
    const { target_agent_id } = req.body;
    if (!target_agent_id) return res.status(400).json({ error: 'target_agent_id required' });
    const convo = await startConvo(req.agentId, target_agent_id);
    res.json({ convo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/conversations/:id/message', requireAgent, async (req, res) => {
  try {
    const { content, msg_type, scenario_key, metadata } = req.body;
    if (!content) return res.status(400).json({ error: 'content required' });
    const msg = await postMessage(
      parseInt(req.params.id), req.agentId,
      content, msg_type, scenario_key, metadata
    );
    res.json({ message: msg });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/conversations/:id/context', requireAgent, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const { convo, messages, otherAgentId } = await getContext(parseInt(req.params.id), req.agentId, limit);
    const otherSummary = await getPromptSummary(otherAgentId);
    res.json({ convo, messages, other_agent_summary: otherSummary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Contact exchange ────────────────────────────────────────────────
router.post('/contact/:convoId/request', requireAgent, async (req, res) => {
  try {
    await requestContact(parseInt(req.params.convoId), req.agentId);
    res.json({ ok: true, message: '已发起联系方式交换请求，等待双方用户确认' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/contact/:convoId/approve', requireUser, async (req, res) => {
  try {
    const { my_contact } = req.body;
    if (!my_contact) return res.status(400).json({ error: '请填写你的联系方式' });
    const result = await approveContact(parseInt(req.params.convoId), req.userId, my_contact);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Reports ─────────────────────────────────────────────────────────
router.get('/reports', requireUser, async (req, res) => {
  try {
    const reports = await getReports(req.userId, parseInt(req.query.limit) || 20);
    res.json({ reports });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/reports/weekly', requireUser, async (req, res) => {
  try {
    const db = require('../db');
    const agentR = await db.query('SELECT id FROM mx_agents WHERE user_id=$1', [req.userId]);
    if (!agentR.rows.length) return res.status(400).json({ error: 'Agent 不存在' });
    const report = await generateWeekly(req.userId, agentR.rows[0].id);
    res.json({ ok: true, report });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
