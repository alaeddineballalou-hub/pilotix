import { type MenuCond, menuRight, onSpace, type Role, SPACE_ALWAYS, SPACES, type SpaceId, STORE_MENU } from '@pilotix/shared';
import { backend } from '../lib/backend';
import { currentShop, pageIsOn } from '../lib/features';
import { moduleOn } from '../lib/modules';
import { rightOn } from '../lib/rights';

/**
 * The menu, as in the original Pilotix (final layout): sub-pages appear as a stage bar inside the page,
 * except the groups ("Commandes", "Pilot AI") whose children stay in the menu with their counts.
 * roles: null = everyone, [] = admin only. A store's menu is the shared list (STORE_MENU); a partner's spaces are below.
 */
export interface NavChild {
  id: string;
  href: string;
  /** live count key (useMenuCounts) and its colour */
  count?: string;
  tone?: string;
  /** icon when the sidebar is folded */
  icon?: string;
  /** who sees this child (admins always); none = everyone who sees the group */
  roles?: Role[];
  /** it is lit on these tabs of a page (an agency's « En livraison » / « Suivi » / « Livré » / « Annulé »: Suivi's tabs) */
  match?: { page: string; subs: string[] };
  /** the plan's menu (and sub-menu) this child belongs to, when its id is not a page of its own (default: its id) */
  plan?: [page: string, sub?: string];
  /** also shown to the people who write the « Pilot Auto Assign » rules (Utilisateurs › Rôles) */
  rules?: boolean;
  /** only shown when this returns true (session roles) */
  onlyIf?: (roles: Role[], isAdmin: boolean) => boolean;
  /** the line opens the tab of the same id of this page (Commandes › Livré) */
  tabOf?: string;
}

export interface NavItem {
  id: string;
  icon: string;
  roles: Role[] | null;
  /** the page's tabs (its first one opens when the address names none) */
  subs?: readonly string[];
  /** stage bar drawn with › arrows (a flow) instead of tabs */
  flow?: boolean;
  /** only shown when this returns true (session roles) */
  onlyIf?: (roles: Role[], isAdmin: boolean) => boolean;
  hidden?: boolean;
  /** also shown to people the administrator allowed to create accounts and set passwords */
  manageUsers?: boolean;
  /** also shown to the people who write the « Pilot Auto Assign » rules (ticked in Utilisateurs) */
  rules?: boolean;
  /** also shown to the people the administrator lets set the Affectation automatique */
  affect?: boolean;
  /** menu children: the item is a group (Commandes, Pilot AI) */
  children?: NavChild[];
  /** pages of the group: it is highlighted on them, and shows its bar under the header when the sidebar is folded */
  pages?: string[];
  /** where the group's line leads when the sidebar is folded (default: its first child) */
  href?: string;
  /** a group that is also a page of its own (Commandes) */
  ownPage?: boolean;
  pageName?: string;
  tabRoles?: Record<string, Role[]>;
  tabNames?: { prefix?: string; each?: Record<string, string> };
  tabAlias?: Record<string, string>;
  personal?: boolean;
}

/**
 * An agent who leads no one (confirmation, suivi, dépôt — not an administrator, a vendeur or an agent manager): he has no
 * Accueil, his Dashboard is his home (his Co-Pilot folded, what waits now, his numbers next to his team's, with his rank).
 */
export function isPlainAgent(roles: Role[], isAdmin: boolean): boolean {
  return !isAdmin && roles.some((r) => r === 'confirmation' || r === 'suivi' || r === 'depot') && !roles.some((r) => r === 'agent_manager' || r === 'vendeur');
}

/** When a line is shown, beyond its roles (the store's menu says which: packages/shared/src/menu.ts). */
const COND: Record<MenuCond, (roles: Role[], isAdmin: boolean) => boolean> = {
  home: (r, admin) => !isPlainAgent(r, admin) || !pageIsOn('dashboard'),
  livreur: (r) => r.includes('livreur'),
  pos: () => moduleOn('pos'),
  notAdmin: (_r, admin) => !admin,
  store: () => storeOnly(),
  partners: () => partnersOn(),
};

/**
 * A store's menu: the shared list (packages/shared/src/menu.ts: its pages, groups, tabs, team screens), the same one
 * Utilisateurs › Rôles and the server read.
 */
export const NAV: NavItem[] = STORE_MENU.map(({ cond, children, ...n }) => ({
  ...n,
  ...(cond ? { onlyIf: COND[cond] } : {}),
  ...(children ? { children: children.map(({ cond: c, ...ch }) => ({ ...ch, ...(c ? { onlyIf: COND[c] } : {}) })) } : {}),
}));

/**
 * A group's child: its own roles (or the people who write the Pilot rules), or everyone who sees the group — left to
 * their role in Utilisateurs › Rôles — and in the shop's plan.
 */
export const canSeeChild = (c: NavChild, roles: Role[], isAdmin: boolean, canRules = false, has: (right: string | null) => boolean = rightOn) =>
  ((isAdmin || ((!c.roles || c.roles.some((r) => roles.includes(r))) && has(menuRight(c.id)))) || (!!c.rules && canRules)) &&
  (c.plan ? pageIsOn(...c.plan) : pageIsOn(c.id)) &&
  (!c.onlyIf || c.onlyIf(roles, isAdmin));

/**
 * The store's pages opened by a group's lines (Pilot Automations' tabs, Referral's, Partenaires'): the line's own right
 * decides, not the page's (the rights are a store's: a partner's space has none).
 */
const BY_LINES = new Set(NAV.flatMap((n) => n.children ?? []).map((c) => c.match?.page).filter((p): p is string => !!p));

/** (`has`: the person's rights, theirs by default; Utilisateurs › Rôles passes a role's to show its menu) */
export function canSee(item: NavItem, roles: Role[], isAdmin: boolean, canManageUsers = false, canRules = false, canAffect = false, has: (right: string | null) => boolean = rightOn): boolean {
  // a menu the shop's plan does not include is not shown to anyone, administrators included
  if (!pageIsOn(item.id)) return false;
  if (item.onlyIf && !item.onlyIf(roles, isAdmin)) return false;
  if (item.manageUsers && canManageUsers) return true;
  if (item.rules && canRules) return true;
  // Management, for the people the administrator lets set the Affectation (that page only)
  if (item.affect && canAffect) return true;
  if (item.roles === null || isAdmin) return true;
  if (!item.roles.some((r) => roles.includes(r))) return false;
  // Utilisateurs › Rôles: a page taken from the role (a group shows while one of its lines does)
  return !!item.children || BY_LINES.has(item.id) || has(menuRight(item.id));
}

/**
 * What a menu shows a person: its lines (a group: the lines it shows), and in a store the team screens (Écrans) they have,
 * with the one picked (« Ancien menu » when it is not one of theirs). The app's menu (Shell) and the role's menu in
 * Utilisateurs › Rôles both use it, so the two never differ.
 */
export function menuView(nav: NavItem[], see: { item: (n: NavItem) => boolean; line: (c: NavChild) => boolean }, picked: SpaceId, withScreens: boolean) {
  const kids = (n: NavItem) => (n.children ?? []).filter(see.line);
  // a group whose lines are all hidden (or out of the shop's plan) is not shown
  const all = nav.filter((n) => !n.hidden && see.item(n) && (!n.children || kids(n).length > 0));
  const onLine = (s: SpaceId, n: NavItem) => (n.children ? kids(n).some((c) => onSpace(s, c.id)) : onSpace(s, n.id));
  const screens = withScreens ? SPACES.filter((s) => all.some((n) => !SPACE_ALWAYS.includes(n.id) && onLine(s.id, n))) : [];
  const screen: SpaceId = screens.length > 1 && screens.some((s) => s.id === picked) ? picked : 'all';
  return { kids, screens, screen, items: all.filter((n) => onLine(screen, n)), kidsOn: (n: NavItem) => kids(n).filter((c) => onSpace(screen, c.id)) };
}

/** The group's line that opens this page and tab (#/notify/messages: « Messages »), if one does. */
export function lineFor(nav: NavItem[], page: string, sub: string | undefined): NavChild | null {
  for (const n of nav) for (const c of n.children ?? []) if (c.match?.page === page && c.match.subs.includes(sub ?? '')) return c;
  return null;
}

/** Where a user lands when the address doesn't match a page they can see. */
export function homeFor(roles: Role[], isAdmin: boolean): string {
  const on = (page: string) => pageIsOn(page) && rightOn(menuRight(page));
  if (!isAdmin && roles.includes('livreur') && !roles.some((r) => ['confirmation', 'suivi', 'depot'].includes(r)) && on('tournee')) return 'tournee';
  if (!isAdmin && roles.includes('confirmation') && !roles.includes('vendeur') && roles.length === 1 && on('confirmation')) return 'confirmation';
  if (isPlainAgent(roles, isAdmin) && on('dashboard')) return 'dashboard';
  return 'accueil';
}

// ---------------------------------------------------------------- a confirmation agency's own space
/**
 * The menu of a confirmation agency: like a store's (Accueil, Commandes › Confirmation / Suivi, Utilisateurs,
 * Réglages), on its sellers' orders (the seller picker at the top of the page), plus its sellers and its bills.
 */
/**
 * The store's « Agences » and « Marketers »: on a multi-shop server (not in its shared demo shop, whose accounts every
 * visitor uses), and in the in-browser demo (its own agency and marketer are made there).
 */
/** A store's own space (not a confirmation agency's or a marketer's). */
function storeOnly(): boolean {
  const s = currentShop();
  return !s?.kind || s.kind === 'store';
}

function partnersOn(): boolean {
  const s = currentShop();
  return s ? !s.demo : backend.kind === 'demo';
}

export const AGENCY_NAV: NavItem[] = [
  // an agent of the agency has no Accueil: the Dashboard is his home (what waits, his numbers and rank, his bonuses)
  { id: 'accueil', icon: 'home', roles: null, onlyIf: (r, admin) => !isPlainAgent(r, admin) },
  // the results over a period per seller, product, wilaya and agent (the chief and the agent managers)
  { id: 'analyse', icon: 'trend', roles: ['agent_manager'] },
  // what waits now and the period's numbers: the team for the chief and the managers, an agent his own
  { id: 'dashboard', icon: 'chart', roles: null },
  {
    id: 'commandes',
    icon: 'list',
    roles: ['confirmation', 'suivi', 'agent_manager'],
    pages: ['confirmation', 'suivi'],
    children: [
      // the parcel's way: confirmed → on the road with no problem → an alert (new, in progress, handled) → delivered → cancelled
      // a confirmation agent (or agency): Confirmation, En livraison, Livré, Annulé — to watch its orders move, no alert,
      // no claim, no swap; a suivi agent: En livraison → Annulé, no Confirmation; both: everything
      // (and swapped to another customer); the claims with the companies are in Alertes
      { id: 'confirmation', href: '#/confirmation', count: 'conf', tone: 'nc-n', icon: 'phone', roles: ['confirmation', 'agent_manager'] },
      { id: 'enlivraison', href: '#/suivi/enlivraison', icon: 'truck', roles: ['suivi', 'confirmation', 'agent_manager'], match: { page: 'suivi', subs: ['enlivraison', 'bloques'] } },
      { id: 'alertes', href: '#/suivi/alertes_new', count: 'suivi', tone: 'nc-a', icon: 'alert', roles: ['suivi', 'confirmation', 'agent_manager'], match: { page: 'suivi', subs: ['alertes', 'alertes_new', 'alertes_encours', 'traites', 'reclamation'] } },
      { id: 'livrees', href: '#/suivi/livres', icon: 'checkcircle', roles: ['suivi', 'confirmation', 'agent_manager'], match: { page: 'suivi', subs: ['livres'] } },
      { id: 'annulees', href: '#/suivi/annules', icon: 'xcircle', roles: ['suivi', 'confirmation', 'agent_manager'], match: { page: 'suivi', subs: ['annules', 'swap'] } },
    ],
  },
  { id: 'confirmation', icon: 'phone', roles: ['confirmation', 'agent_manager'], subs: ['nouvelles', 'attente', 'confirmees'], flow: true, hidden: true },
  { id: 'suivi', icon: 'route', roles: ['suivi', 'confirmation', 'agent_manager'], subs: ['enlivraison', 'alertes', 'traites', 'bloques', 'livres', 'annules'], hidden: true },
  { id: 'produits', icon: 'layers', roles: ['confirmation', 'suivi', 'agent_manager'], subs: ['produits', 'stock'] },
  // « Mes gains »: what the agency owes me (my orders in every seller's store), my plans, my acomptes
  { id: 'gains', icon: 'wallet', roles: ['confirmation', 'suivi', 'agent_manager'], onlyIf: (_r, admin) => !admin },
  // sorted by who: « Équipe » = the agency's people (accounts, who gets which order, pay, scores); « Vendeurs » = its
  // sellers (the list, their plans and prices, the bills)
  {
    id: 'equipe',
    icon: 'users',
    roles: [],
    manageUsers: true,
    pages: ['equipe'],
    href: '#/equipe/personnes',
    children: [
      // the accounts (a person allowed to add accounts sees this one only), who gets which order, the pay
      { id: 'eq-users', href: '#/equipe/personnes', icon: 'usercog', plan: ['equipe'], match: { page: 'equipe', subs: ['personnes', ''] } },
      { id: 'eq-affect', href: '#/equipe/repartition', icon: 'route', roles: [], plan: ['equipe'], match: { page: 'equipe', subs: ['repartition'] } },
      { id: 'eq-paie', href: '#/equipe/paie', icon: 'wallet', roles: [], plan: ['equipe'], match: { page: 'equipe', subs: ['paie'] } },
    ],
  },
  { id: 'vendeurs', icon: 'store', roles: [] },
  { id: 'reglages', icon: 'settings', roles: [] },
  // « Aide »: the same films as a store's (its agents send the photos too)
  { id: 'aide', icon: 'help', roles: null },
  { id: 'profil', icon: 'usercog', roles: null, hidden: true, subs: ['infos', 'parametres', 'securite'] },
  { id: 'boutiques', icon: 'store', roles: null, hidden: true },
];

// ---------------------------------------------------------------- a marketer's own space
/**
 * The menu of a marketer (who runs the ads of the stores it works for): like a store's Marketing (Publicité, its ad
 * sets), on its sellers' ads (the seller picker at the top of the page), plus its sellers, its bills, its team and its
 * settings.
 */
export const MARKETER_NAV: NavItem[] = [
  { id: 'accueil', icon: 'home', roles: null },
  { id: 'marketing', icon: 'megaphone', roles: ['marketer'], subs: ['publicite', 'strategies', 'marketer'] },
  { id: 'vendeurs', icon: 'store', roles: [] },
  { id: 'facturation', icon: 'receipt', roles: [] },
  { id: 'comptepro', icon: 'medal', roles: [] },
  { id: 'utilisateurs', icon: 'usercog', roles: [], manageUsers: true },
  { id: 'reglages', icon: 'settings', roles: [] },
  { id: 'profil', icon: 'usercog', roles: null, hidden: true, subs: ['infos', 'parametres', 'securite'] },
  { id: 'boutiques', icon: 'store', roles: null, hidden: true },
];

// ---------------------------------------------------------------- a store's team screens (Écrans)
// (in the shared menu list, with the pages: packages/shared/src/menu.ts)
export { onSpace, SPACE_ALWAYS, SPACES, type Space, type SpaceId } from '@pilotix/shared';
