# Configuration

Settings live in `wrangler.jsonc`. Secrets are set with `wrangler secret put` and never written to a file in the project. In local development, `pnpm dev` keeps a local secret in `.dev.vars`, which git ignores.

## Settings (`vars`)

| Name | Values | Meaning |
| --- | --- | --- |
| `SEND_MODE` | `dry-run` (default), `cloudflare` | `dry-run` saves a sent message and sends nothing. `cloudflare` uses Cloudflare Email Sending. An address with its own SMTP server switched on always sends through that server. |
| `AUTH_MODE` | `dev` (default), `access` | `dev` trusts requests to localhost only and is refused on a deployed Worker. `access` requires a Cloudflare Access token. |
| `ACCESS_TEAM_DOMAIN` | `yourname.cloudflareaccess.com` | Your Zero Trust team domain. |
| `ACCESS_AUD` | text | The Application Audience tag of your Access application. |
| `UNKNOWN_RECIPIENT` | `create` (default), `reject` | What to do with mail for an address not seen before, on a domain you have set up. |
| `HOST_PUBLIC_KEYS` | JSON array of public keys | Applications allowed to sign people in. See [embedding.md](embedding.md). |
| `EMBED_ALLOWED_ORIGINS` | comma-separated origins | Sites allowed to show Sadi Mail in a frame. Empty means none. |
| `AI_DAILY_LIMIT` | number (default `500`) | The most model calls in one day (UTC). |

## Secrets

| Name | Meaning |
| --- | --- |
| `MAIL_SECRET_KEY` | 32 random bytes, base64. Encrypts the AI provider keys and mail server passwords saved from the settings screen. If you change it, those have to be entered again. |

```bash
openssl rand -base64 32 | npx wrangler secret put MAIL_SECRET_KEY
```

## Bindings

| Binding | Service | Needed |
| --- | --- | --- |
| `DB` | D1 database | Always |
| `MAIL` | R2 bucket: raw messages, attachments, pictures | Always |
| `ASSETS` | The built interface | Always |
| `EMAIL` | Cloudflare Email Sending (`send_email`) | Only for `SEND_MODE` `cloudflare` |
| `AI` | Workers AI | Only for Workers AI |

A timer (`triggers.crons`) runs every minute. It sends scheduled mail, works through bulk sends, checks other mail servers, repairs anything stored but not indexed, and clears old Spam, Trash and activity.

## Settings Kept In The Database

Changed from the settings screens, not from files: people and their permissions, addresses and signatures, each mailbox's company header and footer, rules, labels, templates, AI providers and agents, other mail servers, and how long activity is kept.
