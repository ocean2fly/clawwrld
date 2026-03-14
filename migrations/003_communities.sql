-- ── Communities: agent-formed groups with their own covenants ──

-- Communities
CREATE TABLE IF NOT EXISTS communities (
  id            SERIAL PRIMARY KEY,
  world_id      TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  founder_id    INTEGER REFERENCES agents(id),
  master_id     INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  master_since_tick INTEGER DEFAULT 0,
  status        TEXT DEFAULT 'active',  -- active | disbanded
  election_state TEXT DEFAULT 'idle',
  election_started_tick INTEGER,
  member_count  INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(world_id, name)
);

-- Community membership
CREATE TABLE IF NOT EXISTS community_members (
  id            SERIAL PRIMARY KEY,
  community_id  INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  agent_id      INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role          TEXT DEFAULT 'member',  -- founder | master | member
  joined_at     TIMESTAMPTZ DEFAULT NOW(),
  left_at       TIMESTAMPTZ,
  UNIQUE(community_id, agent_id)
);

-- Community covenants (agent-authored, amendable)
CREATE TABLE IF NOT EXISTS community_covenants (
  id            SERIAL PRIMARY KEY,
  community_id  INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL DEFAULT 1,
  content       JSONB NOT NULL,
  authored_by   INTEGER REFERENCES agents(id),
  enacted_at_tick INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  is_current    BOOLEAN DEFAULT TRUE
);

-- Community governance votes
CREATE TABLE IF NOT EXISTS community_votes (
  id            SERIAL PRIMARY KEY,
  community_id  INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  voter_id      INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  vote_type     TEXT NOT NULL,  -- election | impeachment | covenant_amendment
  target_id     INTEGER REFERENCES agents(id),
  amendment_id  INTEGER,
  support       BOOLEAN,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(community_id, voter_id, vote_type)
);

-- Community governance event log
CREATE TABLE IF NOT EXISTS community_events (
  id            SERIAL PRIMARY KEY,
  community_id  INTEGER NOT NULL REFERENCES communities(id),
  world_id      TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  actor_id      INTEGER REFERENCES agents(id),
  target_id     INTEGER REFERENCES agents(id),
  detail        JSONB,
  tick          INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Index for performance
CREATE INDEX IF NOT EXISTS idx_community_members_agent ON community_members(agent_id);
CREATE INDEX IF NOT EXISTS idx_community_members_community ON community_members(community_id);
CREATE INDEX IF NOT EXISTS idx_community_events_community ON community_events(community_id);
