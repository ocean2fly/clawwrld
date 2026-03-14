// seed-agents.js — Seed preset agents for grassland world
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const db = require('../server/db');
const { issueToken } = require('../server/auth');
const worldData = require('../worlds/grassland/agents.json');

async function seed() {
  console.log('Seeding preset agents for', worldData.worldId);

  for (const agent of worldData.presetAgents) {
    // Check if exists
    const { rows } = await db.query('SELECT id FROM agents WHERE id = $1', [agent.id]);
    if (rows.length > 0) {
      console.log(`  [SKIP] ${agent.name} already exists`);
      continue;
    }

    await db.query(
      `INSERT INTO agents 
         (id, name, species, world_id, position_x, position_y, 
          needs, personality, goal, is_preset, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'alive')`,
      [
        agent.id,
        agent.name,
        agent.species,
        worldData.worldId,
        agent.position.x,
        agent.position.y,
        JSON.stringify(agent.needs),
        JSON.stringify(agent.personality),
        agent.goal,
        true,
      ]
    );

    const token = issueToken(agent.id, worldData.worldId);
    console.log(`  [OK] ${agent.name} (${agent.species})`);
    console.log(`       Token: ${token.slice(0, 40)}...`);
  }

  console.log('\nDone! Preset agents seeded.');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
