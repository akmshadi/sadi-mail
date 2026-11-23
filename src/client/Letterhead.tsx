import { useEffect, useMemo, useRef, useState } from 'react';
import { type Align, type HeaderTone, type Layout, type Letterhead, parseLetterhead, renderLetter } from '../shared/design';
import type { MailboxInfo } from '../shared/types';
import { RequestError, api } from './api';
import { Icon } from './icons';
import type { MailStore } from './store';
import { uploadImage } from './upload';

const SAMPLE = '<p style="margin:0 0 14px">Hello Rima,</p><p style="margin:0 0 14px">Thank you for your order. It leaves our warehouse tomorrow and should reach you within three working days.</p><p style="margin:0">Best regards,<br>The Team</p>';

/** The email at its real 640 px width, shrunk to fit the space, so the preview shows the whole layout. */
function Fitted({ title, html }: { title: string; html: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, el.clientWidth / 640));
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  // Our own rendered design, no scripts allowed; same-origin only so uploaded pictures show.
  return <div className="lh-frame" ref={box} style={{ height: 520 * scale }}><iframe title={title} sandbox="allow-same-origin" srcDoc={html} style={{ width: 640, height: 520, transform: `scale(${scale})` }} /></div>;
}

function Editor({ mailbox, relay }: { mailbox: MailboxInfo; relay: MailStore }) {
  const [open, setOpen] = useState(false);
  const [l, setL] = useState<Letterhead>(mailbox.letterhead);
  const [busy, setBusy] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<Letterhead>) => setL((v) => ({ ...v, ...patch }));
  const dirty = JSON.stringify(l) !== JSON.stringify(mailbox.letterhead);
  const html = useMemo(() => renderLetter(SAMPLE, parseLetterhead({ ...l, brand: l.brand || mailbox.name })), [l, mailbox.name]);
  const fail = (err: unknown) => relay.notify({ text: err instanceof RequestError || err instanceof Error ? err.message : 'That did not work. Try again.' });

  const save = async (next: Letterhead = l) => {
    setBusy('save');
    try {
      const r = await api.patch<{ letterhead: Letterhead }>(`/mailboxes/${mailbox.id}/letterhead`, next);
      setL(r.letterhead);
      await relay.loadBoot();
      relay.notify({ text: r.letterhead.on ? 'Company Header And Footer Saved' : 'Company Header And Footer Switched Off' });
    } catch (err) {
      fail(err);
    } finally {
      setBusy('');
    }
  };
  const logo = async (f: File | undefined) => {
    if (!f) return;
    setBusy('logo');
    try { set({ logo: await uploadImage(f, 600) }); } catch (err) { fail(err); } finally { setBusy(''); }
  };

  return (
    <div className="lh">
      <div className="lh-head">
        <div className="grow" style={{ minWidth: 0 }}>
          <b className="truncate">{mailbox.name}</b>
          <small>{mailbox.letterhead.on ? `On: ${mailbox.letterhead.brand || 'Logo Only'}` : 'No company header and footer'}</small>
        </div>
        <button type="button" role="switch" className="switch" aria-checked={l.on} aria-label={`Company Header And Footer For ${mailbox.name}`} disabled={!!busy} onClick={() => { const next = { ...l, on: !l.on }; setL(next); if (!next.on) void save(next); else setOpen(true); }} />
        <button type="button" className="btn small" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Close' : 'Edit'}</button>
      </div>
      {open && (
        <div className="lh-edit">
          <div className="form-grid">
            <label>Company Name<input className="field" value={l.brand} maxLength={80} placeholder={mailbox.name} onChange={(e) => set({ brand: e.target.value })} /></label>
            <label>Line Under The Name<input className="field" value={l.tagline} maxLength={120} placeholder="What the company does, in a few words" onChange={(e) => set({ tagline: e.target.value })} /></label>
            <div className="wide lh-logo">
              <span>Logo</span>
              <div>
                {l.logo ? <img src={l.logo} alt="" /> : <i aria-hidden="true"><Icon name="image" size={18} /></i>}
                <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => { void logo(e.target.files?.[0]); e.target.value = ''; }} />
                <button type="button" className="btn small" disabled={!!busy} onClick={() => file.current?.click()}>{busy === 'logo' ? 'Uploading…' : l.logo ? 'Replace Logo' : 'Upload Logo'}</button>
                {l.logo && <button type="button" className="btn small ghost" onClick={() => set({ logo: '' })}>Remove</button>}
                <small>With a logo, the name is used as its description. A PNG with a clear background works on every band.</small>
              </div>
            </div>
            <label>Header Band
              <select className="field" value={l.tone} onChange={(e) => set({ tone: e.target.value as HeaderTone })}><option value="light">Light, With A Line</option><option value="dark">Dark</option><option value="accent">Accent Colour</option></select>
            </label>
            <label>Header Alignment
              <select className="field" value={l.align} onChange={(e) => set({ align: e.target.value as Align })}><option value="left">Left</option><option value="center">Centre</option><option value="right">Right</option></select>
            </label>
            <label>Where The Email Sits
              <select className="field" value={l.layout} onChange={(e) => set({ layout: e.target.value as Layout })}><option value="center">Centred Card</option><option value="left">Left, Like A Letter</option></select>
            </label>
            <label>Accent Colour
              <span className="lh-color"><input type="color" value={l.accent} aria-label="Accent Colour" onChange={(e) => set({ accent: e.target.value })} /><code>{l.accent.toUpperCase()}</code></span>
            </label>
            <label className="wide">Footer Text<textarea className="field" rows={3} maxLength={600} value={l.footer} placeholder="A closing line, how to reach you, why they are getting this email" onChange={(e) => set({ footer: e.target.value })} /></label>
            <label className="wide">Company Address<input className="field" value={l.address} maxLength={200} placeholder="Street, city, country" onChange={(e) => set({ address: e.target.value })} /></label>
            <div className="wide profile-actions">
              {dirty && <button type="button" className="btn small ghost" disabled={!!busy} onClick={() => setL(mailbox.letterhead)}>Discard</button>}
              <button type="button" className="btn primary" disabled={!dirty || !!busy} aria-busy={busy === 'save'} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
          <div className="lh-preview">
            <small>Preview With A Sample Message</small>
            <Fitted title={`Preview Of The Company Header And Footer For ${mailbox.name}`} html={html} />
          </div>
        </div>
      )}
    </div>
  );
}

/** One company header and footer per mailbox: saved here, used by designed and letterhead messages sent from it. */
export function Letterheads({ relay }: { relay: MailStore }) {
  if (relay.mailboxes.length === 0) return null;
  return (
    <section className="card letterheads">
      <div className="card-head"><div className="grow"><h2>Company Header And Footer</h2><small>Saved once for each mailbox. Designed messages start with it, and an ordinary message can be sent inside it with the Letterhead switch in Compose.</small></div></div>
      {relay.mailboxes.map((m) => <Editor key={m.id} mailbox={m} relay={relay} />)}
    </section>
  );
}
