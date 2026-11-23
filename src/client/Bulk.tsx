import { useCallback, useEffect, useMemo, useState } from 'react';
import { BULK_MAX, BULK_RATES, parseRecipients, personalise } from '../shared/bulk';
import type { BulkJobInfo } from '../shared/types';
import { RequestError, api } from './api';
import { ago } from './format';
import { Icon } from './icons';
import type { MailStore } from './store';

const failure = (err: unknown) => (err instanceof RequestError ? err.message : 'That did not work. Try again.');
const minutes = (n: number) => (n < 1 ? 'under a minute' : n === 1 ? 'about 1 minute' : n < 90 ? `about ${n} minutes` : `about ${Math.round(n / 60)} hours`);

/** Send the message being written to a list of people, each as their own separate email. */
export function BulkPanel({ relay, fromAddressId, fromEmail, subject, content, hasFiles, onClose, onStarted }: {
  relay: MailStore; fromAddressId: string; fromEmail: string; subject: string; content: () => { text: string; html?: string }; hasFiles: boolean; onClose: () => void; onStarted: () => void;
}) {
  const [list, setList] = useState('');
  const [rate, setRate] = useState<number>(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sure, setSure] = useState(false);
  const parsed = useMemo(() => parseRecipients(list), [list]);
  const count = parsed.people.length;
  const body = useMemo(content, []); // eslint-disable-line react-hooks/exhaustive-deps
  const sample = parsed.people[0];
  const real = relay.boot?.sendMode === 'cloudflare' || relay.boot?.serverSenders.includes(fromEmail);
  const problem = !subject.trim() ? 'Give the message a subject first.' : !body.text.trim() ? 'Write the message first.' : parsed.invalid.length ? `${parsed.invalid.length} line${parsed.invalid.length === 1 ? ' is' : 's are'} not an email address: ${parsed.invalid.slice(0, 2).join(', ')}` : count > BULK_MAX ? `At most ${BULK_MAX} people at a time.` : '';

  useEffect(() => setSure(false), [list, rate]);

  const start = async () => {
    setError('');
    setBusy(true);
    try {
      await api.post<BulkJobInfo>('/bulk', { fromAddressId, recipients: list, subject, text: body.text, html: body.html, perMinute: rate });
      relay.notify({ text: real ? `Sending To ${count} People, ${rate} A Minute` : `Dry Run: Saving ${count} Copies To Sent, Nothing Leaves This Server` });
      onStarted();
    } catch (err) {
      setError(failure(err));
      setSure(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay bulk-overlay" role="dialog" aria-modal="true" aria-label="Send To A List" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <button type="button" className="scrim" aria-label="Close" onClick={onClose} />
      <section className="bulk-panel">
        <header><h2 className="grow">Send To A List</h2><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" size={15} weight={2} /></button></header>
        <div className="bulk-body">
          <p className="lede">Everyone on the list gets this message as their own separate email. Nobody sees the other people. Write <code>{'{{first_name}}'}</code>, <code>{'{{name}}'}</code> or <code>{'{{email}}'}</code> in the subject or the message to fill in each person.</p>
          <label>People, One Per Line
            <textarea className="field mono" rows={8} autoFocus value={list} placeholder={'rima@example.com\nBen Karim <ben@example.com>\nchen@example.com, Chen Wei'} onChange={(e) => setList(e.target.value)} />
          </label>
          <div className="bulk-facts">
            <span><b className="num">{count}</b>{count === 1 ? ' Person' : ' People'}</span>
            {parsed.duplicates > 0 && <span><b className="num">{parsed.duplicates}</b> Repeated, Sent Once</span>}
            {parsed.invalid.length > 0 && <span className="bad"><b className="num">{parsed.invalid.length}</b> Not An Address</span>}
            <span className="grow" />
            <label className="rate">Speed
              <select className="field" value={rate} onChange={(e) => setRate(Number(e.target.value))}>{BULK_RATES.map((r) => <option key={r} value={r}>{r} A Minute</option>)}</select>
            </label>
          </div>
          {sample && (
            <div className="bulk-sample">
              <small>How The First Person Sees It</small>
              <b className="truncate">{personalise(subject || '(No Subject)', sample)}</b>
              <span>To {sample.name ? `${sample.name} <${sample.email}>` : sample.email} · From {fromEmail}</span>
              <p>{personalise(body.text, sample).slice(0, 220)}{body.text.length > 220 ? '…' : ''}</p>
            </div>
          )}
          {count > 1 && <p className="fine" style={{ margin: 0 }}>Takes {minutes(Math.ceil(count / rate))}. Each copy appears in Sent, and progress is shown under Settings, Mail System, where it can also be stopped.{hasFiles ? ' Attachments are not included in a bulk send.' : ''}</p>}
          {(problem || error) && <div className="notice warn" role="alert">{error || problem}</div>}
        </div>
        <footer>
          {!real && <span className="pill warn">Dry Run</span>}
          <span className="grow" />
          <button type="button" className="btn small ghost" onClick={onClose}>Cancel</button>
          {sure
            ? <button type="button" className="btn primary" disabled={busy} aria-busy={busy} onClick={() => void start()}>{busy ? 'Starting…' : `Yes, Send To ${count} People`}</button>
            : <button type="button" className="btn primary" disabled={count < 2 || !!problem} onClick={() => setSure(true)}>Send To {count || ''} People</button>}
        </footer>
      </section>
    </div>
  );
}

const STATE: Record<BulkJobInfo['status'], string> = { running: 'Sending', done: 'Finished', cancelled: 'Stopped' };

/** Recent bulk sends with their progress. A running one refreshes by itself and can be stopped. */
export function BulkSends({ relay }: { relay: MailStore }) {
  const [jobs, setJobs] = useState<BulkJobInfo[] | null>(null);
  const load = useCallback(() => { api.get<{ data: BulkJobInfo[] }>('/bulk').then((r) => setJobs(r.data)).catch(() => setJobs([])); }, []);
  useEffect(load, [load]);
  const running = jobs?.some((j) => j.status === 'running') ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(load, 15_000);
    return () => window.clearInterval(timer);
  }, [running, load]);

  if (!jobs || jobs.length === 0) return null;
  return (
    <section className="card bulk-sends">
      <div className="card-head"><h2 className="grow">Bulk Sends</h2><button type="button" className="icon-btn" aria-label="Refresh Bulk Sends" title="Refresh" onClick={load}><Icon name="refresh" size={15} weight={1.8} /></button></div>
      {jobs.map((j) => (
        <div className="bulk-job" key={j.id}>
          <div className="grow" style={{ minWidth: 0 }}>
            <b className="truncate">{j.subject}</b>
            <small className="truncate">From {j.fromEmail} · Started {ago(j.createdAt)}{j.by ? ` By ${j.by}` : ''} · {j.perMinute} A Minute</small>
            <div className="meter" role="img" aria-label={`${j.done} of ${j.total} done`}><span style={{ width: `${(j.done / j.total) * 100}%` }} /></div>
            <small><span className="num">{j.sent}</span> Sent{j.failed > 0 && <> · <span className="num" style={{ color: 'var(--red)' }}>{j.failed} Failed</span></>} · <span className="num">{j.total - j.done}</span> Left{j.lastError ? ` · ${j.lastError}` : ''}</small>
          </div>
          <span className={`pill ${j.status === 'running' ? '' : 'neutral'}`}>{j.status === 'running' && j.startAt > Date.now() ? 'Waiting' : STATE[j.status]}</span>
          {j.status === 'running' && <button type="button" className="btn small" onClick={() => void api.post(`/bulk/${j.id}/cancel`).then(() => { relay.notify({ text: 'Bulk Send Stopped. Copies Already Sent Stay Sent' }); load(); }).catch((err) => relay.notify({ text: failure(err) }))}>Stop</button>}
        </div>
      ))}
    </section>
  );
}
