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
  /** menu children: the item is a group (Commandes, Pilot AI) */
  children?: NavChild[];
  /** pages of the group: it is highlighted on them, and shows its bar under the header when the sidebar is folded */
  pages?: string[];
  /** where the group's line leads when the sidebar is folded (default: its first child) */
  href?: string;
}

export const NAV: NavItem[] = [
  { id: 'accueil', icon: 'home', roles: null },
  { id: 'dashboard', icon: 'chart', roles: ['agent_manager', 'vendeur'], subs: ['overview', 'confirmation', 'depot', 'suivi', 'livreurs', 'sav'] },
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
      { id: 'suivi', href: '#/suivi', count: 'suivi', tone: 'nc-a', icon: 'route', roles: ['suivi'] },
      { id: 'livrees', href: '#/commandes/livrees', count: 'delivered', tone: 'nc-c', icon: 'checkcircle' },
      { id: 'annulees', href: '#/commandes/annulees', count: 'cancelled', tone: '', icon: 'xcircle' },
    ],
  },
  { id: 'confirmation', icon: 'phone', roles: ['confirmation'], subs: ['nouvelles', 'attente', 'confirmees', 'terminees'], flow: true, hidden: true },
  { id: 'depot', icon: 'package', roles: ['depot'], subs: ['preparer', 'prepares', 'dispatchees', 'enlivraison', 'retours'], flow: true, hidden: true },
  { id: 'suivi', icon: 'route', roles: ['suivi'], subs: ['alertes', 'traites', 'livres', 'annules', 'reclamation', 'swap'], hidden: true },
  { id: 'scanner', icon: 'scanbar', roles: ['depot'] },
  { id: 'sav', icon: 'headset', roles: ['confirmation', 'suivi', 'depot'], subs: ['tickets', 'nouveau', 'attente', 'depot', 'livraison', 'livres', 'annules', 'stats'] },
  { id: 'tournee', icon: 'navigation', roles: ['livreur'], onlyIf: (r) => r.includes('livreur') },
  { id: 'produits', icon: 'layers', roles: ['depot'], subs: ['stock', 'inventaire', 'produits', 'mouvements', 'alertes', 'achats', 'depots'] },
  // Pilot AI: the AI agents. Message AI agent (Dellal) sells in the inbox, CM AI agent answers the comments,
  // Delivery AI agent tells each customer where their order is (WhatsApp, SMS).
  {
    id: 'pilotai',
    icon: 'sparkles',
    roles: ['confirmation', 'marketer', 'suivi'],
    pages: ['messages', 'cm', 'notify'],
    children: [
      { id: 'messages', href: '#/messages', count: 'msgs', tone: 'nc-a', icon: 'chat', roles: ['confirmation'] },
      { id: 'cm', href: '#/cm', count: 'cm', tone: 'nc-a', icon: 'comments', roles: ['confirmation', 'marketer'] },
      { id: 'notify', href: '#/notify', count: 'notify', tone: 'nc-a', icon: 'truck', roles: ['confirmation', 'suivi'] },
    ],
  },
  { id: 'messages', icon: 'chat', roles: ['confirmation'], hidden: true },
  { id: 'cm', icon: 'comments', roles: ['confirmation', 'marketer'], hidden: true },
  { id: 'notify', icon: 'truck', roles: ['confirmation', 'suivi'], hidden: true },
  { id: 'clients', icon: 'users', roles: ['confirmation', 'suivi'] },
  // Publicité (Meta spend face to the orders), Marketer (paying marketers), AI Spy (competitors' ads in Algeria)
  { id: 'marketing', icon: 'megaphone', roles: ['marketer'], subs: ['publicite', 'marketer', 'spy'] },
  // a public page per product, and the orders its fake-order check held back (agents restore the real ones)
  { id: 'landing', icon: 'globe', roles: ['marketer', 'confirmation'] },
  { id: 'caisse', icon: 'wallet', roles: [], subs: ['overview', 'due', 'done', 'livreurs', 'journal'] },
  // an employee's own caisse (money he received, his expenses, what he handed to the main caisse)
  { id: 'macaisse', icon: 'wallet', roles: ['confirmation', 'suivi', 'depot', 'agent_manager'], onlyIf: (_r, admin) => !admin },
  { id: 'livraison', icon: 'truck', roles: [], subs: ['societes', 'pilot', 'couverture', 'api', 'livreurs', 'preferences'], rules: true },
  { id: 'utilisateurs', icon: 'usercog', roles: [], manageUsers: true, subs: ['roles', 'admins', 'vendeurs', 'agents', 'marketeurs', 'managers'] },
  // confirmation agencies working for the store (its code, requests both ways, contracts, numbers, payments)
  { id: 'agences', icon: 'handshake', roles: [], onlyIf: partnersOn },
  // marketers running the store's ads (the same, on their own: a marketer has nothing to do with the agencies)
  { id: 'marketers', icon: 'trend', roles: [], onlyIf: partnersOn },
  { id: 'management', icon: 'briefcase', roles: [], subs: ['statuts', 'paie', 'prix', 'canaux', 'alertes', 'livreur', 'archive'] },
  { id: 'reglages', icon: 'settings', roles: [] },
  { id: 'profil', icon: 'usercog', roles: null, hidden: true, subs: ['infos', 'parametres', 'parrainage', 'securite'] },
];

/** A group's child: its own roles, or everyone who sees the group — and in the shop's plan. */
export const canSeeChild = (c: NavChild, roles: Role[], isAdmin: boolean) => (isAdmin || !c.roles || c.roles.some((r) => roles.includes(r))) && pageIsOn(c.id);

export function canSee(item: NavItem, roles: Role[], isAdmin: boolean, canManageUsers = false, canRules = false): boolean {
  // a menu the shop's plan does not include is not shown to anyone, administrators included
  if (!pageIsOn(item.id)) return false;
  if (item.onlyIf && !item.onlyIf(roles, isAdmin)) return false;
  if (item.manageUsers && canManageUsers) return true;
  if (item.rules && canRules) return true;
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
  {
    id: 'commandes',
    icon: 'list',
    roles: ['confirmation', 'suivi', 'agent_manager'],
    pages: ['confirmation', 'suivi'],
    children: [
      { id: 'confirmation', href: '#/confirmation', count: 'conf', tone: 'nc-n', icon: 'phone', roles: ['confirmation', 'agent_manager'] },
      { id: 'suivi', href: '#/suivi', count: 'suivi', tone: 'nc-a', icon: 'route', roles: ['suivi', 'agent_manager'] },
    ],
  },
  { id: 'confirmation', icon: 'phone', roles: ['confirmation', 'agent_manager'], subs: ['nouvelles', 'attente', 'confirmees'], flow: true, hidden: true },
  { id: 'suivi', icon: 'route', roles: ['suivi', 'agent_manager'], subs: ['alertes', 'traites', 'livres', 'annules'], hidden: true },
  { id: 'vendeurs', icon: 'store', roles: [] },
  { id: 'facturation', icon: 'receipt', roles: [] },
  { id: 'utilisateurs', icon: 'usercog', roles: [], manageUsers: true },
  { id: 'reglages', icon: 'settings', roles: [] },
  { id: 'profil', icon: 'usercog', roles: null, hidden: true, subs: ['infos', 'parametres', 'securite'] },
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
];
