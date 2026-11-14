// A store's menu, in one list: its pages, its groups and their lines, each page's tabs, who sees what by default, and
// the team screens (Écrans). Everything reads it: the app's menu and its screens dropdown (apps/web/src/layout/nav.ts
// only adds the code of the conditions), the router, the pages' tab bars, Utilisateurs › Rôles (rights.ts builds every
// page and tab right from it) and the server's checks. A page, a tab or a screen added, moved or taken away here
// follows everywhere (packages/core/src/test/menu.test.ts checks that the pieces agree).
//
// roles: null = everyone, [] = administrators only. A role also sees what the roles it includes see (ROLE_INCLUDES).

import type { Role } from './index';

/** Each page's tabs, in order (the pages' tab bars use these lists; their names are in `tabNames`). */
export const MENU_TABS = {
  dashboard: ['overview', 'confirmation', 'depot', 'suivi', 'livreurs', 'sav'],
  commandes: ['tout', 'livrees', 'annulees'],
  confirmation: ['nouvelles', 'attente', 'confirmees', 'terminees'],
  depot: ['preparer', 'prepares', 'dispatchees', 'retours'],
  suivi: ['enlivraison', 'alertes', 'traites', 'bloques', 'livres', 'annules', 'reclamation', 'swap'],
  sav: ['tickets', 'nouveau', 'attente', 'depot', 'livraison', 'livres', 'annules', 'satisfaction', 'stats'],
  produits: ['stock', 'inventaire', 'produits', 'guides', 'mouvements', 'alertes', 'prevision', 'lots', 'fabrication', 'achats', 'depots'],
  pos: ['vendre', 'ventes', 'cloture', 'reglages'],
  marketing: ['publicite', 'strategies', 'formulaires', 'campagnes', 'catalogue', 'marketer'],
  caisse: ['overview', 'due', 'done', 'livreurs', 'journal', 'paie'],
  livraison: ['societes', 'api', 'livreurs'],
  utilisateurs: ['roles', 'admins', 'agents', 'managers'],
  management: ['plans', 'statuts', 'affectation', 'prix', 'canaux', 'alertes', 'livreur', 'modules', 'archive'],
  profil: ['infos', 'parametres', 'parrainage', 'securite'],
} as const;

/** When a line is shown, beyond the roles (the app works them out: apps/web/src/layout/nav.ts). */
export type MenuCond =
  /** Accueil: not for an agent who leads no one (the Dashboard is his home), unless the plan has no Dashboard */
  | 'home'
  /** the livreurs only */
  | 'livreur'
  /** the « Point de vente » module is on (Management › Modules) */
  | 'pos'
  /** not the administrators (their own caisse is « Caisse ») */
  | 'notAdmin'
  /** a store's own space (not a partner's) */
  | 'store'
  /** the partners pages (a multi-shop server, the in-browser demo) */
  | 'partners';

/** A group's line (Commandes › Confirmation…). */
export interface MenuLine {
  id: string;
  href: string;
  /** live count key (useMenuCounts) and its colour */
  count?: string;
  tone?: string;
  /** icon when the sidebar is folded */
  icon?: string;
  /** who sees this line (administrators always); none = everyone who sees the group */
  roles?: Role[];
  /** it is lit on these tabs of a page (the line opens a part of another page) */
  match?: { page: string; subs: string[] };
  /** the plan's menu (and sub-menu) this line belongs to, when its id is not a page of its own (default: its id) */
  plan?: [page: string, sub?: string];
  /** also shown to the people who write the « Pilot Auto Assign » rules */
  rules?: boolean;
  cond?: MenuCond;
  /** the line opens the tab of the same id of this page (Commandes › Livré: #/commandes/livrees): it is that tab */
  tabOf?: string;
}

/** A line of the menu: a page, or a group of lines (Commandes, AI Pilot…). */
export interface MenuItem {
  id: string;
  icon: string;
  roles: Role[] | null;
  /** its tabs (MENU_TABS) */
  subs?: readonly string[];
  /** the tabs drawn with › arrows (a flow) */
  flow?: boolean;
  cond?: MenuCond;
  /** not a line of the menu: a page opened from a group's line or a link */
  hidden?: boolean;
  /** also shown to the people allowed to create accounts and set passwords */
  manageUsers?: boolean;
  /** also shown to the people who write the « Pilot Auto Assign » rules */
  rules?: boolean;
  /** also shown to the people allowed to set the Affectation */
  affect?: boolean;
  /** the group's lines */
  children?: MenuLine[];
  /** pages of the group: it is lit on them */
  pages?: string[];
  /** where the group's line leads (default: its first line) */
  href?: string;
  /** a group that is also a page of its own (Commandes: every order, in its tabs), named `pageName` */
  ownPage?: boolean;
  pageName?: string;
  // ---- the tabs, for the pages' tab bars and Utilisateurs › Rôles
  /** a tab whose default roles are not the page's (the team boards: the owners and the managers) */
  tabRoles?: Record<string, Role[]>;
  /** where the tabs' names are (« suivi.tabs » → suivi.tabs.enlivraison), and the ones named elsewhere */
  tabNames?: { prefix?: string; each?: Record<string, string> };
  /** the address's names of a tab's own parts (#/suivi/alertes_new is the tab « Alertes ») */
  tabAlias?: Record<string, string>;
  /** one's own page (Mon profil, Mes boutiques): not a right of a role */
  personal?: boolean;
}

const AGENTS: Role[] = ['confirmation', 'suivi', 'depot'];
const BOARDS: Role[] = ['vendeur', 'agent_manager'];
const DEPOT: Role[] = ['depot'];

export const STORE_MENU: MenuItem[] = [
  { id: 'accueil', icon: 'home', roles: null, cond: 'home' },
  // everyone: owners and managers see the teams' boards (the tabs), the others their own numbers
  {
    id: 'dashboard',
    icon: 'chart',
    roles: ['agent_manager', 'vendeur', 'confirmation', 'suivi', 'depot', 'livreur'],
    subs: MENU_TABS.dashboard,
    tabRoles: { overview: ['vendeur'], confirmation: BOARDS, depot: BOARDS, suivi: BOARDS, livreurs: BOARDS, sav: BOARDS },
    tabNames: { prefix: 'dashboard.areas' },
  },
  {
    id: 'commandes',
    icon: 'list',
    roles: AGENTS,
    subs: MENU_TABS.commandes,
    href: '#/commandes',
    pages: ['commandes', 'confirmation', 'depot', 'suivi', 'livrees', 'retournees'],
    ownPage: true,
    pageName: 'orders.allOrders',
    tabNames: { each: { tout: 'orders.tabs.all', livrees: 'nav.sub.livrees', annulees: 'nav.sub.annulees' } },
    children: [
      { id: 'confirmation', href: '#/confirmation', count: 'conf', tone: 'nc-n', icon: 'phone', roles: ['confirmation'] },
      { id: 'depot', href: '#/depot', count: 'depot', tone: 'nc-a', icon: 'package', roles: ['depot'] },
      { id: 'suivi', href: '#/suivi', count: 'suivi', tone: 'nc-a', icon: 'route', roles: ['suivi', 'confirmation'] },
      // these two lines open Commandes' tabs
      { id: 'livrees', href: '#/commandes/livrees', count: 'delivered', tone: 'nc-c', icon: 'checkcircle', tabOf: 'commandes' },
      { id: 'annulees', href: '#/commandes/annulees', count: 'cancelled', tone: '', icon: 'xcircle', tabOf: 'commandes' },
    ],
  },
  { id: 'confirmation', icon: 'phone', roles: ['confirmation'], subs: MENU_TABS.confirmation, flow: true, hidden: true, tabNames: { prefix: 'confirmation.sub' } },
  { id: 'depot', icon: 'package', roles: DEPOT, subs: MENU_TABS.depot, flow: true, hidden: true, tabNames: { prefix: 'depot.stage' } },
  { id: 'suivi', icon: 'route', roles: ['suivi', 'confirmation'], subs: MENU_TABS.suivi, hidden: true, tabNames: { prefix: 'suivi.tabs' }, tabAlias: { alertes_new: 'alertes', alertes_encours: 'alertes' } },
  { id: 'scanner', icon: 'scanbar', roles: DEPOT },
  { id: 'sav', icon: 'headset', roles: AGENTS, subs: MENU_TABS.sav, tabNames: { prefix: 'sav.views' } },
  { id: 'tournee', icon: 'navigation', roles: ['livreur'], cond: 'livreur' },
  // the agents see the products, the sales guides and the stock; the depot every tab
  {
    id: 'produits',
    icon: 'layers',
    roles: ['depot', 'confirmation', 'suivi'],
    subs: MENU_TABS.produits,
    tabRoles: { inventaire: DEPOT, mouvements: DEPOT, alertes: DEPOT, prevision: DEPOT, lots: DEPOT, fabrication: DEPOT, achats: DEPOT, depots: DEPOT },
    tabNames: { prefix: 'produits.tabs' },
    // Produits › Prix: the products' prices, a part of the « Produits » tab
    tabAlias: { prix: 'produits' },
  },
  // Point de vente: the boutique's counter, once an administrator turns it on (Management › Modules)
  { id: 'pos', icon: 'store', roles: DEPOT, subs: MENU_TABS.pos, cond: 'pos', tabRoles: { reglages: ['vendeur'] }, tabNames: { prefix: 'pos.tabs' } },
  // AI Pilot: the AI agents (the owner, the marketers; not the confirmation agents and their supervisors)
  {
    id: 'pilotai',
    icon: 'sparkles',
    roles: ['vendeur', 'marketer'],
    pages: ['messages', 'social', 'createur', 'cm', 'spy', 'comptes'],
    children: [
      { id: 'messages', href: '#/messages', count: 'msgs', tone: 'nc-a', icon: 'chat', roles: ['vendeur'] },
      { id: 'social', href: '#/social', count: 'posts', tone: 'nc-a', icon: 'calendar', roles: ['marketer'] },
      { id: 'createur', href: '#/createur', icon: 'film', roles: ['marketer'] },
      { id: 'cm', href: '#/cm', count: 'cm', tone: 'nc-a', icon: 'comments', roles: ['marketer'] },
      { id: 'spy', href: '#/spy', icon: 'eye', roles: ['marketer'] },
      { id: 'comptes', href: '#/comptes', icon: 'link', roles: [] },
    ],
  },
  { id: 'messages', icon: 'chat', roles: ['vendeur'], hidden: true },
  { id: 'cm', icon: 'comments', roles: ['marketer'], hidden: true },
  { id: 'social', icon: 'calendar', roles: ['marketer'], hidden: true },
  { id: 'createur', icon: 'film', roles: ['marketer'], hidden: true },
  { id: 'spy', icon: 'eye', roles: ['marketer'], hidden: true },
  { id: 'comptes', icon: 'link', roles: [], hidden: true },
  // Pilot Automations: the parts of pages/notify — the automations and their rules (administrators; the rules also for
  // the people who write them), the delivery messages (the suivi agents) and their settings
  {
    id: 'notify',
    icon: 'zap',
    roles: ['suivi'],
    rules: true,
    pages: ['notify'],
    children: [
      { id: 'auto', href: '#/notify/auto', icon: 'zap', roles: [], plan: ['notify'], match: { page: 'notify', subs: ['auto'] } },
      { id: 'assign', href: '#/notify/assign', icon: 'truck', roles: [], rules: true, plan: ['notify'], match: { page: 'notify', subs: ['assign'] } },
      { id: 'affectation', href: '#/notify/affectation', icon: 'users', roles: [], plan: ['notify'], match: { page: 'notify', subs: ['affectation'] } },
      { id: 'automessages', href: '#/notify/messages', count: 'notify', tone: 'nc-a', icon: 'send', roles: ['suivi'], plan: ['notify'], match: { page: 'notify', subs: ['messages', 'cas', 'tester', 'resultats'] } },
      { id: 'autoreglages', href: '#/notify/reglages', icon: 'settings', roles: [], plan: ['notify'], match: { page: 'notify', subs: ['reglages'] } },
    ],
  },
  // Referral (the store's administrators) and « Code promo » (the welcome codes of the « Awareness » posts and ads)
  {
    id: 'referral',
    icon: 'gift',
    roles: ['marketer', 'vendeur'],
    pages: ['parrainage'],
    href: '#/parrainage',
    children: [
      { id: 'parrainage', href: '#/parrainage', icon: 'gift', roles: [], cond: 'store', match: { page: 'parrainage', subs: ['', 'amis'] } },
      { id: 'codepromo', href: '#/parrainage/codes', icon: 'tag', roles: ['marketer', 'vendeur'], plan: ['parrainage'], match: { page: 'parrainage', subs: ['codes'] } },
    ],
  },
  { id: 'parrainage', icon: 'gift', roles: ['marketer', 'vendeur'], hidden: true },
  // the customers: the suivi agents
  { id: 'clients', icon: 'users', roles: ['suivi'] },
  { id: 'marketing', icon: 'megaphone', roles: ['marketer'], subs: MENU_TABS.marketing, tabNames: { prefix: 'nav' } },
  { id: 'landing', icon: 'globe', roles: ['marketer'] },
  { id: 'caisse', icon: 'wallet', roles: [], subs: MENU_TABS.caisse },
  // an employee's own caisse
  { id: 'macaisse', icon: 'wallet', roles: ['confirmation', 'suivi', 'depot', 'agent_manager'], cond: 'notAdmin' },
  // Partenaires: couriers, the store's livreurs, confirmation agencies, marketers (administrators), influenceurs
  {
    id: 'partenaires',
    icon: 'handshake',
    roles: ['marketer'],
    pages: ['livraison', 'agences', 'marketers', 'influenceurs'],
    children: [
      { id: 'livraison', href: '#/livraison/societes', icon: 'truck', roles: [], plan: ['livraison'], match: { page: 'livraison', subs: ['', 'societes', 'api'] } },
      { id: 'livreurs', href: '#/livraison/livreurs', icon: 'navigation', roles: [], plan: ['livraison', 'livreurs'], match: { page: 'livraison', subs: ['livreurs'] } },
      { id: 'agences', href: '#/agences', icon: 'handshake', roles: [], cond: 'partners' },
      { id: 'marketers', href: '#/marketers', icon: 'trend', roles: [], cond: 'partners' },
      { id: 'influenceurs', href: '#/influenceurs', icon: 'camera', roles: ['marketer'] },
    ],
  },
  { id: 'livraison', icon: 'truck', roles: [], subs: MENU_TABS.livraison, hidden: true },
  { id: 'influenceurs', icon: 'camera', roles: ['marketer'], hidden: true },
  { id: 'utilisateurs', icon: 'usercog', roles: [], manageUsers: true, subs: MENU_TABS.utilisateurs },
  { id: 'agences', icon: 'handshake', roles: [], cond: 'partners', hidden: true },
  { id: 'marketers', icon: 'trend', roles: [], cond: 'partners', hidden: true },
  { id: 'management', icon: 'briefcase', roles: [], affect: true, subs: MENU_TABS.management },
  { id: 'reglages', icon: 'settings', roles: [] },
  { id: 'aide', icon: 'help', roles: null },
  { id: 'profil', icon: 'usercog', roles: null, hidden: true, subs: MENU_TABS.profil, personal: true },
  { id: 'boutiques', icon: 'store', roles: null, hidden: true, personal: true },
];

// ---------------------------------------------------------------- the team screens (Écrans)
/**
 * The store's menu split into one screen per team, picked in a dropdown at the top of the menu (with each screen's red
 * counts). A screen lists the menu items and group lines it shows (by id); « Ancien menu » (all) shows everything. The
 * pages and their links do not change: a screen only chooses which menu lines are shown.
 */
export type SpaceId = 'all' | 'marketing' | 'sponsor' | 'cm' | 'service' | 'depot' | 'finance' | 'admin';
export interface Space {
  id: SpaceId;
  icon: string;
  /** menu items (top level) and group lines (by id) shown on this screen */
  items: string[];
  /** menu counts (useMenuCounts keys) summed in the dropdown's red badge */
  counts: string[];
}
/** always shown, whatever the screen */
export const SPACE_ALWAYS = ['accueil', 'aide'];
export const SPACES: Space[] = [
  { id: 'marketing', icon: 'megaphone', items: ['marketing', 'createur', 'social', 'influenceurs', 'parrainage', 'codepromo'], counts: ['posts'] },
  { id: 'sponsor', icon: 'trend', items: ['marketing', 'landing', 'spy'], counts: ['landing'] },
  { id: 'cm', icon: 'chat', items: ['messages', 'cm', 'codepromo'], counts: ['msgs', 'cm'] },
  { id: 'service', icon: 'phone', items: ['dashboard', 'confirmation', 'suivi', 'livrees', 'annulees', 'sav', 'auto', 'assign', 'affectation', 'automessages', 'autoreglages', 'clients', 'codepromo'], counts: ['conf', 'suivi', 'sav', 'notify'] },
  { id: 'depot', icon: 'package', items: ['dashboard', 'depot', 'scanner', 'produits', 'pos', 'tournee', 'livreurs'], counts: ['depot', 'lowStock'] },
  { id: 'finance', icon: 'wallet', items: ['caisse', 'macaisse'], counts: [] },
  { id: 'admin', icon: 'usercog', items: ['utilisateurs', 'management', 'reglages', 'livraison', 'agences', 'marketers', 'comptes'], counts: [] },
];
/** Is this menu item or group line on the screen? */
export const onSpace = (space: SpaceId, id: string): boolean => {
  if (space === 'all' || SPACE_ALWAYS.includes(id)) return true;
  return !!SPACES.find((s) => s.id === space)?.items.includes(id);
};

// ---------------------------------------------------------------- reading the list
/** The menu's item of a page (its own line, or the hidden page a group's line opens). */
export const menuItem = (id: string) => STORE_MENU.find((n) => n.id === id);
/** A group's line, and its group. */
export function menuLine(id: string): { line: MenuLine; group: MenuItem } | null {
  for (const g of STORE_MENU) for (const c of g.children ?? []) if (c.id === id) return { line: c, group: g };
  return null;
}
/** The screens a page or a line is on (a group's own page: the screens of its lines). */
export function screensOf(id: string): SpaceId[] {
  const direct = SPACES.filter((s) => s.items.includes(id)).map((s) => s.id);
  if (direct.length) return direct;
  const g = menuItem(id);
  if (g?.children) return SPACES.filter((s) => g.children!.some((c) => s.items.includes(c.id))).map((s) => s.id);
  return [];
}

// ---------------------------------------------------------------- the menu's pages, in order (Utilisateurs › Rôles)
export interface MenuTab {
  id: string;
  /** i18n key of its name, as the page's tab bar writes it */
  label: string;
  /** who sees it by default */
  roles: Role[] | null;
}
export interface MenuPage {
  /** the page's id (for a group's line, the line's: 'automessages') */
  id: string;
  /** the menu group it sits in (Commandes, AI Pilot…), null for a line of its own */
  group: string | null;
  icon: string;
  /** who sees it by default: null everyone, [] the administrators only */
  roles: Role[] | null;
  /** i18n key of its name, as the menu writes it */
  label: string;
  /** its tabs (none for an administrators' page, or one whose parts are the group's lines) */
  tabs: MenuTab[];
  /** everyone's, always there (Accueil, Aide) */
  always: boolean;
  /** the team screens it is on (a group's own page: its lines' screens) */
  screens: SpaceId[];
}

/** The ids of the groups' lines (a hidden page of the same id is the page the line opens). */
const LINE_IDS = new Set(STORE_MENU.flatMap((n) => (n.children ?? []).map((c) => c.id)));
/** Pages whose parts are the lines of a group (Pilot Automations', Referral's, Partenaires'): no tabs of their own. */
const SPLIT = new Set(STORE_MENU.flatMap((n) => n.children ?? []).map((c) => c.match?.page).filter((p): p is string => !!p));

/** The i18n key of a tab's name. */
export function menuTabLabel(item: MenuItem, tab: string): string {
  return item.tabNames?.each?.[tab] ?? `${item.tabNames?.prefix ?? `${item.id}.tabs`}.${tab}`;
}

function tabsFor(item: MenuItem | undefined, roles: Role[] | null): MenuTab[] {
  if (!item?.subs || (roles && !roles.length) || SPLIT.has(item.id)) return [];
  return item.subs.map((t) => ({ id: t, label: menuTabLabel(item, t), roles: item.tabRoles?.[t] ?? roles }));
}

function pagesOfMenu(): MenuPage[] {
  const out: MenuPage[] = [];
  const add = (id: string, group: string | null, icon: string, roles: Role[] | null, label: string, item: MenuItem | undefined) => {
    if (out.some((p) => p.id === id)) return;
    out.push({ id, group, icon, roles, label, tabs: tabsFor(item, roles), always: roles === null, screens: screensOf(id) });
  };
  for (const n of STORE_MENU) {
    if (n.personal) continue;
    if (n.children) {
      if (n.ownPage) add(n.id, n.id, n.icon, n.roles, n.pageName ?? `nav.${n.id}`, n);
      for (const c of n.children) if (!c.tabOf) add(c.id, n.id, c.icon ?? n.icon, c.roles ?? n.roles, `nav.sub.${c.id}`, menuItem(c.id));
    } else if (!LINE_IDS.has(n.id)) add(n.id, null, n.icon, n.roles, `nav.${n.id}`, n);
  }
  return out;
}

/** Every page of the store's menu, in the menu's order: a group's lines under it, the pages they open with them. */
export const MENU_PAGES: readonly MenuPage[] = pagesOfMenu();

/** The menu's lines that are a page's tab (Commandes › Livré): line id → the tab's page. */
export const TAB_LINES: ReadonlyMap<string, string> = new Map(STORE_MENU.flatMap((n) => n.children ?? []).filter((c) => c.tabOf).map((c) => [c.id, c.tabOf!] as const));

/** A tab as the app's address names it ('suivi', 'alertes_new' → 'alertes'). */
export const menuTabOf = (page: string, sub: string) => menuItem(page)?.tabAlias?.[sub] ?? sub;
/** The i18n key of a page's tab name ('sav', 'stats' → 'sav.views.stats'), for the page's tab bar. */
export function menuTabName(page: string, tab: string): string {
  const item = menuItem(page);
  return item ? menuTabLabel(item, tab) : `${page}.tabs.${tab}`;
}
