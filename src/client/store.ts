import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AddressInfo, Bootstrap, InboxSection, LabelInfo, ListFilters, MailboxInfo, SendRequest, SendResult, ThreadDetail, ThreadSummary, View } from '../shared/types';
import { RequestError, api } from './api';

export interface Scope {
  mailboxId: string | null;
  addressId: string | null;
}
export type Tab = 'All' | 'Unread' | 'Needs Reply';
export type Load = 'loading' | 'ready' | 'error';
export interface Toast {
  text: string;
  undo?: () => void;
}

const message = (err: unknown) => (err instanceof RequestError ? err.message : 'Something went wrong. Try again.');

export const NO_FILTERS: ListFilters = { after: null, before: null, from: '', files: false };
export const filtersOn = (f: ListFilters) => !!(f.after || f.before || f.from.trim() || f.files);

/** Where the person was (mailbox, address, folder, inbox tab), kept on this device so a reload opens the same place.
 *  Storage can be missing or blocked (private windows, framed pages); then the app simply starts at the inbox. */
const PLACE_KEY = 'sadi-mail.place';
interface Place {
  scope: Scope;
  view: View;
  section: InboxSection;
  /** The conversation that was open. */
  threadId: string | null;
}
const VIEWS: readonly View[] = ['inbox', 'archive', 'spam', 'trash', 'starred', 'unread', 'sent', 'drafts', 'scheduled', 'snoozed'];
const SECTIONS: readonly InboxSection[] = ['primary', 'social', 'promotions', 'updates', 'forums'];
const START: Place = { scope: { mailboxId: null, addressId: null }, view: 'inbox', section: 'primary', threadId: null };
function readPlace(): Place {
  try {
    const raw = JSON.parse(localStorage.getItem(PLACE_KEY) ?? 'null') as Partial<Place> | null;
    if (!raw || typeof raw !== 'object') return START;
    const id = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length < 64 ? v : null);
    return {
      scope: { mailboxId: id(raw.scope?.mailboxId), addressId: id(raw.scope?.addressId) },
      view: VIEWS.includes(raw.view as View) ? (raw.view as View) : 'inbox',
      section: SECTIONS.includes(raw.section as InboxSection) ? (raw.section as InboxSection) : 'primary',
      threadId: id(raw.threadId),
    };
  } catch {
    return START;
  }
}
function writePlace(place: Place): void {
  try {
    localStorage.setItem(PLACE_KEY, JSON.stringify(place));
  } catch {
    /* not kept; the next reload starts at the inbox */
  }
}

export function useRelay() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [initial] = useState(readPlace);
  const [scope, setScopeState] = useState<Scope>(initial.scope);
  const [view, setViewState] = useState<View>(initial.view);
  const [tab, setTab] = useState<Tab>('All');
  const [labelId, setLabelId] = useState<string | null>(null);
  const [section, setSectionState] = useState<InboxSection>(initial.section);
  const [labels, setLabels] = useState<LabelInfo[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listLoad, setListLoad] = useState<Load>('loading');
  const [listError, setListError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [detailLoad, setDetailLoad] = useState<Load>('ready');
  const [detailError, setDetailError] = useState('');
  const [loadImages, setLoadImages] = useState(false);
  const [counts, setCounts] = useState({ inbox: 0, spam: 0, scheduled: 0, sections: { primary: 0, social: 0, promotions: 0, updates: 0, forums: 0 } as Record<InboxSection, number> });
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const [filters, setFilters] = useState<ListFilters>(NO_FILTERS);
  const [loadingMore, setLoadingMore] = useState(false);
  const moreBusy = useRef(false);
  const listKey = `${view}|${scope.mailboxId ?? ''}|${scope.addressId ?? ''}|${labelId ?? ''}|${section}|${filters.after}|${filters.before}|${filters.from}|${filters.files}`;
  const liveKey = useRef(listKey);
  const listSeq = useRef(0);
  liveKey.current = listKey;

  const notify = useCallback((next: Toast) => {
    window.clearTimeout(toastTimer.current);
    setToast(next);
    toastTimer.current = window.setTimeout(() => setToast(null), next.undo ? 7000 : 4000);
  }, []);

  const loadBoot = useCallback(async () => {
    try {
      setBoot(await api.get<Bootstrap>('/bootstrap'));
      setBootError(null);
    } catch (err) {
      setBootError(message(err));
    }
  }, []);

  const query = useMemo(() => {
    const q = new URLSearchParams({ view });
    if (scope.mailboxId) q.set('mailbox', scope.mailboxId);
    if (scope.addressId) q.set('address', scope.addressId);
    if (labelId) q.set('label', labelId);
    else if (view === 'inbox') q.set('section', section);
    if (filters.after) q.set('after', String(filters.after));
    if (filters.before) q.set('before', String(filters.before));
    if (filters.from.trim()) q.set('from', filters.from.trim());
    if (filters.files) q.set('files', '1');
    return q.toString();
  }, [view, scope, labelId, section, filters]);

  const loadList = useCallback(
    async (quiet = false) => {
      const key = liveKey.current;
      // Refreshes overlap (after a send, every 20 s, on focus) and can answer out of order. Only the newest request
      // may change the list, or an older answer lands last and the list and its counts jump back and forth.
      const seq = ++listSeq.current;
      if (!quiet) setListLoad('loading');
      try {
        const [page, c] = await Promise.all([
          api.get<{ data: ThreadSummary[]; nextCursor: string | null }>(`/threads?${query}`),
          api.get<typeof counts>(`/counts${scope.mailboxId ? `?mailbox=${scope.mailboxId}` : ''}`),
        ]);
        if (key !== liveKey.current) return; // the person moved on while this was loading
        if (seq !== listSeq.current) return; // a newer refresh was started; its answer wins
        if (quiet) {
          // A background refresh renews the newest page and keeps the older pages already scrolled into view.
          const oldest = page.data[page.data.length - 1];
          let kept = 0;
          setThreads((prev) => {
            if (!oldest || !page.nextCursor) return page.data;
            const fresh = new Set(page.data.map((t) => t.id));
            const tail = prev.filter((t) => !fresh.has(t.id) && t.lastAt <= oldest.lastAt);
            kept = tail.length;
            return [...page.data, ...tail];
          });
          setNextCursor((prev) => (kept > 0 && prev ? prev : page.nextCursor));
        } else {
          setThreads(page.data);
          setNextCursor(page.nextCursor);
        }
        setCounts(c);
        setListLoad('ready');
      } catch (err) {
        if (key !== liveKey.current || seq !== listSeq.current) return;
        if (!quiet) {
          setListError(message(err));
          setListLoad('error');
        }
      }
    },
    [query, scope.mailboxId],
  );

  const loadMore = useCallback(async () => {
    if (!nextCursor || moreBusy.current) return;
    moreBusy.current = true;
    setLoadingMore(true);
    const key = liveKey.current;
    try {
      const page = await api.get<{ data: ThreadSummary[]; nextCursor: string | null }>(`/threads?${query}&cursor=${nextCursor}`);
      if (key !== liveKey.current) return;
      setThreads((prev) => [...prev, ...page.data.filter((t) => !prev.some((p) => p.id === t.id))]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      notify({ text: message(err) });
    } finally {
      moreBusy.current = false;
      setLoadingMore(false);
    }
  }, [nextCursor, query, notify]);

  const loadLabels = useCallback(() => {
    api.get<{ data: LabelInfo[] }>('/labels').then((r) => setLabels(r.data)).catch(() => undefined);
  }, []);
  useEffect(() => {
    void loadBoot();
    loadLabels();
  }, [loadBoot, loadLabels]);
  useEffect(() => {
    void loadList();
  }, [loadList]);

  // New mail shows up without a reload: check quietly every 20 s and when the window regains focus.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') {
        void loadList(true);
        void loadBoot();
      }
    };
    const timer = window.setInterval(tick, 20_000);
    window.addEventListener('focus', tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', tick);
    };
  }, [loadList, loadBoot]);

  const applySummary = useCallback((s: ThreadSummary) => {
    setThreads((prev) => prev.map((t) => (t.id === s.id ? s : t)));
    setDetail((prev) => (prev && prev.id === s.id ? { ...prev, ...s } : prev));
  }, []);

  const loadDetail = useCallback(
    async (id: string, images: boolean) => {
      setDetailLoad('loading');
      try {
        const d = await api.get<ThreadDetail>(`/threads/${id}${images ? '?images=1' : ''}`);
        setDetail(d);
        setDetailLoad('ready');
        if (d.unread) {
          const s = await api.post<ThreadSummary>(`/threads/${id}/actions`, { action: 'read' });
          applySummary(s);
          void loadBoot();
          setCounts((c) => ({ ...c, inbox: Math.max(0, c.inbox - 1) }));
        }
      } catch (err) {
        setDetailError(message(err));
        setDetailLoad('error');
      }
    },
    [applySummary, loadBoot],
  );

  const select = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      setLoadImages(false);
      if (id) void loadDetail(id, false);
      else setDetail(null);
    },
    [loadDetail],
  );

  const showImages = useCallback(() => {
    setLoadImages(true);
    if (selectedId) void loadDetail(selectedId, true);
  }, [selectedId, loadDetail]);

  const setScope = useCallback((next: Scope) => {
    setScopeState(next);
    setPicked(new Set());
    setThreads([]);
    setListLoad('loading');
    setSelectedId(null);
    setDetail(null);
  }, []);
  /** Show one label's conversations (in the inbox view), or clear the label with null. */
  const setLabel = useCallback((id: string | null) => {
    setLabelId(id);
    if (id) setViewState('inbox');
    setThreads([]);
    setListLoad('loading');
    setTab('All');
    setPicked(new Set());
    setSelectedId(null);
    setDetail(null);
  }, []);
  const setSection = useCallback((next: InboxSection) => {
    setSectionState(next);
    setThreads([]);
    setListLoad('loading');
    setPicked(new Set());
    setSelectedId(null);
    setDetail(null);
  }, []);
  /** Move a conversation to another inbox section; later mail from that sender follows it. */
  const moveToSection = useCallback(
    async (thread: ThreadSummary, to: InboxSection) => {
      const before = threads;
      if (view === 'inbox' && !labelId) {
        const rest = threads.filter((t) => t.id !== thread.id);
        setThreads(rest);
        if (selectedId === thread.id) select(rest[0]?.id ?? null);
      }
      try {
        await api.post(`/threads/${thread.id}/actions`, { action: 'section', section: to });
        notify({ text: `Moved To ${to.charAt(0).toUpperCase() + to.slice(1)}. New Mail From This Sender Goes There Too.` });
        void loadList(true);
      } catch (err) {
        setThreads(before);
        notify({ text: message(err) });
      }
    },
    [threads, view, labelId, selectedId, select, notify, loadList],
  );
  const setView = useCallback((next: View) => {
    setLabelId(null);
    setPicked(new Set());
    setViewState(next);
    setThreads([]);
    setListLoad('loading');
    setTab('All');
    setSelectedId(null);
    setDetail(null);
  }, []);

  /** Archive, trash, spam and "back to inbox" remove the row at once and can be undone. */
  const act = useCallback(
    async (thread: ThreadSummary, action: 'read' | 'unread' | 'star' | 'unstar' | 'archive' | 'trash' | 'spam' | 'inbox') => {
      const moves = action === 'archive' || action === 'trash' || action === 'spam' || action === 'inbox';
      const before = threads;
      if (moves) {
        const index = threads.findIndex((t) => t.id === thread.id);
        const rest = threads.filter((t) => t.id !== thread.id);
        setThreads(rest);
        if (selectedId === thread.id) select(rest[Math.min(index, rest.length - 1)]?.id ?? null);
      }
      try {
        const s = await api.post<ThreadSummary>(`/threads/${thread.id}/actions`, { action });
        if (!moves) applySummary(s);
        if (moves) {
          const label = { archive: 'Archived', trash: 'Moved To Trash', spam: 'Marked As Spam', inbox: 'Moved To Inbox' }[action];
          notify({
            text: `${label}: ${thread.subject}`,
            undo: () => {
              void api.post(`/threads/${thread.id}/actions`, { action: thread.folder === 'inbox' ? 'inbox' : thread.folder }).then(() => loadList(true));
              setToast(null);
            },
          });
        }
        void loadBoot();
      } catch (err) {
        if (moves) setThreads(before);
        notify({ text: message(err) });
      }
    },
    [threads, selectedId, select, applySummary, notify, loadBoot, loadList],
  );

  const snooze = useCallback(
    async (thread: ThreadSummary, until: number) => {
      const before = threads;
      const rest = threads.filter((t) => t.id !== thread.id);
      if (view !== 'snoozed') setThreads(rest);
      if (selectedId === thread.id && view !== 'snoozed') select(rest[0]?.id ?? null);
      try {
        await api.post(`/threads/${thread.id}/actions`, { action: 'snooze', until });
        notify({ text: `Snoozed: ${thread.subject}`, undo: () => { void api.post(`/threads/${thread.id}/actions`, { action: 'inbox' }).then(() => loadList(true)); setToast(null); } });
      } catch (err) {
        setThreads(before);
        notify({ text: message(err) });
      }
    },
    [threads, view, selectedId, select, notify, loadList],
  );

  const toggleLabel = useCallback(
    async (thread: ThreadSummary, labelIdToSet: string, on: boolean) => {
      try {
        const r = await api.post<{ data: LabelInfo[] }>(`/threads/${thread.id}/labels`, { labelId: labelIdToSet, on });
        applySummary({ ...thread, labels: r.data });
      } catch (err) {
        notify({ text: message(err) });
      }
    },
    [applySummary, notify],
  );

  const deleteForever = useCallback(
    async (thread: ThreadSummary) => {
      if (!window.confirm(`Delete “${thread.subject}” for good? This cannot be undone.`)) return;
      try {
        await api.post(`/threads/${thread.id}/delete-forever`);
        const rest = threads.filter((t) => t.id !== thread.id);
        setThreads(rest);
        if (selectedId === thread.id) select(rest[0]?.id ?? null);
        notify({ text: 'Deleted For Good' });
        void loadBoot();
      } catch (err) {
        notify({ text: message(err) });
      }
    },
    [threads, selectedId, select, notify, loadBoot],
  );

  const emptyFolder = useCallback(
    async (folder: 'trash' | 'spam') => {
      const name = folder === 'trash' ? 'Trash' : 'Spam';
      if (!window.confirm(`Delete everything in ${name} for good? This cannot be undone.`)) return;
      try {
        const r = await api.post<{ removed: number; more: boolean }>(`/folders/${folder}/empty${scope.mailboxId ? `?mailbox=${scope.mailboxId}` : ''}`);
        notify({ text: r.more ? `${r.removed} Deleted. More Remain: Empty Again.` : `${name} Emptied: ${r.removed} Deleted` });
        select(null);
        void loadList();
        void loadBoot();
      } catch (err) {
        notify({ text: message(err) });
      }
    },
    [scope.mailboxId, notify, select, loadList, loadBoot],
  );

  const togglePick = useCallback((id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** One action on every ticked conversation. */
  const actPicked = useCallback(
    async (action: 'read' | 'unread' | 'archive' | 'trash' | 'spam' | 'inbox' | 'star') => {
      const ids = [...picked];
      if (ids.length === 0) return;
      const moves = action === 'archive' || action === 'trash' || action === 'spam' || action === 'inbox';
      const before = threads;
      if (moves) {
        setThreads(threads.filter((t) => !picked.has(t.id)));
        if (selectedId && picked.has(selectedId)) select(null);
      }
      setPicked(new Set());
      const results = await Promise.allSettled(ids.map((id) => api.post<ThreadSummary>(`/threads/${id}/actions`, { action })));
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed && moves) setThreads(before);
      const done = ids.length - failed;
      const word = { read: 'Marked Read', unread: 'Marked Unread', archive: 'Archived', trash: 'Moved To Trash', spam: 'Marked As Spam', inbox: 'Moved To Inbox', star: 'Starred' }[action];
      notify({ text: failed ? `${done} Done, ${failed} Could Not Be Changed` : `${word}: ${done} ${done === 1 ? 'Conversation' : 'Conversations'}` });
      void loadList(true);
      void loadBoot();
    },
    [picked, threads, selectedId, select, notify, loadList, loadBoot],
  );

  const send = useCallback(
    async (request: SendRequest): Promise<SendResult> => {
      const result = await api.post<SendResult>('/send', request);
      void loadList(true);
      if (selectedId === result.threadId) void loadDetail(result.threadId, loadImages);
      return result;
    },
    [loadList, loadDetail, selectedId, loadImages],
  );

  const mailboxes: MailboxInfo[] = boot?.mailboxes ?? [];
  const addresses: AddressInfo[] = useMemo(() => mailboxes.flatMap((m) => m.addresses), [mailboxes]);

  useEffect(() => writePlace({ scope, view, section, threadId: selectedId }), [scope, view, section, selectedId]);
  /** The conversation open before a reload, handed out once so the first list opens it again instead of the newest. */
  const restoreThread = useRef(initial.threadId);
  const takeRestoreThread = useCallback(() => {
    const id = restoreThread.current;
    restoreThread.current = null;
    return id;
  }, []);
  // A remembered mailbox or address the person can no longer see (removed, or access taken away) falls back to all mail.
  useEffect(() => {
    if (!boot) return;
    const mailboxOk = !scope.mailboxId || mailboxes.some((m) => m.id === scope.mailboxId);
    const addressOk = !scope.addressId || addresses.some((a) => a.id === scope.addressId);
    if (!mailboxOk || !addressOk) setScope({ mailboxId: null, addressId: null });
  }, [boot, mailboxes, addresses, scope, setScope]);
  const visible = useMemo(
    () => threads.filter((t) => (tab === 'All' ? true : tab === 'Unread' ? t.unread : t.needsReply)),
    [threads, tab],
  );

  return {
    deleteForever, emptyFolder, section, setSection, moveToSection,
    labelId, setLabel, labels, loadLabels, snooze, toggleLabel, picked, togglePick, clearPicked: () => setPicked(new Set()), pickAll: (ids: string[]) => setPicked(new Set(ids)), actPicked, applySummary, loadDetail,
    boot, bootError, loadBoot, mailboxes, addresses, scope, setScope, takeRestoreThread, view, setView, tab, setTab, threads: visible, allThreads: threads, nextCursor, loadMore, loadingMore, filters, setFilters,
    listLoad, listError, loadList, selectedId, select, detail, detailLoad, detailError, loadImages, showImages, counts, act, send, toast, setToast, notify,
  };
}

export type MailStore = ReturnType<typeof useRelay>;
