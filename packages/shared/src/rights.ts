// Utilisateurs › Rôles: what each role of a boutique sees and does, edited by the boutique's administrator.
//
// Every right is one line of a list: a page of the menu ('page:suivi'), a tab of a page ('tab:suivi/swap'), a button
// ('act:orders.cancel'), or one of the few things that can be given « en plus » ('x:assign'). Each has the roles that get
// it by default (what Pilotix always did); the administrator can take any of them away from a role (or from one person),
// and give only the short, safe list of « en plus » ones. The administrator role always has everything.
//
// What is saved per boutique (settings 'roleRights'): per role, the rights taken away (`off`) and the ones given en plus
// (`on`); per person, the same (« Une personne à part »). Rights added to Pilotix later come on by themselves for the roles
// that get them by default.
//
// Agents of a confirmation agency working in the store follow their own line, « Agents d'agence » (role key 'agence'):
// the same as « Confirmation » unless a right says otherwise (they never changed an order's delivery company by default).

import type { Role } from './index';
import { expandRoles, personIs, ROLE_INCLUDES } from './index';
import { MENU_PAGES, menuTabOf, TAB_LINES } from './menu';

/** The roles whose rights are edited (the administrator has everything), and the agency agents' own line. */
export const RIGHTS_ROLES = ['vendeur', 'agent_manager', 'confirmation', 'agence', 'suivi', 'depot', 'livreur', 'marketer'] as const;
export type RightsRole = (typeof RIGHTS_ROLES)[number];

export type RightKind = 'page' | 'tab' | 'act' | 'x';

export interface RightDef {
  id: string;
  kind: RightKind;
  /** a page: the menu group it sits in (Commandes, AI Pilot…); a tab or a button: its page, or a section ('orders', 'general') */
  in: string | null;
  /** who has it by default (null: everyone); a role also gets what the roles it includes have (a vendeur: confirmation…) */
  roles: readonly RightsRole[] | null;
  /** the agency agents do not follow « Confirmation » for this one */
  noAgence?: true;
  /** roles that may get it « en plus » */
  extraFor?: readonly RightsRole[];
  /** may be given « en plus » to one person, whatever their role */
  person?: true;
  /** always on: the editor shows it with a lock */
  locked?: true;
  /** the app hides it; the server cannot stop it (a file made in the browser from what the page already shows) */
  hideOnly?: true;
  /** i18n key of its name (pages and tabs reuse the menu's) */
  label: string;
}

const CONF = ['confirmation'] as const;
const AGENTS = ['confirmation', 'suivi', 'depot'] as const;

type ActIn = { id: string; in: string; roles: readonly RightsRole[]; noAgence?: true; extraFor?: readonly RightsRole[]; person?: true; hideOnly?: true };

/**
 * The main buttons. Their roles are the ones the server lets do it today (nobody loses anything on the first day). A
 * button is not tied to its page on the server: the same action is used from several pages (an order card is everywhere).
 */
const ACTS: readonly ActIn[] = [
  // on the orders, wherever they are shown
  { id: 'orders.create', in: 'orders', roles: AGENTS },
  { id: 'orders.customer', in: 'orders', roles: AGENTS },
  { id: 'orders.items', in: 'orders', roles: AGENTS },
  { id: 'orders.cancel', in: 'orders', roles: CONF },
  // Préférences' « Qui peut changer la société » (suivi always; agents and managers by default; agency agents and
  // the depot when ticked)
  { id: 'orders.company', in: 'orders', roles: ['suivi', 'confirmation', 'agent_manager'], noAgence: true, extraFor: ['agence', 'depot'], person: true },
  { id: 'orders.give', in: 'orders', roles: ['agent_manager', 'vendeur'] },
  { id: 'orders.blacklist', in: 'orders', roles: ['confirmation', 'suivi'] },
  { id: 'orders.send', in: 'orders', roles: ['depot', 'suivi'] },
  { id: 'orders.parcelCancel', in: 'orders', roles: ['depot', 'suivi'] },
  { id: 'orders.export', in: 'orders', roles: AGENTS, hideOnly: true },
  // everywhere (products, orders, dashboards)
  { id: 'costs', in: 'general', roles: ['vendeur', 'depot'], noAgence: true },
  { id: 'conf.photos', in: 'confirmation', roles: CONF },
  { id: 'suivi.treat', in: 'suivi', roles: ['suivi'] },
  { id: 'suivi.claim', in: 'suivi', roles: ['suivi', 'confirmation', 'depot'] },
  { id: 'suivi.swap', in: 'suivi', roles: ['suivi', 'confirmation'] },
  { id: 'suivi.parcel', in: 'suivi', roles: ['suivi'] },
  { id: 'depot.prepare', in: 'depot', roles: ['depot'] },
  { id: 'depot.dispatch', in: 'depot', roles: ['depot'] },
  { id: 'depot.returns', in: 'depot', roles: ['depot'] },
  { id: 'depot.pickup', in: 'depot', roles: ['depot'] },
  { id: 'sav.create', in: 'sav', roles: AGENTS },
  { id: 'sav.exchange', in: 'sav', roles: AGENTS },
  { id: 'sav.settle', in: 'sav', roles: AGENTS },
  { id: 'stock.products', in: 'produits', roles: ['depot'] },
  { id: 'stock.prices', in: 'produits', roles: ['depot'] },
  { id: 'stock.move', in: 'produits', roles: ['depot'] },
  { id: 'stock.purchases', in: 'produits', roles: ['depot'] },
  { id: 'stock.guides', in: 'produits', roles: AGENTS },
  { id: 'pos.sell', in: 'pos', roles: ['depot'] },
  { id: 'pos.cancel', in: 'pos', roles: ['vendeur'] },
  { id: 'caisse.add', in: 'macaisse', roles: ['confirmation', 'suivi', 'depot', 'agent_manager', 'vendeur'] },
  { id: 'caisse.transfer', in: 'macaisse', roles: ['confirmation', 'suivi', 'depot', 'agent_manager', 'vendeur'] },
  { id: 'pay.ask', in: 'macaisse', roles: ['confirmation', 'suivi', 'depot', 'agent_manager'] },
  { id: 'dellal.reply', in: 'messages', roles: CONF },
  { id: 'cm.reply', in: 'cm', roles: ['confirmation', 'marketer'] },
  { id: 'social.publish', in: 'social', roles: ['marketer'] },
  { id: 'createur.ai', in: 'createur', roles: ['marketer'] },
  { id: 'spy.search', in: 'spy', roles: ['marketer'] },
  { id: 'notify.send', in: 'automessages', roles: ['suivi', 'confirmation'] },
  { id: 'promo.settings', in: 'codepromo', roles: ['marketer', 'vendeur'] },
  { id: 'ads.control', in: 'marketing', roles: ['marketer'] },
  { id: 'ads.launch', in: 'marketing', roles: ['marketer'] },
  { id: 'ads.owner', in: 'marketing', roles: ['vendeur'] },
  { id: 'campaigns.send', in: 'marketing', roles: ['marketer'] },
  { id: 'leads.fix', in: 'marketing', roles: ['marketer'] },
  { id: 'catalog.send', in: 'marketing', roles: ['marketer'] },
  { id: 'marketers.pay', in: 'marketing', roles: ['vendeur'] },
  { id: 'landing.edit', in: 'landing', roles: ['marketer'] },
  { id: 'landing.protect', in: 'landing', roles: ['marketer', 'confirmation'] },
  { id: 'partners.manage', in: 'influenceurs', roles: ['marketer'] },
];

/**
 * What can be given « en plus » (it was elsewhere before: the ticks on a person's card, Préférences' « Qui peut … »).
 * Nobody has them by default but the administrator.
 */
const EXTRAS: readonly ActIn[] = [
  // « Peut gérer les utilisateurs »: create the team's accounts, set their passwords (never an administrator's)
  { id: 'x:users', in: 'extra', roles: [], extraFor: ['vendeur', 'agent_manager'], person: true },
  // « Peut attribuer »: give the orders of Dépôt › « À attribuer » a company or a livreur
  { id: 'x:assign', in: 'extra', roles: [], extraFor: ['vendeur', 'agent_manager', 'depot', 'suivi'], person: true },
  // « Affectation »: open Management › Affectation and share the orders out between the agents
  { id: 'x:affect', in: 'extra', roles: [], extraFor: ['vendeur', 'agent_manager'], person: true },
  // Préférences' « Qui peut changer les règles Pilot »
  { id: 'x:rules', in: 'extra', roles: [], extraFor: ['vendeur', 'agent_manager', 'confirmation', 'agence', 'depot', 'suivi'], person: true },
];

/** A menu's roles as rights roles (the administrators are not in the list: they have everything). */
const asRights = (roles: readonly Role[] | null): readonly RightsRole[] | null => (roles === null ? null : (roles.filter((r) => r !== 'admin') as RightsRole[]));

/**
 * The list: the store's menu page by page with each page's tabs (packages/shared/src/menu.ts — a page, a tab or a
 * screen added there is here too), then the buttons, then the « en plus ».
 */
function build(): RightDef[] {
  const out: RightDef[] = [];
  for (const p of MENU_PAGES) {
    out.push({ id: `page:${p.id}`, kind: 'page', in: p.group, roles: asRights(p.roles), label: p.label, ...(p.always ? { locked: true as const } : {}) });
    for (const t of p.tabs) out.push({ id: `tab:${p.id}/${t.id}`, kind: 'tab', in: p.id, roles: asRights(t.roles), label: t.label });
  }
  for (const a of ACTS) out.push({ ...a, id: `act:${a.id}`, kind: 'act', label: `rights.act.${a.id}` });
  for (const a of EXTRAS) out.push({ ...a, kind: 'x', label: `rights.x.${a.id.slice(2)}` });
  return out;
}

/** Every right, in the order of the menu. */
export const RIGHTS: readonly RightDef[] = build();
const BY_ID = new Map(RIGHTS.map((r) => [r.id, r]));
export const rightDef = (id: string) => BY_ID.get(id);
export const isRightId = (id: string) => BY_ID.has(id);

/** The tabs of a page, in order. */
export const tabsOf = (page: string) => RIGHTS.filter((r) => r.kind === 'tab' && r.in === page);
/** The buttons of a page or a section, in order. */
export const actsOf = (where: string) => RIGHTS.filter((r) => r.kind === 'act' && r.in === where);

// ---------------------------------------------------------------- what is saved
export interface RightsEdit {
  /** rights taken away */
  off?: string[];
  /** rights given en plus */
  on?: string[];
}
export interface RoleRights {
  roles: Partial<Record<RightsRole, RightsEdit>>;
  /** one person's own changes (« Une personne à part »), by profile id */
  people: Record<string, RightsEdit>;
}
export const NO_ROLE_RIGHTS: RoleRights = { roles: {}, people: {} };

/** The rights roles of a person: their own roles, a confirmation agency's agent on the agency line. */
export function rightsRolesOf(p: { roles: readonly Role[]; agencyId?: number | null }): RightsRole[] {
  const out = new Set<RightsRole>();
  for (const r of p.roles) {
    if (r === 'admin') continue;
    out.add(r === 'confirmation' && p.agencyId != null ? 'agence' : (r as RightsRole));
  }
  return [...out];
}

/** The roles a role brings with it (a vendeur: confirmation, suivi, dépôt, marketer), itself included. */
function withIncluded(r: RightsRole): RightsRole[] {
  if (r === 'agence') return ['agence'];
  return [r, ...((ROLE_INCLUDES[r as Role] ?? []) as RightsRole[])];
}

/** Does this role have this right by default? */
export function byDefault(role: RightsRole, d: RightDef): boolean {
  if (d.roles === null) return true;
  return withIncluded(role).some((x) => d.roles!.includes(x) || (x === 'agence' && !d.noAgence && d.roles!.includes('confirmation')));
}
/** May this role get it en plus? */
export const extraOk = (role: RightsRole, d: RightDef) => !byDefault(role, d) && !!d.extraFor?.includes(role);

/** Does this role have this right in the boutique (its default, minus what was taken, plus what was given)? */
export function roleHas(role: RightsRole, d: RightDef, rr: RoleRights): boolean {
  const e = rr.roles[role];
  if (byDefault(role, d)) return d.locked || !e?.off?.includes(d.id);
  return extraOk(role, d) && !!e?.on?.includes(d.id);
}

/** A tab needs its page. */
function needsPage(d: RightDef): string | null {
  return d.kind === 'tab' && d.in ? `page:${d.in}` : null;
}

/**
 * Every right one person has in the boutique: what one of their roles has, their own changes on top; a tab only with
 * its page. An administrator: every right.
 */
export function rightsOf(p: { id: number; roles: readonly Role[]; agencyId?: number | null }, rr: RoleRights): Set<string> {
  if (p.roles.includes('admin')) return new Set(RIGHTS.map((r) => r.id));
  const roles = rightsRolesOf(p);
  const mine = rr.people[String(p.id)];
  const out = new Set<string>();
  for (const d of RIGHTS) {
    let on = roles.some((r) => roleHas(r, d, rr));
    if (!d.locked && mine?.off?.includes(d.id)) on = false;
    else if (!on && mine?.on?.includes(d.id) && personExtraOk(roles, d, rr)) on = true;
    if (on) out.add(d.id);
  }
  for (const id of [...out]) {
    const need = needsPage(BY_ID.get(id)!);
    if (need && !out.has(need)) out.delete(id);
  }
  return out;
}

/**
 * May one person with these roles get this right on top of their roles? What one of their roles normally has but was
 * taken from it, what their roles may get en plus, and the few given to one person whatever the role. Never more.
 */
export function personExtraOk(roles: readonly RightsRole[], d: RightDef, rr: RoleRights): boolean {
  if (d.locked || roles.some((r) => roleHas(r, d, rr))) return false;
  return !!d.person || roles.some((r) => byDefault(r, d) || !!d.extraFor?.includes(r));
}

/** The rights a role has in the boutique (for the editor and « Ce qu'il fait »). */
export function roleRightsSet(role: RightsRole, rr: RoleRights): Set<string> {
  const out = new Set<string>();
  for (const d of RIGHTS) if (roleHas(role, d, rr)) out.add(d.id);
  for (const id of [...out]) {
    const need = needsPage(BY_ID.get(id)!);
    if (need && !out.has(need)) out.delete(id);
  }
  return out;
}

/** A role's counts: pages, tabs, buttons it has out of those it can have, and the « en plus » given. */
export function roleSummary(role: RightsRole, rr: RoleRights) {
  const has = roleRightsSet(role, rr);
  const count = (kind: RightKind) => {
    const all = RIGHTS.filter((d) => d.kind === kind && !d.locked && byDefault(role, d));
    return { on: all.filter((d) => has.has(d.id)).length, of: all.length };
  };
  const extras = RIGHTS.filter((d) => extraOk(role, d));
  return { pages: count('page'), tabs: count('tab'), acts: count('act'), extra: { on: extras.filter((d) => has.has(d.id)).length, of: extras.length } };
}

/**
 * A boutique's saved rights, cleaned: known ids only, a role's `off` only among its defaults, `on` only among its « en
 * plus », a person's `on` only what may be given to them. Duplicates and empty lines go.
 */
export function cleanRoleRights(v: unknown, people?: Map<number, { roles: readonly Role[]; agencyId?: number | null }>): RoleRights {
  const src = (v && typeof v === 'object' ? v : {}) as Partial<RoleRights>;
  const out: RoleRights = { roles: {}, people: {} };
  const list = (x: unknown) => [...new Set((Array.isArray(x) ? x : []).filter((i): i is string => typeof i === 'string' && BY_ID.has(i)))];
  for (const r of RIGHTS_ROLES) {
    const e = (src.roles ?? {})[r];
    if (!e) continue;
    const off = list(e.off).filter((id) => { const d = BY_ID.get(id)!; return !d.locked && byDefault(r, d); });
    const on = list(e.on).filter((id) => extraOk(r, BY_ID.get(id)!));
    if (off.length || on.length) out.roles[r] = { ...(off.length ? { off } : {}), ...(on.length ? { on } : {}) };
  }
  for (const [k, e] of Object.entries(src.people ?? {})) {
    if (!/^\d+$/.test(k) || !e) continue;
    const who = people?.get(Number(k));
    if (people && !who) continue;
    const rs = who ? rightsRolesOf(who) : null;
    // a person's `off` only among what their roles give them; `on` only what may be given to them
    const off = list(e.off).filter((id) => { const d = BY_ID.get(id)!; return !d.locked && (!rs || rs.some((r) => roleHas(r, d, out))); });
    // (without the team at hand, e.g. when read back: kept, and checked against the person's roles when used)
    const on = list(e.on).filter((id) => !off.includes(id) && !BY_ID.get(id)!.locked && (!rs || personExtraOk(rs, BY_ID.get(id)!, out)));
    if (off.length || on.length) out.people[k] = { ...(off.length ? { off } : {}), ...(on.length ? { on } : {}) };
  }
  return out;
}

// ---------------------------------------------------------------- the menu's entries
/**
 * The right that shows a menu line: its page ('page:suivi'), or the tab a line opens (Commandes › Livré:
 * 'tab:commandes/livrees'). null: not a line of the list (a group, one's own pages).
 */
export function menuRight(id: string): string | null {
  const tabOf = TAB_LINES.get(id);
  if (tabOf) return `tab:${tabOf}/${id}`;
  return BY_ID.has(`page:${id}`) ? `page:${id}` : null;
}

/** The old ticks, read once into a boutique's first rights (nothing changes for anybody that day). */
export interface OldTicks {
  changeCompany: { confirmation: boolean; agency: boolean; depot: boolean; manager: boolean };
  rulesBy: { confirmation: boolean; agency: boolean; depot: boolean; manager: boolean };
  people: { id: number; roles: readonly Role[]; agencyId?: number | null; canManageUsers?: boolean; canAssign?: boolean; canAffect?: boolean }[];
}

/**
 * A boutique's first rights, from where they were before: Préférences' two « Qui peut … » (as Pilotix read them for
 * each role, the roles it includes counted: a vendeur was also an agent) and each person's three ticks.
 */
export function rightsFromOldTicks(t: OldTicks): RoleRights {
  const rr: RoleRights = { roles: {}, people: {} };
  const add = (r: RightsRole, k: 'on' | 'off', id: string) => {
    const e = (rr.roles[r] ??= {});
    (e[k] ??= []).push(id);
  };
  // what one person of each role could do before (no « Peut attribuer » tick)
  const before = (r: RightsRole, who: OldTicks['changeCompany']) => {
    const roles = expandRoles([r === 'agence' ? 'confirmation' : (r as Role)]);
    return personIs({ isAdmin: false, roles, profile: { canAssign: false, agencyId: r === 'agence' ? 1 : null } }, who);
  };
  const company = BY_ID.get('act:orders.company')!;
  const rules = BY_ID.get('x:rules')!;
  for (const r of RIGHTS_ROLES) {
    const roles = expandRoles([r === 'agence' ? 'confirmation' : (r as Role)]);
    const could = roles.includes('suivi') || before(r, t.changeCompany);
    if (could && !byDefault(r, company)) add(r, 'on', company.id);
    if (!could && byDefault(r, company)) add(r, 'off', company.id);
    if (before(r, t.rulesBy) && !byDefault(r, rules)) add(r, 'on', rules.id);
  }
  const cc = t.changeCompany;
  const rb = t.rulesBy;
  for (const p of t.people) {
    if (p.roles.includes('admin')) continue;
    const on: string[] = [];
    if (p.canManageUsers) on.push('x:users');
    if (p.canAffect) on.push('x:affect');
    if (p.canAssign) {
      on.push('x:assign');
      // « Peut attribuer » also made a person a manager in Préférences' two « Qui peut … »
      if (cc.manager) on.push('act:orders.company');
      if (rb.manager) on.push('x:rules');
    }
    if (on.length) rr.people[String(p.id)] = { on };
  }
  const known = new Map(t.people.map((p) => [p.id, p] as const));
  return cleanRoleRights(rr, known);
}

/**
 * The right of a page's tab as the app's address names it ('suivi', 'alertes_new' → 'tab:suivi/alertes'), null when
 * that sub-page is not a tab of the list.
 */
export function tabRight(page: string, sub: string | undefined | null): string | null {
  if (!sub) return null;
  const id = `tab:${page}/${menuTabOf(page, sub)}`;
  return BY_ID.has(id) ? id : null;
}
