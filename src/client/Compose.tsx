import { type Letterhead, letterheadReady, renderLetter, withLetterhead } from '../shared/design';
import { BulkPanel } from './Bulk';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AddressInfo, AttachmentInfo, DraftDetail, MessageDetail, Person, TemplateInfo, ThreadDetail } from '../shared/types';
import { type EmailDesign, MAX_BLOCKS, designToText, instantiate, isStarter, newBlock, parseDesign, renderDesign, starter } from '../shared/design';
import { RequestError, api } from './api';
import { Designer } from './Designer';
import { bytes, fullTime, longTime, tomorrowMorning } from './format';
import { Icon } from './icons';
import { Avatar, type ComposeMode } from './Mail';
import type { MailStore } from './store';

export interface ComposeState {
  mode: ComposeMode;
  thread?: ThreadDetail;
  message?: MessageDetail;
  /** Text to start the body with, for example a suggested reply. */
  seed?: string;
  /** A saved draft to carry on with. */
  draft?: DraftDetail;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const textToHtml = (text: string) => text.split('\n').map((line) => `<div>${esc(line) || '<br>'}</div>`).join('');

function quoteHtml(m: MessageDetail): string {
  const who = m.from.name ? `${m.from.name} &lt;${esc(m.from.email)}&gt;` : esc(m.from.email);
  return `<div data-quote="1"><div>On ${esc(fullTime(m.at))}, ${who} wrote:</div><blockquote>${textToHtml(m.text.trim())}</blockquote></div>`;
}

function People({ label, people, setPeople, autoFocus, trailing }: { label: string; people: Person[]; setPeople: (p: Person[]) => void; autoFocus?: boolean; trailing?: React.ReactNode }) {
  const [text, setText] = useState('');
  const [found, setFound] = useState<Person[]>([]);
  const [active, setActive] = useState(0);
  const id = `cmp-${label.toLowerCase()}`;
  useEffect(() => {
    const q = text.trim();
    if (q.length < 2 || EMAIL.test(q)) return setFound([]);
    let stale = false;
    const timer = window.setTimeout(() => {
      api.get<{ data: Person[] }>(`/contacts?q=${encodeURIComponent(q)}`).then((r) => { if (!stale) { setFound(r.data.filter((c) => !people.some((x) => x.email === c.email))); setActive(0); } }).catch(() => undefined);
    }, 140);
    return () => { stale = true; window.clearTimeout(timer); };
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  const choose = (person: Person) => {
    setPeople([...people, person]);
    setText('');
    setFound([]);
  };
  const commit = () => {
    const parts = text.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length || !parts.every((p) => EMAIL.test(p))) return;
    setPeople([...people, ...parts.filter((p) => !people.some((x) => x.email === p.toLowerCase())).map((p) => ({ name: '', email: p.toLowerCase() }))]);
    setText('');
  };
  return (
    <div className="cmp-row">
      <label htmlFor={id}>{label}</label>
      {people.map((p) => (
        <span className="chip" key={p.email}>
          <Avatar name={p.name} email={p.email} size="xs" />
          {p.name || p.email}
          <button type="button" aria-label={`Remove ${p.name || p.email}`} onClick={() => setPeople(people.filter((x) => x.email !== p.email))}><Icon name="close" size={11} weight={2.6} /></button>
        </span>
      ))}
      <input
        id={id} type="email" autoFocus={autoFocus} autoComplete="off" value={text} aria-invalid={text !== '' && !EMAIL.test(text.trim())}
        onChange={(e) => setText(e.target.value)} onBlur={() => window.setTimeout(() => { commit(); setFound([]); }, 150)}
        role="combobox" aria-expanded={found.length > 0} aria-controls={`${id}-list`} aria-autocomplete="list"
        onKeyDown={(e) => {
          if (found.length && e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, found.length - 1)); }
          else if (found.length && e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (found.length && (e.key === 'Enter' || e.key === 'Tab')) { e.preventDefault(); choose(found[active]!); }
          else if (found.length && e.key === 'Escape') { e.stopPropagation(); setFound([]); }
          else if ((e.key === 'Enter' || e.key === ',' || e.key === ' ') && text.trim()) { e.preventDefault(); commit(); }
          else if (e.key === 'Backspace' && !text && people.length) setPeople(people.slice(0, -1));
        }}
      />
      {trailing}
      {found.length > 0 && (
        <div className="suggest-list" id={`${id}-list`} role="listbox">
          {found.map((c, i) => (
            <button key={c.email} type="button" role="option" aria-selected={i === active} onMouseDown={(e) => { e.preventDefault(); choose(c); }}>
              <Avatar name={c.name} email={c.email} />
              <span className="grow" style={{ minWidth: 0 }}><span className="truncate" style={{ display: 'block', fontWeight: 600 }}>{c.name || c.email}</span>{c.name && <small className="truncate" style={{ display: 'block' }}>{c.email}</small>}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const FORMATS: { cmd: string; label: string; body: React.ReactNode; arg?: string }[] = [
  { cmd: 'bold', label: 'Bold', body: <b>B</b> },
  { cmd: 'italic', label: 'Italic', body: <i style={{ fontFamily: 'Georgia, serif' }}>I</i> },
  { cmd: 'underline', label: 'Underline', body: <u>U</u> },
  { cmd: 'insertUnorderedList', label: 'Bulleted List', body: <Icon name="list" size={16} weight={1.8} /> },
  { cmd: 'insertOrderedList', label: 'Numbered List', body: <span className="num" style={{ fontSize: 12, fontWeight: 600 }}>1.</span> },
  { cmd: 'formatBlock', arg: 'blockquote', label: 'Quote', body: <Icon name="quote" size={16} weight={1.8} /> },
];

const REWRITES = [['shorter', 'Shorter'], ['warmer', 'Warmer'], ['formal', 'More Formal'], ['grammar', 'Fix Grammar']] as const;

type Format = 'rich' | 'plain' | 'designed' | 'html';
const FORMAT_NAMES: Record<Format, string> = { rich: 'Rich Text', plain: 'Plain Text', designed: 'Designed', html: 'HTML' };

/** The readable text of an HTML message, for the plain-text copy every email carries. Parsed inertly: nothing in it runs. */
function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, head, title').forEach((n) => n.remove());
  doc.querySelectorAll('br').forEach((n) => n.replaceWith('\n'));
  doc.querySelectorAll('p, div, tr, h1, h2, h3, h4, li, table').forEach((n) => n.append('\n'));
  return (doc.body?.textContent ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** A new design for a message: the Announcement starter, with what the person had written as its text. */
function designFrom(text: string, letterhead?: Letterhead): EmailDesign {
  let d = instantiate(starter('announcement').design);
  if (letterhead && letterheadReady(letterhead)) d = withLetterhead(d, letterhead);
  const at = d.blocks.findIndex((b) => b.type === 'text');
  if (text && at >= 0) d.blocks = d.blocks.map((b, i) => (i === at && b.type === 'text' ? { ...b, text } : b));
  return d;
}

export function ComposePage({ relay, state, onClose, onOpenSettings, onEditDraft }: { relay: MailStore; state: ComposeState; onClose: () => void; onOpenSettings: () => void; onEditDraft: (id: string) => void }) {
  const { mode, thread, message, draft } = state;
  const sendable = useMemo(() => relay.mailboxes.filter((m) => m.can.send).flatMap((m) => m.addresses.map((a) => ({ ...a, mailbox: m.name }))), [relay.mailboxes]);
  const ownEmails = useMemo(() => new Set(relay.addresses.map((a) => a.email)), [relay.addresses]);

  // A reply leaves from the address the conversation arrived at. A new message leaves from the address in view.
  const initialFrom = useMemo(() => {
    const pick = (a: AddressInfo | undefined) => (a && sendable.some((s) => s.id === a.id) ? a.id : undefined);
    if (draft) return pick(relay.addresses.find((a) => a.id === draft.fromAddressId)) ?? sendable[0]?.id ?? '';
    if (thread) return pick(relay.addresses.find((a) => a.id === thread.replyFrom)) ?? sendable[0]?.id ?? '';
    if (relay.scope.addressId) return pick(relay.addresses.find((a) => a.id === relay.scope.addressId)) ?? sendable[0]?.id ?? '';
    const inMailbox = sendable.filter((a) => !relay.scope.mailboxId || a.mailboxId === relay.scope.mailboxId);
    return (inMailbox.find((a) => a.isDefault) ?? inMailbox[0] ?? sendable[0])?.id ?? '';
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [from, setFrom] = useState(initialFrom);
  // With a mailbox chosen, From offers that mailbox's addresses only. The address already in use always stays listed.
  const fromChoices = useMemo(() => {
    const id = relay.scope.mailboxId;
    if (!id) return sendable;
    const own = sendable.filter((a) => a.mailboxId === id || a.id === from);
    return own.length ? own : sendable;
  }, [sendable, relay.scope.mailboxId, from]);
  const fromAddress = sendable.find((a) => a.id === from);
  const [to, setTo] = useState<Person[]>(() => {
    if (draft) return draft.to;
    if (!message || mode === 'forward') return [];
    if (message.direction === 'out') return message.to;
    return mode === 'replyAll' ? [message.from, ...message.to.filter((p) => !ownEmails.has(p.email) && p.email !== message.from.email)] : [message.from];
  });
  const [cc, setCc] = useState<Person[]>(() => (draft ? draft.cc : message && mode === 'replyAll' ? message.cc.filter((p) => !ownEmails.has(p.email)) : []));
  const [bcc, setBcc] = useState<Person[]>(draft?.bcc ?? []);
  const [showCc, setShowCc] = useState(cc.length > 0 || bcc.length > 0);
  const [subject, setSubject] = useState(() => {
    if (draft) return draft.subject;
    if (!message) return '';
    const bare = message.subject.replace(/^((re|fwd?)\s*:\s*)+/i, '');
    return mode === 'forward' ? `Fwd: ${bare}` : `Re: ${bare}`;
  });
  const initialDesign = useMemo(() => (draft?.design ? parseDesign(draft.design) : null), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [bodyFormat, setBodyFormat] = useState<Format>(initialDesign ? 'designed' : 'rich');
  const [design, setDesign] = useState<EmailDesign | null>(initialDesign);
  const plain = bodyFormat === 'plain';
  /** The design being built, or null while the message is written in the editor. */
  const designing = bodyFormat === 'designed' ? design : null;
  const coding = bodyFormat === 'html';
  // The company header and footer of the mailbox this message leaves from.
  const letterhead = relay.mailboxes.find((m) => m.addresses.some((a) => a.id === from))?.letterhead;
  const [letter, setLetter] = useState(false);
  const lettered = letter && bodyFormat === 'rich' && !!letterhead && letterheadReady(letterhead);
  const richHtml = (inner: string) => (lettered ? renderLetter(inner, letterhead!) : `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.6">${inner}</div>`);
  const [rawHtml, setRawHtml] = useState('');
  const htmlFile = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState(false);
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(!!state.seed);
  const [rev, setRev] = useState(state.seed ? 1 : 0);
  const touch = () => { setDirty(true); setRev((r) => r + 1); setError(''); };
  // A warning never outstays its welcome: it goes when the person edits, closes it, or after a few seconds.
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(''), 8000);
    return () => window.clearTimeout(timer);
  }, [error]);
  const editor = useRef<HTMLDivElement>(null);
  const draftId = useRef<string | null>(draft?.id ?? null);
  const saving = useRef<Promise<string | null> | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(draft?.savedAt ?? null);
  const [files, setFiles] = useState<AttachmentInfo[]>(draft?.attachments ?? []);
  const [uploading, setUploading] = useState(0);
  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
  const [tplOpen, setTplOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const [ask, setAsk] = useState('');
  const [editAsk, setEditAsk] = useState('');
  const [language, setLanguage] = useState('');
  const [aiBusy, setAiBusy] = useState('');
  const [aiError, setAiError] = useState('');
  const [undo, setUndo] = useState<string | null>(null);
  const aiOn = relay.boot?.ai.connected ?? false;
  const isAdmin = relay.boot?.user.role === 'owner' || relay.boot?.user.role === 'admin';

  const signatureHtml = (a: typeof fromAddress) => (a?.signatureHtml ? `<div data-signature="1"><br>${a.signatureHtml}</div>` : a?.signature.trim() ? `<div data-signature="1"><br>${textToHtml(a.signature.trim())}</div>` : '');

  // The editor is filled once; after that the person's typing is the source of truth.
  useEffect(() => {
    const el = editor.current;
    if (!el) return;
    // A designed draft keeps its content in the design; the editor waits underneath, empty, in case the person switches back.
    el.innerHTML = initialDesign
      ? `<div data-body="1"><div><br></div></div>${signatureHtml(sendable.find((a) => a.id === initialFrom))}`
      : draft
        ? (draft.html ?? `<div data-body="1">${textToHtml(draft.text)}</div>`)
        : `<div data-body="1">${state.seed ? textToHtml(state.seed) : '<div><br></div>'}</div>${signatureHtml(sendable.find((a) => a.id === initialFrom))}${message ? `<br>${quoteHtml(message)}` : ''}`;
    if (to.length > 0 && !initialDesign) {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el.querySelector('[data-body]')!);
      range.collapse(false);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const changeFrom = (id: string) => {
    // Swap the signature only while it is still the block Sadi Mail placed.
    const block = editor.current?.querySelector('[data-signature]');
    const next = signatureHtml(sendable.find((a) => a.id === id));
    if (block) block.outerHTML = next;
    else if (next) editor.current?.querySelector('[data-body]')?.insertAdjacentHTML('afterend', next);
    setFrom(id);
  };

  const format = (cmd: string, arg?: string) => {
    editor.current?.focus();
    document.execCommand(cmd, false, arg);
    touch();
  };
  const addLink = () => {
    const url = window.prompt('Link address', 'https://');
    if (url && /^(https?:\/\/|mailto:)/i.test(url.trim())) format('createLink', url.trim());
  };

  /** The part the person wrote: everything except the quoted mail and the signature. */
  const ownText = () => {
    const copy = editor.current!.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('[data-quote], [data-signature]').forEach((n) => n.remove());
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-9999px;white-space:pre-wrap';
    holder.appendChild(copy);
    document.body.appendChild(holder);
    const text = copy.innerText.trim();
    holder.remove();
    return text;
  };
  /** Replace what the person wrote, keeping the signature and any quoted mail. */
  const fillBody = (text: string) => {
    const el = editor.current!;
    let body = el.querySelector('[data-body]');
    if (!body) {
      const quote = el.querySelector('[data-quote]')?.outerHTML ?? '';
      const sig = el.querySelector('[data-signature]')?.outerHTML ?? '';
      el.innerHTML = `<div data-body="1"></div>${sig}${quote ? `<br>${quote}` : ''}`;
      body = el.querySelector('[data-body]');
    }
    body!.innerHTML = textToHtml(text);
  };
  const setOwnText = (text: string) => {
    setUndo(editor.current!.innerHTML);
    fillBody(text);
    touch();
  };

  const chooseFormat = (next: Format) => {
    if (next === bodyFormat) return;
    if (designing) {
      if (!window.confirm(`Switch to ${FORMAT_NAMES[next]}? The design is dropped and its text is placed in the editor.`)) return;
      fillBody(designToText(designing));
      setUndo(null);
      setDesign(null);
      setBodyFormat(next);
      touch();
      return;
    }
    if (coding) {
      if (rawHtml.trim() && !window.confirm(`Switch to ${FORMAT_NAMES[next]}? Your HTML is dropped and its text is placed in the editor.`)) return;
      fillBody(htmlToText(rawHtml));
      setRawHtml('');
      if (next === 'designed') setDesign(designFrom(htmlToText(rawHtml), letterhead));
      setBodyFormat(next);
      touch();
      return;
    }
    if (next === 'html') {
      if (ownText() && !window.confirm('Switch to HTML? You will paste or write the whole message as HTML, and what is in the editor now is left out.')) return;
      setBodyFormat('html');
      setError('');
      touch();
      return;
    }
    if (next === 'designed') {
      setDesign(designFrom(ownText(), letterhead));
      setBodyFormat('designed');
      setError('');
      touch();
      return;
    }
    setBodyFormat(next);
  };

  const runAi = async (label: string, work: () => Promise<void>) => {
    setAiError('');
    setAiBusy(label);
    try {
      await work();
    } catch (err) {
      setAiError(err instanceof RequestError ? err.message : 'The assistant could not finish. Try again.');
    } finally {
      setAiBusy('');
    }
  };
  /** Show AI text in the body as it arrives, without touching the signature or the quoted mail. */
  const paint = (text: string) => {
    const body = editor.current?.querySelector('[data-body]');
    if (!body) return;
    body.innerHTML = textToHtml(text);
    body.lastElementChild?.scrollIntoView({ block: 'nearest' });
  };
  /** Stream an AI answer into the message body. If it fails, the body is put back as it was. */
  const streamIn = async (path: string, payload: unknown, withSubject: boolean) => {
    const el = editor.current!;
    const before = el.innerHTML;
    if (!el.querySelector('[data-body]')) setOwnText(ownText()); // make sure there is a body block to write into
    const hadSubject = !!subject.trim();
    const split = (soFar: string) => {
      const m = withSubject ? /^\s*Subject:[ \t]*(.*)\r?\n?/i.exec(soFar) : null;
      return m ? { subject: m[1]!.trim(), body: soFar.slice(m[0].length).replace(/^\s+/, '') } : { subject: '', body: soFar };
    };
    try {
      const final = await api.stream(path, payload, (soFar) => {
        const part = split(soFar);
        if (part.subject && !hadSubject) setSubject(part.subject);
        paint(part.body);
      });
      const part = split(final);
      if (!part.body.trim()) throw new RequestError(409, 'ai_failed', 'The AI returned nothing. Try again.');
      paint(part.body.trim());
      setUndo(before);
      touch();
    } catch (err) {
      el.innerHTML = before;
      throw err;
    }
  };
  const write = () =>
    runAi('write', () =>
      thread && mode !== 'forward'
        ? streamIn(`/threads/${thread.id}/ai/reply/stream`, { guidance: ask }, false)
        : streamIn('/ai/write/stream', { instruction: ask, fromName: fromAddress?.displayName ?? '' }, true),
    );
  const rewrite = (style: string) => runAi(style, () => streamIn('/ai/rewrite/stream', { text: ownText(), style, language }, false));
  const editWith = () => {
    const instruction = editAsk;
    if (!ownText()) { setAiError('Write or draft the message first, then say what to change.'); return Promise.resolve(); }
    return runAi('custom', () => streamIn('/ai/rewrite/stream', { text: ownText(), style: 'custom', instruction }, false).then(() => setEditAsk('')));
  };

  /** Write the draft to the server. Calls made while one is in flight wait for it, so a draft is never created twice. */
  const save = async (): Promise<string | null> => {
    if (saving.current) await saving.current.catch(() => null);
    const el = editor.current;
    if (!el || !from) return draftId.current;
    // A designed draft stores the email it would send plus the design itself, so it reopens in the builder.
    const content = coding
      ? { text: htmlToText(rawHtml), html: rawHtml }
      : designing
      ? { text: designToText(designing), html: renderDesign(designing), design: JSON.stringify(designing) }
      : { text: el.innerText.replace(/\n{3,}/g, '\n\n').trim(), html: el.innerHTML };
    const run = api
      .post<{ id: string; savedAt: number; attachments?: AttachmentInfo[] }>('/drafts', {
        id: draftId.current ?? undefined, fromAddressId: from, to, cc, bcc, subject, ...content,
        inReplyToMessageId: message?.id, mode,
      })
      .then((r) => {
        draftId.current = r.id; setSavedAt(r.savedAt); setDirty(false);
        // A new forward comes back with the original's files already copied onto it.
        if (r.attachments?.length) setFiles((prev) => [...prev, ...r.attachments!.filter((f) => !prev.some((x) => x.id === f.id))]);
        return r.id;
      });
    saving.current = run;
    try {
      return await run;
    } finally {
      saving.current = null;
    }
  };
  // A forward of a message with files is saved at once, so the files show as attached before anything is typed.
  useEffect(() => {
    if (!draft && mode === 'forward' && message?.attachments.some((f) => !f.inline)) void save().catch(() => undefined);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Save a moment after the person stops typing.
  useEffect(() => {
    if (rev === 0) return;
    const timer = window.setTimeout(() => void save().catch(() => undefined), 1200);
    return () => window.clearTimeout(timer);
  }, [rev]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = async () => {
    if (dirty) {
      try {
        await save();
      } catch {
        if (!window.confirm('This message could not be saved as a draft. Leave anyway and lose it?')) return;
      }
    }
    if (draftId.current) relay.notify({ text: 'Saved To Drafts' });
    void relay.loadList(true);
    onClose();
  };
  const discard = async () => {
    if ((dirty || draftId.current) && !window.confirm('Discard this message? It will be deleted.')) return;
    if (draftId.current) await api.delete(`/drafts/${draftId.current}`).catch(() => undefined);
    void relay.loadList(true);
    onClose();
  };

  // After a bulk send starts, the draft it was written in has done its job.
  const discardQuietly = async () => {
    if (draftId.current) await api.delete(`/drafts/${draftId.current}`).catch(() => undefined);
    void relay.loadList(true);
    onClose();
  };

  const attach = async (list: File[]) => {
    if (list.length === 0) return;
    setError('');
    try {
      const id = (await save()) ?? draftId.current;
      if (!id) return setError('Choose an address to send from before attaching a file.');
      for (const file of list) {
        if (file.size > 10 * 1024 * 1024) { setError(`${file.name} is over 10 MB and was not attached.`); continue; }
        setUploading((n) => n + 1);
        try {
          const info = await api.putBlob<AttachmentInfo>(`/drafts/${id}/attachments?filename=${encodeURIComponent(file.name)}`, file);
          setFiles((prev) => [...prev, info]);
        } catch (err) {
          setError(err instanceof RequestError ? `${file.name}: ${err.message}` : `${file.name} could not be attached.`);
        } finally {
          setUploading((n) => n - 1);
        }
      }
    } catch (err) {
      setError(err instanceof RequestError ? err.message : 'The file could not be attached.');
    }
  };
  const detach = (file: AttachmentInfo) => {
    setFiles((prev) => prev.filter((f) => f.id !== file.id));
    if (draftId.current) void api.delete(`/drafts/${draftId.current}/attachments/${file.id}`).catch(() => setFiles((prev) => [...prev, file]));
  };

  const openTemplates = () => {
    setTplOpen(!tplOpen);
    if (!templates) api.get<{ data: TemplateInfo[] }>('/templates').then((r) => setTemplates(r.data)).catch(() => setTemplates([]));
  };
  const useTemplate = (t: TemplateInfo) => {
    setTplOpen(false);
    if (t.design) {
      const d = parseDesign(t.design);
      if (!d) return setError(`The design in “${t.name}” could not be read.`);
      if (designing && !isStarter(designing) && !window.confirm(`Replace your design with the template “${t.name}”?`)) return;
      if (!designing && ownText() && !window.confirm(`Use the designed template “${t.name}”? This message becomes a designed message.`)) return;
      setDesign(instantiate(d));
      setBodyFormat('designed');
      if (t.subject && !subject.trim()) setSubject(t.subject);
      touch();
      return;
    }
    if (designing) {
      // A written template joins the design as a text block, above a closing footer.
      if (designing.blocks.length >= MAX_BLOCKS) return setError(`A design can have at most ${MAX_BLOCKS} blocks.`);
      const fresh = newBlock('text');
      const block = fresh.type === 'text' ? { ...fresh, text: t.body } : fresh;
      const blocks = [...designing.blocks];
      blocks.splice(blocks[blocks.length - 1]?.type === 'footer' ? blocks.length - 1 : blocks.length, 0, block);
      setDesign({ ...designing, blocks });
      if (t.subject && !subject.trim()) setSubject(t.subject);
      touch();
      return;
    }
    const mine = ownText();
    setOwnText(mine ? `${mine}\n\n${t.body}` : t.body);
    if (t.subject && !subject.trim()) setSubject(t.subject);
  };
  const saveAsTemplate = async () => {
    const body = designing ? designToText(designing) : ownText();
    if (designing ? designing.blocks.length === 0 : !body) return setError(designing ? 'Add some blocks to the design, then save it as a template.' : 'Write the message first, then save it as a template.');
    const name = window.prompt('Name for this template', subject.replace(/^((re|fwd?)\s*:\s*)+/i, '').slice(0, 60));
    if (!name?.trim()) return;
    try {
      await api.post('/templates', { name, subject, body, ...(designing ? { design: JSON.stringify(designing) } : {}) });
      setTemplates(null);
      setTplOpen(false);
      relay.notify({ text: `Template “${name.trim()}” Saved` });
    } catch (err) {
      setError(err instanceof RequestError ? err.message : 'The template could not be saved.');
    }
  };

  const submit = async (scheduledFor?: number) => {
    setError('');
    const el = editor.current!;
    const text = coding ? htmlToText(rawHtml) : designing ? designToText(designing) : el.innerText.replace(/\n{3,}/g, '\n\n').trim();
    if (!from) return setError('Choose an address to send from.');
    if (coding && !text) return setError('Paste or write some HTML with visible text before sending.');
    if (to.length + cc.length + bcc.length === 0) return setError('Add at least one recipient.');
    if (coding ? false : designing ? designing.blocks.length === 0 || !text : !ownText() && mode !== 'forward') return setError(designing ? 'Add some content to the design before sending.' : 'Write a message before sending.');
    if (uploading > 0) return setError('Wait for the attachments to finish uploading.');
    setBusy(true);
    setMenu(false);
    try {
      // Make sure the newest text and files are in the draft that is about to be sent.
      const sendingDraft = dirty || draftId.current ? await save() : null;
      const html = coding ? rawHtml : designing ? renderDesign(designing) : plain ? undefined : richHtml(el.innerHTML);
      const result = await relay.send({ fromAddressId: from, to, cc, bcc, subject, text, html, inReplyToMessageId: mode !== 'new' && mode !== 'forward' ? message?.id : undefined, scheduledFor, draftId: sendingDraft ?? undefined, undoSeconds: scheduledFor ? undefined : 10 });
      draftId.current = null;
      if (!scheduledFor && result.status === 'scheduled') {
        relay.notify({
          text: result.dryRun ? 'Dry Run: Saving To Sent In 10 Seconds' : 'Sending In 10 Seconds',
          undo: () => {
            relay.setToast(null);
            api.post<{ draftId: string }>(`/messages/${result.messageId}/cancel`).then((r) => onEditDraft(r.draftId)).catch((err) => relay.notify({ text: err instanceof RequestError ? err.message : 'It was too late to take the message back.' }));
          },
        });
        window.setTimeout(() => void relay.loadList(true), 11_500);
      } else relay.notify({
        text: result.status === 'scheduled' ? `Scheduled For ${longTime(scheduledFor!)}` : result.dryRun ? 'Dry Run: Saved To Sent, Nothing Left This Server' : result.status === 'failed' ? 'The Message Could Not Be Sent. It Is Kept In Sent.' : 'Message Sent',
      });
      onClose();
    } catch (err) {
      setError(err instanceof RequestError ? err.message : 'The message could not be sent. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const [bulk, setBulk] = useState(false);
  const bulkContent = () => {
    const el = editor.current!;
    const text = coding ? htmlToText(rawHtml) : designing ? designToText(designing) : el.innerText.replace(/\n{3,}/g, '\n\n').trim();
    const html = coding ? rawHtml : designing ? renderDesign(designing) : plain ? undefined : richHtml(el.innerHTML);
    return { text, html };
  };
  const title = mode === 'new' ? 'New Message' : mode === 'forward' ? 'Forward' : mode === 'replyAll' ? 'Reply All' : 'Reply';
  const dryRun = relay.boot?.sendMode !== 'cloudflare' && !relay.boot?.serverSenders.includes(fromAddress?.email ?? '');

  if (sendable.length === 0) {
    return (
      <div className="compose-page">
        <div className="state">
          <strong>No Address To Send From</strong>
          <p>{relay.addresses.length ? 'You do not have permission to send from any mailbox. Ask an owner or admin.' : 'Addresses appear here once mail has arrived for them, or an admin adds one in Settings.'}</p>
          <button type="button" className="btn small" onClick={onClose}>Back To Mail</button>
        </div>
      </div>
    );
  }

  return (
    <div className={`compose-page${designing ? ' designing' : ''}`} onKeyDown={(e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); }
      else if (e.key === 'Escape') { e.stopPropagation(); if (menu) setMenu(false); else if (tplOpen) setTplOpen(false); else void close(); }
    }}>
      {bulk && fromAddress && <BulkPanel relay={relay} fromAddressId={fromAddress.id} fromEmail={fromAddress.email} subject={subject} content={bulkContent} hasFiles={files.length > 0} onClose={() => setBulk(false)} onStarted={() => { setBulk(false); void discardQuietly(); }} />}
      <section className="compose-main" aria-label={title}>
        <header className="compose-head">
          <button type="button" className="icon-btn" aria-label="Back To Mail" title="Back (Esc)" onClick={() => void close()}><Icon name="left" size={18} /></button>
          <h1 className="grow truncate">{title}</h1>
          <span className="saved" aria-live="polite" data-state={dirty ? 'saving' : savedAt ? 'saved' : 'idle'}>{dirty ? 'Saving…' : savedAt ? 'Draft Saved' : ''}</span>
          {dryRun && <span className="pill warn" title="SEND_MODE is dry-run. Messages are stored in Sent and never leave this server.">Dry Run: Nothing Is Sent</span>}
          <button type="button" className="icon-btn" aria-label="Discard Message" title="Discard" onClick={() => void discard()}><Icon name="trash" /></button>
          <span className="split">
            <button type="button" className="btn primary" disabled={busy} aria-busy={busy} onClick={() => void submit()}>{busy ? 'Sending…' : 'Send'}<span className="mono key-hint" style={{ fontSize: 11, fontWeight: 500, opacity: 0.75 }}>⌘↵</span></button>
            <button type="button" className="btn primary" aria-label="Schedule Send" aria-expanded={menu} disabled={busy} onClick={() => setMenu(!menu)}><Icon name="down" size={13} weight={2.4} /></button>
            {menu && (
              <div className="menu" role="menu">
                {mode === 'new' && <><button type="button" role="menuitem" onClick={() => { setMenu(false); setBulk(true); }}><Icon name="layers" size={15} weight={1.8} />Send To A List (Bulk)…</button><div className="menu-sep" /></>}
                <div className="menu-label">Send Later</div>
                <button type="button" role="menuitem" onClick={() => void submit(tomorrowMorning())}><Icon name="clock" size={15} weight={1.8} />Tomorrow, 08:00</button>
                <div style={{ display: 'flex', gap: 6, padding: '4px 6px 6px' }}>
                  <input type="datetime-local" aria-label="Pick A Date And Time" value={when} onChange={(e) => setWhen(e.target.value)} className="field" style={{ flex: 1, minWidth: 0 }} />
                  <button type="button" className="btn small" disabled={!when || new Date(when).getTime() <= Date.now()} onClick={() => void submit(new Date(when).getTime())}>Set</button>
                </div>
              </div>
            )}
          </span>
        </header>

        <div className="compose-fields">
          <div className="cmp-row">
            <label htmlFor="cmp-from">From</label>
            <select id="cmp-from" value={from} onChange={(e) => changeFrom(e.target.value)}>
              {fromChoices.map((a) => (
                <option key={a.id} value={a.id}>{a.displayName ? `${a.displayName} <${a.email}>` : a.email}{relay.mailboxes.length > 1 && !relay.scope.mailboxId ? ` · ${a.mailbox}` : ''}</option>
              ))}
            </select>
          </div>
          <People label="To" people={to} setPeople={(p) => { setTo(p); touch(); }} autoFocus={to.length === 0} trailing={!showCc && <button type="button" className="btn small ghost" onClick={() => setShowCc(true)}>Cc Bcc</button>} />
          {showCc && <People label="Cc" people={cc} setPeople={(v) => { setCc(v); touch(); }} />}
          {showCc && <People label="Bcc" people={bcc} setPeople={(v) => { setBcc(v); touch(); }} />}
          <div className="cmp-row">
            <label htmlFor="cmp-subject">Subject</label>
            <input id="cmp-subject" value={subject} onChange={(e) => { setSubject(e.target.value); touch(); }} />
          </div>
        </div>

        <div className="compose-tools" role="toolbar" aria-label="Formatting">
          {bodyFormat === 'rich' && FORMATS.map((f) => (
            <button key={f.cmd + (f.arg ?? '')} type="button" className="icon-btn" aria-label={f.label} title={f.label} onMouseDown={(e) => e.preventDefault()} onClick={() => format(f.cmd, f.arg)}>{f.body}</button>
          ))}
          {bodyFormat === 'rich' && <button type="button" className="icon-btn" aria-label="Add Link" title="Add Link" onMouseDown={(e) => e.preventDefault()} onClick={addLink}><Icon name="link" size={16} weight={1.8} /></button>}
          {bodyFormat === 'rich' && <button type="button" className="btn small ghost hide-phone" onMouseDown={(e) => e.preventDefault()} onClick={() => format('removeFormat')}>Clear Formatting</button>}
          {bodyFormat === 'rich' && <span style={{ width: 1, height: 18, background: 'var(--line)', margin: '0 6px' }} />}
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { const picked = [...(e.target.files ?? [])]; e.target.value = ''; void attach(picked); }} />
          <button type="button" className="icon-btn" aria-label="Attach Files" title="Attach Files" onClick={() => fileInput.current?.click()}><Icon name="clip" size={16} weight={1.8} /></button>
          <span className="pop">
            <button type="button" className="btn small ghost" aria-haspopup="menu" aria-expanded={tplOpen} onClick={openTemplates}>Templates</button>
            {tplOpen && (
              <div className="menu" role="menu">
                <div className="menu-label">Insert A Template</div>
                {!templates && <div className="menu-label" style={{ fontWeight: 400 }}>Loading…</div>}
                {templates?.length === 0 && <div className="menu-label" style={{ fontWeight: 400 }}>No templates yet.</div>}
                {templates?.map((t) => <button key={t.id} type="button" role="menuitem" onClick={() => useTemplate(t)}><Icon name="file" size={15} /><span className="truncate">{t.name}</span>{t.design && <span className="pill neutral">Designed</span>}</button>)}
                <button type="button" role="menuitem" onClick={() => void saveAsTemplate()}><Icon name="plus" size={15} weight={2} />Save This Message As A Template</button>
              </div>
            )}
          </span>
          <span className="grow" />
          {bodyFormat === 'rich' && letterhead && letterheadReady(letterhead) && (
            <label className="letter-switch" title="Send this message inside your company header and footer"><button type="button" role="switch" className="switch" aria-checked={letter} aria-label="Company Letterhead" onClick={() => setLetter(!letter)} />Letterhead</label>
          )}
          <div className="tabs" role="tablist" aria-label="Message Format">
            {(['rich', 'plain', 'designed', 'html'] as const).map((f) => (
              <button key={f} type="button" role="tab" aria-selected={bodyFormat === f} onClick={() => chooseFormat(f)}>{FORMAT_NAMES[f]}</button>
            ))}
          </div>
        </div>
        {designing && mode !== 'new' && (
          <p className="compose-hint">A designed message is sent without the {mode === 'forward' ? 'forwarded message' : 'quoted conversation'}.</p>
        )}

        <div
          ref={editor} hidden={!!designing || coding} className={`compose-editor${plain ? ' plain' : ''}`} contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label="Message"
          onInput={() => touch()}
          onPaste={(e) => {
            // Pasted content comes in as plain text, so no outside styling or tracking images ride along.
            e.preventDefault();
            document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
          }}
        />
        {coding && (
          <div className="html-mode">
            <div className="html-code">
              <div className="html-bar">
                <b className="grow">Your HTML</b>
                <input ref={htmlFile} type="file" accept=".html,.htm,text/html" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; if (f.size > 400_000) return setError('That file is over 400 KB. Email programs cut off messages that large.'); void f.text().then((t) => { setRawHtml(t); touch(); }); }} />
                <button type="button" className="btn small" onClick={() => htmlFile.current?.click()}><Icon name="file" size={14} />Open HTML File</button>
              </div>
              <textarea className="field" aria-label="Message HTML" spellCheck={false} value={rawHtml} placeholder={'<h1>Hello</h1>\n<p>Paste the HTML of your email here, or open an .html file.</p>'} onChange={(e) => { setRawHtml(e.target.value); touch(); }} />
              <span className="fine">Sent exactly as written, with a plain-text copy made from its words. Use inline styles and full image addresses (https://…): email programs ignore scripts and most style sheets.</span>
            </div>
            <div className="html-preview">
              <div className="html-bar"><b className="grow">Preview</b><span className="num">{bytes(new Blob([rawHtml]).size)}</span></div>
              <iframe title="Preview Of Your HTML Message" sandbox="" srcDoc={rawHtml || '<p style="font:14px system-ui;color:#64748b;padding:16px">The preview appears here.</p>'} />
            </div>
          </div>
        )}
        {designing && <Designer design={designing} letterhead={letterhead} onChange={(d) => { setDesign(d); touch(); }} />}
        {(files.length > 0 || uploading > 0) && (
          <div className="files-edit" aria-label="Attachments">
            {files.map((f) => (
              <span key={f.id} className="file-pill">
                <Icon name="clip" size={14} weight={1.8} /><span className="truncate">{f.filename}</span><small>{bytes(f.size)}</small>
                <button type="button" className="icon-btn" aria-label={`Remove ${f.filename}`} onClick={() => detach(f)}><Icon name="close" size={12} weight={2.4} /></button>
              </span>
            ))}
            {uploading > 0 && <span className="file-pill"><small>Uploading {uploading} {uploading === 1 ? 'File' : 'Files'}…</small></span>}
          </div>
        )}
        {error && <div className="notice warn" role="alert" style={{ margin: '0 24px 16px' }}><span className="grow">{error}</span><button type="button" className="icon-btn" aria-label="Dismiss" style={{ width: 26, height: 26 }} onClick={() => setError('')}><Icon name="close" size={13} weight={2} /></button></div>}
      </section>

      {!designing && !coding && aiOn && <aside className="compose-ai" aria-label="AI Writing">
        <h2><Icon name="ai" size={15} weight={2} />AI Writing</h2>
        {!aiOn ? (
          <div className="ai-off">
            <h3>No AI Provider Connected</h3>
            <p>Connect Cloudflare Workers AI, or add an Anthropic or OpenAI key, to draft and rewrite messages here.</p>
            {isAdmin && <button type="button" className="btn small" onClick={() => void save().catch(() => undefined).then(onOpenSettings)}>Open AI Settings</button>}
          </div>
        ) : (
          <>
            <section>
              <label className="eyebrow" htmlFor="ai-ask">{thread && mode !== 'forward' ? 'What Should The Reply Say?' : 'What Should This Message Say?'}</label>
              <textarea id="ai-ask" className="field" rows={3} value={ask} onChange={(e) => setAsk(e.target.value)} placeholder={thread ? 'Thursday 15:00 works; ask for the redline first. Any language.' : 'Ask the printer for a quote on 500 brochures. Any language.'} />
              <button type="button" className="btn small" disabled={!!aiBusy || (!thread && !ask.trim())} aria-busy={aiBusy === 'write'} onClick={() => void write()}>
                <Icon name="ai" size={14} weight={2} />{aiBusy === 'write' ? 'Writing…' : thread && mode !== 'forward' ? 'Draft Reply' : 'Write Draft'}
              </button>
            </section>
            <section>
              <label className="eyebrow" htmlFor="ai-edit">Edit With A Prompt</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input id="ai-edit" className="field" style={{ flex: 1, minWidth: 0 }} placeholder="What should change? Any language" value={editAsk} onChange={(e) => setEditAsk(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && editAsk.trim() && !aiBusy) { e.preventDefault(); void editWith(); } }} />
                <button type="button" className="btn small" disabled={!!aiBusy || !editAsk.trim()} aria-busy={aiBusy === 'custom'} onClick={() => void editWith()}>{aiBusy === 'custom' ? 'Working…' : 'Apply'}</button>
              </div>
              <span className="eyebrow">Quick Rewrites</span>
              <div className="chips">
                {REWRITES.map(([style, label]) => (
                  <button key={style} type="button" className="btn small" disabled={!!aiBusy} aria-busy={aiBusy === style} onClick={() => void rewrite(style)}>{aiBusy === style ? 'Working…' : label}</button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input className="field" style={{ flex: 1, minWidth: 0 }} aria-label="Language To Translate Into" placeholder="Language" value={language} onChange={(e) => setLanguage(e.target.value)} />
                <button type="button" className="btn small" disabled={!!aiBusy || !language.trim()} aria-busy={aiBusy === 'translate'} onClick={() => void rewrite('translate')}>{aiBusy === 'translate' ? 'Working…' : 'Translate'}</button>
              </div>
            </section>
            {undo !== null && (
              <button type="button" className="btn small ghost" style={{ alignSelf: 'flex-start' }} onClick={() => { editor.current!.innerHTML = undo; setUndo(null); }}>Undo Last AI Change</button>
            )}
            {aiError && <div className="notice warn" role="alert">{aiError}</div>}
            <p className="fine"><Icon name="shield" size={14} weight={1.8} />The assistant only writes into this draft. Nothing is sent until you press Send.</p>
          </>
        )}
      </aside>}
    </div>
  );
}
