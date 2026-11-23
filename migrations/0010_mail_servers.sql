-- Mail servers outside Cloudflare, for people who bring their own: one row is one account on an
-- SMTP server (sending), an IMAP server (receiving), or both. The password is stored sealed.
CREATE TABLE mail_server (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  email            TEXT NOT NULL UNIQUE,          -- the address this account sends as and receives for
  username         TEXT NOT NULL,
  pass_cipher      TEXT NOT NULL,
  smtp_host        TEXT NOT NULL DEFAULT '',
  smtp_port        INTEGER NOT NULL DEFAULT 465,
  smtp_security    TEXT NOT NULL DEFAULT 'tls' CHECK (smtp_security IN ('tls','starttls','none')),
  imap_host        TEXT NOT NULL DEFAULT '',
  imap_port        INTEGER NOT NULL DEFAULT 993,
  imap_security    TEXT NOT NULL DEFAULT 'tls' CHECK (imap_security IN ('tls','starttls','none')),
  send_enabled     INTEGER NOT NULL DEFAULT 0,
  receive_enabled  INTEGER NOT NULL DEFAULT 0,
  imap_uidvalidity INTEGER,
  imap_last_uid    INTEGER,
  last_checked_at  INTEGER,
  last_received_at INTEGER,
  last_error       TEXT,
  created_at       INTEGER NOT NULL
);
