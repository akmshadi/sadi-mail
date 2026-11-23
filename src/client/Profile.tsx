import { useEffect, useRef, useState } from 'react';
import { EMPTY_PROFILE, type ProfileFields, type Tone, profileForAi } from '../shared/profile';
import { RequestError, api } from './api';
import { Icon } from './icons';
import type { MailStore } from './store';

const TONES: [Tone, string][] = [['neutral', 'No Preference'], ['friendly', 'Warm And Friendly'], ['formal', 'Formal And Polite'], ['direct', 'Short And Direct']];
const PICTURE = 640;

/** The picture, large, over the page. Click anywhere or press Esc to close. */
function Lightbox({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);
  return (
    <div className="overlay lightbox" role="dialog" aria-modal="true" aria-label={`Picture Of ${name}`}>
      <button type="button" className="scrim" aria-label="Close Picture" onClick={onClose} />
      <figure>
        <img src={src} alt={`Picture of ${name}`} />
        <figcaption><b className="grow truncate">{name}</b><button type="button" className="icon-btn" aria-label="Close Picture" autoFocus onClick={onClose}><Icon name="close" size={14} weight={2} /></button></figcaption>
      </figure>
    </div>
  );
}

export function Profile({ relay, avatarVersion, onChange }: { relay: MailStore; avatarVersion: number; onChange: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [saved, setSaved] = useState<ProfileFields | null>(null);
  const [fields, setFields] = useState<ProfileFields>(EMPTY_PROFILE);
  const [error, setError] = useState('');
  const user = relay.boot?.user;
  const aiOn = relay.boot?.ai.connected ?? false;

  useEffect(() => {
    api.get<{ profile: ProfileFields }>('/me/profile').then((r) => { setSaved(r.profile); setFields(r.profile); }).catch(() => setError('Your profile could not be loaded. Reload the page.'));
  }, []);

  if (!user) return null;
  const src = `/api/users/${user.id}/avatar?v=${avatarVersion}`;
  const set = (patch: Partial<ProfileFields>) => setFields((f) => ({ ...f, ...patch }));
  const dirty = saved !== null && JSON.stringify(saved) !== JSON.stringify(fields);
  const forAi = profileForAi(fields);

  const upload = async (file: File) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return relay.notify({ text: 'Use a PNG, JPEG or WebP picture.' });
    setBusy(true);
    try {
      // Cropped to a square and shrunk in the browser, so a phone photo is fine to pick. Large enough to open full size.
      const bitmap = await createImageBitmap(file);
      const side = Math.min(bitmap.width, bitmap.height);
      const size = Math.min(PICTURE, side);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
      if (!blob) throw new Error('no blob');
      await api.putBlob('/me/avatar', blob);
      relay.notify({ text: 'Picture Updated' });
      onChange();
    } catch {
      relay.notify({ text: 'The picture could not be saved. Try another image.' });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setError('');
    setSaving(true);
    try {
      const r = await api.patch<{ profile: ProfileFields }>('/me/profile', fields);
      setSaved(r.profile);
      setFields(r.profile);
      relay.notify({ text: 'Profile Saved' });
      void relay.loadBoot?.();
    } catch (err) {
      setError(err instanceof RequestError ? err.message : 'Your profile could not be saved. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card profile">
      <div className="card-head"><h2 className="grow">Your Profile</h2>{dirty && <span className="pill neutral">Unsaved Changes</span>}</div>

      <div className="profile-top">
        {user.hasAvatar ? (
          <button type="button" className="avatar portrait t1" aria-label="Open Your Picture" title="Open Picture" onClick={() => setZoom(true)}><img src={src} alt="" /></button>
        ) : (
          <span className="avatar portrait t1">{(fields.name || user.name).slice(0, 2).toUpperCase()}</span>
        )}
        <div className="who">
          <b className="truncate">{fields.name || user.name}</b>
          <span className="truncate">{[fields.title, fields.company].filter(Boolean).join(' at ') || 'Add your job title and company below'}</span>
          <span className="pill neutral" style={{ textTransform: 'capitalize', alignSelf: 'flex-start' }}>{user.role}</span>
        </div>
        <div className="pic-actions">
          <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
          <button type="button" className="btn small" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Saving…' : user.hasAvatar ? 'Change Picture' : 'Add Picture'}</button>
          {user.hasAvatar && <button type="button" className="btn small ghost" disabled={busy} onClick={() => void api.delete('/me/avatar').then(onChange).catch(() => relay.notify({ text: 'Could not remove the picture.' }))}>Remove</button>}
        </div>
      </div>

      <div className="form-grid">
        <label>Full Name<input className="field" value={fields.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} /></label>
        <label>Job Title<input className="field" value={fields.title} maxLength={80} placeholder="Operations Manager" onChange={(e) => set({ title: e.target.value })} /></label>
        <label>Company<input className="field" value={fields.company} maxLength={80} onChange={(e) => set({ company: e.target.value })} /></label>
        <label>Phone<input className="field" value={fields.phone} maxLength={40} inputMode="tel" onChange={(e) => set({ phone: e.target.value })} /></label>
        <label>Location<input className="field" value={fields.location} maxLength={80} placeholder="City, country" onChange={(e) => set({ location: e.target.value })} /></label>
        <label>Languages You Write In<input className="field" value={fields.languages} maxLength={120} placeholder="English, Bangla, German" onChange={(e) => set({ languages: e.target.value })} /></label>
        <label className="wide">Writing Tone
          <select className="field" value={fields.tone} onChange={(e) => set({ tone: e.target.value as Tone })}>{TONES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <label className="wide">About You
          <textarea className="field" rows={4} maxLength={800} value={fields.about} placeholder="What you do, who you usually write to, and anything the AI should keep in mind. For example: I handle supplier orders and payments. I greet people by first name and keep messages short." onChange={(e) => set({ about: e.target.value })} />
          <span className="count num">{fields.about.length} / 800</span>
        </label>

        <div className="wide ai-sees">
          <b><Icon name="ai" size={14} weight={2} />What The AI Is Told About You</b>
          {forAi ? <pre>{forAi}</pre> : <p>Nothing yet. Fill in the card and the AI will sign with your name and use your details when you ask for them.</p>}
          <span className="fine">{aiOn
            ? 'This text, exactly as shown, is given to the AI each time it writes a reply or a new message for you. Other people in this installation do not see it.'
            : 'AI is not connected, so nothing reads this card yet. It will be used once a provider is added under AI And Agents.'}</span>
        </div>

        {error && <div className="wide notice warn" role="alert">{error}</div>}
        <div className="wide profile-actions">
          {dirty && <button type="button" className="btn small ghost" disabled={saving} onClick={() => saved && setFields(saved)}>Discard</button>}
          <button type="button" className="btn primary" disabled={!dirty || saving || !fields.name.trim()} aria-busy={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save Profile'}</button>
        </div>
      </div>

      {zoom && user.hasAvatar && <Lightbox src={src} name={fields.name || user.name} onClose={() => setZoom(false)} />}
    </section>
  );
}
