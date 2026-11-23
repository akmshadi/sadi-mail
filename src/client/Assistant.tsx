import { useCallback, useEffect, useState } from 'react';
import type { Brief, MessageDetail, ThreadAi, ThreadDetail } from '../shared/types';
import { RequestError, api } from './api';
import { ago } from './format';
import { Icon } from './icons';
import type { MailStore } from './store';

const failure = (err: unknown) => (err instanceof RequestError ? err.message : 'The assistant could not finish. Try again.');

export function Assistant({ relay, detail, onReply, onOpenSettings }: { relay: MailStore; detail: ThreadDetail | null; onReply: (message: MessageDetail, seed: string) => void; onOpenSettings: () => void }) {
  const [data, setData] = useState<ThreadAi | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const connected = relay.boot?.ai.connected ?? false;
  const isAdmin = relay.boot?.user.role === 'owner' || relay.boot?.user.role === 'admin';
  const id = detail?.id;
  const newest = detail?.messages[detail.messages.length - 1]?.id;

  const load = useCallback(() => {
    if (!id) return setData(null);
    api.get<ThreadAi>(`/threads/${id}/ai`).then(setData).catch((err) => setError(failure(err)));
  }, [id]);
  useEffect(() => {
    setData(null);
    setError('');
    load();
  }, [load, newest]);

  const run = async (label: string, work: () => Promise<void>) => {
    setError('');
    setBusy(label);
    try {
      await work();
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy('');
    }
  };

  if (!connected) {
    return (
      <>
        <div className="ai-off">
          <h3><Icon name="ai" size={15} weight={2} />No AI Provider Connected</h3>
          <p>Once a provider is connected, the assistant works on the open conversation:</p>
          <ul>
            <li>Summarise the thread</li>
            <li>List action items and due dates</li>
            <li>Suggest and draft replies</li>
            <li>Run your own agents on it</li>
          </ul>
          <p>Cloudflare Workers AI is tried first; you can add your own Anthropic or OpenAI key.</p>
          {isAdmin && <button type="button" className="btn small" onClick={onOpenSettings}>Open AI Settings</button>}
        </div>
        <p className="fine"><Icon name="shield" size={14} weight={1.8} />Nothing is sent, deleted or forwarded until you confirm it.</p>
      </>
    );
  }
  if (!detail) return <p className="fine">Open a conversation and the assistant will work on it.</p>;

  const target = [...detail.messages].reverse().find((m) => m.direction === 'in') ?? detail.messages[detail.messages.length - 1]!;
  const canSend = relay.mailboxes.find((m) => m.id === detail.mailboxId)?.can.send ?? false;
  const brief: Brief | null = data?.brief ?? null;
  const summarise = () => run('brief', async () => { const b = await api.post<Brief>(`/threads/${detail.id}/ai/brief`); setData((d) => ({ notes: d?.notes ?? [], agents: d?.agents ?? [], brief: b })); void relay.loadList(true); });
  const draft = () => run('reply', async () => { const r = await api.post<{ text: string }>(`/threads/${detail.id}/ai/reply`, {}); onReply(target, r.text); });

  return (
    <>
      <section className="ai-sec ai-summary">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: 'var(--accent)', display: 'flex' }}><Icon name="ai" size={15} weight={2} /></span>
          <h3 className="grow" style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>Summary</h3>
          {brief && <span style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>{ago(brief.at)}</span>}
        </div>
        {!data && !error && <span className="skeleton" style={{ height: 64 }} />}
        {data && !brief && (
          <>
            <p className="fine">No summary yet for this conversation.</p>
            <button type="button" className="btn small" style={{ alignSelf: 'flex-start' }} disabled={!!busy} aria-busy={busy === 'brief'} onClick={() => void summarise()}>{busy === 'brief' ? 'Reading…' : 'Summarise This Conversation'}</button>
          </>
        )}
        {brief && <p style={{ fontSize: 13.5, lineHeight: 1.6, color: 'var(--ink-2)' }}>{brief.summary}</p>}
        {brief?.stale && (
          <div className="notice"><span className="grow">A newer message arrived after this was written.</span><button type="button" className="link-btn" disabled={!!busy} onClick={() => void summarise()}>{busy === 'brief' ? 'Reading…' : 'Update'}</button></div>
        )}
      </section>

      {brief && brief.actions.length > 0 && (
        <section className="ai-sec ai-actions" style={{ gap: 4 }}>
          <h3 className="eyebrow" style={{ marginBottom: 6 }}>Action Items</h3>
          {brief.actions.map((a, i) => (
            <label key={i} className="todo">
              <input type="checkbox" />
              <span className="grow">{a.text}</span>
              {a.due && <span className="due">{a.due}</span>}
            </label>
          ))}
        </section>
      )}

      {canSend && (
        <section className="ai-sec ai-replies" style={{ gap: 6 }}>
          <h3 className="eyebrow" style={{ marginBottom: 4 }}>Reply</h3>
          {brief?.replies.map((r) => (
            <button key={r} type="button" className="suggest" onClick={() => onReply(target, r)}><span className="grow">{r}</span><Icon name="right" size={14} weight={1.8} /></button>
          ))}
          <button type="button" className="btn small" style={{ alignSelf: 'flex-start' }} disabled={!!busy || detail.flaggedAuth} aria-busy={busy === 'reply'} onClick={() => void draft()}><Icon name="pen" size={14} weight={1.9} />{busy === 'reply' ? 'Drafting…' : 'Draft A Full Reply'}</button>
          {detail.flaggedAuth && <p className="fine">Replies are not drafted for a sender who failed verification.</p>}
        </section>
      )}

      {data && data.notes.length > 0 && (
        <section className="ai-sec ai-notes">
          <h3 className="eyebrow">Drafts And Agent Notes</h3>
          {data.notes.map((n) => (
            <div key={n.id} className="note">
              <b>{n.agent}<span>{ago(n.at)}</span></b>
              {n.status === 'failed' ? <p style={{ color: 'var(--red)' }}>Did not finish: {n.error}</p> : <p>{n.output}</p>}
              {n.kind === 'reply' && n.status === 'ok' && n.output && canSend && <button type="button" className="link-btn" onClick={() => onReply(target, n.output!)}>Open As Reply</button>}
            </div>
          ))}
        </section>
      )}

      {data && data.agents.length > 0 && (
        <section className="ai-sec ai-agents">
          <h3 className="eyebrow">Run An Agent</h3>
          <div className="chips">
            {data.agents.map((a) => (
              <button key={a.id} type="button" className="btn small" disabled={!!busy} aria-busy={busy === a.id} onClick={() => void run(a.id, async () => { await api.post(`/threads/${detail.id}/ai/agents/${a.id}`); load(); })}>{busy === a.id ? 'Running…' : a.name}</button>
            ))}
          </div>
        </section>
      )}

      {error && <div className="notice warn" role="alert">{error}</div>}
      <p className="fine"><Icon name="shield" size={14} weight={1.8} />The assistant reads and drafts. Nothing is sent, deleted or forwarded until you confirm it.</p>
    </>
  );
}
