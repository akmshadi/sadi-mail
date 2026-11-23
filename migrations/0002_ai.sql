-- AI providers, agents and their results.

-- A key added from the settings screen is stored encrypted (AES-GCM) with MAIL_SECRET_KEY, a Worker
-- secret that never reaches the database. Only the last four characters are kept in the clear.
ALTER TABLE ai_provider ADD COLUMN key_cipher TEXT;
ALTER TABLE ai_provider ADD COLUMN key_last4 TEXT;

ALTER TABLE agent ADD COLUMN builtin TEXT;                      -- 'brief' | 'reply' | 'follow-up' for ready-made agents
ALTER TABLE agent ADD COLUMN follow_up_days INTEGER NOT NULL DEFAULT 3;

ALTER TABLE thread ADD COLUMN ai_category TEXT;                 -- 'person' | 'update' | 'newsletter' | 'receipt' | 'promotion' | 'other'
ALTER TABLE thread ADD COLUMN ai_priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE thread ADD COLUMN follow_up INTEGER NOT NULL DEFAULT 0;  -- you wrote last and nobody answered

ALTER TABLE user ADD COLUMN avatar_key TEXT;                    -- R2 key of the person's picture

-- One brief per conversation, rebuilt when a newer message arrives.
CREATE TABLE ai_brief (
  thread_id     TEXT PRIMARY KEY REFERENCES thread(id),
  upto_message  TEXT NOT NULL,                                  -- newest message the brief covers
  summary       TEXT NOT NULL,
  actions_json  TEXT NOT NULL DEFAULT '[]',
  replies_json  TEXT NOT NULL DEFAULT '[]',
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  at            INTEGER NOT NULL
);

-- Every model call an agent or a person makes. This is the audit trail and the cost meter.
CREATE TABLE agent_run (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT REFERENCES agent(id),
  kind        TEXT NOT NULL,                                    -- 'brief' | 'reply' | 'custom' | 'rewrite' | 'write' | 'test'
  thread_id   TEXT,
  user_id     TEXT,                                             -- null when the agent ran by itself
  at          INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('ok','failed','skipped')),
  ms          INTEGER,
  provider    TEXT,
  model       TEXT,
  tokens_in   INTEGER,
  tokens_out  INTEGER,
  output      TEXT,
  error       TEXT
);
CREATE INDEX agent_run_at ON agent_run(at DESC);
CREATE INDEX agent_run_thread ON agent_run(thread_id, at DESC);
