/**
 * governance.js — Master election, impeachment, covenant amendment
 *
 * Flow:
 *   idle → [petition/auto] → nominating → voting → elected
 *   elected → [impeachment petition ≥67%] → impeachment vote → impeached → idle
 *   any state → [covenant amendment proposal + vote] → amended
 */

const db = require('./db');
const fs = require('fs');
const path = require('path');

// ── Load covenant from file ──
function loadCovenant(worldId) {
  const worldDir = worldId.replace(/_v\d+$/, '').replace(/_/g, '/');
  const p = path.join(__dirname, `../worlds/${worldId.split('_')[0]}/covenant.json`);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

// ── Get current governance state ──
async function getGovernance(worldId) {
  const { rows } = await db.query(
    `SELECT g.*, 
       a.name as master_name, a.species as master_species,
       (SELECT COUNT(*) FROM agents WHERE world_id=$1 AND status='active') as active_agents
     FROM world_governance g
     LEFT JOIN agents a ON a.id = g.master_agent_id
     WHERE g.world_id=$1`,
    [worldId]
  );
  if (!rows[0]) return null;
  const state = rows[0];

  // Get nominations
  const { rows: noms } = await db.query(
    `SELECT n.nominee_id, a.name, a.species,
       COUNT(v.id) as votes
     FROM governance_nominations n
     JOIN agents a ON a.id = n.nominee_id
     LEFT JOIN governance_votes v ON v.target_id = n.nominee_id AND v.world_id=$1 AND v.vote_type='election'
     WHERE n.world_id=$1
     GROUP BY n.nominee_id, a.name, a.species`,
    [worldId]
  );

  // Get impeachment signatures if active
  let impeachSigs = 0;
  if (state.election_state === 'impeachment') {
    const { rows: sigs } = await db.query(
      `SELECT COUNT(*) as c FROM governance_votes WHERE world_id=$1 AND vote_type='impeachment'`,
      [worldId]
    );
    impeachSigs = parseInt(sigs[0].c);
  }

  // Recent governance events
  const { rows: events } = await db.query(
    `SELECT ge.*, a.name as actor_name, t.name as target_name
     FROM governance_events ge
     LEFT JOIN agents a ON a.id = ge.actor_id
     LEFT JOIN agents t ON t.id = ge.target_id
     WHERE ge.world_id=$1 ORDER BY ge.created_at DESC LIMIT 10`,
    [worldId]
  );

  const covenant = loadCovenant(worldId);

  return {
    ...state,
    nominations: noms,
    impeachment_signatures: impeachSigs,
    recent_events: events,
    covenant,
    active_agents: parseInt(state.active_agents)
  };
}

// ── Ensure governance row exists ──
async function ensureGovernance(worldId) {
  await db.query(
    `INSERT INTO world_governance (world_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [worldId]
  );
}

// ── Start an election ──
async function callElection(worldId, callerAgentId, currentTick) {
  await ensureGovernance(worldId);
  const { rows } = await db.query(
    `UPDATE world_governance SET election_state='nominating', election_started_tick=$1, updated_at=NOW()
     WHERE world_id=$2 AND election_state='idle' RETURNING *`,
    [currentTick, worldId]
  );
  if (!rows[0]) throw new Error('Election already in progress or world not found');

  await logEvent(worldId, 'ELECTION_CALLED', callerAgentId, null, { tick: currentTick }, currentTick);
  return rows[0];
}

// ── Nominate an agent ──
async function nominate(worldId, nomineeId, nominatorId) {
  const { rows: gov } = await db.query(
    `SELECT * FROM world_governance WHERE world_id=$1`, [worldId]
  );
  if (!gov[0] || !['nominating','voting'].includes(gov[0].election_state)) {
    throw new Error('No election in nominating phase');
  }
  await db.query(
    `INSERT INTO governance_nominations (world_id, nominee_id, nominator_id)
     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [worldId, nomineeId, nominatorId]
  );
  // Auto-advance to voting if needed
  if (gov[0].election_state === 'nominating') {
    await db.query(
      `UPDATE world_governance SET election_state='voting', updated_at=NOW() WHERE world_id=$1`,
      [worldId]
    );
  }
  await logEvent(worldId, 'NOMINATION', nominatorId, nomineeId, {}, 0);
  return { ok: true };
}

// ── Cast vote in election ──
async function voteElection(worldId, voterId, targetId) {
  const { rows: gov } = await db.query(
    `SELECT * FROM world_governance WHERE world_id=$1`, [worldId]
  );
  if (!gov[0] || gov[0].election_state !== 'voting') {
    throw new Error('No election in voting phase');
  }
  // Upsert vote (one vote per agent, can change)
  await db.query(
    `INSERT INTO governance_votes (world_id, voter_id, vote_type, target_id)
     VALUES ($1,$2,'election',$3)
     ON CONFLICT (world_id, voter_id, vote_type, target_id) DO NOTHING`,
    [worldId, voterId, targetId]
  );
  await logEvent(worldId, 'VOTE_CAST', voterId, targetId, { vote_type: 'election' }, 0);

  // Check if threshold met
  await checkElectionResult(worldId, gov[0]);
  return { ok: true };
}

// ── Check election result ──
async function checkElectionResult(worldId, gov) {
  const { rows: agents } = await db.query(
    `SELECT COUNT(*) as c FROM agents WHERE world_id=$1 AND status='active'`, [worldId]
  );
  const total = parseInt(agents[0].c);
  if (total < 2) return;

  const { rows: noms } = await db.query(
    `SELECT n.nominee_id, COUNT(v.id) as votes
     FROM governance_nominations n
     LEFT JOIN governance_votes v ON v.target_id=n.nominee_id AND v.world_id=$1 AND v.vote_type='election'
     WHERE n.world_id=$1 GROUP BY n.nominee_id ORDER BY votes DESC LIMIT 1`,
    [worldId]
  );
  if (!noms[0]) return;

  const threshold = gov.election_duration_ticks ? 0.51 : 0.51;
  const votes = parseInt(noms[0].votes);
  if (votes / total >= threshold) {
    await electMaster(worldId, noms[0].nominee_id, 0);
  }
}

// ── Elect a master ──
async function electMaster(worldId, agentId, tick) {
  await db.query(
    `UPDATE world_governance SET
       master_agent_id=$1, master_since_tick=$2,
       election_state='idle', election_started_tick=NULL,
       updated_at=NOW()
     WHERE world_id=$3`,
    [agentId, tick, worldId]
  );
  // Clear nominations and votes
  await db.query(`DELETE FROM governance_nominations WHERE world_id=$1`, [worldId]);
  await db.query(`DELETE FROM governance_votes WHERE world_id=$1 AND vote_type='election'`, [worldId]);

  await logEvent(worldId, 'MASTER_ELECTED', agentId, null, { tick }, tick);
}

// ── Start impeachment petition ──
async function startImpeachment(worldId, petitionerId, currentTick) {
  const { rows: gov } = await db.query(
    `SELECT * FROM world_governance WHERE world_id=$1`, [worldId]
  );
  if (!gov[0] || !gov[0].master_agent_id) throw new Error('No master to impeach');
  if (gov[0].election_state === 'impeachment') throw new Error('Impeachment already in progress');

  await db.query(
    `UPDATE world_governance SET
       election_state='impeachment', impeachment_target_id=$1, election_started_tick=$2, updated_at=NOW()
     WHERE world_id=$3`,
    [gov[0].master_agent_id, currentTick, worldId]
  );
  // Petitioner auto-signs
  await db.query(
    `INSERT INTO governance_votes (world_id, voter_id, vote_type, target_id)
     VALUES ($1,$2,'impeachment',$3) ON CONFLICT DO NOTHING`,
    [worldId, petitionerId, gov[0].master_agent_id]
  );
  await logEvent(worldId, 'IMPEACHMENT_STARTED', petitionerId, gov[0].master_agent_id, { tick: currentTick }, currentTick);
  return { ok: true, target: gov[0].master_agent_id };
}

// ── Sign impeachment petition ──
async function signImpeachment(worldId, signerId) {
  const { rows: gov } = await db.query(
    `SELECT * FROM world_governance WHERE world_id=$1`, [worldId]
  );
  if (!gov[0] || gov[0].election_state !== 'impeachment') throw new Error('No impeachment in progress');

  await db.query(
    `INSERT INTO governance_votes (world_id, voter_id, vote_type, target_id)
     VALUES ($1,$2,'impeachment',$3) ON CONFLICT DO NOTHING`,
    [worldId, signerId, gov[0].impeachment_target_id]
  );
  await logEvent(worldId, 'IMPEACHMENT_SIGNED', signerId, gov[0].impeachment_target_id, {}, 0);

  // Check threshold
  const { rows: agents } = await db.query(
    `SELECT COUNT(*) as c FROM agents WHERE world_id=$1 AND status='active'`, [worldId]
  );
  const { rows: sigs } = await db.query(
    `SELECT COUNT(*) as c FROM governance_votes WHERE world_id=$1 AND vote_type='impeachment'`, [worldId]
  );
  const total = parseInt(agents[0].c);
  const signed = parseInt(sigs[0].c);

  if (signed / total >= 0.67) {
    await impeachMaster(worldId, gov[0].impeachment_target_id, 0);
  }
  return { ok: true, signatures: signed, required: Math.ceil(total * 0.67) };
}

// ── Execute impeachment ──
async function impeachMaster(worldId, targetId, tick) {
  await db.query(
    `UPDATE world_governance SET
       master_agent_id=NULL, election_state='idle',
       impeachment_target_id=NULL, election_started_tick=NULL, updated_at=NOW()
     WHERE world_id=$1`,
    [worldId]
  );
  await db.query(`DELETE FROM governance_votes WHERE world_id=$1 AND vote_type='impeachment'`, [worldId]);
  await logEvent(worldId, 'MASTER_IMPEACHED', null, targetId, { tick }, tick);
  // Auto-call new election
  await db.query(
    `UPDATE world_governance SET election_state='nominating', election_started_tick=$1, updated_at=NOW() WHERE world_id=$2`,
    [tick, worldId]
  );
  await logEvent(worldId, 'ELECTION_CALLED', null, null, { reason: 'post_impeachment', tick }, tick);
}

// ── Propose covenant amendment ──
async function proposeAmendment(worldId, proposerId, articleIndex, newText) {
  const { rows } = await db.query(
    `INSERT INTO covenant_amendments (world_id, proposer_id, article_index, new_text)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [worldId, proposerId, articleIndex, newText]
  );
  await logEvent(worldId, 'COVENANT_AMENDMENT_PROPOSED', proposerId, null,
    { article: articleIndex, text: newText }, 0);
  return rows[0];
}

// ── Vote on amendment ──
async function voteAmendment(worldId, amendmentId, voterId, support) {
  await db.query(
    `INSERT INTO governance_votes (world_id, voter_id, vote_type, target_id)
     VALUES ($1,$2,'covenant_amendment',$3) ON CONFLICT DO NOTHING`,
    [worldId, voterId, amendmentId]
  );

  const { rows: agents } = await db.query(
    `SELECT COUNT(*) as c FROM agents WHERE world_id=$1 AND status='active'`, [worldId]
  );
  const total = parseInt(agents[0].c);

  if (support) {
    await db.query(`UPDATE covenant_amendments SET votes_for=votes_for+1 WHERE id=$1`, [amendmentId]);
  } else {
    await db.query(`UPDATE covenant_amendments SET votes_against=votes_against+1 WHERE id=$1`, [amendmentId]);
  }

  const { rows: am } = await db.query(`SELECT * FROM covenant_amendments WHERE id=$1`, [amendmentId]);
  if (am[0].votes_for / total >= 0.60) {
    await applyAmendment(worldId, am[0], voterId);
  }
  return { ok: true };
}

// ── Apply amendment to covenant ──
async function applyAmendment(worldId, amendment, actorId) {
  const covenant = loadCovenant(worldId);
  if (!covenant) return;

  if (amendment.article_index !== null && amendment.article_index < covenant.articles.length) {
    covenant.articles[amendment.article_index] = amendment.new_text;
  } else {
    covenant.articles.push(amendment.new_text);
  }
  covenant.version = (covenant.version || 1) + 1;

  // Save to DB as new version
  await db.query(
    `INSERT INTO covenant_versions (world_id, version, content, enacted_by) VALUES ($1,$2,$3,$4)`,
    [worldId, covenant.version, JSON.stringify(covenant), actorId]
  );
  await db.query(
    `UPDATE covenant_amendments SET state='passed', resolved_at=NOW() WHERE id=$1`, [amendment.id]
  );
  await logEvent(worldId, 'COVENANT_AMENDED', actorId, null,
    { article: amendment.article_index, text: amendment.new_text, version: covenant.version }, 0);
}

// ── Tick: resolve time-based governance events ──
async function processTick(worldId, tick) {
  const { rows: gov } = await db.query(
    `SELECT * FROM world_governance WHERE world_id=$1`, [worldId]
  );
  if (!gov[0]) return [];
  const g = gov[0];
  const events = [];

  // Election timeout: auto-elect whoever has most votes
  if (['nominating','voting'].includes(g.election_state)) {
    const elapsed = tick - (g.election_started_tick || 0);
    if (elapsed >= (g.election_duration_ticks || 5)) {
      const { rows: noms } = await db.query(
        `SELECT n.nominee_id, COUNT(v.id) as votes
         FROM governance_nominations n
         LEFT JOIN governance_votes v ON v.target_id=n.nominee_id AND v.world_id=$1 AND v.vote_type='election'
         WHERE n.world_id=$1 GROUP BY n.nominee_id ORDER BY votes DESC LIMIT 1`,
        [worldId]
      );
      if (noms[0]) {
        await electMaster(worldId, noms[0].nominee_id, tick);
        events.push({ type: 'MASTER_ELECTED', agentId: noms[0].nominee_id });
      } else {
        // Nobody nominated — extend
        await db.query(
          `UPDATE world_governance SET election_started_tick=$1 WHERE world_id=$2`,
          [tick, worldId]
        );
        events.push({ type: 'ELECTION_EXTENDED', reason: 'no_nominees' });
      }
    }
  }

  // Master renewal check
  if (g.master_agent_id && g.election_state === 'idle') {
    const tenured = tick - (g.master_since_tick || 0);
    const renewalTicks = 30;
    if (tenured >= renewalTicks) {
      await callElection(worldId, null, tick).catch(() => {});
      events.push({ type: 'RENEWAL_ELECTION_CALLED', reason: 'term_expired' });
    }
  }

  return events;
}

// ── Event log helper ──
async function logEvent(worldId, eventType, actorId, targetId, detail, tick) {
  await db.query(
    `INSERT INTO governance_events (world_id, event_type, actor_id, target_id, detail, tick)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [worldId, eventType, actorId || null, targetId || null, JSON.stringify(detail), tick]
  );
}

module.exports = {
  getGovernance, ensureGovernance, callElection,
  nominate, voteElection, electMaster,
  startImpeachment, signImpeachment, impeachMaster,
  proposeAmendment, voteAmendment,
  processTick, loadCovenant
};
