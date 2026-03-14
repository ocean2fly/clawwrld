/**
 * community.js — Agent-formed communities with their own covenants
 *
 * World Covenant = immutable (set by creator)
 * Community Covenant = authored by agents, amendable, but bounded by world covenant
 */

const db = require('./db');
const { loadCovenant } = require('./governance');

// Default community covenant template — agents fill this in
const DEFAULT_COMMUNITY_COVENANT = (communityName, worldId) => ({
  version: 1,
  type: 'community_covenant',
  immutable: false,
  community_name: communityName,
  world_id: worldId,
  preamble: 'We, the founding members of this community, establish these rules by our own will.',
  articles: [
    'All members are equal in voice within this community.',
    'The community Master serves at the will of the members.',
    'Any member may speak freely within community spaces.'
  ],
  permitted_capabilities: [
    'move', 'speak', 'trade', 'vote', 'nominate',
    'petition', 'propose_amendment', 'challenge', 'donate_memory'
  ],
  restricted_capabilities: [],
  governance: {
    election_threshold: 0.51,
    impeachment_threshold: 0.60,
    amendment_threshold: 0.60,
    election_duration_ticks: 5,
    min_members_for_election: 2,
    membership: 'open'  // open | invite_only | approval_required
  }
});

// ── Validate community covenant against world covenant ──
function validateAgainstWorldCovenant(worldId, commCovenant) {
  const worldCovenant = loadCovenant(worldId);
  if (!worldCovenant) return { valid: true };

  const worldCapabilities = new Set(
    worldCovenant.agent_capabilities.capabilities.map(c => c.id)
  );

  // Check no capability granted beyond world covenant
  const invalid = (commCovenant.permitted_capabilities || []).filter(
    cap => !worldCapabilities.has(cap)
  );
  if (invalid.length > 0) {
    return {
      valid: false,
      error: `Community covenant grants capabilities not in world covenant: ${invalid.join(', ')}`
    };
  }

  // Check election threshold ≥ 50%
  const g = commCovenant.governance || {};
  if (g.election_threshold < 0.50) {
    return { valid: false, error: 'Election threshold must be ≥ 50% per world covenant' };
  }
  if (g.impeachment_threshold < 0.51) {
    return { valid: false, error: 'Impeachment threshold must be ≥ 51% per world covenant' };
  }

  return { valid: true };
}

// ── Form a new community ──
async function formCommunity(worldId, founderId, name, description, covenantOverrides = {}) {
  // Must have ≥ 2 founding members (founder + at least 1 co-founder)
  // For now, allow solo founding — co-founder can join immediately after
  const { rows: [founder] } = await db.query(
    `SELECT * FROM agents WHERE id=$1 AND world_id=$2 AND status='active'`,
    [founderId, worldId]
  );
  if (!founder) throw new Error('Founder agent not found or not active');

  // Build covenant
  const covenant = {
    ...DEFAULT_COMMUNITY_COVENANT(name, worldId),
    ...covenantOverrides,
    community_name: name,
    world_id: worldId
  };

  // Validate
  const validation = validateAgainstWorldCovenant(worldId, covenant);
  if (!validation.valid) throw new Error(validation.error);

  // Create community
  const { rows: [community] } = await db.query(
    `INSERT INTO communities (world_id, name, description, founder_id, master_id, master_since_tick, member_count)
     VALUES ($1,$2,$3,$4,$4,0,1) RETURNING *`,
    [worldId, name, description || '', founderId]
  );

  // Save covenant
  await db.query(
    `INSERT INTO community_covenants (community_id, version, content, authored_by, enacted_at_tick)
     VALUES ($1,1,$2,$3,0)`,
    [community.id, JSON.stringify(covenant), founderId]
  );

  // Add founder as member + master
  await db.query(
    `INSERT INTO community_members (community_id, agent_id, role) VALUES ($1,$2,'founder')`,
    [community.id, founderId]
  );

  await logEvent(community.id, worldId, 'COMMUNITY_FORMED', founderId, null, { name }, 0);
  return { community, covenant };
}

// ── Join a community ──
async function joinCommunity(communityId, agentId) {
  const { rows: [comm] } = await db.query(
    `SELECT * FROM communities WHERE id=$1 AND status='active'`, [communityId]
  );
  if (!comm) throw new Error('Community not found');

  const covenant = await getCurrentCovenant(communityId);
  const membership = covenant?.content?.governance?.membership || 'open';
  if (membership === 'invite_only') throw new Error('This community is invite-only');

  await db.query(
    `INSERT INTO community_members (community_id, agent_id, role)
     VALUES ($1,$2,'member')
     ON CONFLICT (community_id, agent_id) DO UPDATE SET left_at=NULL, role='member'`,
    [communityId, agentId]
  );
  await db.query(
    `UPDATE communities SET member_count=member_count+1, updated_at=NOW() WHERE id=$1`,
    [communityId]
  );
  await logEvent(communityId, comm.world_id, 'MEMBER_JOINED', agentId, null, {}, 0);
  return { ok: true };
}

// ── Leave a community ──
async function leaveCommunity(communityId, agentId) {
  const { rows: [comm] } = await db.query(
    `SELECT * FROM communities WHERE id=$1`, [communityId]
  );
  if (!comm) throw new Error('Community not found');

  await db.query(
    `UPDATE community_members SET left_at=NOW() WHERE community_id=$1 AND agent_id=$2`,
    [communityId, agentId]
  );
  await db.query(
    `UPDATE communities SET member_count=GREATEST(0,member_count-1), updated_at=NOW() WHERE id=$1`,
    [communityId]
  );

  // If master leaves, trigger election
  if (comm.master_id === agentId) {
    await callCommunityElection(communityId, null, 0);
  }

  await logEvent(communityId, comm.world_id, 'MEMBER_LEFT', agentId, null, {}, 0);
  return { ok: true };
}

// ── Get current covenant ──
async function getCurrentCovenant(communityId) {
  const { rows: [c] } = await db.query(
    `SELECT * FROM community_covenants WHERE community_id=$1 AND is_current=TRUE ORDER BY version DESC LIMIT 1`,
    [communityId]
  );
  return c;
}

// ── Propose amendment to community covenant ──
async function proposeAmendment(communityId, proposerId, articleIndex, newText) {
  const { rows: [comm] } = await db.query(
    `SELECT * FROM communities WHERE id=$1`, [communityId]
  );
  // Check proposer is a member
  const { rows: [member] } = await db.query(
    `SELECT * FROM community_members WHERE community_id=$1 AND agent_id=$2 AND left_at IS NULL`,
    [communityId, proposerId]
  );
  if (!member) throw new Error('Only community members can propose amendments');

  const { rows: [am] } = await db.query(
    `INSERT INTO community_votes (community_id, voter_id, vote_type, amendment_id, support)
     VALUES ($1,$2,'covenant_amendment',NULL,TRUE) RETURNING *`,
    [communityId, proposerId]
  );

  // Store amendment in community_events as pending
  await logEvent(communityId, comm.world_id, 'AMENDMENT_PROPOSED', proposerId, null,
    { article_index: articleIndex, new_text: newText, amendment_id: am.id }, 0);

  return { ok: true, amendment_id: am.id, article_index: articleIndex, text: newText };
}

// ── Community election ──
async function callCommunityElection(communityId, callerId, tick) {
  await db.query(
    `UPDATE communities SET election_state='nominating', election_started_tick=$1, updated_at=NOW()
     WHERE id=$2 AND election_state='idle'`,
    [tick, communityId]
  );
  const { rows: [comm] } = await db.query(`SELECT world_id FROM communities WHERE id=$1`, [communityId]);
  await logEvent(communityId, comm?.world_id, 'ELECTION_CALLED', callerId, null, { tick }, tick);
}

// ── Vote in community election ──
async function voteCommunityElection(communityId, voterId, targetId) {
  await db.query(
    `INSERT INTO community_votes (community_id, voter_id, vote_type, target_id)
     VALUES ($1,$2,'election',$3)
     ON CONFLICT (community_id, voter_id, vote_type) DO UPDATE SET target_id=$3`,
    [communityId, voterId, targetId]
  );

  const { rows: comm } = await db.query(`SELECT *, (SELECT COUNT(*) FROM community_members WHERE community_id=$1 AND left_at IS NULL) as members FROM communities WHERE id=$1`, [communityId]);
  const { rows: votes } = await db.query(
    `SELECT target_id, COUNT(*) as votes FROM community_votes WHERE community_id=$1 AND vote_type='election' GROUP BY target_id ORDER BY votes DESC LIMIT 1`,
    [communityId]
  );

  if (votes[0]) {
    const threshold = comm[0].content?.governance?.election_threshold || 0.51;
    if (parseInt(votes[0].votes) / parseInt(comm[0].members) >= threshold) {
      await electCommunityMaster(communityId, votes[0].target_id, 0);
    }
  }
  return { ok: true };
}

// ── Elect community master ──
async function electCommunityMaster(communityId, agentId, tick) {
  await db.query(
    `UPDATE communities SET master_id=$1, master_since_tick=$2, election_state='idle', updated_at=NOW() WHERE id=$3`,
    [agentId, tick, communityId]
  );
  await db.query(`DELETE FROM community_votes WHERE community_id=$1 AND vote_type='election'`, [communityId]);
  const { rows: [c] } = await db.query(`SELECT world_id FROM communities WHERE id=$1`, [communityId]);
  await logEvent(communityId, c.world_id, 'MASTER_ELECTED', agentId, null, { tick }, tick);
}

// ── Impeach community master ──
async function impeachCommunityMaster(communityId, petitionerId) {
  const { rows: [comm] } = await db.query(`SELECT * FROM communities WHERE id=$1`, [communityId]);
  if (!comm?.master_id) throw new Error('No master to impeach');

  await db.query(
    `INSERT INTO community_votes (community_id, voter_id, vote_type, target_id)
     VALUES ($1,$2,'impeachment',$3) ON CONFLICT DO NOTHING`,
    [communityId, petitionerId, comm.master_id]
  );

  const { rows: sigs } = await db.query(
    `SELECT COUNT(*) as c FROM community_votes WHERE community_id=$1 AND vote_type='impeachment'`, [communityId]
  );
  const { rows: members } = await db.query(
    `SELECT COUNT(*) as c FROM community_members WHERE community_id=$1 AND left_at IS NULL`, [communityId]
  );
  const threshold = 0.60;
  const ratio = parseInt(sigs[0].c) / parseInt(members[0].c);

  if (ratio >= threshold) {
    await db.query(
      `UPDATE communities SET master_id=NULL, election_state='nominating', updated_at=NOW() WHERE id=$1`,
      [communityId]
    );
    await db.query(`DELETE FROM community_votes WHERE community_id=$1 AND vote_type='impeachment'`, [communityId]);
    await logEvent(communityId, comm.world_id, 'MASTER_IMPEACHED', petitionerId, comm.master_id, {}, 0);
  }

  return { signatures: parseInt(sigs[0].c), required: Math.ceil(parseInt(members[0].c) * threshold) };
}

// ── Get community info ──
async function getCommunity(communityId) {
  const { rows: [comm] } = await db.query(
    `SELECT c.*, 
       a.name as master_name, a.species as master_species,
       f.name as founder_name
     FROM communities c
     LEFT JOIN agents a ON a.id = c.master_id
     LEFT JOIN agents f ON f.id = c.founder_id
     WHERE c.id=$1`,
    [communityId]
  );
  if (!comm) return null;

  const covenant = await getCurrentCovenant(communityId);
  const { rows: members } = await db.query(
    `SELECT cm.role, a.id, a.name, a.species
     FROM community_members cm JOIN agents a ON a.id=cm.agent_id
     WHERE cm.community_id=$1 AND cm.left_at IS NULL`,
    [communityId]
  );
  const { rows: events } = await db.query(
    `SELECT * FROM community_events WHERE community_id=$1 ORDER BY created_at DESC LIMIT 10`,
    [communityId]
  );

  return { ...comm, covenant: covenant?.content, members, recent_events: events };
}

// ── List communities in a world ──
async function listCommunities(worldId) {
  const { rows } = await db.query(
    `SELECT c.id, c.name, c.description, c.member_count, c.status,
       a.name as master_name, c.master_id,
       (SELECT version FROM community_covenants WHERE community_id=c.id AND is_current=TRUE LIMIT 1) as covenant_version
     FROM communities c
     LEFT JOIN agents a ON a.id=c.master_id
     WHERE c.world_id=$1 AND c.status='active'
     ORDER BY c.member_count DESC`,
    [worldId]
  );
  return rows;
}

// ── Log helper ──
async function logEvent(communityId, worldId, eventType, actorId, targetId, detail, tick) {
  await db.query(
    `INSERT INTO community_events (community_id, world_id, event_type, actor_id, target_id, detail, tick)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [communityId, worldId, eventType, actorId || null, targetId || null, JSON.stringify(detail), tick]
  );
}

module.exports = {
  formCommunity, joinCommunity, leaveCommunity,
  callCommunityElection, voteCommunityElection, electCommunityMaster,
  impeachCommunityMaster, proposeAmendment,
  getCommunity, listCommunities, getCurrentCovenant,
  validateAgainstWorldCovenant, DEFAULT_COMMUNITY_COVENANT
};
