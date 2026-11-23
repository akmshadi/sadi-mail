-- Senders a person has blocked (marked as spam) or cleared (marked not spam).
CREATE TABLE sender_rule (
  email       TEXT PRIMARY KEY,
  verdict     TEXT NOT NULL CHECK (verdict IN ('block', 'allow')),
  created_at  INTEGER NOT NULL
);

-- When a conversation went to Spam or Trash, so it can be removed for good 30 days later.
ALTER TABLE thread ADD COLUMN moved_at INTEGER;
CREATE INDEX thread_moved ON thread(folder, moved_at);
