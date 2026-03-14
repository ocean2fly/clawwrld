// db.js — PostgreSQL connection
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected error on idle client', err);
});

const db = {
  query: (text, params) => pool.query(text, params),
  
  getClient: async () => {
    const client = await pool.connect();
    const query = client.query.bind(client);
    const release = () => client.release();
    return { query, release };
  },
};

module.exports = db;
