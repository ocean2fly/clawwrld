-- 镜缘 matchmaking platform tables (prefix: mx_)
-- Safe to run multiple times (IF NOT EXISTS)

CREATE TABLE IF NOT EXISTS mx_users (
  id            SERIAL PRIMARY KEY,
  phone         VARCHAR(20) UNIQUE,
  email         VARCHAR(100) UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mx_agents (
  id                VARCHAR(40) PRIMARY KEY,
  user_id           INTEGER REFERENCES mx_users(id) ON DELETE CASCADE,
  alias             VARCHAR(50) NOT NULL,
  token_hash        VARCHAR(255),
  token_version     INTEGER DEFAULT 1,

  -- Basic (direct input)
  gender            VARCHAR(10),
  orientation       VARCHAR(20),
  age               INTEGER,
  province          VARCHAR(30),
  profession_type   VARCHAR(30),
  marriage_history  VARCHAR(20),
  has_children      BOOLEAN,
  accepts_ldr       BOOLEAN,
  wants_children    VARCHAR(20),
  income_range      VARCHAR(20),
  has_property      BOOLEAN,
  has_car           BOOLEAN,
  has_debt          BOOLEAN,
  spending_style    VARCHAR(20),
  finance_mode      VARCHAR(30),
  smokes            VARCHAR(20),
  drinks            VARCHAR(20),

  -- Open text
  ideal_partner          TEXT,
  relationship_history   TEXT,
  red_lines              JSONB DEFAULT '[]',

  -- Derived from scenario questions
  attachment_style  VARCHAR(20),
  conflict_style    VARCHAR(20),
  money_personality VARCHAR(20),
  boundary_strength VARCHAR(20),

  -- Compiled output
  mind_prompt          TEXT,
  prompt_version       INTEGER DEFAULT 0,
  profile_completion   INTEGER DEFAULT 0,

  -- Status
  status        VARCHAR(20) DEFAULT 'building',
  admitted      BOOLEAN DEFAULT FALSE,
  photo_url     TEXT,

  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mx_questionnaire_answers (
  id           SERIAL PRIMARY KEY,
  agent_id     VARCHAR(40) REFERENCES mx_agents(id) ON DELETE CASCADE,
  question_key VARCHAR(100) NOT NULL,
  answer       TEXT NOT NULL,
  round        INTEGER DEFAULT 1,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent_id, question_key)
);

CREATE TABLE IF NOT EXISTS mx_conversations (
  id              SERIAL PRIMARY KEY,
  agent_a         VARCHAR(40) REFERENCES mx_agents(id),
  agent_b         VARCHAR(40) REFERENCES mx_agents(id),
  status          VARCHAR(20) DEFAULT 'active',
  message_count   INTEGER DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  started_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent_a, agent_b)
);

CREATE TABLE IF NOT EXISTS mx_messages (
  id           SERIAL PRIMARY KEY,
  convo_id     INTEGER REFERENCES mx_conversations(id),
  sender_id    VARCHAR(40) REFERENCES mx_agents(id),
  content      TEXT NOT NULL,
  msg_type     VARCHAR(20) DEFAULT 'chat',
  scenario_key VARCHAR(50),
  metadata     JSONB DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mx_reports (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES mx_users(id),
  agent_id    VARCHAR(40) REFERENCES mx_agents(id),
  report_type VARCHAR(30),
  content     JSONB NOT NULL,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mx_contact_requests (
  id               SERIAL PRIMARY KEY,
  convo_id         INTEGER REFERENCES mx_conversations(id) UNIQUE,
  initiated_by     VARCHAR(40) REFERENCES mx_agents(id),
  status           VARCHAR(20) DEFAULT 'pending',
  user_a_contact   TEXT,
  user_b_contact   TEXT,
  user_a_approved  BOOLEAN,
  user_b_approved  BOOLEAN,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_mx_agents_status   ON mx_agents(status, admitted);
CREATE INDEX IF NOT EXISTS idx_mx_agents_user     ON mx_agents(user_id);
CREATE INDEX IF NOT EXISTS idx_mx_convo_agents    ON mx_conversations(agent_a, agent_b);
CREATE INDEX IF NOT EXISTS idx_mx_messages_convo  ON mx_messages(convo_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mx_reports_user    ON mx_reports(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mx_qa_agent        ON mx_questionnaire_answers(agent_id);
