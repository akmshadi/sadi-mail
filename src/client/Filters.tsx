import { useEffect, useState } from 'react';
import type { ListFilters } from '../shared/types';
import { Icon } from './icons';
import { NO_FILTERS, filtersOn } from './store';

const DAY = 86_400_000;
const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
// A date-and-time field speaks local time as "2026-11-23T14:30".
const toField = (ms: number | null) => { if (!ms) return ''; const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000); return d.toISOString().slice(0, 16); };
const fromField = (v: string) => (v ? new Date(v).getTime() || null : null);
const short = (ms: number) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

type Preset = { key: string; label: string; range: () => [number | null, number | null] };
const PRESETS: Preset[] = [
  { key: 'today', label: 'Today', range: () => [startOfDay(), null] },
  { key: 'yesterday', label: 'Yesterday', range: () => [startOfDay() - DAY, startOfDay()] },
  { key: '7', label: 'Last 7 Days', range: () => [startOfDay() - 6 * DAY, null] },
  { key: '30', label: 'Last 30 Days', range: () => [startOfDay() - 29 * DAY, null] },
  { key: 'month', label: 'This Month', range: () => { const d = new Date(); return [new Date(d.getFullYear(), d.getMonth(), 1).getTime(), null]; } },
];

/** A one-line description of what is switched on, for the bar above the list. */
export function describeFilters(f: ListFilters): string {
  const parts: string[] = [];
  if (f.after && f.before) parts.push(`${short(f.after)} to ${short(f.before)}`);
  else if (f.after) parts.push(`Since ${short(f.after)}`);
  else if (f.before) parts.push(`Before ${short(f.before)}`);
  if (f.from.trim()) parts.push(`From "${f.from.trim()}"`);
  if (f.files) parts.push('With Attachments');
  return parts.join(' · ');
}

export function FilterPanel({ value, onChange, onClose }: { value: ListFilters; onChange: (f: ListFilters) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const set = (patch: Partial<ListFilters>) => setDraft((d) => ({ ...d, ...patch }));
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 12 }, (_, i) => thisYear - i);
  const yearOf = draft.after && draft.before && new Date(draft.after).getMonth() === 0 && new Date(draft.after).getDate() === 1 && draft.before === new Date(new Date(draft.after).getFullYear() + 1, 0, 1).getTime() ? String(new Date(draft.after).getFullYear()) : '';
  const apply = (next: ListFilters) => { onChange(next); };
  const wrong = !!(draft.after && draft.before && draft.after >= draft.before);

  return (
    <form className="filters" aria-label="Filter Messages By Date And Sender" onSubmit={(e) => { e.preventDefault(); if (!wrong) { apply(draft); onClose(); } }} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <div className="chips" role="group" aria-label="Quick Ranges">
        {PRESETS.map((p) => <button key={p.key} type="button" className="chip" onClick={() => { const [after, before] = p.range(); const next = { ...draft, after, before }; setDraft(next); apply(next); }}>{p.label}</button>)}
        <label className="chip year">
          <span className="sr">Year</span>
          <select aria-label="Year" value={yearOf} onChange={(e) => { const y = Number(e.target.value); const next = y ? { ...draft, after: new Date(y, 0, 1).getTime(), before: new Date(y + 1, 0, 1).getTime() } : { ...draft, after: null, before: null }; setDraft(next); apply(next); }}>
            <option value="">Year</option>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
      </div>
      <div className="range">
        <label>From Date And Time<input className="field" type="datetime-local" value={toField(draft.after)} onChange={(e) => set({ after: fromField(e.target.value) })} /></label>
        <label>To Date And Time<input className="field" type="datetime-local" value={toField(draft.before)} onChange={(e) => set({ before: fromField(e.target.value) })} /></label>
      </div>
      <label>Sender<input className="field" value={draft.from} placeholder="Name or part of an address" onChange={(e) => set({ from: e.target.value })} /></label>
      <label className="check"><input type="checkbox" checked={draft.files} onChange={(e) => set({ files: e.target.checked })} />Only Mail With Attachments</label>
      {wrong && <div className="notice warn" role="alert">The end of the range is before its start.</div>}
      <div className="actions">
        <button type="button" className="btn small ghost" disabled={!filtersOn(draft) && !filtersOn(value)} onClick={() => { setDraft(NO_FILTERS); apply(NO_FILTERS); }}>Clear All</button>
        <span className="grow" />
        <button type="button" className="btn small ghost" onClick={onClose}>Close</button>
        <button type="submit" className="btn small primary" disabled={wrong}><Icon name="check" size={13} weight={2.4} />Apply</button>
      </div>
    </form>
  );
}
