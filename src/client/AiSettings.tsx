import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentInfo, AiOverview, ProviderInfo, ProviderKind } from '../shared/types';
import { RequestError, api } from './api';
import { ago } from './format';
import { Icon } from './icons';
import type { MailStore } from './store';

const failure = (err: unknown) => (err instanceof RequestError ? err.message : 'That did not work. Try again.');

const KIND_LABEL: Record<ProviderKind, string> = { 'workers-ai': 'Cloudflare Workers AI', anthropic: 'Anthropic', openai: 'OpenAI', 'openai-compatible': 'Other (OpenAI-Compatible)' };
const KIND_NOTE: Record<ProviderKind, string> = {
  'workers-ai': 'Runs on your own Cloudflare account, so mail never leaves Cloudflare. Tried first.',
  anthropic: 'Mail text is sent to Anthropic when this provider answers.',
  openai: 'Mail text is sent to OpenAI when this provider answers.',
  'openai-compatible': 'Mail text is sent to the address you enter.',
};

function Switch({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: (next: boolean) => void }) {
  return <button type="button" role="switch" className="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} />;
}

function ProviderRow({ p, reload, relay }: { p: ProviderInfo; reload: () => void; relay: MailStore }) {
  const [busy, setBusy] = useState('');
  const act = async (label: string, work: () => Promise<string>) => {
    setBusy(label);
    try {
      relay.notify({ text: await work() });
      reload();
      void relay.loadBoot();
    } catch (err) {
      relay.notify({ text: failure(err) });
    } finally {
      setBusy('');
    }
  };
  return (
    <div>
      <span className="grow">
        <b>{p.name}</b>
        <small>
          <span className="mono">{p.model}</span>
          {p.keyLast4 ? ` · Key Ending ${p.keyLast4}` : ''}
          {p.kind === 'workers-ai' && !p.usable ? ' · The Workers AI binding is not switched on in wrangler.jsonc' : ''}
        </small>
      </span>
      <span className={`pill ${p.usable ? 'green' : 'neutral'}`}>{p.usable ? 'Ready' : p.enabled ? 'Not Usable' : 'Off'}</span>
      <button type="button" className="btn small" disabled={!!busy || !p.usable} onClick={() => void act('test', async () => { const r = await api.post<{ ms: number; model: string }>(`/ai/providers/${p.id}/test`); return `${p.name} Answered In ${r.ms} ms`; })}>{busy === 'test' ? 'Testing…' : 'Test'}</button>
      <Switch on={p.enabled} label={`Use ${p.name}`} disabled={!!busy} onChange={(next) => void act('toggle', async () => { await api.patch(`/ai/providers/${p.id}`, { enabled: next }); return next ? `${p.name} Switched On` : `${p.name} Switched Off`; })} />
      <button type="button" className="icon-btn" aria-label={`Remove ${p.name}`} title="Remove" disabled={!!busy} onClick={() => window.confirm(`Remove ${p.name}? Its stored key is deleted.`) && void act('remove', async () => { await api.delete(`/ai/providers/${p.id}`); return `${p.name} Removed`; })}><Icon name="trash" size={15} /></button>
    </div>
  );
}

function AddProvider({ data, reload, relay }: { data: AiOverview; reload: () => void; relay: MailStore }) {
  const [kind, setKind] = useState<ProviderKind>('anthropic');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const needsKey = kind !== 'workers-ai';
  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      await api.post('/ai/providers', { kind, model, key, baseUrl });
      setKey('');
      setModel('');
      relay.notify({ text: `${KIND_LABEL[kind]} Added. Press Test To Confirm It Answers.` });
      reload();
      void relay.loadBoot();
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="form-grid">
      <label>
        Provider
        <select className="field" value={kind} onChange={(e) => { setKind(e.target.value as ProviderKind); setModel(''); }}>
          {(Object.keys(KIND_LABEL) as ProviderKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
      </label>
      <label>
        Model
        <input className="field mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder={data.defaults[kind] || 'Model name, as the provider writes it'} />
      </label>
      {kind === 'openai-compatible' && (
        <label className="wide">
          Address
          <input className="field mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" />
        </label>
      )}
      {needsKey && (
        <label className="wide">
          API Key
          <input className="field mono" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Stored encrypted; only the last four characters are ever shown again" />
        </label>
      )}
      <p className="fine wide" style={{ margin: 0 }}><Icon name="shield" size={14} weight={1.8} />{KIND_NOTE[kind]}</p>
      {needsKey && !data.canStoreKeys && <div className="notice warn wide">This installation has no MAIL_SECRET_KEY, so it cannot store a key yet. Add that secret to the Worker first.</div>}
      {kind === 'workers-ai' && !data.workersAiBinding && <div className="notice warn wide">The Workers AI binding is off. Switch on the “ai” block in wrangler.jsonc and restart; Workers AI then works without adding it here.</div>}
      {error && <div className="notice warn wide" role="alert">{error}</div>}
      <div className="wide"><button type="button" className="btn primary" disabled={busy || (needsKey && (!data.canStoreKeys || key.trim().length < 8))} onClick={() => void submit()}>{busy ? 'Adding…' : 'Add Provider'}</button></div>
    </div>
  );
}

function AgentRow({ a, reload, relay, aiReady }: { a: AgentInfo; reload: () => void; relay: MailStore; aiReady: boolean }) {
  const [busy, setBusy] = useState(false);
  const patch = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      await api.patch(`/ai/agents/${a.id}`, body);
      relay.notify({ text: done });
      reload();
    } catch (err) {
      relay.notify({ text: failure(err) });
    } finally {
      setBusy(false);
    }
  };
  const when = a.trigger === 'on-receive' ? 'Runs On Every New Message' : a.trigger === 'schedule' ? 'Runs Every 15 Minutes' : 'Runs When You Ask';
  return (
    <div>
      <span className="grow">
        <b>{a.name}</b>
        <small>{a.instructions}</small>
        <small>{when}{a.usesAi ? ' · One AI Call Per Message' : ' · No AI Cost'}{a.usesAi && a.enabled && !aiReady ? ' · Waiting For A Provider' : ''}</small>
      </span>
      {a.builtin === 'follow-up' && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--ink-2)' }}>
          After
          <select className="field" value={a.followUpDays} disabled={busy} onChange={(e) => void patch({ followUpDays: Number(e.target.value) }, 'Saved')}>
            {[1, 2, 3, 5, 7, 14].map((d) => <option key={d} value={d}>{d} {d === 1 ? 'Day' : 'Days'}</option>)}
          </select>
        </label>
      )}
      <Switch on={a.enabled} label={`Switch ${a.name} On Or Off`} disabled={busy} onChange={(next) => void patch({ enabled: next }, next ? `${a.name} Switched On` : `${a.name} Switched Off`)} />
      {!a.builtin && (
        <button type="button" className="icon-btn" aria-label={`Delete ${a.name}`} title="Delete" disabled={busy} onClick={() => window.confirm(`Delete the agent “${a.name}”?`) && void api.delete(`/ai/agents/${a.id}`).then(reload).catch((err) => relay.notify({ text: failure(err) }))}><Icon name="trash" size={15} /></button>
      )}
    </div>
  );
}

function AddAgent({ reload, relay }: { reload: () => void; relay: MailStore }) {
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [trigger, setTrigger] = useState('manual');
  const [mailboxId, setMailboxId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      await api.post('/ai/agents', { name, instructions, trigger, mailboxId: mailboxId || null });
      relay.notify({ text: `Agent “${name}” Created` });
      setName('');
      setInstructions('');
      reload();
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="form-grid">
      <label>
        Name
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Order Finder" />
      </label>
      <label>
        When It Runs
        <select className="field" value={trigger} onChange={(e) => setTrigger(e.target.value)}>
          <option value="manual">When I Ask, From The Assistant Tab</option>
          <option value="on-receive">On Every New Message</option>
        </select>
      </label>
      <label className="wide">
        Instructions
        <textarea className="field" rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Find any order number, delivery date and amount in the mail and list them. Say “none” when there are none." />
      </label>
      <label>
        Mailbox
        <select className="field" value={mailboxId} onChange={(e) => setMailboxId(e.target.value)}>
          <option value="">Every Mailbox</option>
          {relay.mailboxes.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </label>
      <p className="fine" style={{ margin: 0, alignSelf: 'end' }}><Icon name="shield" size={14} weight={1.8} />An agent reads mail and leaves a note. It cannot send, delete or forward.</p>
      {error && <div className="notice warn wide" role="alert">{error}</div>}
      <div className="wide"><button type="button" className="btn primary" disabled={busy || !name.trim() || instructions.trim().length < 10} onClick={() => void submit()}>{busy ? 'Creating…' : 'Create Agent'}</button></div>
    </div>
  );
}

export function AiSettings({ relay }: { relay: MailStore }) {
  const [data, setData] = useState<AiOverview | null>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState<'' | 'provider' | 'agent'>('');
  const load = useCallback(() => {
    api.get<AiOverview>('/ai').then((d) => { setData(d); setError(''); }).catch((err) => setError(failure(err)));
  }, []);
  useEffect(load, [load]);

  if (error && !data) return <div className="notice warn" role="alert"><span className="grow">{error}</span><button type="button" className="link-btn" onClick={load}>Try Again</button></div>;
  if (!data) return <div className="skeleton" style={{ height: 220, borderRadius: 12 }} />;

  const builtinReady = data.workersAiBinding && !data.providers.some((p) => p.kind === 'workers-ai');
  const aiReady = builtinReady || data.providers.some((p) => p.usable);

  return (
    <>
      <p className="lede" style={{ marginTop: -8 }}>
        Which AI answers, and which agents work on your mail. Cloudflare Workers AI is always tried first; the others follow in the order shown.
        {' '}<b style={{ fontWeight: 600 }}>{data.callsToday} Of {data.dailyLimit}</b> AI calls used today.
      </p>

      <section className="card">
        <div className="card-head"><h2 className="grow">AI Providers</h2><button type="button" className="btn small" onClick={() => setAdding(adding === 'provider' ? '' : 'provider')}><Icon name={adding === 'provider' ? 'close' : 'plus'} size={14} weight={2} />{adding === 'provider' ? 'Close' : 'Add Provider'}</button></div>
        <div className="rows-list">
          {builtinReady && (
            <div>
              <span className="grow"><b>Cloudflare Workers AI</b><small><span className="mono">{data.defaults['workers-ai']}</span> · Built In, Through The Worker’s AI Binding</small></span>
              <span className="pill green">Ready</span>
            </div>
          )}
          {data.providers.map((p) => <ProviderRow key={p.id} p={p} reload={load} relay={relay} />)}
          {!builtinReady && data.providers.length === 0 && (
            <div><span className="grow"><b>No Provider Yet</b><small>Add one below. Until then the assistant, AI writing and AI agents stay off.</small></span></div>
          )}
        </div>
        {adding === 'provider' && <AddProvider data={data} reload={load} relay={relay} />}
      </section>

      <section className="card">
        <div className="card-head"><h2 className="grow">Agents</h2><button type="button" className="btn small" onClick={() => setAdding(adding === 'agent' ? '' : 'agent')}><Icon name={adding === 'agent' ? 'close' : 'plus'} size={14} weight={2} />{adding === 'agent' ? 'Close' : 'New Agent'}</button></div>
        <div className="rows-list">{data.agents.map((a) => <AgentRow key={a.id} a={a} reload={load} relay={relay} aiReady={aiReady} />)}</div>
        {adding === 'agent' && <AddAgent reload={load} relay={relay} />}
      </section>

      <AiActivity relay={relay} stamp={data.runs[0]?.id ?? ''} />
    </>
  );
}

const KEEP = [[7, '7 Days'], [30, '30 Days'], [90, '90 Days'], [0, 'For Ever']] as const;
const KIND: Record<string, string> = { brief: 'Summary', reply: 'Reply Draft', rewrite: 'Rewrite', write: 'Write', test: 'Connection Test', custom: 'Agent' };
interface RunPage { data: AiOverview['runs']; total: number; page: number; pages: number; keepDays: number }

/** AI activity, ten rows to a page. Records can be deleted one by one or all at once, or kept for a chosen time. */
function AiActivity({ relay, stamp }: { relay: MailStore; stamp: string }) {
  const [data, setData] = useState<RunPage | null>(null);
  const [page, setPage] = useState(1);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback((n: number) => {
    api.get<RunPage>(`/ai/runs?page=${n}`).then((d) => { setData(d); setPage(d.page); setError(''); }).catch((err) => setError(err instanceof RequestError ? err.message : 'Could not load AI activity.'));
  }, []);
  useEffect(() => load(1), [load, stamp]);

  const keep = async (days: number) => {
    if (data && days !== 0 && (data.keepDays === 0 || days < data.keepDays) && !window.confirm(`Delete activity older than ${days} days now? This also applies to mail activity. Your mail is not affected.`)) return;
    try {
      await api.patch('/settings', { activityKeepDays: days });
      relay.notify({ text: days === 0 ? 'Activity Is Now Kept For Ever' : `Activity Is Now Kept For ${days} Days` });
      load(1);
    } catch (err) {
      relay.notify({ text: err instanceof RequestError ? err.message : 'Could not save.' });
    }
  };
  const drop = async (id: string | null) => {
    setClearing(false);
    try {
      await api.delete(id ? `/ai/runs/${id}` : '/ai/runs');
      relay.notify({ text: id ? 'Record Deleted' : 'AI Activity Cleared' });
      load(id ? page : 1);
    } catch (err) {
      relay.notify({ text: err instanceof RequestError ? err.message : 'Could not delete.' });
    }
  };

  return (
    <section className="card ai-activity">
      <div className="card-head">
        <h2 className="grow">AI Activity</h2>
        <label className="keep">Keep For
          <select className="field" value={data?.keepDays ?? 30} disabled={!data} onChange={(e) => void keep(Number(e.target.value))}>
            {KEEP.map(([days, label]) => <option key={days} value={days}>{label}</option>)}
          </select>
        </label>
        {clearing ? (
          <>
            <button type="button" className="btn small danger" onClick={() => void drop(null)}>Delete All</button>
            <button type="button" className="btn small ghost" onClick={() => setClearing(false)}>Keep</button>
          </>
        ) : (
          <button type="button" className="btn small" disabled={!data || data.total === 0} onClick={() => setClearing(true)}><Icon name="trash" size={14} />Clear All</button>
        )}
        <button type="button" className="icon-btn" aria-label="Refresh AI Activity" title="Refresh" onClick={() => load(page)}><Icon name="refresh" size={15} weight={1.8} /></button>
      </div>
      {error && <div className="notice warn" role="alert" style={{ margin: 12 }}>{error}</div>}
      {!data && !error && <div className="skeleton" style={{ height: 180, margin: 12 }} />}
      {data && data.total === 0 && <div className="state"><p>No AI activity is recorded.</p></div>}
      {data?.data.map((r) => (
        <div className="log-row" key={r.id}>
          <span className="mono when">{ago(r.at)}</span>
          <span className="what truncate">{r.agent ?? KIND[r.kind] ?? r.kind}</span>
          <span className="grow truncate" style={{ color: r.status === 'failed' ? 'var(--red)' : 'var(--ink-2)' }}>{r.status === 'failed' ? r.error : r.status === 'skipped' ? 'Skipped' : `${r.provider ?? ''} · ${r.model ?? ''}`}</span>
          <span className="mono cost">{r.ms != null ? `${r.ms} ms` : ''}{r.tokensIn != null ? ` · ${r.tokensIn}+${r.tokensOut ?? 0} tok` : ''}</span>
          <button type="button" className="icon-btn" aria-label="Delete This Record" title="Delete" onClick={() => void drop(r.id)}><Icon name="trash" size={14} /></button>
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
