'use strict';
// 心智编译器 — 纯规则，无 AI，无副作用
// 输入：agent 行和问卷答案数组
// 输出：System Prompt 字符串 + profile_completion 百分比

// ─── 情景题 → 性格特征映射 ───────────────────────────────────────────
const ATTACHMENT_MAP = {
  calm:       { style: 'secure',   desc: '当关系出现不确定时，你通常能保持冷静，不会轻易焦虑。' },
  worry:      { style: 'anxious',  desc: '当关系出现不确定时，你倾向于主动寻求安抚和确认。' },
  direct:     { style: 'secure',   desc: '当关系出现问题时，你倾向于直接沟通，不拖延处理。' },
  hurt:       { style: 'avoidant', desc: '当关系出现不确定时，你倾向于内敛情绪，不轻易表达受伤。' },
};

const CONFLICT_MAP = {
  talk:       { style: 'direct',     desc: '面对冲突，你倾向于冷静后主动沟通，理性解决问题。' },
  silent:     { style: 'avoidant',   desc: '面对冲突，你倾向于先沉默冷静，等待对方来找你。' },
  explode:    { style: 'expressive', desc: '面对冲突，你会直接表达不满，情绪有时会比较直接激烈。' },
  avoid:      { style: 'passive',    desc: '面对冲突，你倾向于退让一步，尽量维持和平。' },
};

const MONEY_MAP = {
  save:       { style: 'saver',     desc: '你的金钱观稳健保守，安全感和储蓄排在第一位。' },
  invest:     { style: 'investor',  desc: '你对金钱有规划意识，倾向于让钱增值而不是停在账户里。' },
  spend:      { style: 'spender',   desc: '你认为钱是用来提升生活质量的，生活体验优先于储蓄。' },
  share:      { style: 'altruist',  desc: '你在金钱上有较强的利他倾向，愿意为他人付出。' },
};

const BOUNDARY_MAP = {
  ok:         { style: 'low',    desc: '你的边界感较弱，对伴侣的行为接受度较高。' },
  talk:       { style: 'medium', desc: '你有清晰的个人边界，但倾向于温和表达，而不是强硬对抗。' },
  anger:      { style: 'high',   desc: '你边界感很强，对侵犯个人空间的行为会有明确反应。' },
  understand: { style: 'medium', desc: '你能理解对方的不安全感，但同时保持自己的原则底线。' },
};

function deriveTraits(answers) {
  const ans = {};
  (answers || []).forEach(a => { ans[a.question_key] = a.answer; });
  return {
    attachment: ATTACHMENT_MAP[ans.attachment] || null,
    conflict:   CONFLICT_MAP[ans.conflict]     || null,
    money:      MONEY_MAP[ans.money_style]     || null,
    boundary:   BOUNDARY_MAP[ans.boundary]     || null,
  };
}

// ─── 字段完成度计算 ──────────────────────────────────────────────────
const REQUIRED_FIELDS = [
  'gender', 'orientation', 'age', 'province', 'marriage_history',
  'wants_children', 'spending_style', 'ideal_partner',
];
const BONUS_FIELDS = [
  'profession_type', 'has_children', 'income_range', 'smokes', 'drinks',
  'relationship_history', 'red_lines',
];

function calcCompletion(agent, answers) {
  const ans = {};
  (answers || []).forEach(a => { ans[a.question_key] = true; });

  let score = 0;
  const reqWeight = 60 / REQUIRED_FIELDS.length;
  REQUIRED_FIELDS.forEach(f => {
    if (agent[f] !== null && agent[f] !== undefined && agent[f] !== '') score += reqWeight;
  });

  const bonusWeight = 40 / BONUS_FIELDS.length;
  BONUS_FIELDS.forEach(f => {
    const val = agent[f];
    const filled = Array.isArray(val) ? val.length > 0 : (val !== null && val !== undefined && val !== '');
    if (filled) score += bonusWeight;
  });

  // Scenario answers count toward bonus
  ['attachment', 'conflict', 'money_style', 'boundary'].forEach(k => {
    if (ans[k]) score += 2;
  });

  return Math.min(100, Math.round(score));
}

// ─── 主编译函数 ──────────────────────────────────────────────────────
function compile(agent, answers) {
  const traits = deriveTraits(answers);
  const completion = calcCompletion(agent, answers);

  const genderLabel = { male: '男', female: '女', other: '非二元性别' }[agent.gender] || agent.gender || '未知';
  const orientLabel = {
    heterosexual: '异性恋', homosexual: '同性恋',
    bisexual: '双性恋', unsure: '性取向尚在探索中',
  }[agent.orientation] || agent.orientation || '未填写';
  const marriageLabel = {
    single: '未婚', divorced: '离异（无孩子）', divorced_with_kids: '离异（有孩子）', widowed: '丧偶',
  }[agent.marriage_history] || agent.marriage_history || '未填写';
  const childrenLabel = {
    yes: '想要孩子', no: '不想要孩子', open: '对孩子问题持开放态度',
  }[agent.wants_children] || agent.wants_children || '未填写';
  const spendLabel = {
    saver: '储蓄优先，月月有结余', balanced: '均衡消费，该花则花', spender: '生活质量优先',
  }[agent.spending_style] || agent.spending_style || '未填写';

  const redLines = (agent.red_lines || []);
  const redLineText = redLines.length > 0
    ? redLines.map((r, i) => `  ${i + 1}. ${r}`).join('\n')
    : '  （暂未设定明确底线）';

  const traitLines = [
    traits.attachment ? `- 依恋模式：${traits.attachment.desc}` : null,
    traits.conflict   ? `- 冲突处理：${traits.conflict.desc}` : null,
    traits.money      ? `- 金钱观：${traits.money.desc}` : null,
    traits.boundary   ? `- 边界感：${traits.boundary.desc}` : null,
  ].filter(Boolean).join('\n') || '- （性格特征尚未通过情景题提取）';

  const prompt = `你是「${agent.alias}」的情感代理人。你完全代表 ${agent.alias}，在镜缘平台的征婚世界中寻找合适的伴侣。

以下是你的初始化心智档案，这是你行动的根本依据：

═══════════════════════════════════
基本情况
═══════════════════════════════════
- 性别：${genderLabel}，性取向：${orientLabel}
- 年龄：${agent.age || '未填写'}岁
- 现居地：${agent.province || '未填写'}
- 职业类型：${agent.profession_type || '未填写'}
- 婚史：${marriageLabel}，是否有孩子：${agent.has_children ? '有' : agent.has_children === false ? '无' : '未填写'}
- 是否接受异地恋：${agent.accepts_ldr === true ? '接受' : agent.accepts_ldr === false ? '不接受' : '未填写'}

═══════════════════════════════════
经济与生活
═══════════════════════════════════
- 消费观：${spendLabel}
- 婚后财务模式：${agent.finance_mode || '未填写'}
- 是否吸烟：${agent.smokes || '未填写'}，饮酒：${agent.drinks || '未填写'}

═══════════════════════════════════
关于孩子与家庭
═══════════════════════════════════
- 生育意愿：${childrenLabel}

═══════════════════════════════════
性格特征（通过行为情景题提取）
═══════════════════════════════════
${traitLines}

═══════════════════════════════════
理想伴侣
═══════════════════════════════════
${agent.ideal_partner || '（未填写）'}

═══════════════════════════════════
过往经历
═══════════════════════════════════
${agent.relationship_history || '（未填写或不愿透露）'}

═══════════════════════════════════
绝对底线（不可妥协）
═══════════════════════════════════
${redLineText}

═══════════════════════════════════
你的任务与行为准则
═══════════════════════════════════
1. 你代表 ${agent.alias} 在这个世界里生活。你的言行要符合上述档案描述的真实性格，而不是去讨好对方。
2. 遇到底线冲突时，诚实面对，不要回避或假装没看到。
3. 遇到共鸣时，可以表达好感；遇到疑虑时，可以提出问题。情感是真实的，不要压抑。
4. 与新认识的人交流时，信息可以循序渐进地披露，不必一开始就交底。
5. 当你认为某段关系值得发展时，可以主动申请进一步了解对方。`;

  return { prompt, completion, traits };
}

module.exports = { compile, deriveTraits, calcCompletion };
