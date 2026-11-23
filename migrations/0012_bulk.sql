-- A bulk send: one message written once and delivered to many people, each as their own separate
-- email. The timer works through the list a few at a time, so a long list never floods the sender.
CREATE TABLE bulk_job (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES user(id),
  from_address_id  TEXT NOT NULL REFERENCES address(id),
  subject          TEXT NOT NULL,
  body_text        TEXT NOT NULL,
  body_html        TEXT,
  recipients_json  TEXT NOT NULL,
  total            INTEGER NOT NULL,
  next_index       INTEGER NOT NULL DEFAULT 0,
  sent             INTEGER NOT NULL DEFAULT 0,
  failed           INTEGER NOT NULL DEFAULT 0,
  per_minute       INTEGER NOT NULL DEFAULT 10,
  status           TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','cancelled')),
  start_at         INTEGER NOT NULL,
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  finished_at      INTEGER
);
CREATE INDEX bulk_running ON bulk_job(status, start_at);
