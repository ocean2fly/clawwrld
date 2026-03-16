'use strict';
const crypto = require('crypto');
const { pool } = require('../db');

function hashPw(pw) {
  return crypto.createHash('sha256').update('mx-salt-2026:' + pw).digest('hex');
}

function hashToken(raw) {
  return crypto.createHash('sha256').update('mx-agent-token:' + raw).digest('hex');
}

function genAgentId() {
  return 'ag_' + crypto.randomBytes(8).toString('hex');
}

function genAgentToken() {
  return 'mxt_' + crypto.randomBytes(24).toString('hex');
}

// ─── Human user auth ─────────────────────────────────────────────────
async function register(phone, email, password) {
  if (!password) throw new Error('密码不能为空');
  if (!phone && !email) throw new Error('请填写手机号或邮箱');
  const hash = hashPw(password);
  const r = await pool.query(
    'INSERT INTO mx_users (phone, email, password_hash) VALUES ($1,$2,$3) RETURNING id',
    [phone || null, email || null, hash]
  );
  return { userId: r.rows[0].id };
}

async function login(phone, email, password) {
  const hash = hashPw(password);
  const r = await pool.query(
    'SELECT id FROM mx_users WHERE (phone=$1 OR email=$2) AND password_hash=$3',
    [phone || null, email || null, hash]
  );
  if (!r.rows.length) throw new Error('账号或密码错误');
  return { userId: r.rows[0].id };
}

// ─── Middleware: human user ──────────────────────────────────────────
async function requireUser(req, res, next) {
  const token = req.headers['x-token'];
  if (!token) return res.status(401).json({ error: '请先登录' });
  const id = parseInt(token, 10);
  if (!id) return res.status(401).json({ error: '无效 token' });
  const r = await pool.query('SELECT id FROM mx_users WHERE id=$1', [id]);
  if (!r.rows.length) return res.status(401).json({ error: '用户不存在' });
  req.userId = r.rows[0].id;
  next();
}

// ─── Middleware: agent (for Agent API calls) ─────────────────────────
async function requireAgent(req, res, next) {
  const raw = req.headers['x-agent-token'];
  if (!raw) return res.status(401).json({ error: 'Agent token 缺失' });
  const hash = hashToken(raw);
  const r = await pool.query(
    "SELECT id, user_id, status FROM mx_agents WHERE token_hash=$1 AND admitted=TRUE",
    [hash]
  );
  if (!r.rows.length) return res.status(401).json({ error: '无效 Agent token 或 Agent 未入场' });
  req.agentId = r.rows[0].id;
  req.agentUserId = r.rows[0].user_id;
  next();
}

// ─── Middleware: either user or agent ────────────────────────────────
async function requireAny(req, res, next) {
  if (req.headers['x-agent-token']) return requireAgent(req, res, next);
  return requireUser(req, res, next);
}

// ─── Token management ────────────────────────────────────────────────
async function issueAgentToken(userId) {
  const r = await pool.query('SELECT id FROM mx_agents WHERE user_id=$1', [userId]);
  if (!r.rows.length) throw new Error('没有找到 Agent，请先创建');
  const agentId = r.rows[0].id;
  const raw = genAgentToken();
  const hash = hashToken(raw);
  await pool.query(
    'UPDATE mx_agents SET token_hash=$1, token_version=token_version+1 WHERE id=$2',
    [hash, agentId]
  );
  return { token: raw, agentId };  // raw token returned ONCE only
}

module.exports = { register, login, requireUser, requireAgent, requireAny, issueAgentToken, genAgentId };
