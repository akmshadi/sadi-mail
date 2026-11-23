import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type Align, type Block, type BlockType, type Column, type DesignSettings, type EmailDesign, type FontKey, type ItemRow, type Starter,
  BLOCK_NAMES, BLOCK_TYPES, MAX_BLOCKS, MAX_ROWS, STARTERS, copyBlock, hex6, instantiate, isStarter, mix, newBlock, readableOn, renderDesign, safeImage, safeUrl,
  type HeaderTone, type Layout, type Letterhead, letterheadReady, withLetterhead,
} from '../shared/design';
import { Icon } from './icons';
import { uploadImage } from './upload';
import './designer.css';

// The Email Design Builder: blocks on the left, a live preview of the email on the right.
// Every subcomponent lives at module level and every card is keyed by its block id, so typing
// never remounts an input and focus stays where the person left it.

const ALIGNS: [Align, string][] = [['left', 'Left'], ['center', 'Center'], ['right', 'Right']];
const TONES: [HeaderTone, string][] = [['light', 'Light, With A Line'], ['dark', 'Dark'], ['accent', 'Accent Colour']];
const LAYOUTS: [Layout, string][] = [['center', 'Centred Card'], ['left', 'Left, Like A Letter']];
const FONTS: [FontKey, string][] = [['sans', 'Sans Serif'], ['serif', 'Serif'], ['mono', 'Monospace']];
const DEVICES = { desktop: 600, phone: 375 } as const;

// ---------- fields ----------

function TextField({ label, value, onChange, placeholder, wide, type = 'text', maxLength = 300 }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; wide?: boolean; type?: 'text' | 'url'; maxLength?: number }) {
  return (
    <label className={`dz-field${wide ? ' wide' : ''}`}>
      <span>{label}</span>
      <input className="field" type={type} value={value} maxLength={maxLength} placeholder={placeholder} spellCheck={type !== 'url'} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function AreaField({ label, value, onChange, rows = 4, hint }: { label: string; value: string; onChange: (v: string) => void; rows?: number; hint?: string }) {
  return (
    <label className="dz-field wide">
      <span>{label}</span>
      <textarea className="field" rows={rows} value={value} maxLength={5000} onChange={(e) => onChange(e.target.value)} />
      {hint && <small className="dz-hint">{hint}</small>}
    </label>
  );
}

/** A link field that says plainly when the address will not become a link. */
function UrlField({ label, value, onChange, image, wide = true, placeholder = 'https://' }: { label: string; value: string; onChange: (v: string) => void; image?: boolean; wide?: boolean; placeholder?: string }) {
  const bad = value.trim() !== '' && !(image ? safeImage(value) : safeUrl(value));
  return (
    <label className={`dz-field${wide ? ' wide' : ''}`}>
      <span>{label}</span>
      <input className="field" type="url" inputMode="url" spellCheck={false} value={value} maxLength={2048} placeholder={placeholder} aria-invalid={bad} onChange={(e) => onChange(e.target.value)} />
      {bad && <small className="dz-hint">{image ? 'Use an image address that starts with https:// or http://.' : 'Links must start with https://, http:// or mailto:. Until then this shows without a link.'}</small>}
    </label>
  );
}

/** A picture: upload one (it is stored with your mail and given a public address), or paste an address. */
function ImageField({ label, value, onChange, maxSide }: { label: string; value: string; onChange: (v: string) => void; maxSide: number }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const shown = safeImage(value);
  const bad = value.trim() !== '' && !shown;
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    setBusy(true);
    try {
      onChange(await uploadImage(file, maxSide));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The picture could not be uploaded.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dz-field wide dz-image">
      <span>{label}</span>
      <div className="dz-image-row">
        {shown ? <img src={shown} alt="" /> : <i aria-hidden="true"><Icon name="image" size={18} /></i>}
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
        <button type="button" className="btn small" disabled={busy} aria-busy={busy} onClick={() => input.current?.click()}>{busy ? 'Uploading…' : shown ? 'Replace Picture' : 'Upload Picture'}</button>
        {value && <button type="button" className="btn small ghost" onClick={() => onChange('')}>Remove</button>}
      </div>
      <input className="field" type="url" inputMode="url" spellCheck={false} value={value} maxLength={2048} placeholder="Or paste an image address: https://" aria-label={`${label}: Image Address`} aria-invalid={bad} onChange={(e) => onChange(e.target.value)} />
      {(bad || error) && <small className="dz-hint">{error || 'Use an image address that starts with https:// or http://.'}</small>}
    </div>
  );
}

function SelectField<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <label className="dz-field">
      <span>{label}</span>
      <select className="field" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </select>
    </label>
  );
}

const AlignField = ({ value, onChange }: { value: Align; onChange: (a: Align) => void }) => <SelectField label="Alignment" value={value} options={ALIGNS} onChange={onChange} />;

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const swatch = (hex6(value) ?? '#000000').toLowerCase();
  return (
    <div className="dz-field dz-color" role="group" aria-label={`${label} Color`}>
      <span aria-hidden="true">{label}</span>
      <div>
        <input type="color" aria-label={`Pick ${label} Color`} value={swatch} onChange={(e) => onChange(e.target.value.toUpperCase())} />
        <input
          className="field mono" aria-label={`${label} Color Code`} value={value} maxLength={7} spellCheck={false} aria-invalid={!hex6(value)}
          onChange={(e) => { const v = e.target.value.trim(); if (/^#?[0-9a-f]{0,6}$/i.test(v)) onChange(v.startsWith('#') ? v : `#${v}`); }}
        />
      </div>
    </div>
  );
}

// ---------- block editors ----------

function ColumnFields({ title, column, onChange }: { title: string; column: Column; onChange: (c: Column) => void }) {
  const set = (p: Partial<Column>) => onChange({ ...column, ...p });
  return (
    <fieldset className="dz-sub">
      <legend>{title}</legend>
      <TextField label="Heading" wide value={column.heading} onChange={(heading) => set({ heading })} />
      <AreaField label="Text" rows={3} value={column.text} onChange={(text) => set({ text })} />
      <TextField label="Button Label" value={column.label} maxLength={120} placeholder="Optional" onChange={(label) => set({ label })} />
      <UrlField label="Button Link" wide={false} value={column.url} onChange={(url) => set({ url })} />
    </fieldset>
  );
}

function ItemsFields({ rows, total, onChange }: { rows: ItemRow[]; total: ItemRow | null; onChange: (p: { rows?: ItemRow[]; total?: ItemRow | null }) => void }) {
  const setRow = (i: number, p: Partial<ItemRow>) => onChange({ rows: rows.map((r, j) => (j === i ? { ...r, ...p } : r)) });
  return (
    <div className="dz-items wide">
      <div className="dz-items-head" aria-hidden="true"><span>Item</span><span>Amount</span><span /></div>
      {rows.map((r, i) => (
        // Rows have no id of their own; the index is their identity, and only the last row can be added.
        <div className="dz-items-row" key={i}>
          <input className="field" aria-label={`Item ${i + 1}`} value={r.label} maxLength={300} onChange={(e) => setRow(i, { label: e.target.value })} />
          <input className="field num" aria-label={`Amount ${i + 1}`} value={r.amount} maxLength={60} onChange={(e) => setRow(i, { amount: e.target.value })} />
          <button type="button" className="icon-btn" aria-label={`Remove Item ${i + 1}`} title="Remove" onClick={() => onChange({ rows: rows.filter((_, j) => j !== i) })}><Icon name="close" size={14} weight={2} /></button>
        </div>
      ))}
      <div>
        <button type="button" className="btn small" disabled={rows.length >= MAX_ROWS} onClick={() => onChange({ rows: [...rows, { label: '', amount: '' }] })}><Icon name="plus" size={14} weight={2} />Add Row</button>
      </div>
      <label className="dz-check">
        <input type="checkbox" checked={total !== null} onChange={(e) => onChange({ total: e.target.checked ? { label: 'Total', amount: '' } : null })} />
        Show A Total Row
      </label>
      {total && (
        <div className="dz-items-row">
          <input className="field" aria-label="Total Label" value={total.label} maxLength={300} onChange={(e) => onChange({ total: { ...total, label: e.target.value } })} />
          <input className="field num" aria-label="Total Amount" value={total.amount} maxLength={60} onChange={(e) => onChange({ total: { ...total, amount: e.target.value } })} />
          <span />
        </div>
      )}
    </div>
  );
}

function BlockFields({ block, onChange }: { block: Block; onChange: (b: Block) => void }) {
  switch (block.type) {
    case 'header': {
      const b = block;
      return (<>
        <TextField label="Brand Name" value={b.brand} onChange={(brand) => onChange({ ...b, brand })} />
        <AlignField value={b.align} onChange={(align) => onChange({ ...b, align })} />
        <TextField label="Line Under The Name (Optional)" value={b.tagline ?? ''} placeholder="What the company does, in a few words" onChange={(tagline) => onChange({ ...b, tagline })} />
        <SelectField<HeaderTone> label="Band" value={b.tone ?? 'dark'} options={TONES} onChange={(tone) => onChange({ ...b, tone })} />
        <ImageField label="Logo (Optional)" maxSide={600} value={b.logo} onChange={(logo) => onChange({ ...b, logo })} />
      </>);
    }
    case 'heading': {
      const b = block;
      return (<>
        <TextField label="Heading" wide value={b.text} onChange={(text) => onChange({ ...b, text })} />
        <SelectField<'1' | '2'> label="Size" value={String(b.level) as '1' | '2'} options={[['1', 'Large'], ['2', 'Medium']]} onChange={(v) => onChange({ ...b, level: v === '1' ? 1 : 2 })} />
        <AlignField value={b.align} onChange={(align) => onChange({ ...b, align })} />
      </>);
    }
    case 'text': {
      const b = block;
      return (<>
        <AreaField label="Text" rows={5} value={b.text} hint="Leave a blank line to start a new paragraph." onChange={(text) => onChange({ ...b, text })} />
        <AlignField value={b.align} onChange={(align) => onChange({ ...b, align })} />
      </>);
    }
    case 'button': {
      const b = block;
      return (<>
        <TextField label="Label" value={b.label} maxLength={120} onChange={(label) => onChange({ ...b, label })} />
        <AlignField value={b.align} onChange={(align) => onChange({ ...b, align })} />
        <UrlField label="Link" value={b.url} onChange={(url) => onChange({ ...b, url })} />
      </>);
    }
    case 'image': {
      const b = block;
      return (<>
        <ImageField label="Picture" maxSide={1200} value={b.url} onChange={(url) => onChange({ ...b, url })} />
        <TextField label="Alt Text" value={b.alt} placeholder="What the image shows" onChange={(alt) => onChange({ ...b, alt })} />
        <SelectField<'contained' | 'full'> label="Width" value={b.full ? 'full' : 'contained'} options={[['contained', 'Contained'], ['full', 'Full Width']]} onChange={(v) => onChange({ ...b, full: v === 'full' })} />
        <UrlField label="Link (Optional)" value={b.link} onChange={(link) => onChange({ ...b, link })} />
        <p className="dz-hint wide">An uploaded picture is stored with your mail and loaded from this installation when the email is opened.</p>
      </>);
    }
    case 'divider':
      return <p className="dz-hint wide">A thin line between sections. It has no settings.</p>;
    case 'spacer': {
      const b = block;
      const heights = [8, 16, 24, 32, 48, 64, 96];
      const options = (heights.includes(b.height) ? heights : [...heights, b.height].sort((x, y) => x - y)).map((h): [string, string] => [String(h), `${h} px`]);
      return <SelectField label="Height" value={String(b.height)} options={options} onChange={(v) => onChange({ ...b, height: Number(v) })} />;
    }
    case 'columns': {
      const b = block;
      return (<>
        <ColumnFields title="Left Column" column={b.left} onChange={(left) => onChange({ ...b, left })} />
        <ColumnFields title="Right Column" column={b.right} onChange={(right) => onChange({ ...b, right })} />
        <p className="dz-hint wide">On a phone the right column moves below the left one.</p>
      </>);
    }
    case 'items': {
      const b = block;
      return <ItemsFields rows={b.rows} total={b.total} onChange={(p) => onChange({ ...b, ...p })} />;
    }
    case 'quote': {
      const b = block;
      return (<>
        <AreaField label="Quote" rows={3} value={b.text} onChange={(text) => onChange({ ...b, text })} />
        <TextField label="Attribution" wide value={b.cite} placeholder="Optional" onChange={(cite) => onChange({ ...b, cite })} />
      </>);
    }
    case 'footer': {
      const b = block;
      return (<>
        <AreaField label="Footer Text" rows={3} value={b.text} onChange={(text) => onChange({ ...b, text })} />
        <TextField label="Address Line (Optional)" wide value={b.address} onChange={(address) => onChange({ ...b, address })} />
      </>);
    }
  }
}

function summary(b: Block): string {
  const line = (t: string) => t.replace(/\s+/g, ' ').trim();
  switch (b.type) {
    case 'header': return line(b.brand);
    case 'heading': case 'text': case 'quote': case 'footer': return line(b.text);
    case 'button': return line(b.label);
    case 'image': return line(b.alt) || (safeImage(b.url) ? b.url : 'No image address yet');
    case 'divider': return '';
    case 'spacer': return `${b.height} px`;
    case 'columns': return [line(b.left.heading), line(b.right.heading)].filter(Boolean).join(' · ');
    case 'items': return `${b.rows.length} ${b.rows.length === 1 ? 'row' : 'rows'}${b.total ? ' and a total' : ''}`;
  }
}

type Action = 'up' | 'down' | 'copy' | 'delete';

function BlockCard({ block, index, count, open, full, onToggle, onChange, onAct }: {
  block: Block; index: number; count: number; open: boolean; full: boolean;
  onToggle: () => void; onChange: (b: Block) => void; onAct: (a: Action) => void;
}) {
  const name = BLOCK_NAMES[block.type];
  const text = summary(block);
  return (
    <li className={`dz-card${open ? ' open' : ''}`} id={`dz-${block.id}`}>
      <div className="dz-card-head">
        <button type="button" className="dz-toggle" aria-expanded={open} aria-controls={`dz-body-${block.id}`} onClick={onToggle}>
          <Icon name="right" size={14} weight={2} className="dz-chev" />
          <b>{name}</b>
          {text && <span className="truncate">{text}</span>}
        </button>
        <button type="button" className="icon-btn" data-act="up" aria-label={`Move ${name} Up`} title="Move Up" disabled={index === 0} onClick={() => onAct('up')}><Icon name="up" size={15} weight={2} /></button>
        <button type="button" className="icon-btn" data-act="down" aria-label={`Move ${name} Down`} title="Move Down" disabled={index === count - 1} onClick={() => onAct('down')}><Icon name="down" size={15} weight={2} /></button>
        <button type="button" className="icon-btn" data-act="copy" aria-label={`Duplicate ${name}`} title="Duplicate" disabled={full} onClick={() => onAct('copy')}><Icon name="copy" size={15} /></button>
        <button type="button" className="icon-btn" data-act="delete" aria-label={`Delete ${name}`} title="Delete" onClick={() => onAct('delete')}><Icon name="trash" size={15} /></button>
      </div>
      {open && <div className="dz-card-body" id={`dz-body-${block.id}`}><BlockFields block={block} onChange={onChange} /></div>}
    </li>
  );
}

// ---------- starting designs ----------

/** A small drawing of a starter's block order, in the app's own colours. */
function Thumb({ starter }: { starter: Starter }) {
  return (
    <span className={`dz-thumb${starter.design.settings.font === 'serif' ? ' serif' : ''}`} aria-hidden="true">
      {starter.design.blocks.map((b) => {
        const at = 'align' in b ? ` a-${b.align}` : '';
        switch (b.type) {
          case 'header': return <i key={b.id} className={`t-head${at}`}><i /></i>;
          case 'heading': return <i key={b.id} className={`t-heading l${b.level}${at}`}><i /></i>;
          case 'text': return <i key={b.id} className={`t-text${at}`}><i /><i /></i>;
          case 'button': return <i key={b.id} className={`t-button${at}`}><i /></i>;
          case 'divider': return <i key={b.id} className="t-divider" />;
          case 'items': return <i key={b.id} className="t-items"><i /><i /><i /><i /></i>;
          case 'columns': return <i key={b.id} className="t-columns"><i /><i /></i>;
          case 'quote': return <i key={b.id} className="t-quote"><i /></i>;
          case 'footer': return <i key={b.id} className="t-footer"><i /></i>;
          default: return <i key={b.id} className="t-text"><i /></i>;
        }
      })}
    </span>
  );
}

// ---------- preview ----------

function Preview({ html, width }: { html: string; width: number }) {
  const fit = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [room, setRoom] = useState<number>(width);
  const [height, setHeight] = useState(480);

  useEffect(() => {
    const el = fit.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setRoom(el.clientWidth));
    observer.observe(el);
    setRoom(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  // The height follows the email's content. The last height is kept while a new version loads, so the canvas does not jump.
  useEffect(() => {
    const f = frame.current;
    if (!f) return;
    let observer: ResizeObserver | undefined;
    const measure = () => {
      const body = f.contentDocument?.body;
      if (!body) return;
      setHeight(Math.min(Math.max(Math.ceil(body.getBoundingClientRect().height), 120), 20_000));
    };
    const onLoad = () => {
      observer?.disconnect();
      measure();
      const body = f.contentDocument?.body;
      if (body) {
        observer = new ResizeObserver(measure);
        observer.observe(body);
      }
    };
    f.addEventListener('load', onLoad);
    return () => {
      f.removeEventListener('load', onLoad);
      observer?.disconnect();
    };
  }, [html]);

  const scale = room > 0 ? Math.min(1, room / width) : 1;
  return (
    <div className="dz-canvas">
      <div className="dz-fit" ref={fit}>
        <div className={`dz-stage${width < 600 ? ' phone' : ''}`} style={{ width: Math.floor(width * scale), height: Math.ceil(height * scale) }}>
          <iframe ref={frame} title="Email Preview" sandbox="allow-same-origin" srcDoc={html} style={{ width, height, transform: scale < 1 ? `scale(${scale})` : undefined }} />
        </div>
      </div>
    </div>
  );
}

// ---------- the builder ----------

export function Designer({ design, onChange, letterhead }: { design: EmailDesign; onChange: (d: EmailDesign) => void; letterhead?: Letterhead }) {
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const [device, setDevice] = useState<keyof typeof DEVICES>('desktop');
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [adding, setAdding] = useState(false);
  const [focus, setFocus] = useState<{ id: string; act?: Action } | null>(null);
  const addRef = useRef<HTMLSpanElement>(null);
  const html = useMemo(() => renderDesign(design, { preview: true }), [design]);
  const { blocks, settings } = design;
  const full = blocks.length >= MAX_BLOCKS;

  // After a move, add or duplicate, bring the card into view and put focus back where it belongs.
  useEffect(() => {
    if (!focus) return;
    const card = document.getElementById(`dz-${focus.id}`);
    if (card) {
      const wanted = focus.act ? card.querySelector<HTMLButtonElement>(`[data-act="${focus.act}"]:not(:disabled)`) : null;
      (wanted ?? card.querySelector<HTMLButtonElement>('.dz-toggle'))?.focus({ preventScroll: true });
      card.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
    setFocus(null);
  }, [focus]);

  useEffect(() => {
    if (!adding) return;
    const away = (e: MouseEvent) => { if (!addRef.current?.contains(e.target as Node)) setAdding(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [adding]);

  const setBlocks = (next: Block[]) => onChange({ ...design, blocks: next });
  const setSettings = (p: Partial<DesignSettings>) => onChange({ ...design, settings: { ...settings, ...p } });
  const toggle = (id: string) => setOpen((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const expand = (id: string) => setOpen((prev) => new Set(prev).add(id));

  const act = (index: number, action: Action) => {
    const b = blocks[index];
    if (!b) return;
    const next = [...blocks];
    if (action === 'up' || action === 'down') {
      const to = action === 'up' ? index - 1 : index + 1;
      if (to < 0 || to >= blocks.length) return;
      next.splice(index, 1);
      next.splice(to, 0, b);
      setBlocks(next);
      setFocus({ id: b.id, act: action });
    } else if (action === 'copy') {
      if (full) return;
      const copy = copyBlock(b);
      next.splice(index + 1, 0, copy);
      setBlocks(next);
      expand(copy.id);
      setFocus({ id: copy.id });
    } else {
      next.splice(index, 1);
      setBlocks(next);
      const neighbour = next[Math.min(index, next.length - 1)];
      if (neighbour) setFocus({ id: neighbour.id });
    }
  };

  const add = (type: BlockType) => {
    setAdding(false);
    if (full) return;
    const b = newBlock(type);
    const next = [...blocks];
    // New content goes above a closing footer rather than under it.
    const at = type !== 'footer' && next[next.length - 1]?.type === 'footer' ? next.length - 1 : next.length;
    next.splice(at, 0, b);
    setBlocks(next);
    expand(b.id);
    setFocus({ id: b.id });
  };

  const pick = (s: Starter) => {
    if (!isStarter(design) && !window.confirm(`Start again from “${s.name}”? Your blocks and colors are replaced.`)) return;
    onChange(instantiate(s.design));
    setOpen(new Set());
  };

  const setColor = (key: 'background' | 'surface' | 'text' | 'accent', value: string) => {
    const p: Partial<DesignSettings> = { [key]: value };
    const ok = hex6(value);
    // Keep the colours that depend on this one readable.
    if (ok && key === 'accent') p.accentText = readableOn(ok);
    if (ok && (key === 'text' || key === 'surface')) {
      const text = key === 'text' ? ok : hex6(settings.text);
      const surface = key === 'surface' ? ok : hex6(settings.surface);
      if (text && surface) p.muted = mix(text, surface, 0.4);
    }
    setSettings(p);
  };

  return (
    <div className="designer">
      <div className="dz-switch">
        <div className="tabs" role="tablist" aria-label="Builder View">
          <button type="button" role="tab" aria-selected={view === 'edit'} onClick={() => setView('edit')}>Edit</button>
          <button type="button" role="tab" aria-selected={view === 'preview'} onClick={() => setView('preview')}>Preview</button>
        </div>
      </div>
      <div className="dz-grid" data-view={view}>
        <div className="dz-edit" aria-label="Design And Blocks" role="region">
          <section className="dz-section">
            <h2>Design</h2>
            <div className="dz-label" id="dz-start">Starting Design</div>
            <div className="dz-starters" role="group" aria-labelledby="dz-start">
              {STARTERS.map((s) => (
                <button key={s.key} type="button" className="dz-starter" aria-label={`Start From ${s.name}`} onClick={() => pick(s)}>
                  <Thumb starter={s} />
                  <b>{s.name}</b>
                  <small>{s.description}</small>
                </button>
              ))}
            </div>
            {letterhead && letterheadReady(letterhead) && (
              <button type="button" className="btn small dz-letterhead" onClick={() => onChange(withLetterhead(design, letterhead))}><Icon name="layers" size={14} />Use Company Header And Footer</button>
            )}
            <div className="dz-fields">
              <SelectField<Layout> label="Where The Email Sits" value={settings.layout ?? 'center'} options={LAYOUTS} onChange={(layout) => setSettings({ layout })} />
            </div>
            <div className="dz-label">Colors</div>
            <div className="dz-colors">
              <ColorField label="Background" value={settings.background} onChange={(v) => setColor('background', v)} />
              <ColorField label="Card" value={settings.surface} onChange={(v) => setColor('surface', v)} />
              <ColorField label="Text" value={settings.text} onChange={(v) => setColor('text', v)} />
              <ColorField label="Accent" value={settings.accent} onChange={(v) => setColor('accent', v)} />
            </div>
            <div className="dz-fields">
              <SelectField label="Font" value={settings.font} options={FONTS} onChange={(font) => setSettings({ font })} />
              <label className="dz-field">
                <span>Corner Radius</span>
                <span className="dz-range">
                  <input type="range" min={0} max={24} step={2} value={settings.radius} onChange={(e) => setSettings({ radius: Number(e.target.value) })} />
                  <output className="num">{settings.radius} px</output>
                </span>
              </label>
            </div>
          </section>

          <section className="dz-section">
            <h2>Blocks <span className="dz-count num">{blocks.length} / {MAX_BLOCKS}</span></h2>
            {blocks.length === 0 && <p className="dz-hint">This email has no blocks yet. Add one below, or pick a starting design.</p>}
            <ol className="dz-blocks">
              {blocks.map((b, i) => (
                <BlockCard
                  key={b.id} block={b} index={i} count={blocks.length} open={open.has(b.id)} full={full}
                  onToggle={() => toggle(b.id)} onAct={(a) => act(i, a)}
                  onChange={(nb) => setBlocks(blocks.map((x) => (x.id === nb.id ? nb : x)))}
                />
              ))}
            </ol>
            <span className="pop dz-add" ref={addRef} onKeyDown={(e) => { if (e.key === 'Escape' && adding) { e.stopPropagation(); setAdding(false); } }}>
              <button type="button" className="btn small" aria-haspopup="menu" aria-expanded={adding} disabled={full} onClick={() => setAdding(!adding)}>
                <Icon name="plus" size={14} weight={2} />Add Block
              </button>
              {adding && (
                <div className="menu" role="menu" aria-label="Add Block">
                  {BLOCK_TYPES.map((t, i) => (
                    <button key={t} type="button" role="menuitem" autoFocus={i === 0} onClick={() => add(t)}>{BLOCK_NAMES[t]}</button>
                  ))}
                </div>
              )}
            </span>
            {full && <p className="dz-hint">A design can have at most {MAX_BLOCKS} blocks.</p>}
          </section>
        </div>

        <div className="dz-preview" role="region" aria-label="Email Preview">
          <div className="dz-preview-bar">
            <span className="eyebrow grow">Preview</span>
            <span className="dz-width num">{DEVICES[device]} px</span>
            <div className="tabs" role="tablist" aria-label="Preview Width">
              <button type="button" role="tab" aria-selected={device === 'desktop'} onClick={() => setDevice('desktop')}>Desktop</button>
              <button type="button" role="tab" aria-selected={device === 'phone'} onClick={() => setDevice('phone')}>Phone</button>
            </div>
          </div>
          <Preview html={html} width={DEVICES[device]} />
        </div>
      </div>
    </div>
  );
}
