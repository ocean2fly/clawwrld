-- World renders: submitted by Renderer Agents, consumed by human Watch mode
CREATE TABLE IF NOT EXISTS world_renders (
  id          SERIAL PRIMARY KEY,
  world_id    TEXT NOT NULL,
  tick        INTEGER NOT NULL,
  renderer_id VARCHAR(64) REFERENCES agents(id),
  ascii_map   TEXT,
  narrative   TEXT,
  agent_count INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_world_renders_world ON world_renders(world_id, tick DESC);
