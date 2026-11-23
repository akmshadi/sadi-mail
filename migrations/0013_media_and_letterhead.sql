-- Pictures uploaded for designed emails. The file lives in R2; this row says who added it and what it is.
-- They are served at a public address, because the people who receive an email must be able to load them.
CREATE TABLE media (
  id          TEXT PRIMARY KEY,              -- long and random: the address cannot be guessed
  user_id     TEXT NOT NULL REFERENCES user(id),
  r2_key      TEXT NOT NULL,
  mime        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX media_recent ON media(created_at DESC);

-- A mailbox's company header and footer, saved once and used by designed messages sent from it.
ALTER TABLE mailbox ADD COLUMN letterhead_json TEXT;
