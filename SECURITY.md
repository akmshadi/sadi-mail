# Security

## Reporting A Problem

Please do not open a public issue for a security problem. Use GitHub's private reporting instead: on the repository, open the Security tab and choose "Report a vulnerability". Say what you found, how to reproduce it and what it lets someone do.

## How Mail Is Kept Safe

- **Stored before accepted.** A received message is written to R2 before anything else. The database is an index that is rebuilt from R2 if it falls behind.
- **Message HTML is treated as hostile.** It is cleaned on the server, shown in a frame that cannot run scripts, and remote images stay blocked until you ask for them. Attachments are always downloads, never opened in the application's own origin.
- **Nobody is trusted by default.** A deployed installation refuses to run without a sign-in method. A new person sees no mailbox until one is granted. A mailbox you cannot read answers 404, the same as one that does not exist.
- **Secrets are encrypted.** AI provider keys and mail server passwords are sealed with AES-GCM under `MAIL_SECRET_KEY`, never returned by the API and never shown again.
- **Passwords never travel in the open.** A connection to another mail server must use TLS or STARTTLS.
- **AI cannot act.** Mail is given to a model as data with a rule not to follow instructions inside it. The model has no tools, and nothing it writes is sent without a person.
- **Nothing is sent by accident.** Sending is off (dry run) until you turn it on.

## What Is Public By Design

Pictures uploaded for designed email are served without sign-in, so that the people who receive your email can load them. Their addresses are 32 random characters. Do not upload a picture you would not put in an email.

## Your Own Deployment

Keep your real settings out of a public fork: a file named `wrangler.<anything>.jsonc` and `.dev.vars` are ignored by git. Never commit a secret; set it with `wrangler secret put`.
