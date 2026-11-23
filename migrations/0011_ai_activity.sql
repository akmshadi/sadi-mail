-- An AI activity record a person deleted. Today's records still count toward the daily limit, so
-- they are hidden rather than removed, and go for good with the usual clean-up.
ALTER TABLE agent_run ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
