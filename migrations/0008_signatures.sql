-- A designed signature: the fields a person filled in, and the ready-to-send HTML built from them.
ALTER TABLE address ADD COLUMN signature_json TEXT;
ALTER TABLE address ADD COLUMN signature_html TEXT;
