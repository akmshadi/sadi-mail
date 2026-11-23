import { useCallback, useEffect, useRef, useState } from 'react';
import type { MailboxInfo, Role, UserInfo } from '../shared/types';
import { RequestError, api } from './api';
import { tone } from './format';
import { Icon } from './icons';
import type { MailStore } from './store';
import './people.css';

type Grant = UserInfo['grants'][number];
type Perm = 'read' | 'send' | 'edit' | 'delete';
type GrantMap = Record<string, Grant>;

const PERMS: { key: Perm; label: string }[] = [
  { key: 'read', label: 'Read' },
  { key: 'send', label: 'Send' },
  { key: 'edit', label: 'Edit' },
  { key: 'delete', label: 'Delete' },
];
const ROLES: { key: Role; label: string; means: string }[] = [
  { key: 'owner', label: 'Owner', means: 'Everything, including managing other owners.' },
  { key: 'admin', label: 'Admin', means: 'Everything except changing owners.' },
  { key: 'member', label: 'Member', means: 'Only what is granted, mailbox by mailbox.' },
  { key: 'viewer', label: 'Viewer', means: 'Read only, in the mailboxes they are granted.' },
];
const RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1, viewer: 0 };
const roleLabel = (r: Role) => ROLES.find((x) => x.key === r)?.label ?? r;

const failure = (err: unknown): string => {
  if (err instanceof RequestError) {
    if (err.code === 'last_owner') return 'There must always be one active owner. Make someone else an owner first.';
    if (err.status === 403) return 'Only an owner can change an owner.';
    return err.message;
  }
  return 'That did not work. Try again.';
};

/** Send, Edit and Delete need Read, and a viewer can only read. */
function normalise(g: Grant, role: Role): Grant {
  const read = g.read || g.send || g.edit || g.delete;
  const rest = read && role !== 'viewer';
  return { mailboxId: g.mailboxId, read, send: rest && g.send, edit: rest && g.edit, delete: rest && g.delete };
}

function toMap(grants: Grant[], role: Role): GrantMap {
  const out: GrantMap = {};
  for (const g of grants) out[g.mailboxId] = normalise(g, role);
  return out;
}

function toList(map: GrantMap, role: Role): Grant[] {
  return Object.values(map).map((g) => normalise(g, role)).filter((g) => g.read);
}

const signature = (list: Grant[]): string =>
  list.filter((g) => g.read).sort((a, b) => a.mailboxId.localeCompare(b.mailboxId)).map((g) => `${g.mailboxId}:${+g.read}${+g.send}${+g.edit}${+g.delete}`).join('|');

const joined = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

function Switch({ on, label, disabled, title, onChange }: { on: boolean; label: string; disabled?: boolean; title?: string; onChange: (next: boolean) => void }) {
  return <button type="button" role="switch" className="switch" aria-checked={on} aria-label={label} title={title} disabled={disabled} onClick={() => onChange(!on)} />;
}

function PersonAvatar({ user }: { user: UserInfo }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className={`avatar t${tone(user.id)}`} aria-hidden="true">
      {broken ? user.name.slice(0, 2).toUpperCase() || '?' : <img src={`/api/users/${user.id}/avatar`} alt="" onError={() => setBroken(true)} />}
    </span>
  );
}

function AccessTable({ user, mailboxes, draft, setDraft, locked }: { user: UserInfo; mailboxes: MailboxInfo[]; draft: GrantMap; setDraft: (next: GrantMap) => void; locked: boolean }) {
  const viewer = user.role === 'viewer';
  const toggle = (mb: MailboxInfo, perm: Perm, on: boolean) => {
    const cur = draft[mb.id] ?? { mailboxId: mb.id, read: false, send: false, edit: false, delete: false };
    const next: Grant = { ...cur, [perm]: on };
    if (perm === 'read' && !on) Object.assign(next, { send: false, edit: false, delete: false });
    if (perm !== 'read' && on) next.read = true;
    setDraft({ ...draft, [mb.id]: next });
  };
  return (
    <table className="table">
      <thead>
        <tr>
          <th scope="col">Mailbox</th>
          {PERMS.map((p) => <th key={p.key} scope="col" className="pp-perm">{p.label}</th>)}
        </tr>
      </thead>
      <tbody>
        {mailboxes.map((mb) => {
          const g = draft[mb.id] ?? { mailboxId: mb.id, read: false, send: false, edit: false, delete: false };
          return (
            <tr key={mb.id}>
              <td className="pp-name-cell"><span className="pp-mb"><span className="pp-dot" style={{ background: mb.color }} aria-hidden="true" />{mb.name}</span></td>
              {PERMS.map((p) => {
                const off = locked || (viewer && p.key !== 'read');
                return (
                  <td key={p.key} className="pp-perm">
                    <label className="pp-check" title={viewer && p.key !== 'read' ? 'Viewers can only read.' : undefined}>
                      <input type="checkbox" checked={viewer && p.key !== 'read' ? false : g[p.key]} disabled={off} aria-label={`${p.label} in ${mb.name} for ${user.name}`} onChange={(e) => toggle(mb, p.key, e.target.checked)} />
                      <span className="pp-lbl" aria-hidden="true">{p.label}</span>
                    </label>
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function PersonRow({ user, me, relay, reload }: { user: UserInfo; me: { id: string; role: Role }; relay: MailStore; reload: () => Promise<void> }) {
  const [name, setName] = useState(user.name);
  const [draft, setDraft] = useState<GrantMap>(() => toMap(user.grants, user.role));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'' | 'name' | 'role' | 'status' | 'access'>('');
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const isMe = user.id === me.id;
  const iAmOwner = me.role === 'owner';
  const ownerLocked = user.role === 'owner' && !iAmOwner;
  const privileged = user.role === 'owner' || user.role === 'admin';
  const nameDirty = name.trim() !== user.name && name.trim().length > 0;
  const accessDirty = signature(toList(draft, user.role)) !== signature(user.grants.map((g) => normalise(g, user.role)));
  const mailboxes = relay.mailboxes;

  // One request at a time per person: every control is disabled while one is in flight.
  const run = async (kind: typeof busy, body: Record<string, unknown>, done: string): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(kind);
    try {
      await api.patch(`/users/${user.id}`, body);
      relay.notify({ text: done });
      await reload();
      return true;
    } catch (err) {
      relay.notify({ text: failure(err) });
      return false;
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy('');
    }
  };

  const changeRole = (next: Role) => {
    if (next === user.role) return;
    if (RANK[next] < RANK[user.role] && user.role !== 'member' && !window.confirm(`Lower ${user.name} from ${roleLabel(user.role)} to ${roleLabel(next)}? They lose access to mailboxes that are not granted to them.`)) return;
    void run('role', { role: next }, `${user.name} Is Now ${roleLabel(next)}`);
  };
  const changeStatus = (active: boolean) => {
    if (!active && !window.confirm(`Disable ${user.name}? They are signed out of Sadi Mail and cannot sign in until you turn them back on.`)) return;
    void run('status', { status: active ? 'active' : 'disabled' }, active ? `${user.name} Is Active Again` : `${user.name} Disabled`);
  };
  const saveName = async () => {
    const ok = await run('name', { name: name.trim() }, 'Name Saved');
    if (ok && mounted.current) setName(name.trim());
  };
  const saveAccess = async () => {
    await run('access', { grants: toList(draft, user.role) }, `Access Saved For ${user.name}`);
  };

  const active = user.status === 'active';
  const frozen = busy !== '';
  const selfTitle = (what: string) => (isMe ? `You cannot ${what} yourself.` : ownerLocked ? 'Only an owner can change an owner.' : undefined);

  return (
    <div className="pp-person" role="listitem">
      <div className="pp-main">
        <PersonAvatar user={user} />
        <div className="pp-cell pp-head">
          <label htmlFor={`pp-name-${user.id}`}>Name</label>
          <div className="pp-name">
            <input id={`pp-name-${user.id}`} className="field" value={name} maxLength={120} disabled={frozen || ownerLocked} title={ownerLocked ? 'Only an owner can change an owner.' : undefined} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && nameDirty) void saveName(); }} />
            {nameDirty && <button type="button" className="btn small primary" disabled={frozen} onClick={() => void saveName()}>{busy === 'name' ? 'Saving…' : 'Save'}</button>}
          </div>
        </div>
        <div className="pp-cell">
          <label htmlFor={`pp-role-${user.id}`}>Role</label>
          <select id={`pp-role-${user.id}`} className="field" value={user.role} disabled={frozen || isMe || ownerLocked} title={selfTitle('change the role of')} onChange={(e) => changeRole(e.target.value as Role)}>
            {ROLES.map((r) => <option key={r.key} value={r.key} disabled={r.key === 'owner' && !iAmOwner}>{r.label}</option>)}
          </select>
        </div>
        <div className="pp-cell">
          <span>Status</span>
          <span className="pp-status">
            <Switch on={active} label={`${user.name} Is Active`} disabled={frozen || isMe || ownerLocked} title={selfTitle('disable')} onChange={changeStatus} />
            {active ? 'Active' : 'Disabled'}
          </span>
        </div>
        <div className="pp-cell pp-joined-cell">
          <span>Joined</span>
          <span className="pp-joined">{joined(user.createdAt)}</span>
        </div>
        <div className="pp-toggle-cell">
          {!privileged && (
            <button type="button" className="btn small pp-toggle" aria-expanded={open} aria-controls={`pp-access-${user.id}`} onClick={() => setOpen(!open)}>
              Mailbox Access{accessDirty ? ' (Unsaved)' : ''}<Icon name="down" size={14} weight={2} />
            </button>
          )}
        </div>
      </div>
      {(isMe || !active) && (
        <div className="pp-sees pp-tags" style={{ marginTop: -4 }}>
          {isMe && <span className="pill">You</span>}
          {!active && <span className="pill neutral">Disabled</span>}
        </div>
      )}
      {privileged && <p className="fine pp-sees"><Icon name="shield" size={14} weight={1.8} />{roleLabel(user.role)}s see every mailbox without a grant, so there is nothing to set here.</p>}
      {!privileged && open && (
        <div className="pp-access" id={`pp-access-${user.id}`}>
          {mailboxes.length === 0 ? (
            <div className="state"><p>There are no mailboxes yet. Create one first, then grant it here.</p></div>
          ) : (
            <AccessTable user={user} mailboxes={mailboxes} draft={draft} setDraft={setDraft} locked={frozen} />
          )}
          <div className="pp-foot">
            <p className="fine">
              <Icon name="shield" size={14} weight={1.8} />
              {user.role === 'viewer' ? 'Viewers can only read. Send, Edit and Delete stay off.' : 'Send, Edit and Delete need Read, so ticking one ticks Read.'}
            </p>
            <button type="button" className="btn primary" disabled={frozen || !accessDirty || mailboxes.length === 0} onClick={() => void saveAccess()}>{busy === 'access' ? 'Saving…' : 'Save Access'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function People({ relay }: { relay: MailStore }) {
  const [users, setUsers] = useState<UserInfo[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const me = relay.boot?.user;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setUsers((await api.get<{ data: UserInfo[] }>('/users')).data);
      setError('');
    } catch (err) {
      setError(failure(err));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (!me) return <div className="skeleton" style={{ height: 220, borderRadius: 12 }} />;
  if (error && !users) {
    return <div className="notice warn" role="alert"><span className="grow">{error}</span><button type="button" className="link-btn" onClick={() => void load()}>Try Again</button></div>;
  }
  if (!users) return <div className="skeleton" style={{ height: 260, borderRadius: 12 }} aria-busy="true" aria-label="Loading people" />;

  const onlyMe = users.length === 1 && users[0]!.id === me.id;

  return (
    <>
      <p className="lede" style={{ marginTop: -8 }}>
        People appear here the first time they sign in, through Cloudflare Access or a host application’s token. You cannot add someone by hand. A new person can see nothing until you give them a mailbox below.
      </p>

      <section className="card">
        <div className="card-head"><h2 className="grow">Roles</h2></div>
        <dl className="pp-legend">
          {ROLES.map((r) => <div key={r.key}><dt>{r.label}</dt><dd>{r.means}</dd></div>)}
        </dl>
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="grow">People</h2>
          <button type="button" className="btn small" disabled={loading} onClick={() => void load()}><Icon name="refresh" size={14} weight={1.8} />{loading ? 'Refreshing…' : 'Refresh'}</button>
        </div>
        {error && <div className="notice warn" role="alert" style={{ margin: 12 }}><span className="grow">{error}</span><button type="button" className="link-btn" onClick={() => void load()}>Try Again</button></div>}
        <div role="list">
          {users.map((u) => <PersonRow key={u.id} user={u} me={me} relay={relay} reload={load} />)}
        </div>
        {onlyMe && (
          <div className="state pp-empty">
            <strong>You Are The Only Person So Far</strong>
            <p>Nobody else has signed in yet. Send them the Sadi Mail address; they show up here after their first sign-in.</p>
          </div>
        )}
      </section>
    </>
  );
}
