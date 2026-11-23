import { useCallback, useEffect, useState } from 'react';
import type { MailServerInfo } from '../shared/types';
import { RequestError, api } from './api';
import { ago } from './format';
import { Icon } from './icons';
import type { MailStore } from './store';

type Security = MailServerInfo['smtpSecurity'];
const SECURITY: [Security, string][] = [['tls', 'TLS'], ['starttls', 'STARTTLS']];
const failure = (err: unknown) => (err instanceof RequestError ? err.message : 'That did not work. Try again.');
const BLANK = { email: '', mailboxId: '', username: '', password: '', smtpHost: '', smtpPort: '465', smtpSecurity: 'tls' as Security, imapHost: '', imapPort: '993', imapSecurity: 'tls' as Security };

function Switch({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: (on: boolean) => void }) {
  return <button type="button" role="switch" className="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} />;
}

function ServerRow({ server, relay, onChange }: { server: MailServerInfo; relay: MailStore; onChange: () => void }) {
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState<{ smtp?: { ok: boolean; detail: string }; imap?: { ok: boolean; detail: string } } | null>(null);
  const [confirm, setConfirm] = useState(false);

  const run = async (what: string, job: () => Promise<string | void>) => {
    setBusy(what);
    try {
      const said = await job();
      if (said) relay.notify({ text: said });
      onChange();
    } catch (err) {
      relay.notify({ text: failure(err) });
      onChange();
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="server">
      <div className="server-head">
        <div className="grow" style={{ minWidth: 0 }}>
          <b className="truncate">{server.email}</b>
          <small className="truncate">{server.username !== server.email ? `Signs in as ${server.username}` : 'Signs in with the address'}</small>
        </div>
        <button type="button" className="btn small" disabled={!!busy} onClick={() => void run('test', async () => { setResult(await api.post(`/mail-servers/${server.id}/test`)); })}>{busy === 'test' ? 'Testing…' : 'Test Sign-In'}</button>
        {confirm ? (
          <>
            <button type="button" className="btn small danger" disabled={!!busy} onClick={() => void run('remove', async () => { await api.delete(`/mail-servers/${server.id}`); void relay.loadBoot(); return 'Mail Server Removed'; })}>Remove</button>
            <button type="button" className="btn small ghost" onClick={() => setConfirm(false)}>Keep</button>
          </>
        ) : (
          <button type="button" className="icon-btn" aria-label={`Remove The Server For ${server.email}`} title="Remove" onClick={() => setConfirm(true)}><Icon name="trash" size={15} /></button>
        )}
      </div>

      <div className="server-ways">
        <div className={`way${server.smtpHost ? '' : ' off'}`}>
          <div className="way-top">
            <span className="grow"><b>Send Through It</b><small>SMTP</small></span>
            {server.smtpHost && <Switch on={server.sendEnabled} label={`Send Mail From ${server.email} Through This Server`} disabled={!!busy} onChange={(on) => void run('send', async () => { await api.patch(`/mail-servers/${server.id}`, { sendEnabled: on }); void relay.loadBoot(); return on ? 'Sending Through This Server' : 'Sending Through This Server Is Off'; })} />}
          </div>
          {server.smtpHost ? <code>{server.smtpHost}:{server.smtpPort} · {server.smtpSecurity === 'tls' ? 'TLS' : server.smtpSecurity === 'starttls' ? 'STARTTLS' : 'No Encryption'}</code> : <small>No SMTP server was entered.</small>}
          {server.smtpHost && <small>{server.sendEnabled ? 'Mail from this address really leaves through this server, even while the installation is in dry run.' : 'Off. Mail from this address goes the way the installation sends.'}</small>}
          {result?.smtp && <span className={`status ${result.smtp.ok ? 'ok' : 'bad'}`}><i />{result.smtp.detail}</span>}
        </div>
        <div className={`way${server.imapHost ? '' : ' off'}`}>
          <div className="way-top">
            <span className="grow"><b>Receive From It</b><small>IMAP</small></span>
            {server.imapHost && <Switch on={server.receiveEnabled} label={`Bring Mail For ${server.email} In From This Server`} disabled={!!busy} onChange={(on) => void run('receive', async () => { await api.patch(`/mail-servers/${server.id}`, { receiveEnabled: on }); return on ? 'Checking This Inbox Every Minute' : 'Receiving From This Server Is Off'; })} />}
          </div>
          {server.imapHost ? <code>{server.imapHost}:{server.imapPort} · {server.imapSecurity === 'tls' ? 'TLS' : server.imapSecurity === 'starttls' ? 'STARTTLS' : 'No Encryption'}</code> : <small>No IMAP server was entered.</small>}
          {server.imapHost && (
            <small>
              {server.receiveEnabled ? `Checked every minute. ${server.lastCheckedAt ? `Last checked ${ago(server.lastCheckedAt)}.` : 'Not checked yet.'}${server.lastReceivedAt ? ` Last mail brought in ${ago(server.lastReceivedAt)}.` : ''}` : 'Off. The inbox on that server is not read.'}
            </small>
          )}
          {server.imapHost && server.lastError && <span className="status bad"><i />{server.lastError}</span>}
          {result?.imap && <span className={`status ${result.imap.ok ? 'ok' : 'bad'}`}><i />{result.imap.detail}</span>}
          {server.imapHost && server.receiveEnabled && <button type="button" className="btn small" style={{ alignSelf: 'flex-start' }} disabled={!!busy} onClick={() => void run('check', async () => { const r = await api.post<{ stored: number }>(`/mail-servers/${server.id}/check`); void relay.loadList(true); return r.stored ? `${r.stored} New Message${r.stored === 1 ? '' : 's'} Brought In` : server.watching ? 'No New Mail' : 'Connected. Mail That Arrives From Now On Will Appear'; })}>{busy === 'check' ? 'Checking…' : 'Check Now'}</button>}
        </div>
      </div>
    </div>
  );
}

/** Accounts on mail servers outside Cloudflare. Optional: an installation needs none of this. */
export function MailServers({ relay }: { relay: MailStore }) {
  const [servers, setServers] = useState<MailServerInfo[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<typeof BLANK>) => setForm((f) => ({ ...f, ...patch }));
  const load = useCallback(() => { api.get<{ data: MailServerInfo[] }>('/mail-servers').then((r) => setServers(r.data)).catch(() => setServers([])); }, []);
  useEffect(load, [load]);

  const known = relay.addresses.some((a) => a.email === form.email.trim().toLowerCase());
  const add = async () => {
    setError('');
    setBusy(true);
    try {
      await api.post('/mail-servers', { ...form, smtpPort: Number(form.smtpPort), imapPort: Number(form.imapPort), mailboxId: form.mailboxId || relay.mailboxes[0]?.id });
      setForm(BLANK);
      setAdding(false);
      load();
      void relay.loadBoot();
      relay.notify({ text: 'Mail Server Added. Test The Sign-In, Then Switch On Sending Or Receiving' });
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card servers">
      <div className="card-head">
        <div className="grow"><h2>Other Mail Servers</h2><small>Optional. Cloudflare already receives and sends for your domains. Add an account here only when an address lives on another mail server.</small></div>
        {!adding && <button type="button" className="btn small" onClick={() => setAdding(true)}><Icon name="plus" size={14} weight={2} />Add Server</button>}
      </div>

      {servers === null ? <div className="skeleton" style={{ height: 72, margin: 16, borderRadius: 8 }} aria-busy="true" />
        : servers.length === 0 && !adding ? <div className="state"><strong>No Other Mail Servers</strong><p>Everything goes through Cloudflare. Add a server to send through SMTP or to bring mail in over IMAP.</p></div>
        : servers.map((s) => <ServerRow key={s.id} server={s} relay={relay} onChange={load} />)}

      {adding && (
        <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <label>Email Address<input className="field" type="email" required autoFocus value={form.email} placeholder="you@yourdomain.com" onChange={(e) => set({ email: e.target.value })} /></label>
          <label>Mailbox
            <select className="field" value={form.mailboxId || relay.mailboxes[0]?.id || ''} disabled={known} onChange={(e) => set({ mailboxId: e.target.value })}>{relay.mailboxes.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
            <span className="hint">{known ? 'This address is already in a mailbox.' : 'Where mail for this address will appear.'}</span>
          </label>
          <label>User Name<input className="field" value={form.username} placeholder="Leave empty to use the email address" autoComplete="off" onChange={(e) => set({ username: e.target.value })} /></label>
          <label>Password<input className="field" type="password" required value={form.password} autoComplete="new-password" onChange={(e) => set({ password: e.target.value })} /><span className="hint">Many providers want an app password. It is stored encrypted and never shown again.</span></label>

          <div className="wide split-title">Sending (SMTP)</div>
          <label className="host">Server<input className="field mono" value={form.smtpHost} placeholder="smtp.yourprovider.com" onChange={(e) => set({ smtpHost: e.target.value })} /></label>
          <div className="pair">
            <label>Port<input className="field mono" inputMode="numeric" value={form.smtpPort} onChange={(e) => set({ smtpPort: e.target.value })} /></label>
            <label>Security<select className="field" value={form.smtpSecurity} onChange={(e) => { const v = e.target.value as Security; set({ smtpSecurity: v, smtpPort: v === 'tls' ? '465' : '587' }); }}>{SECURITY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          </div>

          <div className="wide split-title">Receiving (IMAP)</div>
          <label className="host">Server<input className="field mono" value={form.imapHost} placeholder="imap.yourprovider.com" onChange={(e) => set({ imapHost: e.target.value })} /></label>
          <div className="pair">
            <label>Port<input className="field mono" inputMode="numeric" value={form.imapPort} onChange={(e) => set({ imapPort: e.target.value })} /></label>
            <label>Security<select className="field" value={form.imapSecurity} onChange={(e) => { const v = e.target.value as Security; set({ imapSecurity: v, imapPort: v === 'tls' ? '993' : '143' }); }}>{SECURITY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          </div>

          <p className="wide fine" style={{ margin: 0 }}>Fill in sending, receiving, or both. Port 25 cannot be used from Cloudflare. Receiving starts with mail that arrives after you connect, and leaves every message on the other server untouched; bring older mail in with the import tool.</p>
          {error && <div className="wide notice warn" role="alert">{error}</div>}
          <div className="wide profile-actions">
            <button type="button" className="btn small ghost" disabled={busy} onClick={() => { setAdding(false); setError(''); }}>Cancel</button>
            <button type="submit" className="btn primary" disabled={busy} aria-busy={busy}>{busy ? 'Adding…' : 'Add Server'}</button>
          </div>
        </form>
      )}
    </section>
  );
}
