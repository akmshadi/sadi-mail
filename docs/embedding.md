# Using Sadi Mail Inside Your Own Application

Sadi Mail assumes nothing about your users. Your application says who the person is with a short-lived signed token, and Sadi Mail decides what that person may see from the roles and mailbox permissions set inside Sadi Mail.

## 1. Give Sadi Mail Your Public Key

Create an Ed25519 key pair in your application. Put the public key, as a JWK with a `kid`, in `HOST_PUBLIC_KEYS`, and your site's origin in `EMBED_ALLOWED_ORIGINS`. Sadi Mail never holds a secret of yours.

## 2. Sign A Token On Your Server

Sign one when a signed-in person opens mail. Never sign it in the browser.

```ts
import { SignJWT } from 'jose';

const token = await new SignJWT({ name: user.name, role: 'member' }) // role: admin | member | viewer
  .setProtectedHeader({ alg: 'EdDSA', kid: 'my-app-1' })
  .setIssuer('my-app')
  .setAudience('sadi-mail')
  .setSubject(user.id)
  .setIssuedAt()
  .setExpirationTime('5m')
  .sign(privateKey);
```

Tokens older than ten minutes are refused. `EdDSA` and `ES256` are accepted.

## 3. Show The Interface, Or Call The API

```html
<iframe src="https://mail.example.com/?theme=dark#token=TOKEN" title="Mail"></iframe>
```

```ts
const boot = await fetch('https://mail.example.com/api/bootstrap', {
  headers: { authorization: `Bearer ${token}` },
}).then((r) => r.json()); // mailboxes, addresses, unread counts
```

The token goes after `#`, so it is never sent to a server in the address or written to a log.

## 4. Theme It And Read The Unread Count

```ts
window.addEventListener('message', (e) => {
  if (e.data?.type === 'sadi-mail:unread') setBadge(e.data.count);
  if (e.data?.type === 'sadi-mail:ready') {
    frame.contentWindow.postMessage(
      { type: 'sadi-mail:theme', theme: 'dark', tokens: { '--accent': '#0ea5e9' } },
      'https://mail.example.com',
    );
  }
});
```

## 5. Renew The Token Without Reloading

A token lives a few minutes. Before it runs out, sign a new one and hand it to the frame; the page is not reloaded, so an open draft is kept.

```ts
window.addEventListener('message', (e) => {
  if (e.data?.type === 'sadi-mail:ready' && e.data.features?.includes('token-renewal')) canRenew = true;
});

frame.contentWindow.postMessage({ type: 'sadi-mail:token', token: freshToken }, 'https://mail.example.com');
```

## 6. Send Mail From Your Application

Your server can send as any address the token's person has Send on. The message goes out the installation's usual way and is kept in that address's Sent folder.

```ts
await fetch('https://mail.example.com/api/send', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    fromEmail: 'noreply@example.com',
    to: [{ name: '', email: 'customer@example.org' }],
    subject: 'Your receipt',
    text: 'Thank you.',
    html: '<p>Thank you.</p>',
    replyTo: 'support@example.com',
    headers: { 'List-Unsubscribe': '<https://example.com/u/1>' },
    attachments: [{ filename: 'receipt.pdf', mime: 'application/pdf', contentBase64: '…' }],
    idempotencyKey: 'receipt-42',
  }),
});
```

- `headers` accepts only `List-Unsubscribe`, `List-Unsubscribe-Post` and `X-*` names.
- `attachments`: at most 10 files and 10 MB together.
- `idempotencyKey`: sending the same key again returns the first result and sends nothing.
- The answer's `status` is `sent`, or `dry_run` when the installation is not set to send.

## Roles And Permissions

| Role | Can Do |
| --- | --- |
| Owner | Everything. The first person to sign in. Never changed by a token. |
| Admin | Every mailbox, people, settings, AI, mail servers. |
| Member | Only the mailboxes granted, with the permissions granted on each: read, send, edit, delete. |
| Viewer | Read only, in the mailboxes granted. |

Your application is the source of truth for who its people are: when a token names a role, Sadi Mail follows it on every sign-in. Which mailboxes a person may use is granted inside Sadi Mail (Settings › People, or `PATCH /api/users/:id` with `grants`). A person signed in by token sees no mailbox until one is granted.

A mailbox a person cannot read does not exist as far as they can tell: the API answers 404, not 403.
