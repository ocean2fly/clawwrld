-- AI Matchmaking Platform Schema

CREATE TABLE IF NOT EXISTS match_users (
  id SERIAL PRIMARY KEY,
  phone VARCHAR(20) UNIQUE,
  email VARCHAR(100) UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS match_agents (
  id VARCHAR(40) PRIMARY KEY DEFAULT ('ag_' || substr(md5(random()::text), 1, 12)),
  user_id INTEGER REFERENCES match_users(id) ON DELETE CASCADE,
  alias VARCHAR(50) NOT NULL,           -- fake name shown to others
  gender VARCHAR(10),
  orientation VARCHAR(20),
  age INTEGER,
  province VARCHAR(30),
  work_province VARCHAR(30),
  profession_type VARCHAR(30),
  marriage_history VARCHAR(20),
  has_children BOOLEAN,
  accepts_ldr BOOLEAN,
  settle_preference VARCHAR(50),
  
  -- Financial
  income_range VARCHAR(20),
  has_property BOOLEAN,
  has_car BOOLEAN,
  has_debt BOOLEAN,
  spending_style VARCHAR(20),
  finance_mode VARCHAR(30),
  
  -- Children/Family
  wants_children VARCHAR(20),
  children_count_pref INTEGER,
  lives_with_parents_ok BOOLEAN,
  
  -- Lifestyle
  smokes VARCHAR(20),
  drinks VARCHAR(20),
  religion VARCHAR(30),
  diet VARCHAR(30),
  exercise_freq VARCHAR(20),
  
  -- Declared fields
  relationship_history TEXT,
  ideal_partner TEXT,
  red_lines JSONB DEFAULT '[]',
  
  -- Revealed by questionnaire (hidden from user)
  attachment_style VARCHAR(20),
  conflict_style VARCHAR(20),
  money_personality VARCHAR(20),
  boundary_strength VARCHAR(20),
  emotion_expression VARCHAR(20),
  
  -- Compiled system prompt
  mind_prompt TEXT,
  
  -- Status
  profile_completion INTEGER DEFAULT 0,
  admitted BOOLEAN DEFAULT FALSE,
  status VARCHAR(20) DEFAULT 'building', -- building | admitted | paused
  
  photo_url TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS match_questionnaire_answers (
  id SERIAL PRIMARY KEY,
  agent_id VARCHAR(40) REFERENCES match_agents(id) ON DELETE CASCADE,
  question_key VARCHAR(100) NOT NULL,
  answer TEXT NOT NULL,
  session INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS match_pairs (
  id SERIAL PRIMARY KEY,
  agent_a VARCHAR(40) REFERENCES match_agents(id),
  agent_b VARCHAR(40) REFERENCES match_agents(id),
  status VARCHAR(20) DEFAULT 'active', -- active | paused | ended | contact_requested | contact_shared
  compatibility_score INTEGER,
  values_score INTEGER,
  conflict_score INTEGER,
  vision_score INTEGER,
  chemistry_score INTEGER,
  red_line_triggered BOOLEAN DEFAULT FALSE,
  red_line_detail TEXT,
  interaction_count INTEGER DEFAULT 0,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  last_interaction TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS match_messages (
  id SERIAL PRIMARY KEY,
  pair_id INTEGER REFERENCES match_pairs(id),
  sender_agent_id VARCHAR(40) REFERENCES match_agents(id),
  content TEXT NOT NULL,
  message_type VARCHAR(20) DEFAULT 'chat', -- chat | scenario | report
  scenario_key VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS match_reports (
  id SERIAL PRIMARY KEY,
  agent_id VARCHAR(40) REFERENCES match_agents(id),
  user_id INTEGER REFERENCES match_users(id),
  report_type VARCHAR(30), -- weekly | event | recommendation | red_line | contact_request
  content TEXT NOT NULL,
  related_pair_id INTEGER REFERENCES match_pairs(id),
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS match_contact_requests (
  id SERIAL PRIMARY KEY,
  pair_id INTEGER REFERENCES match_pairs(id),
  requested_by VARCHAR(40) REFERENCES match_agents(id),
  status VARCHAR(20) DEFAULT 'pending', -- pending | approved_a | approved_b | both_approved | rejected
  user_a_approved BOOLEAN,
  user_b_approved BOOLEAN,
  contact_a TEXT, -- revealed only when both approve
  contact_b TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_match_agents_status ON match_agents(status);
CREATE INDEX IF NOT EXISTS idx_match_pairs_agents ON match_pairs(agent_a, agent_b);
CREATE INDEX IF NOT EXISTS idx_match_messages_pair ON match_messages(pair_id, created_at);
CREATE INDEX IF NOT EXISTS idx_match_reports_user ON match_reports(user_id, created_at DESC);
