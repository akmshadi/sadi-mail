-- Inbox sections, as in Gmail: Primary, Social, Promotions, Updates, Forums.
ALTER TABLE thread ADD COLUMN section TEXT NOT NULL DEFAULT 'primary';
CREATE INDEX thread_section ON thread(mailbox_id, folder, section, last_at DESC);

-- Mail already known to be automated starts in Updates rather than Primary.
UPDATE thread SET section = 'updates' WHERE is_bulk = 1;

-- When a person moves a conversation to another section, later mail from that sender follows.
CREATE TABLE sender_section (
  email       TEXT PRIMARY KEY,
  section     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
