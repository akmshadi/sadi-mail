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

## Roles And Permissions

| Role | Can Do |
| --- | --- |
| Owner | Everything. The first person to sign in. Never changed by a token. |
| Admin | Every mailbox, people, settings, AI, mail servers. |
| Member | Only the mailboxes granted, with the permissions granted on each: read, send, edit, delete. |
| Viewer | Read only, in the mailboxes granted. |

Your application is the source of truth for who its people are: when a token names a role, Sadi Mail follows it on every sign-in. Which mailboxes a person may use is granted inside Sadi Mail (Settings › People, or `PATCH /api/users/:id` with `grants`). A person signed in by token sees no mailbox until one is granted.

A mailbox a person cannot read does not exist as far as they can tell: the API answers 404, not 403.
