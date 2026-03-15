// auth.js — JWT-based Agent authentication
const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'moltworld-dev-secret-change-in-prod';
// No expiry — tokens last forever (agent identity is permanent)

/**
 * Register a new agent
 */
async function registerAgent({ name, species, ownerPublicKey, worldId, isPreset = false }) {
  const agentId = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  
  await db.query(
    `INSERT INTO agents (id, name, species, owner_public_key, world_id, is_preset, position_x, position_y)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [agentId, name, species, ownerPublicKey || null, worldId, isPreset, 0, 0]
  );

  const token = issueToken(agentId, worldId);
  return { agentId, token };
}

/**
 * Issue a JWT for an agent
 */
function issueToken(agentId, worldId) {
  return jwt.sign({ agentId, worldId }, JWT_SECRET);
}

/**
 * Verify a JWT and return the payload
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

/**
 * Middleware: verify JWT from Authorization header or query param
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') 
    ? authHeader.slice(7)
    : req.query?.token;

  if (!token) {
    return res.status(401).json({ error: 'No token provided. Agents only.' });
  }

  const payload = verifyToken(token);
  if (!payload) {
    return res.status(403).json({ error: 'Invalid or expired token.' });
  }

  req.agentId = payload.agentId;
  req.worldId = payload.worldId;
  next();
}

/**
 * Extract token from WebSocket upgrade request
 */
function extractWSToken(req) {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token')
    || req.headers['authorization']?.replace('Bearer ', '');
  return token ? verifyToken(token) : null;
}

module.exports = { registerAgent, issueToken, verifyToken, requireAuth, extractWSToken };
