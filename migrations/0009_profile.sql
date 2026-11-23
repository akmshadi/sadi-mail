-- A person's own information card: who they are and how they like to write. The AI reads it when it writes for them.
ALTER TABLE user ADD COLUMN profile_json TEXT;
