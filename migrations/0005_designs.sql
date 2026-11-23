-- Messages and templates built with the Email Design Builder keep their design, so they reopen as designs.
ALTER TABLE message ADD COLUMN design_json TEXT;
ALTER TABLE template ADD COLUMN design_json TEXT;
