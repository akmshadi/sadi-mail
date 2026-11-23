import { useEffect, useMemo, useRef, useState } from 'react';
import type { ThreadSummary, View } from '../shared/types';
import { api } from './api';
import { shortTime } from './format';
import { Icon, type IconName } from './icons';
import { Avatar, VIEW_TITLES } from './Mail';
import type { MailStore } from './store';

// ---------- command palette ----------

interface Command {
  id: string;
  label: string;
  hint?: string;
  detail?: string;
  icon: IconName;
  run: () => void;
}

export function Palette({ relay, onClose, onCompose, onSettings, onTheme }: { relay: MailStore; onClose: () => void; onCompose: () => void; onSettings: () => void; onTheme: () => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<ThreadSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => input.current?.focus(), []);

  const commands = useMemo<Command[]>(() => {
    const out: Command[] = [{ id: 'new', label: 'New Message', hint: 'C', icon: 'pen', run: onCompose }];
    out.push({ id: 'all', label: 'Switch To All Mailboxes', hint: '⌘1', icon: 'layers', run: () => relay.setScope({ mailboxId: null, addressId: null }) });
    relay.mailboxes.forEach((m, i) => {
      out.push({ id: `mb-${m.id}`, label: `Switch To ${m.name}`, detail: `${m.addresses.length} ${m.addresses.length === 1 ? 'Address' : 'Addresses'}`, hint: i < 8 ? `⌘${i + 2}` : undefined, icon: 'inbox', run: () => relay.setScope({ mailboxId: m.id, addressId: null }) });
      for (const a of m.addresses) out.push({ id: `ad-${a.id}`, label: `Switch To ${a.email}`, detail: m.name, icon: 'unread', run: () => relay.setScope({ mailboxId: m.id, addressId: a.id }) });
    });
    for (const v of ['inbox', 'unread', 'starred', 'sent', 'scheduled', 'archive', 'spam', 'trash'] as View[]) {
      out.push({ id: `go-${v}`, label: `Go To ${VIEW_TITLES[v]}`, icon: v === 'inbox' ? 'inbox' : v === 'starred' ? 'star' : v === 'sent' ? 'send' : v === 'scheduled' ? 'sched' : v === 'unread' ? 'unread' : (v as IconName), run: () => relay.setView(v) });
    }
    out.push({ id: 'theme', label: 'Switch Light Or Dark Theme', icon: 'sun', run: onTheme });
    if (relay.boot?.user.role === 'owner' || relay.boot?.user.role === 'admin') out.push({ id: 'settings', label: 'Open Settings', icon: 'settings', run: onSettings });
    return out;
  }, [relay, onCompose, onSettings, onTheme]);

  const term = q.trim().toLowerCase();
  const matched = term ? commands.filter((c) => term.split(/\s+/).every((w) => c.label.toLowerCase().includes(w))) : commands.slice(0, 7);

  useEffect(() => {
    if (term.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    let stale = false;
    const timer = window.setTimeout(() => {
      api
        .get<{ data: ThreadSummary[] }>(`/search?q=${encodeURIComponent(term)}`)
        .then((r) => !stale && setHits(r.data))
        .catch(() => !stale && setHits([]))
        .finally(() => !stale && setSearching(false));
    }, 160);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [term]);

  const total = hits.length + matched.length;
  useEffect(() => setActive(0), [term, hits.length]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (index: number) => {
    const hit = hits[index];
    if (hit) {
      relay.setScope({ mailboxId: null, addressId: null });
      relay.setView(hit.folder === 'inbox' ? 'inbox' : hit.folder);
      relay.select(hit.id);
    } else {
      matched[index - hits.length]?.run();
    }
    onClose();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, total - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (total) run(active); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  const mailboxName = (id: string) => relay.mailboxes.find((m) => m.id === id)?.name ?? '';

  return (
    <div className="overlay">
      <button type="button" className="scrim" aria-label="Close Command Palette" onClick={onClose} />
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command Palette" onKeyDown={onKey}>
        <div className="palette-input">
          <Icon name="search" size={19} weight={1.8} />
          <input ref={input} aria-label="Search Mail Or Run A Command" placeholder="Search mail across every address, or type a command" value={q} onChange={(e) => setQ(e.target.value)} role="combobox" aria-expanded="true" aria-controls="palette-list" />
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" size={15} weight={2} /></button>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {term.length >= 2 && (
            <div className="palette-label"><span className="grow">Mail</span><span style={{ fontWeight: 500 }}>{searching ? 'Searching…' : `${hits.length} Found In ${relay.mailboxes.length} ${relay.mailboxes.length === 1 ? 'Mailbox' : 'Mailboxes'}`}</span></div>
          )}
          {hits.map((h, i) => (
            <button key={h.id} type="button" role="option" aria-selected={active === i} className="palette-item" onMouseMove={() => setActive(i)} onClick={() => run(i)}>
              <Avatar name={h.fromName} email={h.fromEmail} />
              <span className="grow" style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <span className="truncate" style={{ fontWeight: 600 }}>{h.subject}</span>
                <small className="truncate">{h.fromName || h.fromEmail} · {h.addressEmail} · {mailboxName(h.mailboxId)}</small>
              </span>
              <small className="num">{shortTime(h.lastAt)}</small>
            </button>
          ))}
          {term.length >= 2 && !searching && hits.length === 0 && <div className="palette-label" style={{ fontWeight: 400 }}>No mail matches “{q.trim()}”.</div>}
          {matched.length > 0 && <div className="palette-label">Commands</div>}
          {matched.map((c, i) => (
            <button key={c.id} type="button" role="option" aria-selected={active === hits.length + i} className="palette-item" onMouseMove={() => setActive(hits.length + i)} onClick={() => run(hits.length + i)}>
              <Icon name={c.icon} />
              <span className="grow truncate">{c.label}{c.detail && <small style={{ marginLeft: 8 }}>{c.detail}</small>}</span>
              {c.hint && <span className="hint">{c.hint}</span>}
            </button>
          ))}
        </div>
        <div className="palette-foot">
          <span className="grow">↑↓ To Navigate</span>
          <span>Open<span className="kbd">↵</span></span>
          <span>Close<span className="kbd">esc</span></span>
        </div>
      </div>
    </div>
  );
}
