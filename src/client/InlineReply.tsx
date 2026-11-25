import { useEffect, useMemo, useRef, useState } from 'react';
import type { MessageDetail, Person, ThreadDetail } from '../shared/types';
import { RequestError, api } from './api';
import { fullTime } from './format';
import { Icon } from './icons';
import type { ComposeMode } from './Mail';
import type { MailStore } from './store';

export interface ReplyRequest {
  mode: 'reply' | 'replyAll';
  /** Text to start with, for example a suggested reply. */
  seed?: string;
  /** Changes on every request, so asking twice in a row opens the box twice. */
  nonce: number;
}

/** The last request acted on. It outlives the box, which is built again whenever the reading pane is. */
let answered = 0;

const REWRITES = [['shorter', 'Shorter'], ['warmer', 'Warmer'], ['formal', 'More Formal'], ['grammar', 'Fix Grammar']] as const;
const failure = (err: unknown) => (err instanceof RequestError ? err.message : 'That did not work. Try again.');

function quoteOf(m: MessageDetail): string {
  const who = m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email;
  return `On ${fullTime(m.at)}, ${who} wrote:\n${m.text.trim().split('\n').map((line) => `> ${line}`).join('\n')}`;
}

/**
 * The reply box at the foot of a conversation. It opens in place, so the message being answered
 * stays in view, and AI writing happens inside it: on the words in the box, not on a separate page.
 */
export function InlineReply({ relay, detail, target, request, onFull, onEditDraft }: {
  relay: MailStore; detail: ThreadDetail; target: MessageDetail; request: ReplyRequest | null;
  onFull: (mode: ComposeMode, message: MessageDetail, seed: string) => void; onEditDraft: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'reply' | 'replyAll'>('reply');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ask, setAsk] = useState('');
  const [asking, setAsking] = useState(false);
  const [aiBusy, setAiBusy] = useState('');
  const [undo, setUndo] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const askBox = useRef<HTMLInputElement>(null);
  const aiOn = relay.boot?.ai.connected ?? false;

  const own = useMemo(() => new Set(relay.addresses.map((a) => a.email)), [relay.addresses]);
  const from = relay.addresses.find((a) => a.id === detail.replyFrom);
  const everyone: Person[] = useMemo(() => {
    const base = target.direction === 'out' ? target.to : [target.from];
    const others = [...target.to, ...target.cc].filter((p) => !own.has(p.email) && !base.some((b) => b.email === p.email));
    return [...base, ...others];
  }, [target, own]);
  const canReplyAll = everyone.length > 1;
  const to = mode === 'replyAll' ? everyone : everyone.slice(0, 1);
  const firstName = (to[0]?.name || to[0]?.email || '').split(/[\s@]/)[0];

  // A new conversation starts with a closed, empty box.
  useEffect(() => {
    setOpen(false); setText(''); setError(''); setAsk(''); setAsking(false); setUndo(null); setMode('reply');
  }, [detail.id]);

  useEffect(() => {
    // A request is answered once. Without this, coming back from the compose page, which builds this box
    // again, would open a reply on whichever conversation is read next.
    if (!request || request.nonce === answered || Date.now() - request.nonce > 10_000) return;
    answered = request.nonce;
    setMode(request.mode === 'replyAll' && canReplyAll ? 'replyAll' : 'reply');
    if (request.seed !== undefined) setText(request.seed);
    setOpen(true);
  }, [request?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open) box.current?.focus();
  }, [open, request?.nonce]);

  // The box grows with what is written, up to a limit, then scrolls.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 96), 320)}px`;
  }, [text, open]);

  // The AI writes straight into the box, and the words appear as they are produced.
  const runAi = async (label: string, path: string, body: unknown) => {
    const before = text;
    setError('');
    setAiBusy(label);
    try {
      const final = await api.stream(path, body, (soFar) => {
        setText(soFar);
        const el = box.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
      if (!final) throw new RequestError(409, 'ai_failed', 'The AI returned nothing. Try again.');
      setText(final);
      setUndo(before);
    } catch (err) {
      setText(before);
      setError(failure(err));
    } finally {
      setAiBusy('');
      window.setTimeout(() => box.current?.focus(), 0);
    }
  };
  // One prompt box, two jobs: with an empty box it writes the reply; with words in it, it edits them as asked.
  const editing = text.trim().length > 0;
  const write = () => {
    const said = ask;
    setAsk('');
    setAsking(false);
    return editing
      ? runAi('write', '/ai/rewrite/stream', { text, style: 'custom', instruction: said })
      : runAi('write', `/threads/${detail.id}/ai/reply/stream`, { guidance: said });
  };
  const rewrite = (style: string) => runAi(style, '/ai/rewrite/stream', { text, style });

  const send = async () => {
    setError('');
    if (!from) return setError('You cannot send from the address this conversation arrived at.');
    if (!text.trim()) return setError('Write a reply before sending.');
    setBusy(true);
    try {
      const body = `${text.trim()}${from.signature.trim() ? `\n\n${from.signature.trim()}` : ''}\n\n${quoteOf(target)}`;
      const subject = `Re: ${target.subject.replace(/^((re|fwd?)\s*:\s*)+/i, '')}`;
      const cc = mode === 'replyAll' ? [] : undefined;
      const result = await relay.send({ fromAddressId: from.id, to, cc, subject, text: body, inReplyToMessageId: target.id, undoSeconds: 10 });
      relay.notify({
        text: result.dryRun ? 'Dry Run: Saving To Sent In 10 Seconds' : 'Sending In 10 Seconds',
        undo: () => {
          relay.setToast(null);
          api.post<{ draftId: string }>(`/messages/${result.messageId}/cancel`).then((r) => onEditDraft(r.draftId)).catch((err) => relay.notify({ text: failure(err) }));
        },
      });
      window.setTimeout(() => { void relay.loadList(true); if (relay.selectedId === detail.id) void relay.loadDetail(detail.id, relay.loadImages); }, 11_500);
      setOpen(false);
      setText('');
      setUndo(null);
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="reply-bar">
        <button type="button" className="reply-box" onClick={() => setOpen(true)}>
          <Icon name="reply" />
          <span className="grow truncate">{text.trim() ? text.trim().split('\n')[0] : `Reply To ${firstName}…`}</span>
          {text.trim() && <span className="pill neutral">Unsent</span>}
          <span className="go"><Icon name="send" weight={2} /></span>
        </button>
      </div>
    );
  }

  return (
    <div className="reply-bar">
      <section className="reply-open" aria-label={`Reply To ${firstName}`}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); }
          else if (e.key === 'Escape') { e.stopPropagation(); if (asking) { setAsking(false); box.current?.focus(); } else setOpen(false); }
        }}>
        <header>
          <Icon name={mode === 'replyAll' ? 'replyAll' : 'reply'} size={15} />
          <span className="grow truncate">To {to.map((p) => p.name || p.email).join(', ')}{from ? <span className="from"> · From {from.email}</span> : null}</span>
          {canReplyAll && (
            <div className="tabs" role="tablist" aria-label="Reply To">
              <button type="button" role="tab" aria-selected={mode === 'reply'} onClick={() => setMode('reply')}>Reply</button>
              <button type="button" role="tab" aria-selected={mode === 'replyAll'} onClick={() => setMode('replyAll')}>Reply All</button>
            </div>
          )}
          <button type="button" className="icon-btn" aria-label="Open In Full Compose Page" title="Open In Full Compose Page: Attachments, Formatting, Schedule" onClick={() => onFull(mode, target, text)}><Icon name="layers" size={15} /></button>
          <button type="button" className="icon-btn" aria-label="Close Reply" title="Close (Esc)" onClick={() => setOpen(false)}><Icon name="close" size={14} weight={2} /></button>
        </header>

        <textarea ref={box} aria-label="Your Reply" placeholder={aiOn ? 'Write your reply, or let AI write it below' : 'Write your reply'} value={text} readOnly={!!aiBusy} aria-busy={!!aiBusy} className={aiBusy ? 'writing' : undefined} onChange={(e) => { setText(e.target.value); if (error) setError(''); }} />

        {aiOn && (
          <div className="reply-ai" aria-label="AI Writing">
            {asking ? (
              <form onSubmit={(e) => { e.preventDefault(); void write(); }}>
                <span className="spark"><Icon name="ai" size={14} weight={2} /></span>
                <input ref={askBox} autoFocus aria-label={editing ? 'What Should Change' : 'What Should The Reply Say'} placeholder={editing ? 'What should change? For example: add the delivery date, or write it in German' : 'What should it say? Any language. Leave empty for a suitable reply'} value={ask} onChange={(e) => setAsk(e.target.value)} disabled={!!aiBusy} />
                <button type="submit" className="btn small primary" disabled={!!aiBusy || (editing && !ask.trim())} aria-busy={aiBusy === 'write'}>{editing ? 'Apply' : 'Write'}</button>
                <button type="button" className="icon-btn" aria-label="Cancel AI Writing" onClick={() => { setAsking(false); box.current?.focus(); }}><Icon name="close" size={13} weight={2} /></button>
              </form>
            ) : (
              <>
                <button type="button" className="btn small" disabled={!!aiBusy || detail.flaggedAuth} title={detail.flaggedAuth ? 'Not offered for a sender who failed verification' : undefined} onClick={() => setAsking(true)}><Icon name="ai" size={14} weight={2} />{aiBusy === 'write' ? 'Writing…' : text.trim() ? 'Edit With A Prompt' : 'Write With AI'}</button>
                {text.trim() && REWRITES.map(([style, label]) => (
                  <button key={style} type="button" className="btn small ghost" disabled={!!aiBusy} aria-busy={aiBusy === style} onClick={() => void rewrite(style)}>{aiBusy === style ? 'Working…' : label}</button>
                ))}
                {undo !== null && <button type="button" className="btn small ghost" disabled={!!aiBusy} onClick={() => { setText(undo); setUndo(null); }}>Undo AI Change</button>}
              </>
            )}
          </div>
        )}

        {error && <div className="notice warn" role="alert">{error}</div>}

        <footer>
          <span className="fine">The original message is quoted below your reply{from?.signature.trim() ? ', after your signature' : ''}.</span>
          <span className="grow" />
          {relay.boot?.sendMode !== 'cloudflare' && !relay.boot?.serverSenders.includes(from?.email ?? '') && <span className="pill warn">Dry Run</span>}
          <button type="button" className="btn primary" disabled={busy || !!aiBusy} aria-busy={busy} onClick={() => void send()}>{busy ? 'Sending…' : 'Send'}<span className="mono key-hint" style={{ fontSize: 11, fontWeight: 500, opacity: 0.75 }}>⌘↵</span></button>
        </footer>
      </section>
    </div>
  );
}
