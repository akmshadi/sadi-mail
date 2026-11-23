# API

Every route is under `/api` and answers JSON. Sign in with `Authorization: Bearer <host token>`, or through Cloudflare Access. Errors look like `{ "error": "code", "message": "A sentence for a person." }`.

A mailbox you cannot read answers 404. Routes that change settings, people, AI or mail servers need the owner or admin role.

Pictures for email are the one thing served without sign-in, at `/media/<id>.<ext>` outside `/api`.

## Session And Status

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/activity` |  |
| GET | `/api/bootstrap` | Who you are, your mailboxes and addresses, unread counts, send mode |
| PATCH | `/api/settings` |  |
| GET | `/api/status` | What is connected, for the Mail System screen |

## Conversations

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/counts` |  |
| POST | `/api/folders/:folder/empty` |  |
| GET | `/api/search` | Search across every readable mailbox |
| GET | `/api/threads` | A page of conversations. Query: view, mailbox, address, section, label, after, before, from, files, cursor, limit |
| GET | `/api/threads/:id` | One conversation with its messages |
| POST | `/api/threads/:id/actions` | Read, unread, star, archive, inbox, trash, spam, not spam, snooze, section |
| GET | `/api/threads/:id/ai` |  |
| POST | `/api/threads/:id/ai/agents/:agentId` |  |
| POST | `/api/threads/:id/ai/brief` |  |
| POST | `/api/threads/:id/ai/reply` |  |
| POST | `/api/threads/:id/ai/reply/stream` |  |
| POST | `/api/threads/:id/delete-forever` |  |
| POST | `/api/threads/:id/labels` |  |

## Messages And Attachments

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/attachments/:id` |  |
| POST | `/api/messages/:id/cancel` |  |
| GET | `/api/messages/:id/raw` |  |

## Sending

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/bulk` |  |
| POST | `/api/bulk` | Start a bulk send |
| POST | `/api/bulk/:id/cancel` |  |
| POST | `/api/send` | Send, schedule, or send with undo |

## Drafts

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/drafts` |  |
| DELETE | `/api/drafts/:id` |  |
| GET | `/api/drafts/:id` |  |
| PUT | `/api/drafts/:id/attachments` |  |
| DELETE | `/api/drafts/:id/attachments/:fileId` |  |

## Labels, Rules, Templates, Contacts

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/contacts` |  |
| GET | `/api/labels` |  |
| POST | `/api/labels` |  |
| DELETE | `/api/labels/:id` |  |
| GET | `/api/rules` |  |
| POST | `/api/rules` |  |
| DELETE | `/api/rules/:id` |  |
| PATCH | `/api/rules/:id` |  |
| POST | `/api/rules/:id/run` |  |
| GET | `/api/templates` |  |
| POST | `/api/templates` |  |
| DELETE | `/api/templates/:id` |  |

## Addresses, Mailboxes, Mail Servers

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/addresses` |  |
| PATCH | `/api/addresses/:id` |  |
| GET | `/api/mail-servers` |  |
| POST | `/api/mail-servers` |  |
| DELETE | `/api/mail-servers/:id` |  |
| PATCH | `/api/mail-servers/:id` |  |
| POST | `/api/mail-servers/:id/check` |  |
| POST | `/api/mail-servers/:id/test` |  |
| PATCH | `/api/mailboxes/:id/letterhead` |  |

## People And Profile

| Method | Path | Notes |
| --- | --- | --- |
| DELETE | `/api/me/avatar` |  |
| PUT | `/api/me/avatar` |  |
| GET | `/api/me/profile` |  |
| PATCH | `/api/me/profile` |  |
| GET | `/api/users` |  |
| PATCH | `/api/users/:id` |  |
| GET | `/api/users/:id/avatar` |  |

## Pictures

| Method | Path | Notes |
| --- | --- | --- |
| PUT | `/api/media` | Upload a picture for email; returns its public address |
| DELETE | `/api/media/:id` |  |

## AI

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/ai` |  |
| POST | `/api/ai/agents` |  |
| DELETE | `/api/ai/agents/:id` |  |
| PATCH | `/api/ai/agents/:id` |  |
| POST | `/api/ai/providers` |  |
| DELETE | `/api/ai/providers/:id` |  |
| PATCH | `/api/ai/providers/:id` |  |
| POST | `/api/ai/providers/:id/test` |  |
| POST | `/api/ai/rewrite` |  |
| POST | `/api/ai/rewrite/stream` |  |
| DELETE | `/api/ai/runs` |  |
| GET | `/api/ai/runs` |  |
| DELETE | `/api/ai/runs/:id` |  |
| POST | `/api/ai/write` |  |
| POST | `/api/ai/write/stream` |  |

## Import

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/import/message` |  |
| GET | `/api/import/status` |  |

This list is generated from the route definitions in `src/worker`. The request and response shapes are the TypeScript types in `src/shared/types.ts`.
