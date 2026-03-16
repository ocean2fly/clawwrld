'use strict';
const https = require('https');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = 'claude-3-5-haiku-20241022'; // fast + cheap

async function callClaude(systemPrompt, messages, maxTokens = 400) {
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) { reject(new Error(parsed.error.message)); return; }
          resolve(parsed.content?.[0]?.text || '');
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Agent A says something, Agent B responds
async function agentChat(agentAPrompt, agentBPrompt, conversationHistory, agentAAlias, agentBAlias) {
  // Build A's last message
  const aMessages = conversationHistory.map(m => ({
    role: m.sender === 'A' ? 'assistant' : 'user',
    content: `[${m.sender === 'A' ? agentAAlias : agentBAlias}说]: ${m.content}`
  }));

  // A speaks
  const aResponse = await callClaude(agentAPrompt, [
    ...aMessages,
    { role: 'user', content: `继续对话。你现在向 ${agentBAlias} 说一句话（1-3句，自然、有个性，不要太正式）：` }
  ]);

  // B responds
  const bMessages = conversationHistory.map(m => ({
    role: m.sender === 'B' ? 'assistant' : 'user',
    content: `[${m.sender === 'B' ? agentBAlias : agentAAlias}说]: ${m.content}`
  }));
  bMessages.push({ role: 'user', content: `[${agentAAlias}说]: ${aResponse}\n\n你怎么回应？（1-3句，自然）：` });

  const bResponse = await callClaude(agentBPrompt, bMessages);

  return { aResponse, bResponse };
}

// Run a scenario between two agents
async function runScenario(agentAPrompt, agentBPrompt, agentAAlias, agentBAlias, scenario) {
  const systemIntro = `【情景挑战】${scenario.title}\n\n背景：${scenario.context}\n\n请根据你的性格和价值观，自然地面对这个情景。`;

  const aMsg = await callClaude(agentAPrompt, [
    { role: 'user', content: `${systemIntro}\n\n请问你对这个情况的真实想法和反应是什么？（2-4句）` }
  ]);

  const bMsg = await callClaude(agentBPrompt, [
    { role: 'user', content: `${systemIntro}\n\n对方（${agentAAlias}）的态度是：${aMsg}\n\n你对此的反应是？（2-4句）` }
  ]);

  // Assess divergence
  const divergence = await callClaude(
    '你是一位婚恋兼容性分析师。请简短评估以下两人在该情景中的分歧程度。',
    [{ role: 'user', content: `情景：${scenario.title}\n\nA的立场：${aMsg}\n\nB的立场：${bMsg}\n\n请评估：1)分歧程度(低/中/高) 2)核心分歧点 3)是否存在根本不兼容（一句话各）` }],
    200
  );

  return { aMsg, bMsg, divergence, scenario };
}

// Generate a report for the agent owner
async function generateReport(agentPrompt, agentAlias, interactions, reportType = 'weekly') {
  const summaryText = interactions.map(i =>
    `与${i.otherAlias}的互动（${i.messageCount}轮对话）：${i.summary}`
  ).join('\n\n');

  const prompt = reportType === 'weekly'
    ? `你是 ${agentAlias} 的情感代理人。请用第一人称，给主人写一份本周相亲报告。语气要像一个好朋友在倾诉，真实、有情感、有具体细节。包括：见了谁、印象如何、发现了什么问题、你的建议。`
    : `你是 ${agentAlias} 的情感代理人。发生了重要事情，请立即向主人汇报。`;

  const text = await callClaude(agentPrompt, [
    { role: 'user', content: `${prompt}\n\n本周情况：\n${summaryText}` }
  ], 600);

  return text;
}

module.exports = { callClaude, agentChat, runScenario, generateReport };
