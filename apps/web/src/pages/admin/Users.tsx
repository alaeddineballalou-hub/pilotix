// Utilisateurs: the Rôles table and one list per role, with the create / edit form (users.create / users.update).
import { AgencySellerWork, expandRoles, LANGUAGES, Profile, Role, ROLES } from '@pilotix/shared';
import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { canSee, NAV } from '../../layout/nav';
import { rpc } from '../../lib/backend';
import { pageIsOn } from '../../lib/features';
import { usePhoneProblem } from '../../lib/phoneCheck';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { when } from '../../lib/format';
import { Card, copyText, Empty, ErrorBox, Field, Icon, Loading, StageBar } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { ConfirmButton } from './bits';
import { usePartnerKind, useTp } from '../agency/parts';

export const USER_SUBS = ['roles', 'admins', 'vendeurs', 'agents', 'marketeurs', 'managers'] as const;
/** WhatsApp with a ready message, to the person's number when it is known (0550… → 213550…). */
const waLink = (phone: string | null | undefined, text: string) => {
  const d = String(phone ?? '').replace(/\D/g, '');
  return `https://wa.me/${d.startsWith('00') ? d.slice(2) : d.startsWith('0') ? `213${d.slice(1)}` : d}?text=${encodeURIComponent(text)}`;
};
const SUB_ROLE: Record<string, Role> = { admins: 'admin', vendeurs: 'vendeur', agents: 'confirmation', marketeurs: 'marketer', managers: 'agent_manager' };
/** A confirmation agency's Utilisateurs: everyone, then one list per role of an agency. */
const AGENCY_SUBS = ['equipe', 'agents', 'suivi', 'managers', 'admins'] as const;
const AGENCY_SUB_ROLE: Record<string, Role> = { agents: 'confirmation', suivi: 'suivi', managers: 'agent_manager', admins: 'admin' };
/** The roles of an agency's people: its chief, its supervisors, its agents. */
const AGENCY_ROLES: Role[] = ['admin', 'agent_manager', 'confirmation', 'suivi'];
/** A marketer's Utilisateurs: everyone, its marketers (media buyers), its administrators. */
const MARKETER_SUBS = ['equipe', 'marketeurs', 'admins'] as const;
const MARKETER_SUB_ROLE: Record<string, Role> = { marketeurs: 'marketer', admins: 'admin' };
const MARKETER_ROLES: Role[] = ['admin', 'marketer'];
const ROLE_SUB: Partial<Record<Role, string>> = { admin: 'admins', vendeur: 'vendeurs', confirmation: 'agents', marketer: 'marketeurs', agent_manager: 'managers' };
/** Rôles table order, as in the original. */
const ROLE_ORDER: Role[] = ['admin', 'vendeur', 'agent_manager', 'confirmation', 'suivi', 'depot', 'livreur', 'marketer'];
/** Every page in menu order, with the hidden Livrées / Retournées pages of the original. */
const PAGE_ORDER = ['accueil', 'dashboard', 'commandes', 'confirmation', 'depot', 'scanner', 'suivi', 'livrees', 'retournees', 'sav', 'tournee', 'produits', 'messages', 'cm', 'clients', 'marketing', 'caisse', 'macaisse', 'livraison', 'utilisateurs', 'management', 'reglages'];

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

export function UsersPage({ sub, rest, agency }: { sub?: string; rest?: string[]; agency?: boolean }) {
  const { t } = useTranslation();
  const cur = subOf(sub, rest);
  const [form, setForm] = useState<{ user: Profile | null; role: Role | null } | null>(null);
  const { session } = useSession();
  const tp = useTp();
  const mk = usePartnerKind() === 'marketer';
  if (agency) {
    // a partner (agency, marketer): its whole team first, then each role; each person with their sellers and products
    const all: readonly string[] = mk ? MARKETER_SUBS : AGENCY_SUBS;
    const k = all.includes(sub ?? '') ? sub! : 'equipe';
    const role = (mk ? MARKETER_SUB_ROLE : AGENCY_SUB_ROLE)[k] ?? null;
    const subs = all.filter((x) => session?.isAdmin || x !== 'admins');
    return (
      <>
        <StageBar flow={false} current={k} items={subs.map((x) => ({ key: x, label: tp(`users.subs.${x}`), href: `#/utilisateurs/${x}` }))} />
        <RoleList agency role={role} onNew={() => setForm({ user: null, role })} onEdit={(u) => setForm({ user: u, role })} />
        {form && <UserForm agency user={form.user} role={form.role} onClose={() => setForm(null)} />}
      </>
    );
  }
  // people allowed to handle the team's accounts (not administrators) do not see the administrators' list
  const subs = USER_SUBS.filter((k) => session?.isAdmin || k !== 'admins');
  return (
    <>
      <StageBar flow={false} current={cur.sub} items={subs.map((k) => ({ key: k, label: t(`admin.subs.${k}`), href: `#/utilisateurs/${k}` }))} />
      {cur.role ? <RoleList role={cur.role} onNew={() => setForm({ user: null, role: cur.role })} onEdit={(u) => setForm({ user: u, role: cur.role })} /> : <RolesTable onNew={() => setForm({ user: null, role: null })} />}
      {form && <UserForm user={form.user} role={form.role} onClose={() => setForm(null)} />}
    </>
  );
}

/** A role's name: a partner names its own (Chef d'agence, Superviseur, Agent de confirmation, Marketeur…). */
function useRoleName(agency?: boolean) {
  const { t } = useTranslation();
  const tp = useTp();
  return (r: Role) => (agency ? tp(`team.r.${r}`, { defaultValue: t(`roles.${r}`) }) : t(`roles.${r}`));
}

function RolesTable({ onNew }: { onNew: () => void }) {
  const { t } = useTranslation();
  const { session } = useSession();
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
                {ROLE_ORDER.filter((r) => session?.isAdmin || r !== 'admin').map((r) => {
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

function RoleList({ role, onNew, onEdit, agency }: { role: Role | null; onNew: () => void; onEdit: (u: Profile) => void; agency?: boolean }) {
  const { t } = useTranslation();
  const tp = useTp();
  const { session, me } = useSession();
  const roleName = useRoleName(agency);
  const q = useRpc('users.list', role ? { role } : {});
  const choices = useRpc('agency.sellerChoices', {}, { enabled: !!agency, staleTime: 60_000 });
  const sellerName = (id: number) => choices.data?.find((c) => c.store.id === id)?.store.name ?? '…';
  /** the store's owner (who created it): only they change their own account */
  const ownerId = session?.shop?.ownerProfileId ?? null;
  /** accounts only the administrator may change (administrators, people with the accounts right, oneself); the owner's: only the owner */
  const locked = (u: Profile) => (u.id === ownerId && u.id !== me) || (!session?.isAdmin && (u.roles.includes('admin') || !!u.canManageUsers || u.id === me));
  // archived accounts are in Management › Archives (users.list still names them, for the history)
  const rows = (q.data ?? []).filter((u) => !u.archived);
  const archives = !agency && !!session?.isAdmin && pageIsOn('management', 'archive');
  // users.list matches own roles; vendeurs also count as agents etc. only through their own roles (as in the original)
  return (
    <>
      <Card
        title={agency ? tp(`users.title.${role ?? 'all'}`) : t(`admin.users.listTitle.${role}`)}
        help={agency ? tp('users.help') : t('admin.users.listHelp')}
        actions={
          <>
            {archives && (
              <a className="btn" href="#/management/archive/users">
                <Icon name="archive" /> {t('admin.users.archives')}
              </a>
            )}
            <button className="btn primary" onClick={onNew}>
              {agency ? t('agency.users.new') : t(`admin.users.newBtn.${role}`)}
            </button>
          </>
        }
      />
      <div className="card">
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorBox error={q.error} onRetry={() => q.refetch()} />
        ) : !rows.length ? (
          <Empty>{t('admin.users.empty')}</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('admin.users.colName')}</th>
                  <th>{t('admin.users.colPhone')}</th>
                  <th>{t('admin.users.colRoles')}</th>
                  {agency && <th>{t('agency.users.colSellers')}</th>}
                  <th>{t('admin.users.colLast')}</th>
                  <th>{t('admin.users.colState')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => (
                  <tr
                    key={u.id}
                    className={`${locked(u) ? '' : 'clickable'} ${u.active ? '' : 'dim'}`}
                    title={locked(u) ? (u.id === ownerId ? t('admin.users.ownerHint') : t('admin.users.lockedHint')) : undefined}
                    onClick={() => !locked(u) && onEdit(u)}
                    tabIndex={locked(u) ? -1 : 0}
                    onKeyDown={(e) => e.key === 'Enter' && !locked(u) && onEdit(u)}
                  >
                    <td data-l={t('admin.users.colName')}>
                      <b>
                        {locked(u) && '🔒 '}
                        {u.name}
                      </b>
                      <small className="ltr">{u.email}</small>
                    </td>
                    <td data-l={t('admin.users.colPhone')}>
                      <span className="ltr">{u.phone || '—'}</span>
                    </td>
                    <td data-l={t('admin.users.colRoles')}>
                      {u.roles.map((r) => (
                        <span key={r} className="chip">
                          {roleName(r)}
                        </span>
                      ))}
                      {u.canManageUsers && (
                        <span className="chip" title={t('admin.users.manageUsersHint')}>
                          🔑 {t('admin.users.manageChip')}
                        </span>
                      )}
                      {u.id === ownerId && (
                        <span className="chip px-chip-owner" title={t('admin.users.ownerHint')}>
                          👑 {t('admin.users.owner')}
                        </span>
                      )}
                    </td>
                    {agency && (
                      <td data-l={t('agency.users.colSellers')} className="agx-users-sellers">
                        {!u.agencySellers ? (
                          <span className="chip agx-all-chip">{t('agency.users.allSellers')}</span>
                        ) : !u.agencySellers.length ? (
                          <span className="muted">{t('agency.users.noSeller')}</span>
                        ) : (
                          u.agencySellers.map((w) => (
                            <span key={w.store} className="chip" title={w.products ? t('agency.nProducts', { count: w.products.length }) : t('agency.allProducts')}>
                              {sellerName(w.store)}
                              {w.products && <small>{'\u00a0·\u00a0'}{t('agency.nProducts', { count: w.products.length })}</small>}
                            </span>
                          ))
                        )}
                      </td>
                    )}
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

function UserForm({ user, role, onClose, agency }: { user: Profile | null; role: Role | null; onClose: () => void; agency?: boolean }) {
  const { t } = useTranslation();
  const mk = usePartnerKind() === 'marketer';
  const { me, session } = useSession();
  const isAdmin = !!session?.isAdmin;
  const roleName = useRoleName(agency);
  /** an agency's person: the sellers they work for and, for each, the products (null: every seller) */
  const [sellers, setSellers] = useState<AgencySellerWork[] | null>(user ? (user.agencySellers ?? null) : null);
  const [manage, setManage] = useState(!!user?.canManageUsers);
  const [name, setName] = useState(user?.name ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  // wrong, another person of the team, another Pilotix account: said under the field while it is typed
  const phoneBad = usePhoneProblem(phone, (p) => rpc('users.phoneCheck', { phone: p, id: user?.id ?? null, email: email.trim() }));
  const [email, setEmail] = useState(user?.email ?? '');
  const [password, setPassword] = useState('');
  const [roles, setRoles] = useState<Role[]>(user?.roles ?? (role ? [role] : [agency && mk ? 'marketer' : 'confirmation']));
  const [language, setLanguage] = useState(user?.language ?? 'fr');
  const [company, setCompany] = useState<number | null>(user?.livreurCompanyId ?? null);
  const [err, setErr] = useState('');
  const [newPw, setNewPw] = useState<string | null>(null);
  const companies = useRpc('admin.companies', {}, { enabled: !agency });
  // a person who already has a Pilotix account (another store) keeps their own password: the one typed here does nothing
  const create = useAction('users.create', { success: (r) => ((r as { existingAccount?: boolean }).existingAccount ? t('admin.users.createdExisting') : t('admin.users.created')), onDone: onClose });
  const update = useAction('users.update', { success: t('admin.users.saved'), onDone: onClose });
  const toggle = useAction('users.update', { success: (r) => (r.active ? t('admin.users.activated') : t('admin.users.deactivated')), onDone: onClose });
  const reset = useAction('admin.users.resetPassword', { onDone: (r) => setNewPw(r.password) });
  const archive = useAction('archive.set', { success: (r) => (r.done ? t('admin.users.archivedDone', { name: user?.name ?? '' }) : t('admin.users.archiveRefused')), onDone: onClose });
  const ownerId = session?.shop?.ownerProfileId ?? null;
  const canArchive = !agency && !!user && isAdmin && user.id !== me && user.id !== ownerId && pageIsOn('management', 'archive');
  const busy = create.isPending || update.isPending;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!roles.length) return setErr(t('admin.users.needRole'));
    setErr('');
    const base = {
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim(),
      roles,
      language,
      livreurCompanyId: roles.includes('livreur') ? company : null,
      // only the administrator gives (or takes back) the right to handle accounts
      ...(isAdmin ? { canManageUsers: manage && !roles.includes('admin') } : {}),
      ...(agency ? { sellers } : {}),
    };
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
          <button type="submit" form="px-user-form" className="btn primary" disabled={busy || !!phoneBad.problem}>
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
          <Field label={t('admin.users.phone')} hint={phoneBad.problem ? <span className="form-err">{t(`auth.phoneErr.${phoneBad.problem}`)}</span> : t('admin.users.phoneHint')}>
            <input required minLength={9} aria-invalid={!!phoneBad.problem} value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" maxLength={30} className="ltr" placeholder="0550 00 00 00" />
          </Field>
          <Field label={t('admin.users.email')}>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="ltr" autoComplete="off" />
          </Field>
          <Field label={t('admin.users.password')} hint={user ? t('admin.users.passwordKeep') : `${t('admin.users.passwordHint')} ${t('admin.users.passwordAccount')}`}>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required={!user} minLength={8} autoComplete="new-password" />
          </Field>
        </div>
        <Field label={t('admin.users.roles')} hint={t('admin.users.rolesHint')}>
          <div className="row" style={{ flexWrap: 'wrap', gap: '6px 14px' }}>
            {(agency ? (mk ? MARKETER_ROLES : AGENCY_ROLES) : ROLE_ORDER)
              .filter((r) => isAdmin || r !== 'admin')
              .map((r) => (
                <label key={r} className="row nowrap" style={{ gap: 6 }}>
                  <input type="checkbox" checked={roles.includes(r)} onChange={() => flip(r)} disabled={user?.id === me && r === 'admin'} />
                  {roleName(r)}
                </label>
              ))}
          </div>
        </Field>
        {agency && <SellersField value={sellers} onChange={setSellers} />}
        {isAdmin && !roles.includes('admin') && (
          <Field label={t('admin.users.manageUsers')} hint={t('admin.users.manageUsersHint')}>
            <label className="row nowrap" style={{ gap: 8 }}>
              <input type="checkbox" checked={manage} onChange={(e) => setManage(e.target.checked)} />
              🔑 {t('admin.users.manageUsersLabel')}
            </label>
          </Field>
        )}
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
            <div className="okbox px-newpw">
              <p>{t('admin.users.resetDone')}</p>
              <div className="px-newpw-row">
                <code className="ltr px-newpw-code">{newPw}</code>
                <button type="button" className="btn small" onClick={async () => toast((await copyText(newPw)) ? t('admin.users.copied') : t('common.error'), 'ok')}>
                  <Icon name="copy" /> {t('admin.users.copy')}
                </button>
                <a className="btn small" target="_blank" rel="noreferrer" href={waLink(user.phone, t('admin.users.waText', { name: user.name, email: user.email, password: newPw, site: location.origin }))}>
                  <Icon name="whatsapp" /> WhatsApp
                </a>
              </div>
              <p className="small muted">{t('admin.users.resetNote')}</p>
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
          {canArchive && (
            <ConfirmButton className="btn small ghost" disabled={archive.isPending} question={t('admin.users.archiveConfirm')} onConfirm={() => archive.mutate({ kind: 'users', ids: [user.id], archived: true })}>
              <Icon name="archive" /> {t('admin.users.archive')}
            </ConfirmButton>
          )}
        </div>
      )}
    </Modal>
  );
}

/**
 * An agency's person: every seller (also the new ones), or some sellers — and for each one, all the agency's products
 * there or some of them.
 */
function SellersField({ value, onChange }: { value: AgencySellerWork[] | null; onChange: (v: AgencySellerWork[] | null) => void }) {
  const { t } = useTranslation();
  const tp = useTp();
  const q = useRpc('agency.sellerChoices', {}, { staleTime: 60_000 });
  const list = q.data ?? [];
  const some = value !== null;
  const of = (store: number) => value?.find((w) => w.store === store);
  const set = (store: number, w: AgencySellerWork | null) => onChange([...(value ?? []).filter((x) => x.store !== store), ...(w ? [w] : [])]);
  return (
    <Field label={t('agency.users.sellers')} hint={tp('users.sellersHint')}>
      <div className="agx-sellers">
        <label className="agx-radio">
          <input type="radio" name="agx-sellers" checked={!some} onChange={() => onChange(null)} />
          <span>
            <b>{t('agency.users.allSellers')}</b>
            <small className="muted">{t('agency.users.allSellersSub')}</small>
          </span>
        </label>
        <label className="agx-radio">
          <input type="radio" name="agx-sellers" checked={some} onChange={() => onChange(list.filter((c) => c.status === 'active').map((c) => ({ store: c.store.id, products: null })))} />
          <span>
            <b>{t('agency.users.someSellers')}</b>
            <small className="muted">{t('agency.users.someSellersSub')}</small>
          </span>
        </label>
        {some && (
          <ul className="agx-seller-list">
            {!list.length && <li className="muted small">{q.isLoading ? t('common.loading') : t('agency.home.noSeller')}</li>}
            {list.map((c) => {
              const w = of(c.store.id);
              return (
                <li key={c.store.id} className={w ? 'on' : ''}>
                  <label className="agx-seller-row">
                    <input type="checkbox" checked={!!w} onChange={(e) => set(c.store.id, e.target.checked ? { store: c.store.id, products: null } : null)} />
                    <b>{c.store.name}</b>
                    {c.status === 'pending' && <small className="muted">{t('agency.st.pending')}</small>}
                  </label>
                  {w && (
                    <div className="agx-seller-prod">
                      <select value={w.products ? 'some' : 'all'} aria-label={t('agency.users.productsOf', { store: c.store.name })} onChange={(e) => set(c.store.id, { store: c.store.id, products: e.target.value === 'all' ? null : [] })}>
                        <option value="all">{t('agency.users.allProducts')}</option>
                        <option value="some">{t('agency.users.someProducts')}</option>
                      </select>
                      {w.products && <ProductsPick store={c.store.id} value={w.products} onChange={(p) => set(c.store.id, { store: c.store.id, products: p })} />}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Field>
  );
}

/** Some of a seller's products (the agency's there). */
function ProductsPick({ store, value, onChange }: { store: number; value: number[]; onChange: (v: number[]) => void }) {
  const { t } = useTranslation();
  const q = useRpc('agency.products', { store }, { staleTime: 60_000 });
  if (q.isLoading) return <small className="muted">{t('common.loading')}</small>;
  return (
    <div className="agx-prods">
      {(q.data ?? []).map((p) => {
        const on = value.includes(p.id);
        return (
          <label key={p.id} className={`chip agx-prod${on ? ' on' : ''}`}>
            <input type="checkbox" checked={on} onChange={() => onChange(on ? value.filter((x) => x !== p.id) : [...value, p.id])} />
            {p.name}
          </label>
        );
      })}
      {!value.length && <small className="form-err">{t('agency.users.pickProduct')}</small>}
    </div>
  );
}
