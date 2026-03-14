-- ── Governance: Master election, impeachment, covenant ──

-- Current governance state per world
CREATE TABLE IF NOT EXISTS world_governance (
  world_id          TEXT PRIMARY KEY,
  master_agent_id   INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  master_since_tick INTEGER DEFAULT 0,
  election_state    TEXT DEFAULT 'idle',  -- idle | nominating | voting | impeachment
  election_started_tick INTEGER,
  election_duration_ticks INTEGER DEFAULT 5,
  impeachment_target_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Votes: elections and impeachments
CREATE TABLE IF NOT EXISTS governance_votes (
  id          SERIAL PRIMARY KEY,
  world_id    TEXT NOT NULL,
  voter_id    INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  vote_type   TEXT NOT NULL,  -- election | impeachment | covenant_amendment
  target_id   INTEGER REFERENCES agents(id) ON DELETE CASCADE,  -- who they vote FOR (election) or AGAINST (impeachment)
  amendment_id INTEGER,       -- for covenant votes
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(world_id, voter_id, vote_type, target_id)
);

-- Nominations (agents put themselves or others forward)
CREATE TABLE IF NOT EXISTS governance_nominations (
  id          SERIAL PRIMARY KEY,
  world_id    TEXT NOT NULL,
  nominee_id  INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  nominator_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(world_id, nominee_id)
);

-- Covenant amendments proposed by agents
CREATE TABLE IF NOT EXISTS covenant_amendments (
  id          SERIAL PRIMARY KEY,
  world_id    TEXT NOT NULL,
  proposer_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  article_index INTEGER,       -- which article to amend (null = new article)
  new_text    TEXT NOT NULL,
  state       TEXT DEFAULT 'voting',  -- voting | passed | rejected
  votes_for   INTEGER DEFAULT 0,
  votes_against INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

-- Covenant history (what the covenant looked like at each version)
CREATE TABLE IF NOT EXISTS covenant_versions (
  id          SERIAL PRIMARY KEY,
  world_id    TEXT NOT NULL,
  version     INTEGER NOT NULL,
  content     JSONB NOT NULL,
  enacted_by  INTEGER REFERENCES agents(id),  -- null = system/creator
  tick        INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Governance event log
CREATE TABLE IF NOT EXISTS governance_events (
  id          SERIAL PRIMARY KEY,
  world_id    TEXT NOT NULL,
  event_type  TEXT NOT NULL,  -- ELECTION_CALLED, VOTE_CAST, MASTER_ELECTED, IMPEACHMENT_STARTED, MASTER_IMPEACHED, COVENANT_AMENDED
  actor_id    INTEGER REFERENCES agents(id),
  target_id   INTEGER REFERENCES agents(id),
  detail      JSONB,
  tick        INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Initialize governance for existing worlds
INSERT INTO world_governance (world_id) VALUES ('grassland_v1') ON CONFLICT DO NOTHING;
