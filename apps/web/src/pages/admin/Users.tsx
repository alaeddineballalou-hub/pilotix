// Utilisateurs: the Rôles table and one list per role, with the create / edit form (users.create / users.update).
import { expandRoles, LANGUAGES, Profile, Role, ROLES } from '@pilotix/shared';
import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { canSee, NAV } from '../../layout/nav';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { when } from '../../lib/format';
import { Card, Empty, ErrorBox, Field, Loading, StageBar } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { ConfirmButton } from './bits';

export const USER_SUBS = ['roles', 'admins', 'vendeurs', 'agents', 'marketeurs', 'managers'] as const;
const SUB_ROLE: Record<string, Role> = { admins: 'admin', vendeurs: 'vendeur', agents: 'confirmation', marketeurs: 'marketer', managers: 'agent_manager' };
const ROLE_SUB: Partial<Record<Role, string>> = { admin: 'admins', vendeur: 'vendeurs', confirmation: 'agents', marketer: 'marketeurs', agent_manager: 'managers' };
/** Rôles table order, as in the original. */
const ROLE_ORDER: Role[] = ['admin', 'vendeur', 'agent_manager', 'confirmation', 'suivi', 'depot', 'livreur', 'marketer'];
/** Every page in menu order, with the hidden Livrées / Retournées pages of the original. */
const PAGE_ORDER = ['accueil', 'dashboard', 'commandes', 'confirmation', 'depot', 'scanner', 'suivi', 'livrees', 'retournees', 'sav', 'tournee', 'produits', 'clients', 'publicite', 'caisse', 'livraison', 'utilisateurs', 'management', 'reglages'];

/** Pages a role opens (its own roles + what they include), computed from the menu rules. */
export function pagesOf(role: Role): string[] {
  const roles = expandRoles([role]);
  const isAdmin = role === 'admin';
  return PAGE_ORDER.filter((id) => {
    if (id === 'livrees' || id === 'retournees') return isAdmin || roles.some((r) => ['confirmation', 'suivi', 'depot'].includes(r));
    const item = NAV.find((n) => n.id === id);
    if (!item) return false;
    if (id === 'tournee') return isAdmin || roles.includes('livreur');
    return canSee(item, roles, isAdmin);
  });
}

const subOf = (sub: string | undefined, rest: string[] | undefined): { sub: string; role: Role | null } => {
  if (sub === 'role' && rest?.[0] && (ROLES as readonly string[]).includes(rest[0])) return { sub: 'role', role: rest[0] as Role };
  if (sub && SUB_ROLE[sub]) return { sub, role: SUB_ROLE[sub] };
  return { sub: 'roles', role: null };
};

export function UsersPage({ sub, rest }: { sub?: string; rest?: string[] }) {
  const { t } = useTranslation();
  const cur = subOf(sub, rest);
  const [form, setForm] = useState<{ user: Profile | null; role: Role | null } | null>(null);
  return (
    <>
      <StageBar flow={false} current={cur.sub} items={USER_SUBS.map((k) => ({ key: k, label: t(`admin.subs.${k}`), href: `#/utilisateurs/${k}` }))} />
      {cur.role ? <RoleList role={cur.role} onNew={() => setForm({ user: null, role: cur.role })} onEdit={(u) => setForm({ user: u, role: cur.role })} /> : <RolesTable onNew={() => setForm({ user: null, role: null })} />}
      {form && <UserForm user={form.user} role={form.role} onClose={() => setForm(null)} />}
    </>
  );
}

function RolesTable({ onNew }: { onNew: () => void }) {
  const { t } = useTranslation();
  const q = useRpc('admin.roles', {});
  return (
    <>
      <Card
        title={t('admin.users.rolesTitle')}
        help={t('admin.users.rolesHelp')}
        actions={
          <button className="btn primary" onClick={onNew}>
            {t('admin.users.newUser')}
          </button>
        }
      />
      <div className="card">
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorBox error={q.error} onRetry={() => q.refetch()} />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('admin.users.colRole')}</th>
                  <th className="wide">{t('admin.users.colWhat')}</th>
                  <th className="wide">{t('admin.users.colPages')}</th>
                  <th>{t('admin.users.colUsers')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ROLE_ORDER.map((r) => {
                  const c = q.data?.[r] ?? { active: 0, total: 0, names: [] };
                  const names = c.names.slice(0, 4).join(', ') + (c.names.length > 4 ? '…' : '');
                  const pages = pagesOf(r).map((p) => t(`nav.${p}`));
                  return (
                    <tr key={r}>
                      <td data-l={t('admin.users.colRole')}>
                        <b>{t(`roles.${r}`)}</b>
                        <small>{r}</small>
                      </td>
                      <td className="wide px-cw" data-l={t('admin.users.colWhat')} title={t(`admin.users.desc.${r}`)}>
                        <div className="px-clamp">{t(`admin.users.desc.${r}`)}</div>
                      </td>
                      <td className="wide px-cw" data-l={t('admin.users.colPages')} title={pages.join(' · ')}>
                        <div className="px-clamp">
                          <div>
                            {pages.map((p) => (
                              <span key={p} className="chip">
                                {p}
                              </span>
                            ))}
                          </div>
                        </div>
                      </td>
                      <td data-l={t('admin.users.colUsers')}>
                        <b>{t('admin.users.active', { count: c.active })}</b>
                        <small>{names}</small>
                      </td>
                      <td data-l="">
                        <a className="btn small" href={ROLE_SUB[r] ? `#/utilisateurs/${ROLE_SUB[r]}` : `#/utilisateurs/role/${r}`}>
                          {t('admin.users.see')}
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function RoleList({ role, onNew, onEdit }: { role: Role; onNew: () => void; onEdit: (u: Profile) => void }) {
  const { t } = useTranslation();
  const q = useRpc('users.list', { role });
  // users.list matches own roles; vendeurs also count as agents etc. only through their own roles (as in the original)
  return (
    <>
      <Card
        title={t(`admin.users.listTitle.${role}`)}
        help={t('admin.users.listHelp')}
        actions={
          <button className="btn primary" onClick={onNew}>
            {t(`admin.users.newBtn.${role}`)}
          </button>
        }
      />
      <div className="card">
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorBox error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data?.length ? (
          <Empty>{t('admin.users.empty')}</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('admin.users.colName')}</th>
                  <th>{t('admin.users.colPhone')}</th>
                  <th>{t('admin.users.colRoles')}</th>
                  <th>{t('admin.users.colLast')}</th>
                  <th>{t('admin.users.colState')}</th>
                </tr>
              </thead>
              <tbody>
                {q.data.map((u) => (
                  <tr key={u.id} className={`clickable ${u.active ? '' : 'dim'}`} onClick={() => onEdit(u)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onEdit(u)}>
                    <td data-l={t('admin.users.colName')}>
                      <b>{u.name}</b>
                      <small className="ltr">{u.email}</small>
                    </td>
                    <td data-l={t('admin.users.colPhone')}>
                      <span className="ltr">{u.phone || '—'}</span>
                    </td>
                    <td data-l={t('admin.users.colRoles')}>
                      {u.roles.map((r) => (
                        <span key={r} className="chip">
                          {t(`roles.${r}`)}
                        </span>
                      ))}
                    </td>
                    <td data-l={t('admin.users.colLast')}>{u.lastSeenAt ? when(u.lastSeenAt) : t('admin.users.never')}</td>
                    <td data-l={t('admin.users.colState')}>
                      <span className={`badge t-${u.active ? 'ok' : 'off'}`}>{u.active ? t('admin.users.activeBadge') : t('admin.users.inactiveBadge')}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function UserForm({ user, role, onClose }: { user: Profile | null; role: Role | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { me } = useSession();
  const [name, setName] = useState(user?.name ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [password, setPassword] = useState('');
  const [roles, setRoles] = useState<Role[]>(user?.roles ?? (role ? [role] : ['confirmation']));
  const [language, setLanguage] = useState(user?.language ?? 'fr');
  const [company, setCompany] = useState<number | null>(user?.livreurCompanyId ?? null);
  const [err, setErr] = useState('');
  const [newPw, setNewPw] = useState<string | null>(null);
  const companies = useRpc('admin.companies', {});
  const create = useAction('users.create', { success: t('admin.users.created'), onDone: onClose });
  const update = useAction('users.update', { success: t('admin.users.saved'), onDone: onClose });
  const toggle = useAction('users.update', { success: (r) => (r.active ? t('admin.users.activated') : t('admin.users.deactivated')), onDone: onClose });
  const reset = useAction('admin.users.resetPassword', { onDone: (r) => setNewPw(r.password) });
  const busy = create.isPending || update.isPending;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!roles.length) return setErr(t('admin.users.needRole'));
    setErr('');
    const base = { name: name.trim(), email: email.trim(), phone: phone.trim() || null, roles, language, livreurCompanyId: roles.includes('livreur') ? company : null };
    if (user) update.mutate({ id: user.id, ...base, ...(password ? { password } : {}) });
    else create.mutate({ ...base, password });
  };
  const flip = (r: Role) => setRoles((cur) => (cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]));

  return (
    <Modal
      title={user ? t('admin.users.formEdit', { name: user.name }) : t('admin.users.formNew')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('admin.cancel')}
          </button>
          <button type="submit" form="px-user-form" className="btn primary" disabled={busy}>
            {user ? t('admin.users.save') : t('admin.users.create')}
          </button>
        </>
      }
    >
      <form id="px-user-form" onSubmit={submit}>
        <div className="grid2">
          <Field label={t('admin.users.name')}>
            <input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={120} autoComplete="off" />
          </Field>
          <Field label={t('admin.users.phone')}>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" maxLength={20} className="ltr" placeholder="0550 00 00 00" />
          </Field>
          <Field label={t('admin.users.email')}>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="ltr" autoComplete="off" />
          </Field>
          <Field label={t('admin.users.password')} hint={user ? t('admin.users.passwordKeep') : t('admin.users.passwordHint')}>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required={!user} minLength={8} autoComplete="new-password" />
          </Field>
        </div>
        <Field label={t('admin.users.roles')} hint={t('admin.users.rolesHint')}>
          <div className="row" style={{ flexWrap: 'wrap', gap: '6px 14px' }}>
            {ROLE_ORDER.map((r) => (
              <label key={r} className="row nowrap" style={{ gap: 6 }}>
                <input type="checkbox" checked={roles.includes(r)} onChange={() => flip(r)} disabled={user?.id === me && r === 'admin'} />
                {t(`roles.${r}`)}
              </label>
            ))}
          </div>
        </Field>
        <div className="grid2">
          {roles.includes('livreur') && (
            <Field label={t('admin.users.company')}>
              <select value={company ?? ''} onChange={(e) => setCompany(e.target.value ? Number(e.target.value) : null)}>
                <option value="">{t('admin.users.companyNone')}</option>
                {companies.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label={t('admin.users.language')}>
            <select value={language} onChange={(e) => setLanguage(e.target.value as typeof language)}>
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {l === 'fr' ? 'Français' : l === 'en' ? 'English' : 'العربية'}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {err && <p className="error">{err}</p>}
      </form>
      {user && (
        <div className="row" style={{ marginTop: 14, gap: 8, flexWrap: 'wrap', borderTop: '1px solid var(--line)', paddingTop: 12 }}>
          {newPw ? (
            <div className="okbox" style={{ width: '100%' }}>
              {t('admin.users.resetDone')} <code className="ltr">{newPw}</code>
            </div>
          ) : (
            <ConfirmButton question={t('admin.users.resetConfirm')} onConfirm={() => reset.mutate({ id: user.id })}>
              {t('admin.users.reset')}
            </ConfirmButton>
          )}
          {user.id !== me &&
            (user.active ? (
              <ConfirmButton className="btn small danger" question={t('admin.users.deactivateConfirm')} onConfirm={() => toggle.mutate({ id: user.id, active: false })}>
                {t('admin.users.deactivate')}
              </ConfirmButton>
            ) : (
              <button type="button" className="btn small ok" onClick={() => toggle.mutate({ id: user.id, active: true })}>
                {t('admin.users.activate')}
              </button>
            ))}
        </div>
      )}
    </Modal>
  );
}
