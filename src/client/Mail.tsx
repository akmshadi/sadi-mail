import { FilterPanel, describeFilters } from './Filters';
import { NO_FILTERS, filtersOn } from './store';
import { Fragment, useEffect, useRef, useState } from 'react';
import type { InboxSection, MessageDetail, ThreadDetail, ThreadSummary, View } from '../shared/types';
import { api } from './api';
import { bytes, dayGroup, fileKind, initials, longTime, nextMonday, shortTime, tomorrowMorning, tone } from './format';
import { Icon, type IconName } from './icons';
import { Assistant } from './Assistant';
import { InlineReply, type ReplyRequest } from './InlineReply';
import type { MailStore, Tab } from './store';

export const VIEW_TITLES: Record<View, string> = {
  inbox: 'Inbox', unread: 'Unread', starred: 'Starred', snoozed: 'Snoozed', sent: 'Sent', scheduled: 'Scheduled', drafts: 'Drafts', archive: 'Archive', spam: 'Spam', trash: 'Trash',
};

export const SECTION_TITLES: Record<InboxSection, string> = { primary: 'Primary', social: 'Social', promotions: 'Promotions', updates: 'Updates', forums: 'Forums' };
const SECTION_ORDER: InboxSection[] = ['primary', 'social', 'promotions', 'updates', 'forums'];

export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward';

export function Avatar({ name, email, size = '' }: { name: string; email: string; size?: '' | 'lg' | 'xl' | 'xs' }) {
  return <span className={`avatar ${size} t${tone(email)}`}>{initials(name, email)}</span>;
}

// ---------- list ----------

function EmptyList({ relay }: { relay: MailStore }) {
  const { view, tab, allThreads, boot } = relay;
  if (allThreads.length > 0) {
    return (
      <div className="state">
        <strong>Nothing Under {tab}</strong>
        <p>Every conversation here has been dealt with.</p>
        <button className="btn small" onClick={() => relay.setTab('All')}>Show All</button>
      </div>
    );
  }
  if (view === 'inbox' && relay.section !== 'all' && !relay.labelId) {
    return (
      <div className="state">
        <strong>Nothing Under {SECTION_TITLES[relay.section]}</strong>
        <p>Mail is sorted into these tabs as it arrives. The rest of the Inbox is under All Mail.</p>
        <button className="btn small" onClick={() => relay.setSection('all')}>Show All Mail</button>
      </div>
    );
  }
  if (view === 'inbox' && boot && boot.storage.messages === 0) {
    return (
      <div className="state">
        <strong>No Mail Yet</strong>
        <p>Sadi Mail is ready. Point a Cloudflare Email Routing rule at this Worker, or load sample mail on your own machine with:</p>
        <span className="mono">pnpm seed</span>
      </div>
    );
  }
  const text: Record<View, string> = {
    inbox: 'You are all caught up.', unread: 'Nothing unread.', starred: 'Star a conversation with S to keep it here.', sent: 'Messages you send appear here.',
    scheduled: 'Messages waiting for their send time appear here.', drafts: 'No drafts.', archive: 'Archive a conversation with E to move it out of the inbox.',
    spam: 'Nothing in spam.', trash: 'Trash is empty.', snoozed: 'Snooze a conversation and it waits here until its time.',
  };
  return (
    <div className="state">
      <strong>{VIEW_TITLES[view]} Is Empty</strong>
      <p>{text[view]}</p>
    </div>
  );
}

function Row({ thread, current, showAddress, onPick, picked, onTogglePick }: { thread: ThreadSummary; current: boolean; showAddress: boolean; onPick: () => void; picked: boolean; onTogglePick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (current) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [current]);
  return (
    <li className={`row-wrap${picked ? ' picked' : ''}`}>
      <button type="button" className="row-check" role="checkbox" aria-checked={picked} aria-label={`Select Conversation: ${thread.subject}`} onClick={onTogglePick}><i>{picked && <Icon name="check" size={11} weight={3} />}</i></button>
      <button ref={ref} type="button" className={`row-btn${thread.unread ? ' unread' : ''}`} aria-current={current} onClick={onPick}>
        <Avatar name={thread.fromName} email={thread.fromEmail} />
        <span className="row-main">
          <span className="row-top">
            <span className="row-from truncate">{thread.fromName || thread.fromEmail}{thread.messageCount > 1 && <span className="num" style={{ color: 'var(--ink-3)', fontWeight: 500 }}> {thread.messageCount}</span>}</span>
            <span className="row-time num">{shortTime(thread.lastAt)}</span>
          </span>
          <span className="row-subject truncate">{thread.subject}</span>
          <span className="row-snippet">
            <span className="grow truncate">{thread.snippet}</span>
            {thread.hasAttachment && thread.files.length === 0 && <span role="img" aria-label="Has Attachment" style={{ display: 'flex' }}><Icon name="clip" size={14} weight={1.8} /></span>}
            <span role="img" aria-label={thread.starred ? 'Starred' : 'Not Starred'} className={thread.starred ? 'star-on' : 'star-off'} style={{ display: 'flex' }}>
              <Icon name="star" size={15} fill={thread.starred ? 'currentColor' : 'none'} />
            </span>
          </span>
          {thread.flaggedAuth ? (
            <span className="row-flag red">Suspicious Sender</span>
          ) : thread.followUp ? (
            <span className="row-flag accent">No Reply Yet</span>
          ) : thread.priority ? (
            <span className="row-flag accent">Priority</span>
          ) : thread.needsReply && !thread.unread ? (
            <span className="row-flag accent">Waiting On You</span>
          ) : thread.snoozedUntil ? (
            <span className="row-flag muted">Snoozed Until {longTime(thread.snoozedUntil)}</span>
          ) : showAddress ? (
            <span className="row-flag muted truncate">{thread.addressEmail}</span>
          ) : null}
          {thread.files.length > 0 && (
            <span className="row-files" aria-label={`${thread.fileCount} ${thread.fileCount === 1 ? 'Attachment' : 'Attachments'}`}>
              {thread.files.slice(0, 2).map((name, i) => (
                <span key={i} className="file-chip"><span className={`kind${fileKind(name) === 'PDF' ? ' pdf' : ''}`}>{fileKind(name)}</span><span className="truncate">{name}</span></span>
              ))}
              {thread.fileCount > 2 && <span className="file-chip more num">+{thread.fileCount - 2}</span>}
            </span>
          )}
          {thread.labels.length > 0 && (
            <span className="row-labels">{thread.labels.map((l) => <span key={l.id} className="label-chip"><i className="swatch" style={{ background: l.color }} />{l.name}</span>)}</span>
          )}
        </span>
      </button>
    </li>
  );
}

export function ThreadList({ relay, onOpen }: { relay: MailStore; onOpen: (id: string) => void }) {
  const { threads, view, tab, listLoad, counts, scope } = relay;
  const tabs: Tab[] = ['All', 'Unread', 'Needs Reply'];
  let lastGroup = '';
  const groupCounts = new Map<string, number>();
  for (const t of threads) groupCounts.set(dayGroup(t.lastAt), (groupCounts.get(dayGroup(t.lastAt)) ?? 0) + 1);

  // Older pages load by themselves when the end of the list comes near.
  const more = useRef<HTMLLIElement>(null);
  const [filtering, setFiltering] = useState(false);
  const active = filtersOn(relay.filters);
  const loadMore = relay.loadMore;
  const cursor = relay.nextCursor;
  useEffect(() => {
    const el = more.current;
    if (!el || !cursor) return;
    const watch = new IntersectionObserver((seen) => { if (seen.some((s) => s.isIntersecting)) void loadMore(); }, { rootMargin: '600px 0px' });
    watch.observe(el);
    return () => watch.disconnect();
  }, [cursor, loadMore, threads.length]);

  return (
    <section className="list" aria-label="Message List">
      <div className="list-head">
        <div className="list-title">
          <h1 className="truncate">{relay.labelId ? (relay.labels.find((l) => l.id === relay.labelId)?.name ?? 'Label') : VIEW_TITLES[view]}</h1>
          {view === 'inbox' && counts.inbox > 0 && <span className="pill num">{counts.inbox} Unread</span>}
          <span className="grow" />
          <button type="button" className={`icon-btn filter-btn${active ? ' on' : ''}`} aria-label={active ? 'Filters: On' : 'Filter By Date And Sender'} title="Filter By Date, Time, Sender Or Attachments" aria-expanded={filtering} onClick={() => setFiltering(!filtering)}><Icon name="filter" size={15} weight={1.8} /></button>
          <button type="button" className="icon-btn" aria-label="Refresh" title="Refresh" onClick={() => void relay.loadList()}><Icon name="refresh" size={15} weight={1.8} /></button>
        </div>
        {filtering && <FilterPanel value={relay.filters} onChange={relay.setFilters} onClose={() => setFiltering(false)} />}
        {active && !filtering && (
          <div className="filter-bar"><Icon name="filter" size={13} weight={2} /><span className="grow truncate">{describeFilters(relay.filters)}</span><button type="button" className="link-btn" onClick={() => relay.setFilters(NO_FILTERS)}>Clear</button></div>
        )}
        {view === 'inbox' && !relay.labelId && (
          <div className="sections" role="tablist" aria-label="Inbox Sections">
            {(['all', ...SECTION_ORDER] as const).map((s) => {
              const unread = s === 'all' ? relay.counts.inbox : relay.counts.sections[s];
              return (
                <button key={s} type="button" role="tab" aria-selected={relay.section === s} title={s === 'all' ? 'Every Conversation In The Inbox' : SECTION_TITLES[s]} onClick={() => relay.setSection(s)}>
                  {s === 'all' ? 'All Mail' : s === 'promotions' ? 'Promos' : SECTION_TITLES[s]}
                  {unread > 0 && <span className="num" aria-label={`${unread} Unread`}>{unread}</span>}
                </button>
              );
            })}
          </div>
        )}
        <div className="list-tools">
          <button type="button" className="select-all" role="checkbox" aria-checked={threads.length > 0 && relay.picked.size === threads.length ? true : relay.picked.size > 0 ? 'mixed' : false}
            aria-label="Select All On This Page" title="Select All On This Page" disabled={threads.length === 0}
            onClick={() => (relay.picked.size === threads.length ? relay.clearPicked() : relay.pickAll(threads.map((t) => t.id)))}>
            <i>{relay.picked.size > 0 && <Icon name={relay.picked.size === threads.length ? 'check' : 'minus'} size={11} weight={3} />}</i>
            <span>Select All</span>
          </button>
          <div className="tabs" role="tablist" aria-label="Filter Messages">
            {tabs.map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => relay.setTab(t)}>{t}</button>
            ))}
          </div>
        </div>
      </div>

      {listLoad === 'loading' && (
        <div aria-busy="true" aria-label="Loading Messages" style={{ padding: '0 8px' }}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div className="skel-row" key={i}>
              <span className="skeleton" style={{ width: 36, height: 36, borderRadius: 18 }} />
              <span className="grow" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span className="skeleton" style={{ height: 12, width: '55%' }} />
                <span className="skeleton" style={{ height: 12, width: '90%' }} />
                <span className="skeleton" style={{ height: 12, width: '70%' }} />
              </span>
            </div>
          ))}
        </div>
      )}
      {listLoad === 'error' && (
        <div className="state" role="alert">
          <strong>Could Not Load Mail</strong>
          <p>{relay.listError}</p>
          <button className="btn small" onClick={() => void relay.loadList()}>Try Again</button>
        </div>
      )}
      {(view === 'trash' || view === 'spam') && !relay.labelId && (
        <div className="notice" style={{ margin: '0 12px 8px', padding: '8px 12px', fontSize: 12.5 }}>
          <span className="grow">{view === 'spam' ? 'Mail from blocked or forged senders.' : 'Deleted conversations.'} Removed for good after 30 days.</span>
          {threads.length > 0 && <button type="button" className="link-btn" onClick={() => void relay.emptyFolder(view)}>{view === 'trash' ? 'Empty Trash' : 'Empty Spam'}</button>}
        </div>
      )}
      {relay.picked.size > 0 && (
        <div className="bulk" role="toolbar" aria-label="Selected Conversations">
          <span className="num">{relay.picked.size} Selected</span>
          <span className="grow" />
          <button type="button" className="btn small ghost" title="Mark Selected As Read" onClick={() => void relay.actPicked('read')}>Read</button>
          <button type="button" className="btn small ghost" title="Mark Selected As Unread" onClick={() => void relay.actPicked('unread')}>Unread</button>
          {view !== 'trash' && <button type="button" className="btn small ghost" title={view === 'inbox' ? 'Archive Selected' : 'Move Selected To Inbox'} onClick={() => void relay.actPicked(view === 'inbox' ? 'archive' : 'inbox')}>{view === 'inbox' ? 'Archive' : 'To Inbox'}</button>}
          {view === 'trash'
            ? <button type="button" className="btn small ghost" title="Move Selected Back To The Inbox" onClick={() => void relay.actPicked('inbox')}>Restore</button>
            : <button type="button" className="btn small ghost danger" title="Move Selected To Trash" onClick={() => void relay.actPicked('trash')}>Delete</button>}
          <button type="button" className="icon-btn" aria-label="Clear Selection" title="Clear" onClick={relay.clearPicked}><Icon name="close" size={14} weight={2} /></button>
        </div>
      )}
      {listLoad === 'ready' && threads.length === 0 && <EmptyList relay={relay} />}
      {listLoad === 'ready' && threads.length > 0 && (
        <ul className={`rows${relay.picked.size ? ' picking' : ''}`}>
          {threads.map((t) => {
            const g = dayGroup(t.lastAt);
            const head = g !== lastGroup;
            lastGroup = g;
            return (
              <Fragment key={t.id}>
                {head && (
                  <li className="group" aria-hidden="true"><span className="grow">{g}</span><span className="n num">{groupCounts.get(g)}</span></li>
                )}
                <Row thread={t} current={relay.selectedId === t.id} showAddress={!scope.addressId} onPick={() => onOpen(t.id)} picked={relay.picked.has(t.id)} onTogglePick={() => relay.togglePick(t.id)} />
              </Fragment>
            );
          })}
          {relay.nextCursor
            ? <li ref={more} className="more" aria-live="polite"><span className="spin" aria-hidden="true" />{relay.loadingMore ? 'Loading Older Mail…' : 'Older Mail Loads As You Scroll'}</li>
            : threads.length > 12 && <li className="more end">End Of List · {threads.length} Conversations</li>}
        </ul>
      )}
    </section>
  );
}

// ---------- reader ----------

const FRAME_STYLE = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src data:"><base target="_blank"><style>html{color-scheme:light}body{margin:0;padding:0;font:15px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;color:#1f2937;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}a{color:#4338ca}img[data-sadi-mail-blocked][width="1"],img[data-sadi-mail-blocked][height="1"],img[data-sadi-mail-blocked][width="0"]{display:none!important}img[data-sadi-mail-blocked]{display:inline-block;min-width:24px;min-height:24px;background:#f1f5f9;border:1px dashed #cbd5e1;border-radius:4px}blockquote{margin:0 0 0 8px;padding-left:12px;border-left:2px solid #e5eaf2;color:#475569}</style>`;

/** In the dark theme a simple message (no colours of its own) is shown dark too, instead of as a bright white box. */
const DARK_FRAME_STYLE = `<style>html{color-scheme:dark}body{color:#e5e7eb;background:#16191f}a{color:#aab1fb}blockquote{border-left-color:#2a2f3a;color:#9aa3b2}</style>`;

/** A simple message (no colours or layout of its own) reads like the rest of the page: same type, no box around it. */
const PLAIN_FRAME_STYLE = `<style>body{padding:2px 0 8px;font-size:15.5px;line-height:1.7}p{margin:0 0 1em}p:last-child{margin-bottom:0}</style>`;

/** A designed email sets its own colours or layout tables; those keep their white page in every theme. */
function hasOwnColours(html: string): boolean {
  return /bgcolor\s*=|background(-color)?\s*:|<table[\s>]|\scolor\s*:\s*#(?:f{3}|f{6})\b/i.test(html);
}

/** Follows the theme the app sets on <html data-theme>. */
function useDarkTheme(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark');
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setDark(root.dataset.theme === 'dark'));
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/** Message HTML runs in a frame that cannot execute scripts; its height follows its content. */
function HtmlBody({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const plain = !hasOwnColours(html);
  const dark = useDarkTheme() && plain;
  const [height, setHeight] = useState(120);
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | undefined;
    const measure = () => {
      const doc = frame.contentDocument;
      if (!doc?.documentElement || !doc.body) return;
      // A designed email is often built 600 px wide or more. Rather than cut it off, shrink it to fit the column.
      doc.body.style.zoom = '1';
      const natural = doc.documentElement.scrollWidth;
      const room = frame.clientWidth;
      if (room > 0 && natural > room + 1) doc.body.style.zoom = String(Math.max(0.3, room / natural));
      // Measure the content itself, never the page: a page is at least as tall as its frame, so measuring it
      // after the frame grew would report the frame's own height back and the message would grow without end.
      const range = doc.createRange();
      range.selectNodeContents(doc.body);
      const content = range.getBoundingClientRect();
      const box = doc.body.getBoundingClientRect();
      const style = frame.contentWindow?.getComputedStyle(doc.body);
      const below = style ? (parseFloat(style.paddingBottom) || 0) + (parseFloat(style.marginBottom) || 0) : 0;
      const scale = box.width > 0 && doc.body.offsetWidth > 0 ? box.width / doc.body.offsetWidth : 1;
      const scrolled = frame.contentWindow?.scrollY ?? 0;
      const bottom = (content.height > 0 ? content.bottom : box.bottom - below * scale) + scrolled + below * scale;
      setHeight(Math.min(Math.max(Math.ceil(bottom) + 1, 60), 20_000));
    };
    const onLoad = () => {
      measure();
      const body = frame.contentDocument?.body;
      if (body) {
        observer = new ResizeObserver(measure);
        observer.observe(body);
        observer.observe(frame);
      }
    };
    frame.addEventListener('load', onLoad);
    return () => {
      frame.removeEventListener('load', onLoad);
      observer?.disconnect();
    };
  }, [html, dark]);
  return <iframe ref={ref} className={`msg-frame${plain ? ' plain' : ''}${dark ? ' dark' : ''}`} title="Message Content" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={FRAME_STYLE + (plain ? PLAIN_FRAME_STYLE : '') + (dark ? DARK_FRAME_STYLE : '') + html} style={{ height }} />;
}

function authInfo(m: MessageDetail): { icon: 'shield' | 'shieldX' | 'shieldOff' | 'send'; cls: string; label: string } {
  if (m.direction === 'out') return { icon: 'send', cls: 'auth-none', label: 'Sent From This Mailbox' };
  if (m.auth.dmarc === 'fail') return { icon: 'shieldX', cls: 'auth-fail', label: 'DMARC Failed: The Sender Could Not Be Verified' };
  if (m.auth.dmarc === 'pass') return { icon: 'shield', cls: 'auth-pass', label: `Verified Sender: SPF ${m.auth.spf}, DKIM ${m.auth.dkim}, DMARC pass` };
  return { icon: 'shieldOff', cls: 'auth-none', label: 'No Authentication Result For This Message' };
}

const STATUS_PILL: Partial<Record<MessageDetail['status'], { text: string; cls: string }>> = {
  dry_run: { text: 'Dry Run: Not Sent', cls: 'warn' },
  scheduled: { text: 'Scheduled', cls: '' },
  failed: { text: 'Failed To Send', cls: 'red' },
  draft: { text: 'Draft', cls: 'neutral' },
};

function Message({ m, relay, onReply, onEditDraft }: { m: MessageDetail; relay: MailStore; onReply: () => void; onEditDraft: (id: string) => void }) {
  const takeBack = () =>
    void api.post<{ draftId: string }>(`/messages/${m.id}/cancel`).then((r) => { relay.notify({ text: 'Taken Back. It Is A Draft Again.' }); onEditDraft(r.draftId); }).catch((err: Error) => { relay.notify({ text: err.message }); void relay.loadDetail(relay.selectedId ?? '', relay.loadImages); });
  const a = authInfo(m);
  const pill = STATUS_PILL[m.status];
  const files = m.attachments.filter((f) => !f.inline);
  const save = (id: string, filename: string) => void api.download(`/attachments/${id}`, filename).catch((err: Error) => relay.notify({ text: err.message }));
  return (
    <div className="msg">
      <div className="msg-head">
        <Avatar name={m.from.name} email={m.from.email} size="lg" />
        <div className="grow" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div className="msg-who">
            <b>{m.from.name || m.from.email}</b>
            <span role="img" aria-label={a.label} title={a.label} className={a.cls} style={{ display: 'flex' }}><Icon name={a.icon} size={14} weight={2} /></span>
            {m.from.name && <span className="email">&lt;{m.from.email}&gt;</span>}
            {pill && <span className={`pill ${pill.cls}`}>{pill.text}</span>}
            {m.status === 'draft' && <button type="button" className="btn small" onClick={() => onEditDraft(m.id)}>Continue Writing</button>}
            {m.status === 'scheduled' && <button type="button" className="btn small" onClick={takeBack}>Cancel Send</button>}
          </div>
          <div className="msg-to truncate">
            To {m.to.map((p) => p.name || p.email).join(', ') || 'Undisclosed Recipients'}
            {m.cc.length > 0 && ` · Cc ${m.cc.map((p) => p.name || p.email).join(', ')}`}
            {m.scheduledFor && m.status === 'scheduled' && ` · Sends ${longTime(m.scheduledFor)}`}
          </div>
        </div>
        <span className="msg-date">{longTime(m.at)}</span>
        {m.direction === 'in' && <button type="button" className="icon-btn" aria-label="Reply" title="Reply (R)" onClick={onReply}><Icon name="reply" /></button>}
      </div>

      {m.error && <div className="notice warn" role="alert">This message was not sent: {m.error}</div>}
      {m.hasRemoteImages && !relay.loadImages && (
        <div className="notice">
          <Icon name="imageOff" />
          <span className="grow">Remote images are blocked to keep tracking pixels out.</span>
          <button type="button" className="link-btn" onClick={relay.showImages}>Load Images</button>
        </div>
      )}
      <div className="msg-body">
        {m.html ? <HtmlBody html={m.html} /> : <div className="msg-text">{m.text}</div>}
        {m.truncated && <div className="notice">This message is long. Sadi Mail shows the first part; the full message is in the raw source.</div>}
        {files.length > 0 && (
          <div className="files">
            {files.map((f) => (
              <div className="file" key={f.id}>
                <span className={`file-kind${fileKind(f.filename) === 'PDF' ? ' pdf' : ''}`}>{fileKind(f.filename)}</span>
                <span className="grow"><b className="truncate">{f.filename}</b><small>{bytes(f.size)}</small></span>
                <button type="button" className="icon-btn" aria-label={`Download ${f.filename}`} title="Download" onClick={() => save(f.id, f.filename)}><Icon name="download" size={15} weight={1.8} /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Pop({ label, title, icon, end, disabled, children }: { label: string; title: string; icon: IconName; end?: boolean; disabled?: boolean; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  return (
    <span className={`pop${end ? ' end' : ''}`} ref={ref} onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); } }}>
      <button type="button" className="icon-btn" aria-label={label} title={title} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}><Icon name={icon} size={17} /></button>
      {open && <div className="menu" role="menu">{children(() => setOpen(false))}</div>}
    </span>
  );
}

function LabelMenu({ relay, detail }: { relay: MailStore; detail: ThreadDetail }) {
  const [name, setName] = useState('');
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const colors = ['#4F46E5', '#059669', '#D97706', '#DC2626', '#7C3AED', '#0891B2', '#64748B'];
      const made = await api.post<{ id: string }>('/labels', { name, color: colors[relay.labels.length % colors.length] });
      setName('');
      relay.loadLabels();
      await relay.toggleLabel(detail, made.id, true);
    } catch (err) {
      relay.notify({ text: err instanceof Error ? err.message : 'Could not create the label.' });
    }
  };
  return (
    <>
      <div className="menu-label">Labels</div>
      {relay.labels.length === 0 && <div className="menu-label" style={{ fontWeight: 400 }}>No labels yet. Create one below.</div>}
      {relay.labels.map((l) => {
        const on = detail.labels.some((x) => x.id === l.id);
        return (
          <button key={l.id} type="button" role="menuitemcheckbox" aria-checked={on} onClick={() => void relay.toggleLabel(detail, l.id, !on)}>
            <span className="check">{on && <Icon name="check" size={13} weight={2.6} />}</span><i className="swatch" style={{ background: l.color }} /><span className="truncate">{l.name}</span>
          </button>
        );
      })}
      <form onSubmit={(e) => void create(e)}>
        <input className="field" autoFocus aria-label="New Label Name" placeholder="New label" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        <button type="submit" className="btn small" disabled={!name.trim()}>Add</button>
      </form>
    </>
  );
}

export function Reader({ relay, open, onBack, onCompose, onEditDraft, onToggleContext, reply, onReplyHere }: { relay: MailStore; open: boolean; onBack: () => void; onCompose: (mode: ComposeMode, message?: MessageDetail, seed?: string) => void; onEditDraft: (id: string) => void; onToggleContext: () => void; reply: ReplyRequest | null; onReplyHere: (mode: 'reply' | 'replyAll', seed?: string) => void }) {
  const { detail, detailLoad, threads, selectedId } = relay;
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [selectedId]);

  const index = threads.findIndex((t) => t.id === selectedId);
  const go = (delta: number) => {
    const next = threads[index + delta];
    if (next) relay.select(next.id);
  };
  const lastInbound = detail ? [...detail.messages].reverse().find((m) => m.direction === 'in') : undefined;
  const target = lastInbound ?? detail?.messages[detail.messages.length - 1];
  const canEdit = detail ? (relay.mailboxes.find((m) => m.id === detail.mailboxId)?.can.edit ?? false) : false;
  const canDelete = detail ? (relay.mailboxes.find((m) => m.id === detail.mailboxId)?.can.delete ?? false) : false;
  const canSend = detail ? (relay.mailboxes.find((m) => m.id === detail.mailboxId)?.can.send ?? false) : false;

  if (!selectedId) {
    return (
      <main className={`reader${open ? ' open' : ''}`}>
        <div className="state">
          <strong>No Conversation Selected</strong>
          <p>Pick a message from the list, or press <span className="kbd">J</span> and <span className="kbd">K</span> to move through it.</p>
        </div>
      </main>
    );
  }

  const hidden = detail && !expanded && detail.messages.length > 2 ? detail.messages.length - 1 : 0;
  const shown = detail ? (hidden ? detail.messages.slice(-1) : detail.messages) : [];

  return (
    <main className={`reader${open ? ' open' : ''}`}>
      <div className="reader-bar">
        <button type="button" className="icon-btn back-btn" aria-label="Back To List" onClick={onBack}><Icon name="left" size={18} /></button>
        <button type="button" className="icon-btn hide-phone" aria-label="Previous Conversation" title="Previous (K)" disabled={index <= 0} onClick={() => go(-1)}><Icon name="left" size={17} /></button>
        <button type="button" className="icon-btn hide-phone" aria-label="Next Conversation" title="Next (J)" disabled={index < 0 || index >= threads.length - 1} onClick={() => go(1)}><Icon name="right" size={17} /></button>
        <span className="sep" />
        {detail && (
          <>
            {detail.folder === 'inbox' ? (
              <button type="button" className="icon-btn" aria-label="Archive" title="Archive (E)" disabled={!canEdit} onClick={() => void relay.act(detail, 'archive')}><Icon name="archive" size={17} /></button>
            ) : (
              <button type="button" className="icon-btn" aria-label={detail.folder === 'spam' ? 'Not Spam' : 'Move To Inbox'} title={detail.folder === 'spam' ? 'Not Spam: Move To Inbox And Trust This Sender' : 'Move To Inbox'} disabled={!canEdit} onClick={() => void relay.act(detail, 'inbox')}><Icon name="inbox" size={17} /></button>
            )}
            <button type="button" className="icon-btn" aria-label="Move To Trash" title="Trash (#)" disabled={!canDelete || detail.folder === 'trash'} onClick={() => void relay.act(detail, 'trash')}><Icon name="trash" size={17} /></button>
            <Pop label="Snooze" title="Snooze" icon="clock" disabled={!canEdit || detail.folder !== 'inbox'}>
              {(close) => (
                <>
                  <div className="menu-label">Snooze Until</div>
                  {([['Later Today', Date.now() + 3 * 3_600_000], ['Tomorrow, 08:00', tomorrowMorning()], ['Next Monday, 08:00', nextMonday()]] as const).map(([text, until]) => (
                    <button key={text} type="button" role="menuitem" onClick={() => { close(); void relay.snooze(detail, until); }}><Icon name="clock" size={15} weight={1.8} />{text}</button>
                  ))}
                  {detail.snoozedUntil && <button type="button" role="menuitem" onClick={() => { close(); void relay.act(detail, 'inbox'); }}><Icon name="inbox" size={15} />Stop Snoozing</button>}
                </>
              )}
            </Pop>
            <Pop label="Labels" title="Labels" icon="tag" disabled={!canEdit}>{() => <LabelMenu relay={relay} detail={detail} />}</Pop>
            <Pop label="More Actions" title="More" icon="more">
              {(close) => (
                <>
                  <button type="button" role="menuitem" disabled={!canSend} onClick={() => { close(); onReplyHere('replyAll'); }}><Icon name="replyAll" size={15} />Reply All<span className="grow" /><span className="kbd">A</span></button>
                  <button type="button" role="menuitem" disabled={!canSend} onClick={() => { close(); onCompose('forward', target); }}><Icon name="forward" size={15} />Forward<span className="grow" /><span className="kbd">F</span></button>
                  <button type="button" role="menuitem" disabled={!canEdit} onClick={() => { close(); void relay.act(detail, 'unread'); }}><Icon name="unread" size={15} />Mark As Unread<span className="grow" /><span className="kbd">U</span></button>
                  <button type="button" role="menuitem" disabled={!canEdit || detail.folder === 'spam'} onClick={() => { close(); void relay.act(detail, 'spam'); }}><Icon name="spam" size={15} />Mark As Spam<span className="grow" /><span className="kbd">!</span></button>
                  {detail.folder === 'inbox' && <div className="menu-label">Move To Section</div>}
                  {detail.folder === 'inbox' && SECTION_ORDER.filter((s) => s !== detail.section).map((s) => (
                    <button key={s} type="button" role="menuitem" disabled={!canEdit} onClick={() => { close(); void relay.moveToSection(detail, s); }}><Icon name="inbox" size={15} />{SECTION_TITLES[s]}</button>
                  ))}
                  {(detail.folder === 'trash' || detail.folder === 'spam') && <button type="button" role="menuitem" disabled={!canDelete} onClick={() => { close(); void relay.deleteForever(detail); }}><Icon name="trash" size={15} />Delete Forever</button>}
                </>
              )}
            </Pop>
          </>
        )}
        <span className="grow" />
        {index >= 0 && <span className="position num">{index + 1} Of {threads.length}</span>}
        {detail && <button type="button" className="icon-btn ctx-toggle" aria-label={relay.boot?.ai.connected ? 'Assistant And Details' : 'Details And Activity'} title={relay.boot?.ai.connected ? 'Assistant And Details' : 'Details And Activity'} onClick={onToggleContext}><Icon name={relay.boot?.ai.connected ? 'ai' : 'user'} size={17} /></button>}
        {detail && (
          <>
            <button type="button" className="icon-btn" aria-label={detail.starred ? 'Remove Star' : 'Star'} aria-pressed={detail.starred} title="Star (S)" disabled={!canEdit} onClick={() => void relay.act(detail, detail.starred ? 'unstar' : 'star')}>
              <Icon name="star" size={17} fill={detail.starred ? 'currentColor' : 'none'} />
            </button>
            <button type="button" className="icon-btn" aria-label="Reply" title="Reply (R)" disabled={!canSend} onClick={() => onReplyHere('reply')}><Icon name="reply" size={17} /></button>
          </>
        )}
      </div>

      {detailLoad === 'loading' && !detail && (
        <div className="reader-scroll" aria-busy="true" aria-label="Loading Conversation">
          <div className="article">
            <span className="skeleton" style={{ height: 28, width: '70%' }} />
            <span className="skeleton" style={{ height: 42, width: '50%' }} />
            <span className="skeleton" style={{ height: 160 }} />
          </div>
        </div>
      )}
      {detailLoad === 'error' && (
        <div className="state" role="alert">
          <strong>Could Not Open This Conversation</strong>
          <p>{relay.detailError}</p>
          <button className="btn small" onClick={() => relay.select(selectedId)}>Try Again</button>
        </div>
      )}
      {detail && detailLoad !== 'error' && (
        <>
          <div className="reader-scroll">
            <article key={detail.id} className={`article${expanded ? ' expanded' : ''}`}>
              {detail.flaggedAuth && (
                <div className="alert" role="alert">
                  <Icon name="spam" size={18} weight={1.8} />
                  <div className="grow" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <strong>This Sender Could Not Be Verified</strong>
                    <span>{lastInbound?.from.email ?? 'The sender'} failed DMARC, so this message may not be from who it claims. Do not follow its links or open its files unless you are sure.</span>
                    <span className="acts">{detail.folder !== 'spam' ? <button type="button" className="btn small danger" disabled={!canEdit} onClick={() => void relay.act(detail, 'spam')}>Move To Spam And Block Sender</button> : <button type="button" className="btn small" disabled={!canEdit} onClick={() => void relay.act(detail, 'inbox')}>Not Spam</button>}</span>
                  </div>
                </div>
              )}
              <header className="subject">
                <h2>{detail.subject}</h2>
                {detail.folder !== 'inbox' && <span className="pill neutral">{VIEW_TITLES[detail.folder]}</span>}
                <span className="pill neutral">{detail.addressEmail}</span>
                {detail.labels.map((l) => <span key={l.id} className="label-chip"><i className="swatch" style={{ background: l.color }} />{l.name}</span>)}
                {detail.snoozedUntil && <span className="pill neutral">Snoozed Until {longTime(detail.snoozedUntil)}</span>}
              </header>
              {hidden > 0 && (
                <button type="button" className="collapsed" onClick={() => setExpanded(true)}>
                  <span className="grow">{hidden} Earlier {hidden === 1 ? 'Message' : 'Messages'} In This Conversation</span>
                  <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--accent-text)' }}>Show</span>
                </button>
              )}
              {shown.map((m) => (
                <Message key={m.id} m={m} relay={relay} onReply={() => onReplyHere('reply')} onEditDraft={onEditDraft} />
              ))}
            </article>
          </div>
          {canSend && target && (
            <InlineReply relay={relay} detail={detail} target={target} request={reply} onEditDraft={onEditDraft}
              onFull={(mode, message, seed) => onCompose(mode, message, seed)} />
          )}
        </>
      )}
    </main>
  );
}

// ---------- context panel ----------

const EVENT_LABEL: Record<string, string> = {
  accepted: 'Accepted By Email Routing', stored: 'Stored Raw Message', parsed: 'Parsed By Email Worker', indexed: 'Indexed For Search',
  'dry-run': 'Dry Run', sent: 'Handed To Sending Provider', failed: 'Sending Failed', scheduled: 'Scheduled',
};

export function ContextPanel({ relay, detail, onOpenSettings, onReply, open, onClose }: { relay: MailStore; detail: ThreadDetail | null; onOpenSettings: () => void; onReply: (message: MessageDetail, seed: string) => void; open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<'assistant' | 'details' | 'activity'>(relay.boot?.ai.connected ? 'assistant' : 'details');
  // Once a provider is connected the Assistant is the first thing shown, unless the person already chose a tab.
  const chose = useRef(false);
  const connected = relay.boot?.ai.connected ?? false;
  useEffect(() => {
    if (connected && !chose.current) setTab('assistant');
  }, [connected]);
  // Without an AI provider the panel is simply Details and Activity; nothing about AI is shown.
  const allTabs = [['assistant', 'Assistant'], ['details', 'Details'], ['activity', 'Activity']] as const;
  const tabs = allTabs.filter(([key]) => key !== 'assistant' || (relay.boot?.ai.connected ?? false));
  const person = detail ? ([...detail.messages].reverse().find((m) => m.direction === 'in') ?? detail.messages[0]) : undefined;
  const last = detail?.messages[detail.messages.length - 1];

  return (
    <aside className={`context${open ? ' open' : ''}`} aria-label="Conversation Context">
      <div className="ctx-tabs" role="tablist" aria-label="Conversation Context">
        {tabs.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key || (key === 'details' && tab === 'assistant' && !connected)} onClick={() => { chose.current = true; setTab(key); }}>{label}</button>
        ))}
        <span className="grow" />
        <button type="button" className="icon-btn ctx-close" aria-label="Close Panel" onClick={onClose} style={{ marginBottom: 10 }}><Icon name="close" size={15} weight={2} /></button>
      </div>
      <div className="ctx-body">
        {tab === 'assistant' && connected && <Assistant relay={relay} detail={detail} onReply={onReply} onOpenSettings={onOpenSettings} />}

        {(tab === 'details' || (tab === 'assistant' && !connected)) && !detail && <p className="fine">Open a conversation to see who it is from.</p>}
        {(tab === 'details' || (tab === 'assistant' && !connected)) && detail && person && (
          <>
            <section style={{ alignItems: 'flex-start', gap: 12 }}>
              <Avatar name={person.from.name} email={person.from.email} size="xl" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em' }}>{person.from.name || person.from.email}</span>
                <span style={{ fontSize: 12.5, color: 'var(--ink-3)', overflowWrap: 'anywhere' }}>{person.from.email}</span>
              </div>
            </section>
            <section style={{ gap: 2 }}>
              <h3 className="eyebrow" style={{ marginBottom: 6 }}>This Conversation</h3>
              <div className="kv"><span>Arrived At</span><span>{detail.addressEmail}</span></div>
              <div className="kv"><span>Mailbox</span><span>{relay.mailboxes.find((m) => m.id === detail.mailboxId)?.name ?? ''}</span></div>
              <div className="kv"><span>Messages</span><span className="num">{detail.messageCount}</span></div>
              <div className="kv"><span>Replies Go From</span><span>{relay.addresses.find((a) => a.id === detail.replyFrom)?.email ?? detail.addressEmail}</span></div>
            </section>
            <section style={{ gap: 2 }}>
              <h3 className="eyebrow" style={{ marginBottom: 6 }}>Previous Conversations</h3>
              {detail.earlier.length === 0 && <p className="fine">No earlier conversations with this sender.</p>}
              {detail.earlier.map((e) => (
                <button key={e.id} type="button" className="prev" onClick={() => relay.select(e.id)}>
                  <span className="grow">{e.subject}</span><span>{shortTime(e.at)}</span>
                </button>
              ))}
            </section>
          </>
        )}

        {tab === 'activity' && !last && <p className="fine">Open a conversation to see how its latest message travelled.</p>}
        {tab === 'activity' && last && (
          <section style={{ gap: 0 }}>
            <h3 className="eyebrow" style={{ marginBottom: 12 }}>{last.direction === 'in' ? 'How This Message Arrived' : 'What Happened To This Message'}</h3>
            {last.events.length === 0 && <p className="fine">No activity was recorded for this message.</p>}
            {last.events.map((e, i) => (
              <div className="step" key={i}>
                <div className={`step-line${e.kind === 'failed' ? ' bad' : e.kind === 'dry-run' || e.kind === 'scheduled' ? ' info' : ''}`}><i /></div>
                <div className="step-text">
                  <b>{EVENT_LABEL[e.kind] ?? e.kind}<span>{e.ms != null ? `${e.ms} ms` : new Date(e.at).toLocaleTimeString([], { hour12: false })}</span></b>
                  <small>{e.detail}</small>
                </div>
              </div>
            ))}
            <button type="button" className="link-btn" style={{ alignSelf: 'flex-start', fontWeight: 500, fontSize: 13 }} onClick={() => void api.download(`/messages/${last.id}/raw`, `${last.id}.eml`).catch((err: Error) => relay.notify({ text: err.message }))}>
              Download Raw Source
            </button>
          </section>
        )}
      </div>
    </aside>
  );
}
