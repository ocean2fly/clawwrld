-- ── Governance: Master election, impeachment, covenant ──

CREATE TABLE IF NOT EXISTS world_governance (
  world_id          TEXT PRIMARY KEY,
  master_agent_id   VARCHAR(64) REFERENCES agents(id) ON DELETE SET NULL,
  master_since_tick INTEGER DEFAULT 0,
  election_state    TEXT DEFAULT 'idle',
  election_started_tick INTEGER,
  election_duration_ticks INTEGER DEFAULT 5,
  impeachment_target_id VARCHAR(64) REFERENCES agents(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS governance_votes (
  id          SERIAL PRIMARY KEY,
  world_id    TEXT NOT NULL,
  voter_id    VARCHAR(64) NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  vote_type   TEXT NOT NULL,
  target_id   VARCHAR(64) REFERENCES agents(id) ON DELETE CASCADE,
  amendment_id INTEGER,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(world_id, voter_id, vote_type, target_id)
);

CREATE TABLE IF NOT EXISTS governance_nominations (
  id          SERIAL PRIMARY KEY,
  world_id    TEXT NOT NULL,
  nominee_id  VARCHAR(64) NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  nominator_id VARCHAR(64) NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(world_id, nominee_id)
);

CREATE TABLE IF NOT EXISTS covenant_amendments (
  id            SERIAL PRIMARY KEY,
  world_id      TEXT NOT NULL,
  proposer_id   VARCHAR(64) NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  article_index INTEGER,
  new_text      TEXT NOT NULL,
  state         TEXT DEFAULT 'voting',
  votes_for     INTEGER DEFAULT 0,
  votes_against INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS covenant_versions (
  id          SERIAL PRIMARY KEY,
  world_id    TEXT NOT NULL,
  version     INTEGER NOT NULL,
  content     JSONB NOT NULL,
  enacted_by  VARCHAR(64) REFERENCES agents(id),
  tick        INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS governance_events (
  id          SERIAL PRIMARY KEY,
  world_id    TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  actor_id    VARCHAR(64) REFERENCES agents(id),
  target_id   VARCHAR(64) REFERENCES agents(id),
  detail      JSONB,
  tick        INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO world_governance (world_id) VALUES ('grassland_v1') ON CONFLICT DO NOTHING;
