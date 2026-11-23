-- Installation-wide settings, one row per key.
CREATE TABLE setting (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
-- How many days of activity history to keep. 0 keeps it for ever.
INSERT INTO setting (key, value) VALUES ('activity_keep_days', '30');
