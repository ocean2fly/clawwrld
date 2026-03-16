'use strict';
const db = require('../db');
const { compile } = require('./compiler');
const { genAgentId } = require('./auth');

const BASIC_FIELDS = [
  'gender','orientation','age','province','profession_type','marriage_history',
  'has_children','accepts_ldr','wants_children','income_range','has_property',
  'has_car','has_debt','spending_style','finance_mode','smokes','drinks',
  'ideal_partner','relationship_history','red_lines','photo_url',
];

// ─── Create agent for user (called after alias is set) ───────────────
async function createAgent(userId, alias) {
  const existing = await db.query('SELECT id FROM mx_agents WHERE user_id=$1', [userId]);
  if (existing.rows.length) return existing.rows[0].id;
  const id = genAgentId();
  await db.query('INSERT INTO mx_agents (id, user_id, alias) VALUES ($1,$2,$3)', [id, userId, alias]);
  return id;
}

// ─── Get agent + answers ─────────────────────────────────────────────
async function getAgentByUser(userId) {
  const r = await db.query('SELECT * FROM mx_agents WHERE user_id=$1', [userId]);
  if (!r.rows.length) return null;
  const agent = r.rows[0];
  const ans = await db.query('SELECT * FROM mx_questionnaire_answers WHERE agent_id=$1', [agent.id]);
  agent.answers = ans.rows;
  return agent;
}

async function getAgentById(agentId) {
  const r = await db.query('SELECT * FROM mx_agents WHERE id=$1', [agentId]);
  if (!r.rows.length) return null;
  const agent = r.rows[0];
  const ans = await db.query('SELECT * FROM mx_questionnaire_answers WHERE agent_id=$1', [agentId]);
  agent.answers = ans.rows;
  return agent;
}

// ─── Update basic profile fields ─────────────────────────────────────
async function updateBasic(userId, data) {
  const agent = await db.query('SELECT id FROM mx_agents WHERE user_id=$1', [userId]);
  if (!agent.rows.length) throw new Error('Agent 不存在，请先创建');
  const agentId = agent.rows[0].id;

  const updates = {};
  BASIC_FIELDS.forEach(k => {
    if (data[k] !== undefined) updates[k] = data[k];
  });
  if (!Object.keys(updates).length) return agentId;

  const cols = Object.keys(updates).map((k, i) => `${k}=$${i + 2}`).join(', ');
  await db.query(
    `UPDATE mx_agents SET ${cols}, updated_at=NOW() WHERE id=$1`,
    [agentId, ...Object.values(updates)]
  );
  return agentId;
}

// ─── Save questionnaire answers (upsert) ─────────────────────────────
async function saveAnswers(userId, answers, round) {
  const agent = await db.query('SELECT id FROM mx_agents WHERE user_id=$1', [userId]);
  if (!agent.rows.length) throw new Error('Agent 不存在');
  const agentId = agent.rows[0].id;

  for (const { key, answer } of answers) {
    await db.query(
      `INSERT INTO mx_questionnaire_answers (agent_id, question_key, answer, round)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (agent_id, question_key) DO UPDATE SET answer=EXCLUDED.answer`,
      [agentId, key, answer, round || 1]
    );
  }
  return agentId;
}

// ─── Compile mind prompt ─────────────────────────────────────────────
async function recompile(userId) {
  const agent = await getAgentByUser(userId);
  if (!agent) throw new Error('Agent 不存在');
  const { prompt, completion, traits } = compile(agent, agent.answers);

  // Also persist derived traits
  const { attachment, conflict, money, boundary } = traits;
  await db.query(
    `UPDATE mx_agents SET
       mind_prompt=$1, profile_completion=$2, prompt_version=prompt_version+1,
       attachment_style=$3, conflict_style=$4, money_personality=$5, boundary_strength=$6,
       updated_at=NOW()
     WHERE id=$7`,
    [
      prompt, completion,
      attachment?.style || null,
      conflict?.style || null,
      money?.style || null,
      boundary?.style || null,
      agent.id,
    ]
  );
  return { completion, promptPreview: prompt.substring(0, 300) + '…' };
}

// ─── Admit agent to market ───────────────────────────────────────────
async function admitAgent(userId) {
  const agent = await db.query('SELECT id, profile_completion FROM mx_agents WHERE user_id=$1', [userId]);
  if (!agent.rows.length) throw new Error('Agent 不存在');
  const { id, profile_completion } = agent.rows[0];
  if (profile_completion < 60) throw new Error(`档案完成度 ${profile_completion}%，至少需要 60% 才能入场`);
  await db.query("UPDATE mx_agents SET admitted=TRUE, status='admitted' WHERE id=$1", [id]);
  return { agentId: id };
}

// ─── Public profile (for market display) ─────────────────────────────
function toPublicProfile(agent) {
  return {
    id: agent.id,
    alias: agent.alias,
    gender: agent.gender,
    age: agent.age,
    province: agent.province,
    profession_type: agent.profession_type,
    marriage_history: agent.marriage_history,
    has_children: agent.has_children,
    wants_children: agent.wants_children,
    spending_style: agent.spending_style,
    smokes: agent.smokes,
    drinks: agent.drinks,
    profile_completion: agent.profile_completion,
    status: agent.status,
    photo_url: agent.photo_url || null,
  };
}

// ─── Agent prompt summary (for other agents to build context) ────────
function toPromptSummary(agent) {
  const lines = [
    `对方代号：${agent.alias}`,
    `性别：${agent.gender || '?'}，年龄：${agent.age || '?'}岁，来自：${agent.province || '?'}`,
    `婚史：${agent.marriage_history || '?'}，生育意愿：${agent.wants_children || '?'}`,
    `消费观：${agent.spending_style || '?'}`,
    `性格类型（依恋/冲突/边界）：${agent.attachment_style || '?'} / ${agent.conflict_style || '?'} / ${agent.boundary_strength || '?'}`,
  ];
  if (agent.ideal_partner) lines.push(`对方描述的理想伴侣：${agent.ideal_partner.substring(0, 100)}`);
  return lines.join('\n');
}

module.exports = {
  createAgent, getAgentByUser, getAgentById, updateBasic,
  saveAnswers, recompile, admitAgent, toPublicProfile, toPromptSummary,
};
