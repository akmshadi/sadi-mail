import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { DraftDetail, MessageDetail, View } from '../shared/types';
import { RequestError, api, setHostToken } from './api';
import { ago, bytes } from './format';
import { Icon, type IconName } from './icons';
import { ContextPanel, Reader, ThreadList, VIEW_TITLES, type ComposeMode } from './Mail';
import { ComposePage, type ComposeState } from './Compose';
import { Palette } from './Overlays';
import type { ReplyRequest } from './InlineReply';
import { Settings, type SettingsTab } from './Settings';
import { type MailStore, type Scope, useRelay } from './store';

type Theme = 'light' | 'dark';
type Page = 'mail' | 'settings' | 'compose';

/**
 * Run a state change inside a View Transition, so the workspace settles into its new page and a theme
 * switch cross-fades instead of flashing. Falls back to a plain update where the API is missing or
 * the person asked for reduced motion. `kind` lets the stylesheet pick the right animation.
 */
function morph(update: () => void, kind: 'page' | 'theme' = 'page') {
  const root = document.documentElement;
  if (!document.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    update();
    return;
  }
  root.dataset.vt = kind;
  const t = document.startViewTransition(() => flushSync(update));
  void t.finished.finally(() => { if (root.dataset.vt === kind) delete root.dataset.vt; });
}

function initialTheme(): Theme {
  const theme = readTheme();
  // Applied before the first paint, so the page never flashes the wrong theme.
  document.documentElement.dataset.theme = theme;
  return theme;
}

function readTheme(): Theme {
  const asked = new URLSearchParams(window.location.search).get('theme');
  if (asked === 'light' || asked === 'dark') return asked;
  try {
    const saved = localStorage.getItem('sadi-mail-theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Storage can be blocked when embedded; fall through to the system setting.
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const NAV: { view: View; icon: IconName }[] = [
  { view: 'inbox', icon: 'inbox' }, { view: 'unread', icon: 'unread' }, { view: 'starred', icon: 'star' }, { view: 'snoozed', icon: 'clock' }, { view: 'drafts', icon: 'file' }, { view: 'scheduled', icon: 'sched' },
  { view: 'sent', icon: 'send' }, { view: 'archive', icon: 'archive' }, { view: 'spam', icon: 'spam' }, { view: 'trash', icon: 'trash' },
];

/** Tokens a host application may set when Sadi Mail is embedded. Anything else is ignored. */
const HOST_TOKENS = new Set(['--bg', '--surface', '--reading', '--panel', '--raised', '--line', '--ink', '--ink-2', '--ink-3', '--accent', '--accent-hover', '--on-accent', '--accent-soft', '--accent-text', '--sel', '--font']);

function ScopeMenu({ relay, onPick }: { relay: MailStore; onPick: (s: Scope) => void }) {
  const { scope, mailboxes } = relay;
  return (
    <div className="menu" role="listbox" aria-label="Choose Mailbox Or Address">
      <button type="button" role="option" aria-selected={!scope.mailboxId} onClick={() => onPick({ mailboxId: null, addressId: null })}><Icon name="layers" size={15} />All Mailboxes</button>
      {mailboxes.map((m) => (
        <div key={m.id} style={{ display: 'contents' }}>
          <div className="menu-label">{m.name}</div>
          {m.addresses.length > 1 && (
            <button type="button" role="option" aria-selected={scope.mailboxId === m.id && !scope.addressId} onClick={() => onPick({ mailboxId: m.id, addressId: null })}>All {m.addresses.length} Addresses</button>
          )}
          {m.addresses.map((a) => (
            <button key={a.id} type="button" role="option" aria-selected={scope.addressId === a.id} onClick={() => onPick({ mailboxId: m.id, addressId: a.id })}><span className="truncate">{a.email}</span></button>
          ))}
        </div>
      ))}
    </div>
  );
}

function ScopeButton({ relay }: { relay: MailStore }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { scope, mailboxes, addresses } = relay;
  const label = scope.addressId ? (addresses.find((a) => a.id === scope.addressId)?.email ?? '') : scope.mailboxId ? `${mailboxes.find((m) => m.id === scope.mailboxId)?.name ?? ''} · All Addresses` : 'All Mailboxes';
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="scope" ref={ref} onKeyDown={(e) => e.key === 'Escape' && open && (e.stopPropagation(), setOpen(false))}>
      <button type="button" className="scope-btn" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="dot" />
        <span className="grow truncate">{label}</span>
        <Icon name="down" size={15} weight={2} />
      </button>
      {open && <ScopeMenu relay={relay} onPick={(s) => { relay.setScope(s); setOpen(false); }} />}
    </div>
  );
}

// Mailboxes that still have the default colour each get their own from this set, so tiles can be told apart at a glance.
const TILE_COLORS = ['#4F46E5', '#0F9D8A', '#C0397B', '#2B7FD9', '#3D9A4B', '#7C4DDB', '#475569', '#D0453B'];
const tileColor = (color: string, index: number) => (color && color.toUpperCase() !== '#4F46E5' ? color : TILE_COLORS[index % TILE_COLORS.length]!);

export function App() {
  const relay = useRelay();
  const [dropLabel, setDropLabel] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  // Deleting a label removes it from every conversation that carried it; the conversations themselves stay.
  const removeLabel = async (id: string, name: string) => {
    setDropLabel(null);
    try {
      await api.delete(`/labels/${id}`);
      if (relay.labelId === id) relay.setView('inbox');
      relay.loadLabels();
      void relay.loadList(true);
      relay.notify({ text: `Label Deleted: ${name}` });
    } catch (err) {
      relay.notify({ text: err instanceof RequestError ? err.message : 'The label could not be deleted.' });
    }
  };
  const { boot, mailboxes, scope, view, threads, selectedId, detail } = relay;
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [page, setPageNow] = useState<Page>('mail');
  const pageRef = useRef(page);
  pageRef.current = page;
  /** Change page; a real change (not a repeat of the current page) gets the page transition. */
  const setPage = useCallback((next: Page, alongside?: () => void) => {
    if (next === pageRef.current) { alongside?.(); setPageNow(next); return; }
    morph(() => { alongside?.(); setPageNow(next); });
  }, []);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('system');
  const [palette, setPalette] = useState(false);
  const [compose, setCompose] = useState<ComposeState | null>(null);
  const [reading, setReading] = useState(false);
  const [ctxOpen, setCtxOpen] = useState(false);
  const [reply, setReply] = useState<ReplyRequest | null>(null);
  const replyHere = useCallback((mode: 'reply' | 'replyAll', seed?: string) => { setPage('mail'); setReading(true); setReply({ mode, seed, nonce: Date.now() }); }, []); // phone: is the reading pane showing
  const isAdmin = boot?.user.role === 'owner' || boot?.user.role === 'admin';
  const [avatarVersion, setAvatarVersion] = useState(0);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('sadi-mail-theme', theme);
    } catch {
      // Not saved; the choice still applies to this visit.
    }
  }, [theme]);
  const toggleTheme = useCallback(() => {
    const next: Theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    // The attribute is set inside the transition so the new snapshot is already in the new theme.
    morph(() => { document.documentElement.dataset.theme = next; setTheme(next); }, 'theme');
  }, []);

  // Embedding: a host page may set the theme and a small set of colour tokens, and is told the unread count.
  const embedded = window.parent !== window;
  useEffect(() => {
    if (!embedded) return;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent || !e.data) return;
      // The host renews its short-lived token without reloading the frame, so an open draft is never lost.
      if (e.data.type === 'sadi-mail:token' && typeof e.data.token === 'string' && e.data.token.length < 4096) {
        setHostToken(e.data.token);
        return;
      }
      if (e.data.type !== 'sadi-mail:theme') return;
      if (e.data.theme === 'light' || e.data.theme === 'dark') setTheme(e.data.theme);
      if (e.data.tokens && typeof e.data.tokens === 'object') {
        for (const [key, value] of Object.entries(e.data.tokens as Record<string, unknown>)) {
          if (HOST_TOKENS.has(key) && typeof value === 'string' && value.length < 120 && !/[;{}<>]|url\(/i.test(value)) document.documentElement.style.setProperty(key, value);
        }
      }
    };
    window.addEventListener('message', onMessage);
    window.parent.postMessage({ type: 'sadi-mail:ready', features: ['token-renewal'] }, '*');
    return () => window.removeEventListener('message', onMessage);
  }, [embedded]);
  const unreadTotal = mailboxes.reduce((n, m) => n + m.unread, 0);
  useEffect(() => {
    document.title = unreadTotal ? `(${unreadTotal}) Sadi Mail` : 'Sadi Mail';
    if (embedded) window.parent.postMessage({ type: 'sadi-mail:unread', count: unreadTotal }, '*');
  }, [unreadTotal, embedded]);

  const wide = () => window.matchMedia('(min-width: 761px)').matches;
  // On a wide screen the first conversation opens by itself, so the reading pane is never blank.
  useEffect(() => {
    if (relay.listLoad === 'ready' && !selectedId && threads[0] && wide()) relay.select(threads[0].id);
  }, [relay.listLoad, selectedId, threads]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = useCallback((id: string) => { relay.select(id); setReading(true); }, [relay]);
  const startCompose = useCallback(
    (mode: ComposeMode, message?: MessageDetail, seed?: string) => {
      setPage('compose', () => setCompose({ mode, message, seed, thread: mode === 'new' ? undefined : (detail ?? undefined) }));
    },
    [detail, setPage],
  );
  /** Reopen a saved draft on the compose page. */
  const openDraft = useCallback(
    (id: string) => {
      api.get<DraftDetail>(`/drafts/${id}`).then((draft) => setPage('compose', () => setCompose({ mode: draft.mode, draft }))).catch(() => relay.notify({ text: 'That draft could not be opened.' }));
    },
    [relay, setPage],
  );
  const pickScope = (s: Scope) => { relay.setScope(s); setPage('mail'); setReading(false); };
  const pickView = (v: View) => { relay.setView(v); setPage('mail'); setReading(false); };

  // Keyboard: every action in the reading toolbar has a single key, as in the titles on the buttons.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); return; }
      if (mod && /^[1-9]$/.test(e.key)) {
        const n = Number(e.key);
        const target = n === 1 ? { mailboxId: null, addressId: null } : mailboxes[n - 2] ? { mailboxId: mailboxes[n - 2]!.id, addressId: null } : null;
        if (target) { e.preventDefault(); pickScope(target); }
        return;
      }
      const el = e.target as HTMLElement;
      if (mod || e.altKey || palette || page === 'compose' || el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (page !== 'mail') { if (e.key === 'Escape') setPage('mail'); return; }
      const index = threads.findIndex((t) => t.id === selectedId);
      const current = index >= 0 ? threads[index]! : null;
      const can = (action: 'edit' | 'delete' | 'send') => !!current && !!mailboxes.find((m) => m.id === current.mailboxId)?.can[action];
      const move = (delta: number) => { const next = threads[index < 0 ? 0 : index + delta]; if (next) relay.select(next.id); };
      switch (e.key) {
        case 'j': case 'ArrowDown': e.preventDefault(); move(1); break;
        case 'k': case 'ArrowUp': e.preventDefault(); move(-1); break;
        case 'Enter': if (current) setReading(true); break;
        case 'Escape': setReading(false); break;
        case '/': e.preventDefault(); setPalette(true); break;
        case 'c': e.preventDefault(); startCompose('new'); break;
        case 'e': if (can('edit')) void relay.act(current!, current!.folder === 'inbox' ? 'archive' : 'inbox'); break;
        case '#': if (can('delete')) void relay.act(current!, 'trash'); break;
        case '!': if (can('edit')) void relay.act(current!, 'spam'); break;
        case 's': if (can('edit')) void relay.act(current!, current!.starred ? 'unstar' : 'star'); break;
        case 'u': if (can('edit')) void relay.act(current!, 'unread'); break;
        case 'r': case 'a': case 'f': {
          const last = detail && detail.id === selectedId ? ([...detail.messages].reverse().find((m) => m.direction === 'in') ?? detail.messages[detail.messages.length - 1]) : undefined;
          if (last && can('send')) { e.preventDefault(); if (e.key === 'f') startCompose('forward', last); else replyHere(e.key === 'a' ? 'replyAll' : 'reply'); }
          break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (relay.bootError && !boot) {
    return (
      <div className="app"><div className="state" role="alert">
        <strong>Sadi Mail Could Not Start</strong>
        <p>{relay.bootError}</p>
        <button className="btn" onClick={() => void relay.loadBoot()}>Try Again</button>
      </div></div>
    );
  }

  const count = (v: View) => (v === 'inbox' ? relay.counts.inbox : v === 'spam' ? relay.counts.spam : v === 'scheduled' ? relay.counts.scheduled : 0);
  const lastIn = boot?.storage.lastReceivedAt ?? null;
  const used = boot?.storage.bytes ?? 0;

  return (
    <div className="app">
      <div className="rail">
        <div className="logo" role="img" aria-label="Sadi Mail"><Icon name="logo" size={18} weight={2.2} /></div>
        <div className={`rail-slot${!scope.mailboxId ? ' active' : ''}`}>
          <button type="button" className="rail-btn tile all" aria-label="All Mailboxes" aria-pressed={!scope.mailboxId} title="All Mailboxes (⌘1)" onClick={() => pickScope({ mailboxId: null, addressId: null })}><span className="face"><Icon name="layers" size={17} /></span></button>
        </div>
        {mailboxes.map((m, i) => {
          const active = scope.mailboxId === m.id;
          return (
            <div key={m.id} className={`rail-slot${active ? ' active' : ''}`}>
              <button type="button" className="rail-btn tile" style={{ '--tile': tileColor(m.color, i) } as React.CSSProperties} aria-label={`${m.name}${m.unread ? `, ${m.unread} Unread` : ''}`} aria-pressed={active} title={`${m.name}${i < 8 ? ` (⌘${i + 2})` : ''}`} onClick={() => pickScope({ mailboxId: m.id, addressId: null })}>
                <span className="face">{m.name.charAt(0).toUpperCase()}</span>
                {m.unread > 0 && !active && <span className="badge num">{m.unread > 99 ? '99+' : m.unread}</span>}
              </button>
            </div>
          );
        })}
        <span className="grow" />
        <button type="button" className="icon-btn" aria-label="Settings" title="Settings" aria-pressed={page === 'settings'} onClick={() => setPage(page === 'settings' ? 'mail' : 'settings')}><Icon name="settings" size={18} /></button>
        <button type="button" className="me" aria-label={`Your Profile: ${boot?.user.name ?? ''}`} title={boot ? `${boot.user.name} · ${boot.user.role}` : ''} onClick={() => { setSettingsTab('profile'); setPage('settings'); }}>
          {boot?.user.hasAvatar ? <img src={`/api/users/${boot.user.id}/avatar?v=${avatarVersion}`} alt="" /> : (boot?.user.name ?? '·').slice(0, 2).toUpperCase()}
        </button>
      </div>

      <div className="main">
        <div className="topbar">
          <div className="brand">Sadi Mail{boot?.sendMode === 'dry-run' && !boot.serverSenders.length && <small title="Messages are stored but never leave this server">Dry Run</small>}</div>
          <button type="button" className="searchbar" onClick={() => setPalette(true)}>
            <Icon name="search" weight={1.8} />
            <span className="grow truncate">Search mail across every address, or run a command</span>
            <span className="kbd">⌘K</span>
          </button>
          <span className="grow" />
          <button type="button" className="icon-btn" aria-label={theme === 'dark' ? 'Switch To Light Theme' : 'Switch To Dark Theme'} title={theme === 'dark' ? 'Light Theme' : 'Dark Theme'} onClick={toggleTheme}><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} /></button>
        </div>

        <div className="mobile-top">
          <button type="button" className="icon-btn" aria-label="Open Folders And Labels" aria-expanded={drawer} onClick={() => setDrawer(true)}><Icon name="menu" size={20} /></button>
          <ScopeButton relay={relay} />
          <button type="button" className="icon-btn" aria-label={theme === 'dark' ? 'Switch To Light Theme' : 'Switch To Dark Theme'} onClick={toggleTheme}><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} /></button>
        </div>

        <div className="body">
          {drawer && <button type="button" className="drawer-scrim" aria-label="Close Folders" onClick={() => setDrawer(false)} />}
          <nav className={`sidebar${drawer ? ' open' : ''}`} aria-label="Mailboxes" onClick={(e) => { if ((e.target as HTMLElement).closest('.nav-item, .compose-btn, [role="option"]')) setDrawer(false); }} onKeyDown={(e) => { if (e.key === 'Escape' && drawer) { e.stopPropagation(); setDrawer(false); } }}>
            <div className="drawer-head"><b className="grow">Sadi Mail</b><button type="button" className="icon-btn" aria-label="Close Folders" onClick={() => setDrawer(false)}><Icon name="close" size={16} weight={2} /></button></div>
            <ScopeButton relay={relay} />
            <button type="button" className="compose-btn" onClick={() => startCompose('new')}><Icon name="pen" weight={1.9} /><span className="grow" style={{ textAlign: 'left' }}>Compose</span><span className="mono">C</span></button>
            <div className="nav">
              {NAV.map((n) => (
                <button key={n.view} type="button" className={`nav-item${page === 'mail' && view === n.view && !relay.labelId ? ' active' : ''}`} aria-current={page === 'mail' && view === n.view && !relay.labelId ? 'page' : undefined} onClick={() => pickView(n.view)}>
                  <Icon name={n.icon} />
                  <span className="grow">{VIEW_TITLES[n.view]}</span>
                  {count(n.view) > 0 && <span className="count num">{count(n.view)}</span>}
                </button>
              ))}
            </div>
            {relay.labels.length > 0 && (
              <div className="nav side-labels">
                <div className="nav-title">Labels</div>
                {relay.labels.map((l) => (
                  <div key={l.id} className="label-row">
                    <button type="button" className={`nav-item${page === 'mail' && relay.labelId === l.id ? ' active' : ''}`} aria-current={page === 'mail' && relay.labelId === l.id ? 'page' : undefined} onClick={() => { relay.setLabel(l.id); setPage('mail'); setReading(false); }}>
                      <i className="swatch" style={{ background: l.color }} />
                      <span className="grow truncate">{l.name}</span>
                    </button>
                    {(boot?.user.role === 'owner' || boot?.user.role === 'admin') && (dropLabel === l.id ? (
                      <span className="confirm">
                        <button type="button" className="btn small danger" autoFocus onClick={() => void removeLabel(l.id, l.name)}>Delete</button>
                        <button type="button" className="icon-btn" aria-label="Keep Label" onClick={() => setDropLabel(null)}><Icon name="close" size={13} weight={2} /></button>
                      </span>
                    ) : (
                      <button type="button" className="icon-btn drop" aria-label={`Delete Label ${l.name}`} title="Delete Label" onClick={() => setDropLabel(l.id)}><Icon name="trash" size={14} /></button>
                    ))}
                  </div>
                ))}
              </div>
            )}
            <div className="side-foot">
              <div className="row"><b className="grow" style={{ fontWeight: 600 }}>Storage</b><span className="num" style={{ color: 'var(--ink-3)' }}>{bytes(used)} In R2</span></div>
              <div className="meter" role="img" aria-label={`${bytes(used)} of the 10 GB free R2 allowance used`}><span style={{ width: `${Math.min(100, (used / (10 * 1024 ** 3)) * 100)}%` }} /></div>
              <div className={`health${lastIn ? '' : ' idle'}`}><i />{lastIn ? `Last Mail Received ${ago(lastIn)}` : 'No Mail Received Yet'}</div>
            </div>
          </nav>

          <div className="surface">
            {page === 'compose' && compose ? (
              <ComposePage key={`${compose.mode}-${compose.message?.id ?? 'new'}-${compose.seed ?? ''}-${compose.draft?.id ?? ''}`} relay={relay} state={compose} onEditDraft={openDraft} onClose={() => setPage('mail', () => setCompose(null))} onOpenSettings={() => setPage('settings', () => { setSettingsTab('ai'); setCompose(null); })} />
            ) : page === 'settings' ? (
              <Settings relay={relay} tab={isAdmin || settingsTab === 'templates' ? settingsTab : 'profile'} setTab={setSettingsTab} onBack={() => setPage('mail')} avatarVersion={avatarVersion} onAvatarChange={() => { setAvatarVersion((v) => v + 1); void relay.loadBoot(); }} />
            ) : (
              <>
                <ThreadList relay={relay} onOpen={open} />
                <Reader relay={relay} open={reading} onBack={() => setReading(false)} onCompose={startCompose} onEditDraft={openDraft} onToggleContext={() => setCtxOpen((v) => !v)} reply={reply} onReplyHere={replyHere} />
                <ContextPanel relay={relay} detail={detail} onOpenSettings={() => { setSettingsTab('ai'); setPage('settings'); }} onReply={(_message, seed) => { setCtxOpen(false); replyHere('reply', seed); }} open={ctxOpen} onClose={() => setCtxOpen(false)} />
              </>
            )}
          </div>
        </div>

        <div className="mobile-bar" role="navigation" aria-label="Main">
          <button type="button" aria-current={page === 'mail' && view === 'inbox' ? 'page' : undefined} onClick={() => pickView('inbox')}><Icon name="inbox" size={20} />Inbox</button>
          <button type="button" onClick={() => setPalette(true)}><Icon name="search" size={20} />Search</button>
          <button type="button" className="fab-like" onClick={() => startCompose('new')}><Icon name="pen" size={20} />Compose</button>
          <button type="button" aria-current={page === 'mail' && view === 'sent' ? 'page' : undefined} onClick={() => pickView('sent')}><Icon name="send" size={20} />Sent</button>
          <button type="button" aria-current={page === 'settings' ? 'page' : undefined} onClick={() => setPage('settings')}><Icon name="settings" size={20} />Settings</button>
        </div>
      </div>

      {palette && <Palette relay={relay} onClose={() => setPalette(false)} onCompose={() => startCompose('new')} onSettings={() => { setSettingsTab('system'); setPage('settings'); }} onTheme={toggleTheme} />}
      {relay.toast && (
        <div className="toast" role="status">
          <span className="truncate">{relay.toast.text}</span>
          {relay.toast.undo && <button type="button" onClick={relay.toast.undo}>Undo</button>}
        </div>
      )}
    </div>
  );
}
