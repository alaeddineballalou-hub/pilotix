// Utilisateurs › Rôles › <role>: what a role sees and does, as its own menu (« Menu miroir »), screen by screen (the
// team screens, Écrans). Each page of the role's menu has its switch; opened, its tabs and its buttons. Then « En plus du
// rôle » (the short safe list), what the role can never have, « Une personne à part », and on the side the menu the
// person will see, with its screens dropdown. Saved with rights.save.
//
// Everything here is read from the store's menu list (packages/shared/src/menu.ts): its pages and their groups, icons,
// tabs and screens. A page, a tab or a screen added or moved there shows here by itself; the preview is drawn by the
// menu's own function (menuView, layout/nav.ts).
import {
  actsOf,
  byDefault,
  expandRoles,
  type Role,
  extraOk,
  type Profile,
  personExtraOk,
  type RightDef,
  rightDef,
  RIGHTS,
  RIGHTS_ROLES,
  type RightsRole,
  rightsRolesOf,
  roleHas,
  type RoleRights,
  roleRightsSet,
  MENU_PAGES,
  SPACES,
  type SpaceId,
  tabsOf,
} from '@pilotix/shared';
import type { TFunction } from 'i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { canSee, canSeeChild, menuView, NAV } from '../../layout/nav';
import { rpc } from '../../lib/backend';
import { pageIsOn } from '../../lib/features';
import { useRpc } from '../../lib/query';
import { ErrorBox, Field, Icon, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { Switch } from './bits';
import './rolerights.css';

type Person = { id: number; name: string; roles: Profile['roles']; agencyId: number | null; active: boolean };

/** One line of the role's menu: a page (with its tabs and buttons), or the orders' buttons (no page of their own). */
interface Line {
  key: string;
  icon: string;
  page: RightDef | null;
  label: string;
  tabs: RightDef[];
  acts: RightDef[];
  /** the menu group it sits in (Commandes, AI Pilot…) */
  group: string | null;
  /** the team screens it is on */
  screens: SpaceId[];
}

/** A part of the role's menu: one team screen, what is on every screen, or what is on none (« Ancien menu » only). */
type PartId = SpaceId | 'always' | 'none';
interface Part {
  id: PartId;
  icon: string;
  lines: Line[];
}

/**
 * A right's name where it stands alone (the list of what a role can never have, a person's changes, the changes bar):
 * a group's line with its group (« Pilot Automations › Réglages » is not « Réglages »), a tab with its page.
 */
function fullName(t: TFunction, d: RightDef): string {
  if (d.kind === 'tab' && d.in) {
    const p = rightDef(`page:${d.in}`);
    return p ? `${fullName(t, p)} › ${t(d.label)}` : t(d.label);
  }
  if (d.kind === 'page' && d.in && d.in !== d.id.slice(5) && d.in !== 'commandes') return `${t(`nav.${d.in}`)} › ${t(d.label)}`;
  return t(d.label);
}

/** Is this page of the menu in the shop's plan (and its module on) for these roles? */
function inPlan(id: string, roles: Role[]): boolean {
  const item = NAV.find((n) => n.id === id);
  if (item) return pageIsOn(item.id) && (!item.onlyIf || item.onlyIf(roles, false));
  const child = NAV.flatMap((n) => n.children ?? []).find((c) => c.id === id);
  if (child) return (child.plan ? pageIsOn(...child.plan) : pageIsOn(child.id)) && (!child.onlyIf || child.onlyIf(roles, false));
  return true;
}

const sameSet = (a: string[] = [], b: string[] = []) => a.length === b.length && a.every((x) => b.includes(x));

/** Switch one right of a role in the draft: a default taken away (or given back), an « en plus » given (or taken back). */
function toggled(rr: RoleRights, r: RightsRole, d: RightDef, on: boolean): RoleRights {
  const cur = rr.roles[r] ?? {};
  let off = cur.off ?? [];
  let more = cur.on ?? [];
  if (byDefault(r, d)) off = on ? off.filter((x) => x !== d.id) : [...new Set([...off, d.id])];
  else if (extraOk(r, d)) more = on ? [...new Set([...more, d.id])] : more.filter((x) => x !== d.id);
  return { ...rr, roles: { ...rr.roles, [r]: { ...(off.length ? { off } : {}), ...(more.length ? { on: more } : {}) } } };
}

/** What changed between two saved states: one line per right, per role or per person. */
function changesOf(a: RoleRights, b: RoleRights) {
  const out: { who: string; id: string; on: boolean }[] = [];
  for (const r of RIGHTS_ROLES) {
    const x = a.roles[r] ?? {};
    const y = b.roles[r] ?? {};
    for (const id of new Set([...(x.off ?? []), ...(y.off ?? [])])) if ((x.off ?? []).includes(id) !== (y.off ?? []).includes(id)) out.push({ who: r, id, on: !(y.off ?? []).includes(id) });
    for (const id of new Set([...(x.on ?? []), ...(y.on ?? [])])) if ((x.on ?? []).includes(id) !== (y.on ?? []).includes(id)) out.push({ who: r, id, on: (y.on ?? []).includes(id) });
  }
  for (const k of new Set([...Object.keys(a.people), ...Object.keys(b.people)])) {
    const x = a.people[k] ?? {};
    const y = b.people[k] ?? {};
    if (!sameSet(x.off, y.off) || !sameSet(x.on, y.on)) out.push({ who: `p${k}`, id: '', on: true });
  }
  return out;
}

export function RoleRightsPage({ role: asked }: { role?: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useRpc('rights.get', {});
  const counts = useRpc('admin.roles', {});
  const [draft, setDraft] = useState<RoleRights | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [person, setPerson] = useState<{ id: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  // the screen picked in the preview's dropdown (« Ancien menu » first, as in the app)
  const [pv, setPv] = useState<SpaceId>('all');
  const saved = q.data?.rights ?? null;
  useEffect(() => {
    if (saved && !draft) setDraft(saved);
  }, [saved, draft]);
  const role: RightsRole = (RIGHTS_ROLES as readonly string[]).includes(asked ?? '') ? (asked as RightsRole) : 'confirmation';
  const people: Person[] = (q.data?.people ?? []) as Person[];
  const changes = useMemo(() => (saved && draft ? changesOf(saved, draft) : []), [saved, draft]);
  // leaving the page with changes not saved: the browser asks first
  useEffect(() => {
    if (!changes.length) return;
    const stay = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', stay);
    return () => window.removeEventListener('beforeunload', stay);
  }, [changes.length]);

  if (q.isLoading || !draft) return q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;

  const roleName = (r: RightsRole) => (r === 'agence' ? t('rights.agence') : t(`roles.${r}`));
  const name = (d: RightDef) => t(d.label);
  const ofRole = (r: RightsRole) => people.filter((p) => p.active && rightsRolesOf(p).includes(r));
  const countOf = (r: RightsRole) => (r === 'agence' ? ofRole('agence').length : (counts.data?.[r as keyof typeof counts.data] as { active?: number } | undefined)?.active ?? ofRole(r).length);
  const agencyShown = ofRole('agence').length > 0 || !!draft.roles.agence;
  const pills = RIGHTS_ROLES.filter((r) => r !== 'agence' || agencyShown);

  const has = (d: RightDef) => roleHas(role, d, draft);
  const changed = (d: RightDef) => roleHas(role, d, draft) !== byDefault(role, d);
  const flip = (d: RightDef, on: boolean) => setDraft(toggled(draft, role, d, on));
  const set = roleRightsSet(role, draft);

  // the role's menu: its pages (by default, in the shop's plan), each with its tabs and buttons
  const asRoles = expandRoles([role === 'agence' ? 'confirmation' : (role as Role)]);
  const lines: Line[] = [];
  for (const p of MENU_PAGES) {
    const d = rightDef(`page:${p.id}`)!;
    if (!byDefault(role, d) || !inPlan(p.id, asRoles)) continue;
    lines.push({
      key: d.id,
      icon: p.icon,
      page: d,
      label: name(d),
      tabs: tabsOf(p.id).filter((x) => byDefault(role, x)),
      acts: actsOf(p.id).filter((x) => byDefault(role, x)),
      group: p.group,
      screens: p.screens,
    });
  }
  // the orders' buttons (and what is everywhere), right after the Commandes group's pages, on their screen
  const orderActs = [...actsOf('orders'), ...actsOf('general')].filter((x) => byDefault(role, x));
  if (orderActs.length) {
    const after = lines.map((l) => l.group).lastIndexOf('commandes');
    const cmd = lines.find((l) => l.key === 'page:commandes') ?? lines[after];
    const line: Line = { key: 'orders', icon: 'list', page: null, label: t(after >= 0 ? 'rights.orders' : 'rights.general'), tabs: [], acts: orderActs, group: after >= 0 ? 'commandes' : null, screens: cmd?.screens ?? [] };
    lines.splice(after >= 0 ? after + 1 : lines.length, 0, line);
  }
  // the role's screens, the one holding most of its pages first (then the menu's order): each page sits under the
  // first of its screens, and names the others; Accueil and Aide are on every screen
  const nOn = (s: SpaceId) => lines.filter((l) => l.page && !l.page.locked && l.screens.includes(s)).length;
  const order = SPACES.map((s) => s.id).filter((s) => nOn(s) > 0).sort((a, b) => nOn(b) - nOn(a));
  const home = (l: Line): PartId => (l.page?.locked ? 'always' : (order.find((s) => l.screens.includes(s)) ?? 'none'));
  const also = (l: Line) => (l.page ? l.screens.filter((s) => s !== home(l)) : []);
  const parts: Part[] = [
    { id: 'always' as PartId, icon: 'home' },
    ...order.map((s) => ({ id: s as PartId, icon: SPACES.find((x) => x.id === s)!.icon })),
    { id: 'none' as PartId, icon: 'list' },
  ]
    .map((p) => ({ ...p, lines: lines.filter((l) => home(l) === p.id) }))
    .filter((p) => p.lines.length > 0);
  const partName = (id: PartId) => (id === 'always' ? t('rights.partAlways') : id === 'none' ? t('rights.partNone') : t(`nav.screens.${id}`));
  const extras = RIGHTS.filter((d) => extraOk(role, d));
  const never = [...new Set(RIGHTS.filter((d) => d.kind === 'page' && !byDefault(role, d) && !extraOk(role, d) && !d.locked).map((d) => fullName(t, d)))];
  const firstPerson = ofRole(role)[0];
  const opened = lines.find((l) => l.key === open && l.page) ?? null;
  // the menu the person will see: the app's own menu function, with the role's rights (its screens dropdown too)
  const hasR = (id: string | null) => !id || set.has(id);
  const view = menuView(
    NAV,
    {
      item: (n) => canSee(n, asRoles, false, set.has('x:users'), set.has('x:rules'), set.has('x:affect'), hasR),
      line: (c) => canSeeChild(c, asRoles, false, set.has('x:rules'), hasR),
    },
    pv,
    true,
  );
  const lit = (id: string) => opened?.key === `page:${id}`;

  const save = async () => {
    setBusy(true);
    try {
      const r = await rpc('rights.save', { roles: draft.roles, people: draft.people });
      setDraft(r.rights as RoleRights);
      await qc.invalidateQueries();
      toast(t('rights.saved'), 'ok');
    } catch (e: any) {
      toast(String(e?.message ?? e), 'bad');
    } finally {
      setBusy(false);
    }
  };

  const describe = (c: { who: string; id: string; on: boolean }) => {
    if (c.who.startsWith('p')) return t('rights.personTitle', { name: people.find((p) => `p${p.id}` === c.who)?.name ?? '' });
    const d = rightDef(c.id);
    return t(c.on ? 'rights.changeOn' : 'rights.changeOff', { who: roleName(c.who as RightsRole), what: d ? fullName(t, d) : c.id });
  };

  return (
    <div className="rr">
      <div className="rr-head">
        <div>
          <h1>{t('rights.title')}</h1>
          <p>{t('rights.sub')}</p>
        </div>
        <button
          type="button"
          className="btn ghost"
          disabled={!draft.roles[role]}
          onClick={() => {
            const roles = { ...draft.roles };
            delete roles[role];
            setDraft({ ...draft, roles });
            toast(t('rights.backDone', { role: roleName(role) }), 'info');
          }}
        >
          {t('rights.back')}
        </button>
      </div>

      <nav className="rr-pills" aria-label={t('rights.pickRole')}>
        <span className="rr-pill rr-pill-admin" title={t('rights.adminAll')}>
          <Icon name="lock" />
          {t('roles.admin')}
        </span>
        {pills.map((r) => (
          <a key={r} className={`rr-pill${r === role ? ' on' : ''}`} href={`#/utilisateurs/roles/${r}`} aria-current={r === role ? 'page' : undefined} title={r === 'agence' ? t('rights.agenceHint') : undefined}>
            {roleName(r)}
            <small>{countOf(r)}</small>
            {changesOf({ roles: { [r]: saved?.roles[r] }, people: {} }, { roles: { [r]: draft.roles[r] }, people: {} }).length > 0 && <i className="rr-dot" aria-hidden="true" />}
          </a>
        ))}
      </nav>

      <div className="rr-cols">
        <div className="rr-l">
          <section className="rr-tree" aria-label={t('rights.menuOf', { role: roleName(role) })}>
            <h2>{t('rights.menuOf', { role: roleName(role) })}</h2>
            {parts.map((p) => (
              <section key={p.id} className="rr-part" aria-labelledby={`rr-part-${p.id}`}>
                <div className="rr-part-h">
                  <Icon name={p.icon} />
                  <b id={`rr-part-${p.id}`}>{partName(p.id)}</b>
                  <small>{p.id === 'none' ? t('rights.partNoneHint') : t('rights.nPages', { count: p.lines.filter((l) => l.page).length })}</small>
                </div>
                {p.lines.map((l, i) => {
                  const groupStart = l.group && l.group !== p.lines[i - 1]?.group;
                  const isOpen = open === l.key;
                  const on = !l.page || has(l.page);
                  const tabsOn = l.tabs.filter((x) => roleHas(role, x, draft)).length;
                  const actsOn = l.acts.filter((x) => roleHas(role, x, draft)).length;
                  const elsewhere = also(l);
                  const sub = [
                    l.tabs.length ? t('rights.tabsN', { count: tabsOn, of: l.tabs.length }) : '',
                    l.acts.length ? t('rights.actsN', { count: actsOn, of: l.acts.length }) : '',
                    elsewhere.length ? t('rights.alsoOn', { list: elsewhere.map((s) => t(`nav.screens.${s}`)).join(', ') }) : '',
                  ]
                    .filter(Boolean)
                    .join(' · ');
                  const anyChange = (l.page && changed(l.page)) || l.tabs.some(changed) || l.acts.some(changed);
                  return (
                    <div key={l.key} className={`rr-line${l.group ? ' g' : ''}${isOpen ? ' open' : ''}${on ? '' : ' off'}`}>
                      {groupStart && <div className="rr-group">{t(`nav.${l.group}`)}</div>}
                      <div className="rr-it">
                        <Icon name={l.icon} className="rr-ic" />
                        <div className="rr-t">
                          <b>{l.label}</b>
                          {l.key === 'orders' && <small>{t('rights.ordersSub')}</small>}
                          {sub && <small>{sub}</small>}
                        </div>
                        {anyChange && <span className="rr-mod">{t('rights.modified')}</span>}
                        {(l.tabs.length > 0 || l.acts.length > 0) && (
                          <button type="button" className="rr-exp" aria-expanded={isOpen} aria-label={t(isOpen ? 'rights.close' : 'rights.open', { name: l.label })} onClick={() => setOpen(isOpen ? null : l.key)}>
                            <Icon name={isOpen ? 'chevron' : 'chevr'} />
                          </button>
                        )}
                        {l.page?.locked ? (
                          <span className="rr-lock">
                            <Icon name="lock" />
                            {t('rights.always')}
                          </span>
                        ) : l.page ? (
                          <Switch checked={on} label={l.label} onChange={(v) => flip(l.page!, v)} />
                        ) : null}
                      </div>
                      {isOpen && (
                        <div className="rr-in">
                          {!on && <p className="rr-note">{t('rights.pageOff')}</p>}
                          {l.tabs.length > 0 && (
                            <>
                              <div className="rr-lab">{t('rights.tabs')}</div>
                              <div className="rr-chips">
                                {l.tabs.map((x) => {
                                  const v = roleHas(role, x, draft);
                                  return (
                                    <button key={x.id} type="button" className={`rr-chip${v ? ' on' : ''}`} aria-pressed={v} disabled={!on} onClick={() => flip(x, !v)}>
                                      {changed(x) && <i className="rr-dot" aria-hidden="true" />}
                                      {name(x)}
                                    </button>
                                  );
                                })}
                              </div>
                            </>
                          )}
                          {l.acts.length > 0 && (
                            <>
                              <div className="rr-lab">{t('rights.acts')}</div>
                              {l.acts.map((x) => (
                                <ActRow key={x.id} d={x} on={roleHas(role, x, draft)} changed={changed(x)} onChange={(v) => flip(x, v)} />
                              ))}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </section>
            ))}
            {extras.length > 0 && (
              <>
                <div className="rr-sep" />
                <h2>{t('rights.extra')}</h2>
                <p className="rr-hint">{t('rights.extraSub')}</p>
                {extras.map((x) => (
                  <ActRow key={x.id} d={x} on={roleHas(role, x, draft)} changed={changed(x)} extra onChange={(v) => flip(x, v)} />
                ))}
              </>
            )}
            {never.length > 0 && (
              <div className="rr-no">
                <Icon name="info" />
                <span>{t('rights.none', { role: roleName(role), pages: never.join(', ') })}</span>
              </div>
            )}
          </section>

          <section className="rr-tree rr-people" aria-labelledby="rr-people">
            <h2 id="rr-people">{t('rights.people')}</h2>
            <p className="rr-hint">{t('rights.peopleSub')}</p>
            {Object.keys(draft.people).length === 0 && <p className="rr-hint">{t('rights.peopleNone')}</p>}
            {Object.entries(draft.people).map(([k, e]) => {
              const p = people.find((x) => String(x.id) === k);
              if (!p) return null;
              const list = (ids?: string[]) => (ids ?? []).map((id) => rightDef(id)).filter((d): d is RightDef => !!d).map((d) => fullName(t, d)).join(', ');
              return (
                <div key={k} className="rr-it rr-person">
                  <span className="rr-av" aria-hidden="true">
                    {p.name.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="rr-t">
                    <b>{p.name}</b>
                    {!!e.on?.length && <small className="rr-plus">{t('rights.more', { list: list(e.on) })}</small>}
                    {!!e.off?.length && <small className="rr-minus">{t('rights.less', { list: list(e.off) })}</small>}
                  </div>
                  <button type="button" className="btn small ghost" onClick={() => setPerson({ id: p.id })}>
                    {t('rights.edit')}
                  </button>
                </div>
              );
            })}
            {person ? (
              <PersonApart people={people} draft={draft} id={person.id} onChange={setDraft} onClose={() => setPerson(null)} />
            ) : (
              <button type="button" className="btn" onClick={() => setPerson({ id: null })}>
                {t('rights.addPerson')}
              </button>
            )}
          </section>
        </div>

        <aside className="rr-r" aria-label={firstPerson ? t('rights.preview', { name: firstPerson.name }) : t('rights.previewRole', { role: roleName(role) })}>
          <div className="rr-cap">
            <b>{firstPerson ? t('rights.preview', { name: firstPerson.name }) : t('rights.previewRole', { role: roleName(role) })}</b>
            <small>{t('rights.previewSub')}</small>
          </div>
          <div className="rr-phone">
            <div className="rr-scr">
              {view.screens.length > 1 && (
                <label className="rr-pscr">
                  <span>{t('nav.screens.title')}</span>
                  <select value={view.screen} onChange={(e) => setPv(e.target.value as SpaceId)}>
                    <option value="all">{t('nav.screens.all')}</option>
                    {view.screens.map((s) => (
                      <option key={s.id} value={s.id}>
                        {t(`nav.screens.${s.id}`)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="rr-menu">
                {view.items.map((n) =>
                  n.children ? (
                    <div key={n.id} className="rr-mg">
                      <div className={`rr-mi rr-mh${lit(n.id) ? ' on' : ''}`}>
                        <Icon name={n.icon} />
                        <span>{t(`nav.${n.id}`)}</span>
                      </div>
                      {view.kidsOn(n).map((c) => (
                        <div key={c.id} className={`rr-mi rr-ms${lit(c.id) ? ' on' : ''}`}>
                          <Icon name={c.icon ?? n.icon} />
                          <span>{t(`nav.sub.${c.id}`)}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div key={n.id} className={`rr-mi${lit(n.id) ? ' on' : ''}`}>
                      <Icon name={n.icon} />
                      <span>{t(`nav.${n.id}`)}</span>
                    </div>
                  ),
                )}
              </div>
              {opened && opened.tabs.length > 0 && opened.page && set.has(opened.page.id) && (
                <div className="rr-ptabs">
                  <small>{t('rights.previewTabs', { page: opened.label })}</small>
                  <div>
                    {opened.tabs
                      .filter((x) => set.has(x.id))
                      .map((x) => (
                        <span key={x.id} className="rr-ptab">
                          {name(x)}
                        </span>
                      ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </aside>
      </div>

      {changes.length > 0 && (
        <div className="rr-bar" role="region" aria-label={t('rights.changes', { count: changes.length })}>
          <p>
            {t('rights.changes', { count: changes.length })}
            <small>{changes.slice(0, 3).map(describe).join(' · ')}</small>
          </p>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => setDraft(saved)}>
            {t('rights.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={save}>
            {t('rights.save')}
          </button>
        </div>
      )}
    </div>
  );
}

function ActRow({ d, on, changed, extra, onChange, label }: { d: RightDef; on: boolean; changed: boolean; extra?: boolean; onChange: (v: boolean) => void; label?: string }) {
  const { t } = useTranslation();
  const help = d.kind === 'x' ? t(`rights.xHelp.${d.id.slice(2)}`) : d.kind === 'act' ? t(`rights.actHelp.${d.id.slice(4)}`, { defaultValue: '' }) : '';
  return (
    <div className="rr-row">
      <div className="rr-t">
        <b>{label ?? t(d.label)}</b>
        {help && <small>{help}</small>}
      </div>
      {extra && on && <span className="rr-plus-pill">{t('rights.extraPill')}</span>}
      {changed && !extra && <span className="rr-mod">{t('rights.modified')}</span>}
      <Switch checked={on} label={label ?? t(d.label)} onChange={onChange} />
    </div>
  );
}

/** « Une personne à part »: one person's own changes on top of their roles (remove what they have, add what may be given). */
function PersonApart({ people, draft, id, onChange, onClose }: { people: Person[]; draft: RoleRights; id: number | null; onChange: (rr: RoleRights) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [who, setWho] = useState<number | null>(id);
  const p = people.find((x) => x.id === who) ?? null;
  const roles = p ? rightsRolesOf(p) : [];
  const mine = (p && draft.people[String(p.id)]) || {};
  const viaRole = (d: RightDef) => roles.some((r) => roleHas(r, d, draft));
  // what they have through their roles (pages and buttons; tabs follow the pages), and what may be given to them
  const theirs = RIGHTS.filter((d) => (d.kind === 'page' || d.kind === 'act') && !d.locked && viaRole(d));
  const giveable = RIGHTS.filter((d) => d.kind !== 'tab' && personExtraOk(roles, d, draft));
  const setMine = (off: string[], on: string[]) => {
    if (!p) return;
    const people2 = { ...draft.people };
    if (!off.length && !on.length) delete people2[String(p.id)];
    else people2[String(p.id)] = { ...(off.length ? { off } : {}), ...(on.length ? { on } : {}) };
    onChange({ ...draft, people: people2 });
  };
  const off = mine.off ?? [];
  const on = mine.on ?? [];
  return (
    <div className="rr-pm">
      <div className="rr-pm-head">
        <b>{p ? t('rights.personTitle', { name: p.name }) : t('rights.addPerson').replace(/^\+\s*/, '')}</b>
        <button type="button" className="btn small primary" onClick={onClose}>
          {t('rights.done')}
        </button>
      </div>
        <Field label={t('rights.pickPerson')}>
          <select value={who ?? ''} onChange={(e) => setWho(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{t('rights.pickPersonPh')}</option>
            {people
              .filter((x) => x.active)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} · {rightsRolesOf(x).map((r) => (r === 'agence' ? t('rights.agence') : t(`roles.${r}`))).join(', ')}
                </option>
              ))}
          </select>
        </Field>
        {p && (
          <>
            <p className="rr-hint">{t('rights.personHelp', { name: p.name })}</p>
            <div className="rr-lab">{t('rights.personCan')}</div>
            {giveable.length === 0 && <p className="rr-hint">{t('rights.personNothing')}</p>}
            {giveable.map((d) => (
              <ActRow key={d.id} d={d} label={fullName(t, d)} on={on.includes(d.id)} changed={false} extra onChange={(v) => setMine(off, v ? [...new Set([...on, d.id])] : on.filter((x) => x !== d.id))} />
            ))}
            <div className="rr-lab">{t('rights.personHas')}</div>
            {theirs.map((d) => (
              <ActRow key={d.id} d={d} label={fullName(t, d)} on={!off.includes(d.id)} changed={off.includes(d.id)} onChange={(v) => setMine(v ? off.filter((x) => x !== d.id) : [...new Set([...off, d.id])], on)} />
            ))}
          </>
        )}
    </div>
  );
}
