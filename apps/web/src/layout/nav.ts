import type { Role } from '@pilotix/shared';
import { backend } from '../lib/backend';
import { currentShop, pageIsOn } from '../lib/features';

/**
 * The menu, as in the original Pilotix (final layout): sub-pages appear as a stage bar inside the page,
 * except the groups ("Commandes", "Pilot AI") whose children stay in the menu with their counts.
 * roles: null = everyone, [] = admin only.
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
  /** also shown to the people who write the « Pilot Auto Assign » rules (ticked in Préférences) */
  rules?: boolean;
  /** only shown when this returns true */
  onlyIf?: () => boolean;
}

export interface NavItem {
  id: string;
  icon: string;
  roles: Role[] | null;
  /** sub-pages shown in the stage bar (key, label key in nav.json) */
  subs?: string[];
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
}

export const NAV: NavItem[] = [
  { id: 'accueil', icon: 'home', roles: null },
  // everyone: owners and managers see the teams' boards, the others their own numbers (Mine.tsx)
  { id: 'dashboard', icon: 'chart', roles: ['agent_manager', 'vendeur', 'confirmation', 'suivi', 'depot', 'livreur'], subs: ['overview', 'confirmation', 'depot', 'suivi', 'livreurs', 'sav'] },
  {
    id: 'commandes',
    icon: 'list',
    roles: ['confirmation', 'suivi', 'depot'],
    subs: ['tout', 'livrees', 'annulees'],
    href: '#/commandes',
    pages: ['commandes', 'confirmation', 'depot', 'suivi', 'livrees', 'retournees'],
    children: [
      { id: 'confirmation', href: '#/confirmation', count: 'conf', tone: 'nc-n', icon: 'phone', roles: ['confirmation'] },
      { id: 'depot', href: '#/depot', count: 'depot', tone: 'nc-a', icon: 'package', roles: ['depot'] },
      { id: 'suivi', href: '#/suivi', count: 'suivi', tone: 'nc-a', icon: 'route', roles: ['suivi', 'confirmation'] },
      { id: 'livrees', href: '#/commandes/livrees', count: 'delivered', tone: 'nc-c', icon: 'checkcircle' },
      { id: 'annulees', href: '#/commandes/annulees', count: 'cancelled', tone: '', icon: 'xcircle' },
    ],
  },
  { id: 'confirmation', icon: 'phone', roles: ['confirmation'], subs: ['nouvelles', 'attente', 'confirmees', 'terminees'], flow: true, hidden: true },
  { id: 'depot', icon: 'package', roles: ['depot'], subs: ['preparer', 'prepares', 'dispatchees', 'retours'], flow: true, hidden: true },
  { id: 'suivi', icon: 'route', roles: ['suivi', 'confirmation'], subs: ['enlivraison', 'alertes', 'traites', 'bloques', 'livres', 'annules', 'reclamation', 'swap'], hidden: true },
  { id: 'scanner', icon: 'scanbar', roles: ['depot'] },
  { id: 'sav', icon: 'headset', roles: ['confirmation', 'suivi', 'depot'], subs: ['tickets', 'nouveau', 'attente', 'depot', 'livraison', 'livres', 'annules', 'stats'] },
  { id: 'tournee', icon: 'navigation', roles: ['livreur'], onlyIf: (r) => r.includes('livreur') },
  { id: 'produits', icon: 'layers', roles: ['depot', 'confirmation', 'suivi'], subs: ['stock', 'inventaire', 'produits', 'guides', 'mouvements', 'alertes', 'achats', 'depots'] },
  // AI Pilot: the AI agents. Pilot Message (Dellal) sells in the inbox, Pilot Content plans the posts and publishes them,
  // Pilot Comments answers the comments; Comptes: the Facebook and TikTok accounts they use (an administrator links
  // them, pages/comptes).
  {
    id: 'pilotai',
    icon: 'sparkles',
    roles: ['confirmation', 'marketer'],
    pages: ['messages', 'social', 'cm', 'comptes'],
    children: [
      { id: 'messages', href: '#/messages', count: 'msgs', tone: 'nc-a', icon: 'chat', roles: ['confirmation'] },
      { id: 'social', href: '#/social', icon: 'calendar', roles: ['marketer'] },
      { id: 'cm', href: '#/cm', count: 'cm', tone: 'nc-a', icon: 'comments', roles: ['confirmation', 'marketer'] },
      { id: 'comptes', href: '#/comptes', icon: 'link', roles: [] },
    ],
  },
  { id: 'messages', icon: 'chat', roles: ['confirmation'], hidden: true },
  { id: 'cm', icon: 'comments', roles: ['confirmation', 'marketer'], hidden: true },
  { id: 'social', icon: 'calendar', roles: ['marketer'], hidden: true },
  { id: 'comptes', icon: 'link', roles: [], hidden: true },
  // Pilot Automations: what Pilotix does by itself, a group of its own whose lines are the parts of pages/notify — the
  // automations (Automatisations, Auto Pilot Affectation: admins; Auto Pilot Assign, with the Pilot Auto Assign rules and
  // the Préférences: admins, and the rules alone for the people who write them), the delivery messages each customer gets
  // (Messages, its Cas, Tester and Résultats tabs inside: WhatsApp, SMS) and their Réglages (admins)
  {
    id: 'notify',
    icon: 'zap',
    roles: ['confirmation', 'suivi'],
    rules: true,
    pages: ['notify'],
    children: [
      { id: 'auto', href: '#/notify/auto', icon: 'zap', roles: [], plan: ['notify'], match: { page: 'notify', subs: ['auto'] } },
      { id: 'assign', href: '#/notify/assign', icon: 'truck', roles: [], rules: true, plan: ['notify'], match: { page: 'notify', subs: ['assign'] } },
      { id: 'affectation', href: '#/notify/affectation', icon: 'users', roles: [], plan: ['notify'], match: { page: 'notify', subs: ['affectation'] } },
      { id: 'automessages', href: '#/notify/messages', count: 'notify', tone: 'nc-a', icon: 'send', roles: ['confirmation', 'suivi'], plan: ['notify'], match: { page: 'notify', subs: ['messages', 'cas', 'tester', 'resultats'] } },
      { id: 'autoreglages', href: '#/notify/reglages', icon: 'settings', roles: [], plan: ['notify'], match: { page: 'notify', subs: ['reglages'] } },
    ],
  },
  { id: 'clients', icon: 'users', roles: ['confirmation', 'suivi'] },
  // Publicité (Meta spend face to the orders), Formulaires (the ads' lead forms become orders), Campagnes (WhatsApp offers
  // to the customers who said yes), Marketer (paying marketers), AI Spy (competitors' ads in Algeria)
  { id: 'marketing', icon: 'megaphone', roles: ['marketer'], subs: ['publicite', 'formulaires', 'campagnes', 'catalogue', 'influenceurs', 'marketer', 'spy'] },
  // a public page per product, and the orders its fake-order check held back (agents restore the real ones)
  { id: 'landing', icon: 'globe', roles: ['marketer', 'confirmation'] },
  { id: 'caisse', icon: 'wallet', roles: [], subs: ['overview', 'due', 'done', 'livreurs', 'journal'] },
  // an employee's own caisse (money he received, his expenses, what he handed to the main caisse)
  { id: 'macaisse', icon: 'wallet', roles: ['confirmation', 'suivi', 'depot', 'agent_manager'], onlyIf: (_r, admin) => !admin },
  // Partenaires: everyone the store works with, in one group — couriers, its own livreurs, confirmation agencies, marketers
  // (Pilot Auto Assign's rules and the Préférences are in Pilot Automations › Auto Pilot Assign)
  {
    id: 'partenaires',
    icon: 'handshake',
    roles: [],
    pages: ['livraison', 'agences', 'marketers'],
    children: [
      { id: 'livraison', href: '#/livraison/societes', icon: 'truck', plan: ['livraison'], match: { page: 'livraison', subs: ['', 'societes', 'api'] } },
      { id: 'livreurs', href: '#/livraison/livreurs', icon: 'navigation', plan: ['livraison', 'livreurs'], match: { page: 'livraison', subs: ['livreurs'] } },
      { id: 'agences', href: '#/agences', icon: 'handshake', roles: [], onlyIf: partnersOn },
      { id: 'marketers', href: '#/marketers', icon: 'trend', roles: [], onlyIf: partnersOn },
    ],
  },
  { id: 'livraison', icon: 'truck', roles: [], subs: ['societes', 'api', 'livreurs'], hidden: true },
  // no « Vendeurs »: a seller never adds another seller
  { id: 'utilisateurs', icon: 'usercog', roles: [], manageUsers: true, subs: ['roles', 'admins', 'agents', 'managers'] },
  // confirmation agencies working for the store (its code, requests both ways, contracts, numbers, payments)
  { id: 'agences', icon: 'handshake', roles: [], onlyIf: partnersOn, hidden: true },
  // marketers running the store's ads (the same, on their own: a marketer has nothing to do with the agencies)
  { id: 'marketers', icon: 'trend', roles: [], onlyIf: partnersOn, hidden: true },
  { id: 'management', icon: 'briefcase', roles: [], affect: true, subs: ['plans', 'statuts', 'affectation', 'paie', 'prix', 'canaux', 'alertes', 'livreur', 'archive'] },
  { id: 'reglages', icon: 'settings', roles: [] },
  { id: 'profil', icon: 'usercog', roles: null, hidden: true, subs: ['infos', 'parametres', 'parrainage', 'securite'] },
  // « Mes boutiques »: opened from the boutique at the bottom of the menu (and the account menu)
  { id: 'boutiques', icon: 'store', roles: null, hidden: true },
];

/** A group's child: its own roles (or the people who write the Pilot rules), or everyone who sees the group — and in the shop's plan. */
export const canSeeChild = (c: NavChild, roles: Role[], isAdmin: boolean, canRules = false) =>
  (isAdmin || !c.roles || c.roles.some((r) => roles.includes(r)) || (!!c.rules && canRules)) && (c.plan ? pageIsOn(...c.plan) : pageIsOn(c.id)) && (!c.onlyIf || c.onlyIf());

export function canSee(item: NavItem, roles: Role[], isAdmin: boolean, canManageUsers = false, canRules = false, canAffect = false): boolean {
  // a menu the shop's plan does not include is not shown to anyone, administrators included
  if (!pageIsOn(item.id)) return false;
  if (item.onlyIf && !item.onlyIf(roles, isAdmin)) return false;
  if (item.manageUsers && canManageUsers) return true;
  if (item.rules && canRules) return true;
  // Management, for the people the administrator lets set the Affectation (that page only)
  if (item.affect && canAffect) return true;
  if (item.roles === null || isAdmin) return true;
  return item.roles.some((r) => roles.includes(r));
}

/** Where a user lands when the address doesn't match a page they can see. */
export function homeFor(roles: Role[], isAdmin: boolean): string {
  if (!isAdmin && roles.includes('livreur') && !roles.some((r) => ['confirmation', 'suivi', 'depot'].includes(r)) && pageIsOn('tournee')) return 'tournee';
  if (!isAdmin && roles.includes('confirmation') && !roles.includes('vendeur') && roles.length === 1 && pageIsOn('confirmation')) return 'confirmation';
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
function partnersOn(): boolean {
  const s = currentShop();
  return s ? !s.demo : backend.kind === 'demo';
}

export const AGENCY_NAV: NavItem[] = [
  { id: 'accueil', icon: 'home', roles: null },
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
      { id: 'alertes', href: '#/suivi/alertes_new', count: 'suivi', tone: 'nc-a', icon: 'alert', roles: ['suivi', 'agent_manager'], match: { page: 'suivi', subs: ['alertes', 'alertes_new', 'alertes_encours', 'traites', 'reclamation'] } },
      { id: 'livrees', href: '#/suivi/livres', icon: 'checkcircle', roles: ['suivi', 'confirmation', 'agent_manager'], match: { page: 'suivi', subs: ['livres'] } },
      { id: 'annulees', href: '#/suivi/annules', icon: 'xcircle', roles: ['suivi', 'confirmation', 'agent_manager'], match: { page: 'suivi', subs: ['annules', 'swap'] } },
    ],
  },
  { id: 'confirmation', icon: 'phone', roles: ['confirmation', 'agent_manager'], subs: ['nouvelles', 'attente', 'confirmees'], flow: true, hidden: true },
  { id: 'suivi', icon: 'route', roles: ['suivi', 'confirmation', 'agent_manager'], subs: ['enlivraison', 'alertes', 'traites', 'bloques', 'livres', 'annules'], hidden: true },
  { id: 'produits', icon: 'layers', roles: ['confirmation', 'suivi', 'agent_manager'], subs: ['produits', 'stock'] },
  { id: 'vendeurs', icon: 'store', roles: [] },
  { id: 'facturation', icon: 'receipt', roles: [] },
  { id: 'affectation', icon: 'users', roles: [] },
  { id: 'utilisateurs', icon: 'usercog', roles: [], manageUsers: true },
  { id: 'reglages', icon: 'settings', roles: [] },
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
  { id: 'marketing', icon: 'megaphone', roles: ['marketer'], subs: ['publicite', 'marketer'] },
  { id: 'vendeurs', icon: 'store', roles: [] },
  { id: 'facturation', icon: 'receipt', roles: [] },
  { id: 'comptepro', icon: 'medal', roles: [] },
  { id: 'utilisateurs', icon: 'usercog', roles: [], manageUsers: true },
  { id: 'reglages', icon: 'settings', roles: [] },
  { id: 'profil', icon: 'usercog', roles: null, hidden: true, subs: ['infos', 'parametres', 'securite'] },
  { id: 'boutiques', icon: 'store', roles: null, hidden: true },
];
