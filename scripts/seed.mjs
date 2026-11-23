#!/usr/bin/env node
// Sends sample mail into a local `wrangler dev` through the same door real mail uses:
// Cloudflare's local Email Routing endpoint. Nothing here touches a real mailbox.
//
//   pnpm seed                 → http://localhost:8787
//   SADI_MAIL_URL=http://localhost:8791 pnpm seed

const base = process.env.SADI_MAIL_URL ?? 'http://localhost:8787';
let n = 0;

function eml({ from, to, subject, text, html, id, replyTo, auth, pdf, list }) {
  const head = [
    ...(auth ? [`Authentication-Results: mx.cloudflare.net; ${auth}`] : ['Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass']),
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    `Message-ID: <${id ?? `seed-${++n}-${Date.now()}@sample.example`}>`,
    `Date: ${new Date().toUTCString()}`,
    ...(replyTo ? [`In-Reply-To: <${replyTo}>`, `References: <${replyTo}>`] : []),
    ...(list ? [`List-Unsubscribe: <${list}>`] : []),
    'MIME-Version: 1.0',
  ];
  if (pdf) {
    const b = 'sadi-mail-seed-boundary';
    return [...head, `Content-Type: multipart/mixed; boundary="${b}"`, '', `--${b}`, 'Content-Type: text/plain; charset=utf-8', '', text, `--${b}`,
      `Content-Type: application/pdf; name="${pdf}"`, `Content-Disposition: attachment; filename="${pdf}"`, 'Content-Transfer-Encoding: base64', '',
      Buffer.from('%PDF-1.4\n% Sample file created by the Sadi Mail seed script.\n').toString('base64'), `--${b}--`, ''].join('\r\n');
  }
  if (html) return [...head, 'Content-Type: text/html; charset=utf-8', '', html].join('\r\n');
  return [...head, 'Content-Type: text/plain; charset=utf-8', '', text].join('\r\n');
}

const mail = [
  { from: 'Priya Nair <priya@nairstudio.example>', to: 'studio@northwind.example', subject: 'Photos from Saturday’s shoot', pdf: 'Selects_Sat_contact_sheet.pdf',
    text: 'Hi!\n\n14 selects from Saturday are on the attached contact sheet. The full set is uploading tonight and I’ll send the link once it’s done.\n\nPriya' },
  { from: 'The Margin <issue@themargin.example>', to: 'hello@fieldwork.example', subject: 'Issue 112: Pricing for small studios', list: 'https://themargin.example/unsubscribe',
    html: '<div style="max-width:560px;margin:auto;font-family:Georgia,serif"><h1 style="font-size:26px">Pricing for small studios</h1><img src="https://images.themargin.example/issue-112/header.png" width="560" height="200" alt="Issue header"><p>This week: three ways small studios are moving away from hourly billing, and what changed when they did.</p><p>Plus: a reader question on retainers that cover maintenance, and a short list of tools for tracking scope.</p><p><a href="https://themargin.example/issues/112">Read on the web</a></p><img src="https://track.themargin.example/open.gif?u=123" width="1" height="1" alt=""></div>' },
  { from: 'Tomás Ortega <tomas@ortega.example>', to: 'me@tidewater.example', subject: 'Coffee next week?',
    text: 'Hey!\n\nI’m back in town from the 1st. Free for coffee Tuesday or Wednesday morning? The place by the canal again?\n\nT.' },
  { from: 'Aisha Rahman <aisha.rahman@halcyonlabs.example>', to: 'studio@northwind.example', subject: 'Contract draft — Q1 retainer', pdf: 'Halcyon_Q1_retainer_draft.pdf',
    text: 'Hi both,\n\nAttached is the draft agreement for the Q1 retainer. Our legal team flagged clause 7 (transfer of IP on final payment) — they would prefer transfer on delivery of each milestone.\n\nCould we discuss on Thursday? Any time after 14:00 works on my side.\n\nThanks,\nAisha' },
  { from: 'Payroll Team <hr-notice@fieldw0rk.example>', to: 'hello@fieldwork.example', subject: 'Action required: verify payroll details', auth: 'spf=fail; dkim=none; dmarc=fail',
    text: 'Dear team member,\n\nYour payroll details require verification before Friday to avoid a delay in payment. Please sign in through the secure portal below.\n\nhttps://fieldw0rk.example/verify' },
  { from: 'Lena Fischer <lena@kontur.example>', to: 'hello@fieldwork.example', subject: 'Homepage copy — final round', id: 'copy-1@kontur.example',
    text: 'Hi,\n\nFirst pass of the homepage copy is in the shared doc. Hero, three feature blocks and the footer line.\n\nLena' },
  { from: 'Lena Fischer <lena@kontur.example>', to: 'hello@fieldwork.example', subject: 'Re: Homepage copy — final round', id: 'copy-2@kontur.example', replyTo: 'copy-1@kontur.example',
    text: 'Second pass is up. I shortened the feature blocks to two lines each.\n\nLena' },
  { from: 'Lena Fischer <lena@kontur.example>', to: 'hello@fieldwork.example', subject: 'Re: Homepage copy — final round', replyTo: 'copy-2@kontur.example',
    text: 'Morning!\n\nI tightened the hero line and cut the second paragraph — it reads much faster now. Two questions before we lock it: are we still saying “for small studios”, and do you want the pricing link in the main navigation or only in the footer?\n\nIf I hear back today I can hand it to development tomorrow morning.\n\nLena' },
  { from: 'Vincent Moreau <vincent@moreauprint.example>', to: 'billing@fieldwork.example', subject: 'Invoice INV-2291 — November print run', pdf: 'INV-2291.pdf',
    text: 'Hi,\n\nPlease find attached the invoice for the November print run — 1,200 tri-fold brochures delivered to your studio on Monday. Payment terms are 14 days as usual, so it falls due on Friday 28 November.\n\nThe December run can go to press as soon as you approve the proofs. Could you let me know by Wednesday whether the paper stock stays the same?\n\nBest regards,\nVincent' },
];

const addressOf = (v) => /<([^>]+)>/.exec(v)?.[1] ?? v;
let failed = 0;
for (const m of mail) {
  const url = `${base}/cdn-cgi/local/email?from=${encodeURIComponent(addressOf(m.from))}&to=${encodeURIComponent(addressOf(m.to))}`;
  try {
    const res = await fetch(url, { method: 'POST', body: eml(m) });
    console.log(res.ok ? 'delivered' : `FAILED ${res.status}`, '·', m.subject);
    if (!res.ok) { failed++; console.log('  ', (await res.text()).slice(0, 200)); }
  } catch (err) {
    failed++;
    console.log('FAILED', '·', m.subject, '·', err.message);
  }
  await new Promise((r) => setTimeout(r, 150));
}
if (failed) {
  console.error(`\n${failed} of ${mail.length} messages were not delivered. Is \`pnpm dev\` running at ${base}?`);
  process.exit(1);
}
console.log(`\n${mail.length} sample messages delivered to ${base}.`);
