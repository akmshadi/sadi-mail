# Setting Up Sadi Mail On Cloudflare

Everything runs on your own Cloudflare account. You need a Cloudflare account, a domain on it if you want to receive mail through Cloudflare, Node 22 and pnpm.

## 1. Install

```bash
pnpm install
```

```bash
npx wrangler login
```

```bash
pnpm run setup
```

Use `pnpm run setup`, not `pnpm setup`: pnpm has its own command called `setup`. `pnpm cloudflare` runs the same script.

Setup does this, asking before each change:

1. Checks your Node version and Cloudflare login.
2. Finds or creates the D1 database `sadi-mail` and writes its id into `wrangler.jsonc` in your copy.
3. Finds or creates the R2 bucket `sadi-mail`.
4. Applies the database migrations.
5. Sets the `MAIL_SECRET_KEY` Worker secret to a random value if it is not set. You never see it.
6. Asks for your Cloudflare Access team domain and application AUD and sets `AUTH_MODE` to `access`.
7. Builds the interface and deploys the Worker.

To see what it would do without running anything or logging in:

```bash
pnpm run setup --dry-run
```

`--yes` skips the questions. `--team-domain` and `--aud` answer the sign-in questions.

A database id is not a secret, but if your copy is a public fork you may prefer to keep your own settings in a file named `wrangler.<anything>.jsonc`, which git ignores, and deploy with `npx wrangler deploy -c wrangler.<anything>.jsonc`.

## 2. Sign-In

Sadi Mail never deploys in `dev` mode, because anyone could then open the mailbox. Choose one:

- **Cloudflare Access.** In Zero Trust, create an Access application for your Worker's address and allow the people who may open it. Give setup the team domain (`yourname.cloudflareaccess.com`) and the application's AUD tag.
- **Your own application.** Leave Access out and let your application sign people in. See [embedding.md](embedding.md).

The first person to sign in becomes the owner. Everyone after that sees no mailbox until an owner or admin grants one.

## 3. Receiving Mail

Choose either or both, per address.

**Through Cloudflare.** In your domain's Email Routing settings, add a rule for an address, or the catch-all, that sends to the Worker `sadi-mail`. Email Routing needs Cloudflare's MX records, so that domain cannot also receive mail at another provider. Setup never touches your DNS.

**From another mail server.** In Settings › Mail System › Other Mail Servers, add the account's IMAP server. Sadi Mail checks it every minute and brings in mail that arrives after you connect. It only reads: nothing on the other server is marked, moved or deleted. Bring older mail in with `pnpm import-mail --help`.

## 4. Sending Mail

Until you choose a way to send, Sadi Mail is in **dry run**: a sent message is saved in Sent and nothing leaves.

**Through Cloudflare Email Sending.** Onboard your sending domain in the Cloudflare dashboard, then in `wrangler.jsonc` set `"SEND_MODE": "cloudflare"` and add `"send_email": [{ "name": "EMAIL" }]`, and deploy again.

**Through your own SMTP server.** In Other Mail Servers, add the SMTP server for an address and switch on Send Through It. Mail from that address then really leaves through that server, whatever `SEND_MODE` says. Cloudflare does not allow connections on port 25: use 465 (TLS) or 587 (STARTTLS).

## 5. Pictures In Email

Pictures uploaded for designed email are served at `/media/…` with no sign-in, because the people who receive your email have to be able to load them. Each address is 32 random characters, so it cannot be guessed.

**If your installation is behind Cloudflare Access,** add an Access rule that bypasses the path `/media/` on your Worker's address. Without it, recipients see broken pictures.

## 6. AI (Optional)

- **Cloudflare Workers AI:** uncomment the `ai` line in `wrangler.jsonc` and deploy. Mail text then stays on Cloudflare. It is billed to your account by use.
- **Your own provider:** in Settings › AI And Agents, add an Anthropic, OpenAI or OpenAI-compatible key, with any model name. Keys are encrypted with `MAIL_SECRET_KEY`.

`AI_DAILY_LIMIT` caps the number of model calls a day.

## 7. Updating

Pull the new version, then:

```bash
npx wrangler d1 migrations apply sadi-mail --remote
```

```bash
pnpm build:client
```

```bash
npx wrangler deploy
```
