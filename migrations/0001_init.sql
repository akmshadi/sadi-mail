-- Sadi Mail v0.1 schema. R2 holds every raw message; these tables are an index that can be rebuilt from it.

-- People who can sign in, and what each may do.
CREATE TABLE user (
  id          TEXT PRIMARY KEY,
  subject     TEXT NOT NULL UNIQUE,          -- identity from Access, a host token, or "dev"
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member','viewer')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at  INTEGER NOT NULL
);

-- A mailbox is a group of addresses that share one inbox (a brand, a company, a person).
CREATE TABLE mailbox (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#4F46E5',
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE domain (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  mailbox_id  TEXT NOT NULL REFERENCES mailbox(id),
  catch_all   INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

CREATE TABLE address (
  id            TEXT PRIMARY KEY,
  mailbox_id    TEXT NOT NULL REFERENCES mailbox(id),
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL DEFAULT '',
  signature     TEXT NOT NULL DEFAULT '',
  is_default    INTEGER NOT NULL DEFAULT 0,
  discovered    INTEGER NOT NULL DEFAULT 0,   -- created automatically when mail first arrived for it
  created_at    INTEGER NOT NULL
);
CREATE INDEX address_mailbox ON address(mailbox_id);

-- Per-user grants on a mailbox. Owners and admins see every mailbox without a row here.
CREATE TABLE mailbox_grant (
  user_id     TEXT NOT NULL REFERENCES user(id),
  mailbox_id  TEXT NOT NULL REFERENCES mailbox(id),
  can_read    INTEGER NOT NULL DEFAULT 1,
  can_send    INTEGER NOT NULL DEFAULT 0,
  can_edit    INTEGER NOT NULL DEFAULT 0,     -- archive, label, mark read
  can_delete  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, mailbox_id)
);

CREATE TABLE thread (
  id              TEXT PRIMARY KEY,
  mailbox_id      TEXT NOT NULL REFERENCES mailbox(id),
  address_id      TEXT NOT NULL REFERENCES address(id),   -- the address this conversation arrived at or left from
  subject         TEXT NOT NULL,
  folder          TEXT NOT NULL DEFAULT 'inbox' CHECK (folder IN ('inbox','archive','spam','trash')),
  last_at         INTEGER NOT NULL,
  last_from_name  TEXT NOT NULL DEFAULT '',
  last_from_email TEXT NOT NULL DEFAULT '',
  snippet         TEXT NOT NULL DEFAULT '',
  message_count   INTEGER NOT NULL DEFAULT 0,
  unread_count    INTEGER NOT NULL DEFAULT 0,
  has_attachment  INTEGER NOT NULL DEFAULT 0,
  has_inbound     INTEGER NOT NULL DEFAULT 0,
  has_outbound    INTEGER NOT NULL DEFAULT 0,
  starred         INTEGER NOT NULL DEFAULT 0,
  flagged_auth    INTEGER NOT NULL DEFAULT 0,             -- a message in it failed DMARC
  is_bulk         INTEGER NOT NULL DEFAULT 0,             -- newsletter or automated mail; never "waiting on you"
  snoozed_until   INTEGER
);
CREATE INDEX thread_list ON thread(mailbox_id, folder, last_at DESC);
CREATE INDEX thread_recent ON thread(folder, last_at DESC);

CREATE TABLE message (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL REFERENCES thread(id),
  mailbox_id    TEXT NOT NULL REFERENCES mailbox(id),
  address_id    TEXT NOT NULL REFERENCES address(id),
  direction     TEXT NOT NULL CHECK (direction IN ('in','out')),
  status        TEXT NOT NULL CHECK (status IN ('received','draft','scheduled','sent','dry_run','failed')),
  message_id    TEXT,                          -- the Message-ID header
  in_reply_to   TEXT,
  refs          TEXT NOT NULL DEFAULT '',
  from_name     TEXT NOT NULL DEFAULT '',
  from_email    TEXT NOT NULL,
  to_json       TEXT NOT NULL DEFAULT '[]',
  cc_json       TEXT NOT NULL DEFAULT '[]',
  subject       TEXT NOT NULL DEFAULT '',
  snippet       TEXT NOT NULL DEFAULT '',
  body_text     TEXT NOT NULL DEFAULT '',      -- capped; the full message is always in R2
  body_html     TEXT,                          -- capped, stored as received; cleaned every time it is served
  body_truncated INTEGER NOT NULL DEFAULT 0,
  at            INTEGER NOT NULL,              -- received or sent time, ms
  scheduled_for INTEGER,
  size          INTEGER NOT NULL DEFAULT 0,
  raw_key       TEXT,                          -- R2 key of the raw .eml
  unread        INTEGER NOT NULL DEFAULT 0,
  spf           TEXT NOT NULL DEFAULT 'none',
  dkim          TEXT NOT NULL DEFAULT 'none',
  dmarc         TEXT NOT NULL DEFAULT 'none',
  created_by    TEXT REFERENCES user(id),
  error         TEXT
);
CREATE INDEX message_thread ON message(thread_id, at);
CREATE INDEX message_msgid ON message(mailbox_id, message_id);
CREATE INDEX message_due ON message(status, scheduled_for);

CREATE TABLE attachment (
  id          TEXT PRIMARY KEY,
  message_id  TEXT NOT NULL REFERENCES message(id),
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  content_id  TEXT,
  inline      INTEGER NOT NULL DEFAULT 0,
  r2_key      TEXT NOT NULL
);
CREATE INDEX attachment_message ON attachment(message_id);

-- What happened to a message on its way in or out (the Activity tab reads this).
CREATE TABLE message_event (
  id          TEXT PRIMARY KEY,
  message_id  TEXT NOT NULL,
  at          INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  ms          INTEGER
);
CREATE INDEX message_event_message ON message_event(message_id, at);

CREATE VIRTUAL TABLE message_fts USING fts5(subject, sender, recipients, body, tokenize = 'unicode61 remove_diacritics 2');

CREATE TABLE label (
  id TEXT PRIMARY KEY, mailbox_id TEXT REFERENCES mailbox(id), name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#64748B'
);
CREATE TABLE thread_label (
  thread_id TEXT NOT NULL REFERENCES thread(id), label_id TEXT NOT NULL REFERENCES label(id), PRIMARY KEY (thread_id, label_id)
);

CREATE TABLE template (
  id TEXT PRIMARY KEY, mailbox_id TEXT REFERENCES mailbox(id), name TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
);

-- AI providers a workspace has connected. Keys are never stored here: key_ref names a Worker secret.
CREATE TABLE ai_provider (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('workers-ai','anthropic','openai','openai-compatible')),
  name        TEXT NOT NULL,
  base_url    TEXT,
  model       TEXT NOT NULL,
  key_ref     TEXT,
  priority    INTEGER NOT NULL DEFAULT 100,   -- lowest runs first; Workers AI ships at 10
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

-- An agent is a named instruction set with a trigger and the actions it is allowed to take.
CREATE TABLE agent (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,                -- 'summarise','triage','draft-reply','follow-up','custom'
  instructions  TEXT NOT NULL DEFAULT '',
  trigger       TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual','on-receive','schedule')),
  schedule      TEXT,
  mailbox_id    TEXT REFERENCES mailbox(id),
  provider_id   TEXT REFERENCES ai_provider(id),
  may_draft     INTEGER NOT NULL DEFAULT 1,
  may_label     INTEGER NOT NULL DEFAULT 0,
  may_send      INTEGER NOT NULL DEFAULT 0,    -- off unless a person turns it on
  enabled       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE audit (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, user_id TEXT, action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX audit_at ON audit(at DESC);
