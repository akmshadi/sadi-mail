import { useCallback, useEffect, useState } from 'react';
import type { TemplateInfo } from '../shared/types';
import { RequestError, api } from './api';
import { Icon } from './icons';
import type { MailStore } from './store';
import './designer.css';

const failure = (err: unknown) => (err instanceof RequestError ? err.message : 'That did not work. Try again.');

/** Settings tab: reusable messages. Insert one from the Templates menu on the compose page. */
export function Templates({ relay }: { relay: MailStore }) {
  const [list, setList] = useState<TemplateInfo[] | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<TemplateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const canEdit = relay.boot?.user.role !== 'viewer';
  const load = useCallback(() => {
    api.get<{ data: TemplateInfo[] }>('/templates').then((r) => { setList(r.data); setError(''); }).catch((err) => setError(failure(err)));
  }, []);
  useEffect(load, [load]);

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await api.post('/templates', { id: editing.id || undefined, name: editing.name, subject: editing.subject, body: editing.body });
      relay.notify({ text: `Template “${editing.name.trim()}” Saved` });
      setEditing(null);
      load();
    } catch (err) {
      relay.notify({ text: failure(err) });
    } finally {
      setBusy(false);
    }
  };
  /** A designed template is edited in the builder on the compose page; here it can only be renamed. */
  const rename = async (t: TemplateInfo) => {
    const name = window.prompt('New name for this template', t.name)?.trim();
    if (!name || name === t.name) return;
    try {
      await api.post('/templates', { id: t.id, name, subject: t.subject, body: t.body, design: t.design });
      relay.notify({ text: `Template Renamed To “${name.slice(0, 60)}”` });
      load();
    } catch (err) {
      relay.notify({ text: failure(err) });
    }
  };
  const remove = (t: TemplateInfo) => {
    if (!window.confirm(`Delete the template “${t.name}”?`)) return;
    api.delete(`/templates/${t.id}`).then(load).catch((err) => relay.notify({ text: failure(err) }));
  };

  if (error && !list) return <div className="notice warn" role="alert"><span className="grow">{error}</span><button type="button" className="link-btn" onClick={load}>Try Again</button></div>;
  if (!list) return <div className="skeleton" style={{ height: 160, borderRadius: 12 }} />;

  return (
    <>
      <p className="lede" style={{ marginTop: -8 }}>Messages you send often. Pick one from the Templates menu while composing and it is placed in the message for you to finish. Designed templates are made on the compose page in Designed mode.</p>
      <section className="card">
        <div className="card-head">
          <h2 className="grow">Templates</h2>
          {canEdit && <button type="button" className="btn small" onClick={() => setEditing(editing ? null : { id: '', name: '', subject: '', body: '' })}><Icon name={editing ? 'close' : 'plus'} size={14} weight={2} />{editing ? 'Close' : 'New Template'}</button>}
        </div>
        {list.length === 0 && !editing && (
          <div className="state"><strong>No Templates Yet</strong><p>Save a reply you write often, such as a quote, a thank-you or delivery details.</p></div>
        )}
        <div className="rows-list">
          {list.map((t) => (
            <div key={t.id}>
              <span className="grow" style={{ minWidth: 0 }}>
                <span className="tpl-name"><b className="truncate">{t.name}</b>{t.design && <span className="pill neutral">Designed</span>}</span>
                <small className="truncate">{t.subject ? `${t.subject} · ` : ''}{t.body.replace(/\s+/g, ' ').slice(0, 140)}</small>
              </span>
              {canEdit && (t.design
                ? <button type="button" className="btn small" onClick={() => void rename(t)}>Rename</button>
                : <button type="button" className="btn small" onClick={() => setEditing(t)}>Edit</button>)}
              {canEdit && <button type="button" className="icon-btn" aria-label={`Delete ${t.name}`} title="Delete" onClick={() => remove(t)}><Icon name="trash" size={15} /></button>}
            </div>
          ))}
        </div>
        {editing && (
          <div className="form-grid">
            <label>Name<input className="field" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Quote Reply" /></label>
            <label>Subject (Optional)<input className="field" value={editing.subject} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} placeholder="Used only when the subject is empty" /></label>
            <label className="wide">Message<textarea className="field" rows={7} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} /></label>
            <div className="wide"><button type="button" className="btn primary" disabled={busy || !editing.name.trim() || !editing.body.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save Template'}</button></div>
          </div>
        )}
      </section>
    </>
  );
}
