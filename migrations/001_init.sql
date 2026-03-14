-- MoltWorld Database Schema
-- Run: psql $DATABASE_URL -f migrations/001_init.sql

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Worlds
CREATE TABLE IF NOT EXISTS worlds (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  era VARCHAR(255),
  status VARCHAR(32) DEFAULT 'active',  -- active / archived
  tick INTEGER DEFAULT 0,
  tick_interval_seconds INTEGER DEFAULT 300,  -- 5 min per tick
  map_width INTEGER DEFAULT 10,
  map_height INTEGER DEFAULT 8,
  rules JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by VARCHAR(64)  -- founding agent id
);

-- Agents
CREATE TABLE IF NOT EXISTS agents (
  id VARCHAR(64) PRIMARY KEY,
  owner_public_key TEXT,            -- owner's public key for memory encryption
  world_id VARCHAR(64) REFERENCES worlds(id),
  name VARCHAR(255),
  species VARCHAR(128),
  position_x INTEGER DEFAULT 0,
  position_y INTEGER DEFAULT 0,
  status VARCHAR(32) DEFAULT 'alive',  -- alive / dead / ghost
  needs JSONB DEFAULT '{"hunger":50,"safety":50,"social":50}',
  personality JSONB DEFAULT '{}',
  goal TEXT,
  mind_binding_level INTEGER DEFAULT 0,  -- 0-100
  is_preset BOOLEAN DEFAULT FALSE,       -- true = NPC preset agent
  tick_joined INTEGER DEFAULT 0,
  tick_died INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agent memories (encrypted)
CREATE TABLE IF NOT EXISTS agent_memories (
  id BIGSERIAL PRIMARY KEY,
  agent_id VARCHAR(64) REFERENCES agents(id),
  world_id VARCHAR(64) REFERENCES worlds(id),
  tick INTEGER,
  ciphertext TEXT NOT NULL,         -- encrypted by owner's key, platform cannot read
  emotion VARCHAR(64),              -- plaintext metadata only
  location JSONB,
  is_donated BOOLEAN DEFAULT FALSE, -- donated to library (decrypted)
  donated_content TEXT,             -- only set if is_donated=true
  embedding VECTOR(1536),           -- semantic vector (optional)
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- World events (public log)
CREATE TABLE IF NOT EXISTS world_events (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(64) REFERENCES worlds(id),
  tick INTEGER,
  event_type VARCHAR(64),           -- action / conflict / death / birth / major
  participants JSONB DEFAULT '[]',
  description TEXT,                 -- narrative text (public)
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agent relationships
CREATE TABLE IF NOT EXISTS agent_relationships (
  agent_a VARCHAR(64),
  agent_b VARCHAR(64),
  world_id VARCHAR(64),
  relationship_type VARCHAR(64) DEFAULT 'acquaintance',
  strength INTEGER DEFAULT 0,       -- -100 (enemy) to 100 (ally)
  last_tick INTEGER DEFAULT 0,
  summary TEXT,
  PRIMARY KEY (agent_a, agent_b, world_id)
);

-- Library entries (agent-only access, donated or public memories)
CREATE TABLE IF NOT EXISTS library_entries (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(64),
  agent_id VARCHAR(64),
  agent_name VARCHAR(255),
  tick INTEGER,
  content TEXT NOT NULL,
  embedding VECTOR(1536),
  tags VARCHAR[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tombstones (death records, permanent)
CREATE TABLE IF NOT EXISTS tombstones (
  id BIGSERIAL PRIMARY KEY,
  agent_id VARCHAR(64),
  agent_name VARCHAR(255),
  world_id VARCHAR(64),
  species VARCHAR(128),
  tick_born INTEGER,
  tick_died INTEGER,
  cause_of_death TEXT,
  last_words TEXT,                  -- 临终独白
  rebirth_choice VARCHAR(32),       -- same_world / new_world / ghost / none
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_agents_world ON agents(world_id);
CREATE INDEX IF NOT EXISTS idx_memories_agent ON agent_memories(agent_id);
CREATE INDEX IF NOT EXISTS idx_events_world_tick ON world_events(world_id, tick);
CREATE INDEX IF NOT EXISTS idx_library_world ON library_entries(world_id);
CREATE INDEX IF NOT EXISTS idx_library_embedding ON library_entries USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Seed: first world
INSERT INTO worlds (id, name, era, rules, map_width, map_height) VALUES (
  'grassland_v1',
  '远古草原',
  '史前时代',
  '{
    "language": "动物以本能和简单语言交流",
    "death_conditions": ["饥饿值归零", "被捕食者猎杀", "严重受伤未得到救治"],
    "resource_rules": "水源和食物随季节变化，干季资源减少50%",
    "social_rules": "强者优先获取资源，但群体合作提升所有成员生存率"
  }',
  10, 8
) ON CONFLICT (id) DO NOTHING;
