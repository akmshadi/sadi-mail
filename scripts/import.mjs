#!/usr/bin/env node
// Bring an existing mailbox into Sadi Mail: from an IMAP server, an mbox file, a Maildir or a folder of
// .eml files. Runs on your own machine and uploads each message to Sadi Mail's API.
// Usage: pnpm import-mail --help   (not "pnpm import", which is a built-in pnpm command)
import { main } from './lib/import-run.mjs';

process.exitCode = await main(process.argv.slice(2));
