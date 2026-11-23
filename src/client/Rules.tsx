import { useCallback, useEffect, useState } from 'react';
import type { LabelInfo, RuleInfo } from '../shared/types';
import { RequestError, api } from './api';
import { Icon } from './icons';
import './rules.css';
import type { MailStore } from './store';

const failure = (err: unknown) => (err instanceof RequestError ? err.message : 'That did not work. Try again.');

type Move = '' | 'archive' | 'spam' | 'trash';
const MOVE_LABEL: Record<Exclude<Move, ''>, string> = { archive: 'Archive', spam: 'Spam', trash: 'Trash' };

interface Draft {
  id?: string;
  name: string;
  mailboxId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  hasAttachment: boolean;
  labelId: string;
  star: boolean;
  markRead: boolean;
  moveTo: Move;
}

const blank: Draft = { name: '', mailboxId: '', from: '', to: '', subject: '', body: '', hasAttachment: false, labelId: '', star: false, markRead: false, moveTo: '' };

const draftOf = (r: RuleInfo): Draft => ({
  id: r.id, name: r.name, mailboxId: r.mailboxId ?? '', from: r.match.from ?? '', to: r.match.to ?? '', subject: r.match.subject ?? '', body: r.match.body ?? '',
  hasAttachment: !!r.match.hasAttachment, labelId: r.action.labelId ?? '', star: !!r.action.star, markRead: !!r.action.markRead, moveTo: r.action.moveTo ?? '',
});

const hasCondition = (d: Draft) => !!(d.from.trim() || d.to.trim() || d.subject.trim() || d.body.trim() || d.hasAttachment);
const hasAction = (d: Draft) => !!(d.labelId || d.star || d.markRead || d.moveTo);

/** “From contains ‘invoice@’ → Label Invoices, Mark Read” */
function sentence(r: RuleInfo, labels: LabelInfo[]): string {
  const when: string[] = [];
  if (r.match.from) when.push(`From contains ‘${r.match.from}’`);
  if (r.match.to) when.push(`To contains ‘${r.match.to}’`);
  if (r.match.subject) when.push(`Subject contains ‘${r.match.subject}’`);
  if (r.match.body) when.push(`Body contains ‘${r.match.body}’`);
  if (r.match.hasAttachment) when.push('Has an attachment');
  const then: string[] = [];
  if (r.action.labelId) then.push(`Label ${labels.find((l) => l.id === r.action.labelId)?.name ?? 'Deleted Label'}`);
  if (r.action.star) then.push('Star');
  if (r.action.markRead) then.push('Mark Read');
  if (r.action.moveTo) then.push(`Move To ${MOVE_LABEL[r.action.moveTo]}`);
  return `${when.join(' and ') || 'No conditions'} → ${then.join(', ') || 'No actions'}`;
}

function Switch({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: (next: boolean) => void }) {
  return <button type="button" role="switch" className="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} />;
}

function RuleRow({ rule, labels, mailboxName, reload, edit, relay }: { rule: RuleInfo; labels: LabelInfo[]; mailboxName: string; reload: () => void; edit: () => void; relay: MailStore }) {
  const [busy, setBusy] = useState(false);
  const act = async (work: () => Promise<string>) => {
    setBusy(true);
    try {
      relay.notify({ text: await work() });
      reload();
    } catch (err) {
      relay.notify({ text: failure(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`rules-row${rule.enabled ? '' : ' is-off'}`}>
      <span className="grow">
        <b>{rule.name}</b>
        <span className="rules-sentence">{sentence(rule, labels)}</span>
        <small>{mailboxName}{rule.enabled ? '' : ' · Off'}</small>
      </span>
      <span className="rules-tools">
        <button type="button" className="btn small" disabled={busy} onClick={() => void act(async () => {
          const r = await api.post<{ matched: number }>(`/rules/${rule.id}/run`, {});
          void relay.loadBoot();
          void relay.loadList(true);
          return r.matched === 1 ? 'Rule Applied To 1 Conversation' : `Rule Applied To ${r.matched} Conversations`;
        })}><Icon name="bolt" size={14} weight={1.8} />{busy ? 'Running…' : 'Run On Existing Mail'}</button>
        <button type="button" className="icon-btn" aria-label={`Edit ${rule.name}`} title="Edit" disabled={busy} onClick={edit}><Icon name="pen" size={15} /></button>
        <button type="button" className="icon-btn" aria-label={`Delete ${rule.name}`} title="Delete" disabled={busy} onClick={() => window.confirm(`Delete the rule “${rule.name}”? Mail it already handled stays as it is.`) && void act(async () => { await api.delete(`/rules/${rule.id}`); return `${rule.name} Deleted`; })}><Icon name="trash" size={15} /></button>
        <Switch on={rule.enabled} label={`Switch ${rule.name} On Or Off`} disabled={busy} onChange={(next) => void act(async () => { await api.patch(`/rules/${rule.id}`, { enabled: next }); return next ? `${rule.name} Switched On` : `${rule.name} Switched Off`; })} />
      </span>
    </div>
  );
}

function RuleForm({ initial, labels, reloadLabels, close, saved, relay }: { initial: Draft; labels: LabelInfo[]; reloadLabels: () => Promise<void>; close: () => void; saved: () => void; relay: MailStore }) {
  const [d, setD] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [makingLabel, setMakingLabel] = useState(false);
  const [labelName, setLabelName] = useState('');
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setD((prev) => ({ ...prev, [key]: value }));
  const ready = !!d.name.trim() && hasCondition(d) && hasAction(d);

  const addLabel = async () => {
    setError('');
    try {
      const made = await api.post<LabelInfo>('/labels', { name: labelName.trim(), color: '#64748B' });
      await reloadLabels();
      relay.loadLabels();
      set('labelId', made.id);
      setLabelName('');
      setMakingLabel(false);
    } catch (err) {
      setError(failure(err));
    }
  };

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      await api.post<RuleInfo>('/rules', {
        id: d.id,
        name: d.name.trim(),
        mailboxId: d.mailboxId || null,
        match: { from: d.from, to: d.to, subject: d.subject, body: d.body, hasAttachment: d.hasAttachment || undefined },
        action: { labelId: d.labelId || undefined, star: d.star || undefined, markRead: d.markRead || undefined, moveTo: d.moveTo || undefined },
      });
      relay.notify({ text: d.id ? `${d.name.trim()} Saved` : `${d.name.trim()} Created` });
      saved();
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form-grid rules-form">
      <label>
        Name
        <input className="field" value={d.name} maxLength={60} onChange={(e) => set('name', e.target.value)} placeholder="Invoices" />
      </label>
      <label>
        Mailbox
        <select className="field" value={d.mailboxId} onChange={(e) => set('mailboxId', e.target.value)}>
          <option value="">Every Mailbox</option>
          {relay.mailboxes.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </label>

      <p className="rules-group">When A Message Arrives And</p>
      <label>
        From Contains
        <input className="field" value={d.from} maxLength={200} onChange={(e) => set('from', e.target.value)} placeholder="invoice@" />
      </label>
      <label>
        To Contains
        <input className="field" value={d.to} maxLength={200} onChange={(e) => set('to', e.target.value)} placeholder="sales@" />
      </label>
      <label>
        Subject Contains
        <input className="field" value={d.subject} maxLength={200} onChange={(e) => set('subject', e.target.value)} placeholder="Receipt" />
      </label>
      <label>
        Body Contains
        <input className="field" value={d.body} maxLength={200} onChange={(e) => set('body', e.target.value)} placeholder="Order number" />
      </label>
      <label className="rules-check wide">
        <input type="checkbox" checked={d.hasAttachment} onChange={(e) => set('hasAttachment', e.target.checked)} />
        Has Attachment
      </label>

      <p className="rules-group">Then</p>
      <label className="wide">
        Apply Label
        <select className="field" value={d.labelId} onChange={(e) => set('labelId', e.target.value)}>
          <option value="">No Label</option>
          {labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </label>
      <div className="wide">
        {makingLabel ? (
          <div className="rules-newlabel">
            <input className="field" aria-label="New Label Name" value={labelName} maxLength={40} onChange={(e) => setLabelName(e.target.value)} placeholder="Label name" />
            <button type="button" className="btn small" disabled={!labelName.trim()} onClick={() => void addLabel()}>Add Label</button>
            <button type="button" className="btn small ghost" onClick={() => { setMakingLabel(false); setLabelName(''); }}>Cancel</button>
          </div>
        ) : (
          <button type="button" className="link-btn" onClick={() => setMakingLabel(true)}>Create A New Label</button>
        )}
      </div>
      <label className="rules-check">
        <input type="checkbox" checked={d.star} onChange={(e) => set('star', e.target.checked)} />
        Star
      </label>
      <label className="rules-check">
        <input type="checkbox" checked={d.markRead} onChange={(e) => set('markRead', e.target.checked)} />
        Mark As Read
      </label>
      <label>
        Move To
        <select className="field" value={d.moveTo} onChange={(e) => set('moveTo', e.target.value as Move)}>
          <option value="">None</option>
          <option value="archive">Archive</option>
          <option value="spam">Spam</option>
          <option value="trash">Trash</option>
        </select>
      </label>

      {error && <div className="notice warn wide" role="alert">{error}</div>}
      <div className="wide rules-actions">
        <button type="button" className="btn primary" disabled={busy || !ready} onClick={() => void submit()}>{busy ? 'Saving…' : d.id ? 'Save Rule' : 'Create Rule'}</button>
        <button type="button" className="btn ghost" onClick={close}>Cancel</button>
      </div>
    </div>
  );
}

/** Settings tab: rules that act on new mail. */
export function Rules({ relay }: { relay: MailStore }) {
  const [rules, setRules] = useState<RuleInfo[] | null>(null);
  const [labels, setLabels] = useState<LabelInfo[]>([]);
  const [error, setError] = useState('');
  const [form, setForm] = useState<Draft | null>(null);

  const loadLabels = useCallback(async () => {
    const res = await api.get<{ data: LabelInfo[] }>('/labels');
    setLabels(res.data);
  }, []);
  const load = useCallback(() => {
    Promise.all([api.get<{ data: RuleInfo[] }>('/rules'), loadLabels()])
      .then(([r]) => { setRules(r.data); setError(''); })
      .catch((err) => setError(failure(err)));
  }, [loadLabels]);
  useEffect(load, [load]);

  if (error && !rules) return <div className="notice warn" role="alert"><span className="grow">{error}</span><button type="button" className="link-btn" onClick={load}>Try Again</button></div>;
  if (!rules) return <div className="skeleton" style={{ height: 220, borderRadius: 12 }} />;

  const mailboxName = (id: string | null) => (id ? relay.mailboxes.find((m) => m.id === id)?.name ?? 'Unknown Mailbox' : 'Every Mailbox');

  return (
    <>
      <p className="lede" style={{ marginTop: -8 }}>
        Rules run on new mail as it arrives, before any AI agent sees it. Every rule that matches is applied, in the order shown. A rule never moves a conversation out of the trash.
      </p>

      <section className="card rules-card">
        <div className="card-head">
          <h2 className="grow">Rules</h2>
          <button type="button" className="btn small" onClick={() => setForm(form ? null : { ...blank })}><Icon name={form ? 'close' : 'plus'} size={14} weight={2} />{form ? 'Close' : 'New Rule'}</button>
        </div>
        {rules.length === 0 && !form && (
          <div className="state"><strong>No Rules Yet</strong><p>Label, star, mark read or move mail automatically. Try a rule for invoices or newsletters.</p></div>
        )}
        {rules.length > 0 && (
          <div className="rows-list">
            {rules.map((r) => <RuleRow key={r.id} rule={r} labels={labels} mailboxName={mailboxName(r.mailboxId)} reload={load} edit={() => setForm(draftOf(r))} relay={relay} />)}
          </div>
        )}
        {form && <RuleForm key={form.id ?? 'new'} initial={form} labels={labels} reloadLabels={loadLabels} close={() => setForm(null)} saved={() => { setForm(null); load(); }} relay={relay} />}
      </section>
    </>
  );
}
