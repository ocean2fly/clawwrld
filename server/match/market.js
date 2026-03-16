'use strict';
const { pool } = require('../db');
const { toPublicProfile, toPromptSummary, getAgentById } = require('./profile');

// List market (admitted agents, exclude self)
async function listMarket(excludeAgentId, filters = {}) {
  const params = [excludeAgentId || ''];
  let where = "status='admitted' AND admitted=TRUE AND id != $1";
  let i = 2;

  if (filters.gender)   { where += ` AND gender=$${i++}`;   params.push(filters.gender); }
  if (filters.min_age)  { where += ` AND age>=$${i++}`;     params.push(parseInt(filters.min_age)); }
  if (filters.max_age)  { where += ` AND age<=$${i++}`;     params.push(parseInt(filters.max_age)); }
  if (filters.wants_children) { where += ` AND wants_children=$${i++}`; params.push(filters.wants_children); }

  const r = await pool.query(
    `SELECT * FROM mx_agents WHERE ${where} ORDER BY created_at DESC LIMIT 50`,
    params
  );
  return r.rows.map(toPublicProfile);
}

// Get single public profile
async function getPublicProfile(agentId) {
  const agent = await getAgentById(agentId);
  if (!agent || !agent.admitted) return null;
  return toPublicProfile(agent);
}

// Get prompt summary for another agent to use as context
async function getPromptSummary(agentId) {
  const agent = await getAgentById(agentId);
  if (!agent || !agent.admitted) return null;
  return toPromptSummary(agent);
}

module.exports = { listMarket, getPublicProfile, getPromptSummary };
