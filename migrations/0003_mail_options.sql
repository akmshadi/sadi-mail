-- Drafts remember what they answer and how they were opened, so they reopen exactly as left.
ALTER TABLE message ADD COLUMN reply_to_id TEXT;
ALTER TABLE message ADD COLUMN compose_mode TEXT;

CREATE INDEX thread_snoozed ON thread(snoozed_until);
CREATE INDEX thread_label_label ON thread_label(label_id);
CREATE UNIQUE INDEX label_name ON label(name);

-- Rules act on new mail as it arrives: label it, star it, mark it read, or move it.
CREATE TABLE rule (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  mailbox_id  TEXT REFERENCES mailbox(id),          -- null = every mailbox
  position    INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1,
  match_json  TEXT NOT NULL DEFAULT '{}',           -- { from?, to?, subject?, body?, hasAttachment? } : all given parts must match
  action_json TEXT NOT NULL DEFAULT '{}',           -- { labelId?, star?, markRead?, moveTo?: 'archive'|'spam'|'trash' }
  created_at  INTEGER NOT NULL
);
