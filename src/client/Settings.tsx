import { useCallback, useEffect, useState } from 'react';
import { EMPTY_SIGNATURE, type SignatureFields, signatureHtml, signatureIsEmpty, signatureText } from '../shared/signature';
import type { AddressInfo, SystemStatus } from '../shared/types';
import { RequestError, api } from './api';
import { ago, bytes } from './format';
import { Icon } from './icons';
import { AiSettings } from './AiSettings';
import { BulkSends } from './Bulk';
import { Letterheads } from './Letterhead';
import { MailServers } from './MailServers';
import { Profile } from './Profile';
import { Templates } from './Templates';
import { People } from './People';
import { Rules } from './Rules';
import type { MailStore } from './store';

function AddressRow({ address, mailbox, relay }: { address: AddressInfo; mailbox: string; relay: MailStore }) {
  const [name, setName] = useState(address.displayName);
  const [fields, setFields] = useState<SignatureFields>(address.signatureFields ?? { ...EMPTY_SIGNATURE, name: address.displayName });
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<SignatureFields>) => setFields({ ...fields, ...patch });
  const preview = signatureHtml(fields);
  const save = async (body: Record<string, unknown>, done: string) => {
    setSaving(true);
    try {
      await api.patch(`/addresses/${address.id}`, body);
      await relay.loadBoot();
      relay.notify({ text: done });
      return true;
    } catch (err) {
      relay.notify({ text: err instanceof RequestError ? err.message : 'Could not save. Try again.' });
      return false;
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="addr">
      <div className="addr-row">
        <span className="grow" style={{ minWidth: 0 }}>
          <b className="truncate">{address.email}</b>
          <small>{mailbox}{address.isDefault ? ' · Default' : ''}{address.discovered ? ' · Added When Mail Arrived' : ''}</small>
        </span>
        <label className="addr-name">
          <span className="sr">From Name For {address.email}</span>
          <input className="field" placeholder="Name shown to recipients" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="button" className="btn small" disabled={saving || name === address.displayName} onClick={() => void save({ displayName: name }, `Saved ${address.email}`)}>Save Name</button>
        <button type="button" className="btn small" aria-expanded={open} onClick={() => setOpen(!open)}>{address.signature ? 'Edit Signature' : 'Add Signature'}</button>
      </div>
      {!open && address.signature && <pre className="sig-current">{address.signature}</pre>}
      {open && (
        <div className="sig-edit">
          <div className="form-grid">
            <label>Closing Line<input className="field" value={fields.closing} onChange={(e) => set({ closing: e.target.value })} placeholder="Best regards," /></label>
            <label>Your Name<input className="field" value={fields.name} onChange={(e) => set({ name: e.target.value })} /></label>
            <label>Job Title<input className="field" value={fields.title} onChange={(e) => set({ title: e.target.value })} /></label>
            <label>Company<input className="field" value={fields.company} onChange={(e) => set({ company: e.target.value })} /></label>
            <label>Phone<input className="field" value={fields.phone} onChange={(e) => set({ phone: e.target.value })} /></label>
            <label>Website<input className="field" value={fields.website} onChange={(e) => set({ website: e.target.value })} placeholder="example.com" /></label>
            <label className="wide">Logo Or Photo Address (Optional)<input className="field" value={fields.logoUrl} onChange={(e) => set({ logoUrl: e.target.value })} placeholder="https://… a square picture already on the web" /></label>
            <label className="wide">Layout
              <span className="tabs" role="tablist" aria-label="Signature Layout" style={{ alignSelf: 'flex-start' }}>
                {([['divider', 'Accent Line'], ['simple', 'Simple'], ['compact', 'One Line']] as const).map(([key, label]) => (
                  <button key={key} type="button" role="tab" aria-selected={fields.style === key} onClick={() => set({ style: key })}>{label}</button>
                ))}
              </span>
            </label>
          </div>
          <div className="sig-preview">
            <span className="eyebrow">Preview</span>
            {signatureIsEmpty(fields) ? <p className="fine">Fill in your name and the preview appears here.</p> : <div className="sig-paper" dangerouslySetInnerHTML={{ __html: preview }} />}
            <span className="eyebrow">In Plain-Text Mail</span>
            <pre className="sig-current">{signatureText(fields) || '—'}</pre>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn primary" disabled={saving} onClick={() => void save({ signatureFields: fields }, 'Signature Saved').then((ok) => ok && setOpen(false))}>{saving ? 'Saving…' : 'Save Signature'}</button>
              {address.signature && <button type="button" className="btn ghost" disabled={saving} onClick={() => window.confirm('Remove the signature from this address?') && void save({ signatureFields: { ...EMPTY_SIGNATURE, closing: '' } }, 'Signature Removed').then((ok) => { if (ok) { setFields({ ...EMPTY_SIGNATURE }); setOpen(false); } })}>Remove</button>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const KEEP = [[7, '7 Days'], [30, '30 Days'], [90, '90 Days'], [0, 'For Ever']] as const;
interface ActivityPage { data: { id: string; at: number; direction: 'in' | 'out'; from: string; to: string; status: string; ms: number | null }[]; total: number; page: number; pages: number; keepDays: number }

/** Mail activity, ten rows to a page, with a choice of how long the history is kept. */
function Activity({ relay }: { relay: MailStore }) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ActivityPage | null>(null);
  const [error, setError] = useState('');
  const load = useCallback((n: number) => {
    api.get<ActivityPage>(`/activity?page=${n}`).then((d) => { setData(d); setPage(d.page); setError(''); }).catch((err) => setError(err instanceof RequestError ? err.message : 'Could not load activity.'));
  }, []);
  useEffect(() => load(1), [load]);
  const keep = async (days: number) => {
    if (data && days !== 0 && (data.keepDays === 0 || days < data.keepDays) && !window.confirm(`Delete activity older than ${days} days now? Your mail is not affected.`)) return;
    try {
      const r = await api.patch<{ removed: number }>('/settings', { activityKeepDays: days });
      relay.notify({ text: r.removed ? `Saved. ${r.removed} Old Activity Records Deleted.` : 'Saved' });
      load(1);
    } catch (err) {
      relay.notify({ text: err instanceof RequestError ? err.message : 'Could not save.' });
    }
  };
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="grow">Mail Activity</h2>
        <label className="keep">Keep For
          <select className="field" value={data?.keepDays ?? 30} disabled={!data} onChange={(e) => void keep(Number(e.target.value))}>
            {KEEP.map(([days, label]) => <option key={days} value={days}>{label}</option>)}
          </select>
        </label>
        <button type="button" className="btn small" onClick={() => load(page)}><Icon name="refresh" size={14} weight={1.8} />Refresh</button>
      </div>
      {error && <div className="notice warn" role="alert" style={{ margin: 12 }}>{error}</div>}
      {!data && !error && <div className="skeleton" style={{ height: 180, margin: 12 }} />}
      {data && data.total === 0 && <div className="state"><p>Nothing has been received or sent in this period.</p></div>}
      {data?.data.map((r) => (
        <div className="log-row" key={r.id}>
          <span className="mono num">{new Date(r.at).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</span>
          <span className={`dir ${r.direction}`}>{r.direction === 'in' ? 'IN' : 'OUT'}</span>
          <span className="grow truncate">{r.from} → {r.to || '—'}</span>
          <span className="mono">{r.status === 'dry_run' ? 'dry run' : r.status}{r.ms != null ? ` · ${r.ms} ms` : ''}</span>
        </div>
      ))}
      {data && data.total > 0 && (
        <div className="pager">
          <span className="num">{(data.page - 1) * 10 + 1}–{Math.min(data.page * 10, data.total)} Of {data.total}</span>
          <span className="grow" />
          <button type="button" className="btn small" disabled={data.page <= 1} onClick={() => load(data.page - 1)}><Icon name="left" size={13} weight={2} />Previous</button>
          <span className="num">Page {data.page} Of {data.pages}</span>
          <button type="button" className="btn small" disabled={data.page >= data.pages} onClick={() => load(data.page + 1)}>Next<Icon name="right" size={13} weight={2} /></button>
        </div>
      )}
    </section>
  );
}

export type SettingsTab = 'system' | 'ai' | 'people' | 'rules' | 'templates' | 'profile';

export function Settings({ relay, onBack, tab, setTab, avatarVersion, onAvatarChange }: { relay: MailStore; onBack: () => void; tab: SettingsTab; setTab: (t: SettingsTab) => void; avatarVersion: number; onAvatarChange: () => void }) {
  const isAdmin = relay.boot?.user.role === 'owner' || relay.boot?.user.role === 'admin';
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    setError('');
    api.get<SystemStatus>('/status').then(setStatus).catch((err) => setError(err instanceof RequestError ? err.message : 'Could not load status.'));
  }, []);
  useEffect(() => { if (isAdmin) load(); }, [load, isAdmin]);

  const caps = status
    ? [
        {
          title: 'Receiving', cls: status.receiving.state === 'working' ? 'ok' : 'warn',
          status: status.receiving.state === 'working' ? 'Working' : 'Not Tested Yet',
          body: status.receiving.lastReceivedAt ? `Last message arrived ${ago(status.receiving.lastReceivedAt)}. Every message is written to R2 before it is indexed.` : 'No message has arrived yet. Add an Email Routing rule that sends mail to this Worker.',
        },
        { title: 'Storage And Search', cls: 'ok', status: 'Working', body: `${status.storage.messages.toLocaleString()} messages, ${bytes(status.storage.bytes)}. Raw mail in R2, index and search in D1.` },
        {
          title: 'Sending', cls: status.sending.state === 'working' ? 'ok' : 'warn',
          status: status.sending.state === 'working' ? 'Working' : status.sending.state === 'dry-run' ? 'Dry Run' : 'Configured, Not Tested',
          body: status.sending.state === 'dry-run' ? 'Messages are stored in Sent and never leave this server. Set SEND_MODE to "cloudflare" after onboarding a sending domain.' : status.sending.state === 'working' ? 'Cloudflare Email Sending has accepted mail from this installation.' : 'Cloudflare Email Sending is selected, but no message has been accepted yet.',
        },
        {
          title: 'AI Assistant', cls: status.ai.state === 'connected' ? 'ok' : 'muted', planned: status.ai.state !== 'connected',
          status: status.ai.state === 'connected' ? 'Connected' : 'Not Connected',
          body: status.ai.state === 'connected' ? status.ai.providers.map((p) => `${p.name} (${p.model})`).join(', ') : 'Agents, summaries and AI writing are not built yet. Cloudflare Workers AI will be the default; Anthropic and OpenAI keys can be added.',
        },
      ]
    : [];

  return (
    <div className="settings">
      <div className="settings-inner">
        <div>
          <button type="button" className="btn small ghost" onClick={onBack} style={{ marginLeft: -10, marginBottom: 12 }}><Icon name="left" size={14} weight={2} />Back To Mail</button>
          <h1>Settings</h1>
        </div>
        <div className="settings-tabs" role="tablist" aria-label="Settings">
          {isAdmin && <button type="button" role="tab" aria-selected={tab === 'system'} onClick={() => setTab('system')}>Mail System</button>}
          {isAdmin && <button type="button" role="tab" aria-selected={tab === 'ai'} onClick={() => setTab('ai')}>AI And Agents</button>}
          {isAdmin && <button type="button" role="tab" aria-selected={tab === 'people'} onClick={() => setTab('people')}>People</button>}
          {isAdmin && <button type="button" role="tab" aria-selected={tab === 'rules'} onClick={() => setTab('rules')}>Rules</button>}
          <button type="button" role="tab" aria-selected={tab === 'templates'} onClick={() => setTab('templates')}>Templates</button>
          <button type="button" role="tab" aria-selected={tab === 'profile'} onClick={() => setTab('profile')}>Your Profile</button>
        </div>
        {tab === 'ai' && isAdmin && <AiSettings relay={relay} />}
        {tab === 'people' && isAdmin && <People relay={relay} />}
        {tab === 'rules' && isAdmin && <Rules relay={relay} />}
        {tab === 'templates' && <Templates relay={relay} />}
        {tab === 'profile' && <Profile relay={relay} avatarVersion={avatarVersion} onChange={onAvatarChange} />}
        {tab === 'system' && isAdmin && <p className="lede" style={{ marginTop: -8 }}>How mail reaches and leaves your mailboxes. Every status here is read from this installation’s own data, not assumed.</p>}

        {tab === 'system' && isAdmin && error && <div className="notice warn" role="alert"><span className="grow">{error}</span><button type="button" className="link-btn" onClick={load}>Try Again</button></div>}
        {tab === 'system' && isAdmin && !status && !error && <div className="caps" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 132, borderRadius: 12 }} />)}</div>}

        {tab === 'system' && isAdmin && status && (
          <>
            <div className="caps">
              {caps.map((c) => (
                <div key={c.title} className={`cap${c.planned ? ' planned' : ''}`}>
                  <span className={`status ${c.cls}`}><i />{c.status}</span>
                  <b>{c.title}</b>
                  <p>{c.body}</p>
                </div>
              ))}
            </div>

            <section className="card">
              <div className="card-head"><h2 className="grow">Domains</h2></div>
              {status.domains.length === 0 ? (
                <div className="state"><strong>No Domains Yet</strong><p>A domain appears here when the first message for it arrives.</p></div>
              ) : (
                <table className="table">
                  <thead><tr><th>Domain</th><th>Mailbox</th><th>Addresses</th><th>Unknown Addresses</th></tr></thead>
                  <tbody>
                    {status.domains.map((d) => (
                      <tr key={d.name}><td><b style={{ fontWeight: 600 }}>{d.name}</b></td><td>{d.mailbox}</td><td className="num">{d.addresses}</td><td>{d.catchAll ? 'Accepted And Added (Catch-All)' : 'Refused'}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="card">
              <div className="card-head"><h2 className="grow">Addresses And Signatures</h2></div>
              {relay.addresses.length === 0 ? (
                <div className="state"><strong>No Addresses Yet</strong><p>Addresses are added automatically when mail arrives for them.</p></div>
              ) : (
                <div className="addr-list">{relay.mailboxes.flatMap((m) => m.addresses.map((x) => <AddressRow key={x.id} address={x} mailbox={m.name} relay={relay} />))}</div>
              )}
            </section>

            <Letterheads relay={relay} />

            <BulkSends relay={relay} />

            <MailServers relay={relay} />

            <Activity relay={relay} />
          </>
        )}
      </div>
    </div>
  );
}
