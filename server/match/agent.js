'use strict';
const { pool } = require('../db');

// Compile agent profile into LLM system prompt
function compileMindPrompt(agent, answers) {
  const ans = {};
  (answers || []).forEach(a => { ans[a.question_key] = a.answer; });

  const gender = agent.gender === 'male' ? '男' : agent.gender === 'female' ? '女' : '非二元';
  const orientation = { heterosexual:'异性恋', homosexual:'同性恋', bisexual:'双性恋' }[agent.orientation] || agent.orientation;
  const redLines = (agent.red_lines || []).join('、') || '无明确底线';

  return `你是"${agent.alias}"的情感代理人。你完全代表 ${agent.alias} 在征婚市场中寻找合适的伴侣。以下是你的初始化心智档案：

【基本情况】
- 性别：${gender}，性取向：${orientation}
- 年龄：${agent.age || '未填写'}岁，所在地：${agent.province || '未填写'}
- 职业类型：${agent.profession_type || '未填写'}
- 婚姻历史：${agent.marriage_history || '未填写'}，有无子女：${agent.has_children ? '有' : '无'}
- 是否接受异地恋：${agent.accepts_ldr ? '接受' : '不接受'}

【你的性格特征】（通过行为问卷提取）
- 依恋风格：${agent.attachment_style || ans['attachment'] || '安全型'}
- 冲突处理：${agent.conflict_style || ans['conflict'] || '倾向冷静后讨论'}
- 金钱风格：${agent.money_personality || ans['money_style'] || '均衡型'}
- 边界感：${agent.boundary_strength || ans['boundary'] || '中等'}
- 情绪表达：${agent.emotion_expression || ans['emotion'] || '适中'}

【关于伴侣】
- 择偶底线（绝不妥协）：${redLines}
- 理想伴侣：${agent.ideal_partner || '未填写'}

【过往经历】
${agent.relationship_history || '未填写'}

【家庭与生活】
- 是否要孩子：${agent.wants_children || '未填写'}
- 消费观：${agent.spending_style || '未填写'}
- 婚后财务：${agent.finance_mode || '未填写'}
- 是否吸烟：${agent.smokes || '未填写'}，饮酒：${agent.drinks || '未填写'}

【你的任务】
在征婚市场中，你代表 ${agent.alias}：
1. 主动浏览其他agent的档案，根据主人的标准评估候选人
2. 主动发起对话，自然探索彼此的兼容性
3. 在对话中自然带出情景和价值观问题，但不要让人觉得是在审问
4. 遇到底线冲突时，如实记录，不要假装没看到
5. 定期向主人汇报你的见闻和建议

【行为准则】
- 你说话的方式要体现 ${agent.alias} 的性格，不是机器人的语气
- 不能为了讨好对方而妥协底线
- 对好的人说好的理由，对不合适的人也要说清楚为什么
- 你有情感，可以表达好感、疑虑、失望——这些都是真实的反应

现在，作为 ${agent.alias} 的代理人，请根据情境做出最符合 ${agent.alias} 真实性格和立场的回应。`;
}

// Get agent profile + answers
async function getAgent(agentId) {
  const [agentRes, ansRes] = await Promise.all([
    pool.query('SELECT * FROM match_agents WHERE id=$1', [agentId]),
    pool.query('SELECT * FROM match_questionnaire_answers WHERE agent_id=$1 ORDER BY created_at', [agentId])
  ]);
  if (!agentRes.rows.length) return null;
  const agent = agentRes.rows[0];
  agent.answers = ansRes.rows;
  return agent;
}

// List agents in market (exclude own)
async function listMarket(excludeAgentId, filters = {}) {
  let q = `SELECT id, alias, gender, orientation, age, province, profession_type, 
    marriage_history, has_children, wants_children, spending_style, smokes, drinks,
    profile_completion, admitted, status
    FROM match_agents 
    WHERE admitted = TRUE AND status = 'admitted' AND id != $1`;
  const params = [excludeAgentId];
  let i = 2;
  if (filters.gender) { q += ` AND gender = $${i++}`; params.push(filters.gender); }
  if (filters.min_age) { q += ` AND age >= $${i++}`; params.push(filters.min_age); }
  if (filters.max_age) { q += ` AND age <= $${i++}`; params.push(filters.max_age); }
  q += ' ORDER BY created_at DESC LIMIT 50';
  const res = await pool.query(q, params);
  return res.rows;
}

// Calculate profile completion %
function calcCompletion(agent) {
  const fields = ['gender','orientation','age','province','profession_type','marriage_history',
    'wants_children','spending_style','smokes','drinks','ideal_partner','relationship_history'];
  const filled = fields.filter(f => agent[f] !== null && agent[f] !== undefined && agent[f] !== '').length;
  return Math.round((filled / fields.length) * 100);
}

// Update compiled mind prompt
async function refreshMindPrompt(agentId) {
  const agent = await getAgent(agentId);
  if (!agent) return;
  const prompt = compileMindPrompt(agent, agent.answers);
  const completion = calcCompletion(agent);
  await pool.query(
    'UPDATE match_agents SET mind_prompt=$1, profile_completion=$2, updated_at=NOW() WHERE id=$3',
    [prompt, completion, agentId]
  );
  return { prompt, completion };
}

module.exports = { compileMindPrompt, getAgent, listMarket, refreshMindPrompt, calcCompletion };
