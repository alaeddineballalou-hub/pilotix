import type { Role } from '@pilotix/shared';

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
  { id: 'produits', icon: 'layers', roles: ['depot'], subs: ['stock', 'produits', 'mouvements'] },
  // Pilot AI: the AI agents. Message AI agent (Dellal) sells in the inbox, CM AI agent answers the comments.
  {
    id: 'pilotai',
    icon: 'sparkles',
    roles: ['confirmation', 'marketer'],
    pages: ['messages', 'cm'],
    children: [
      { id: 'messages', href: '#/messages', count: 'msgs', tone: 'nc-a', icon: 'chat', roles: ['confirmation'] },
      { id: 'cm', href: '#/cm', count: 'cm', tone: 'nc-a', icon: 'comments', roles: ['confirmation', 'marketer'] },
    ],
  },
  { id: 'messages', icon: 'chat', roles: ['confirmation'], hidden: true },
  { id: 'cm', icon: 'comments', roles: ['confirmation', 'marketer'], hidden: true },
  { id: 'clients', icon: 'users', roles: ['confirmation', 'suivi'] },
  { id: 'marketing', icon: 'megaphone', roles: ['marketer'], subs: ['publicite', 'marketer'] },
  { id: 'caisse', icon: 'wallet', roles: [], subs: ['due', 'done', 'livreurs'] },
  { id: 'livraison', icon: 'truck', roles: [], subs: ['societes', 'api', 'livreurs'] },
  { id: 'utilisateurs', icon: 'usercog', roles: [], subs: ['roles', 'admins', 'vendeurs', 'agents', 'marketeurs', 'managers'] },
  { id: 'management', icon: 'briefcase', roles: [], subs: ['statuts', 'paie', 'prix', 'canaux'] },
  { id: 'reglages', icon: 'settings', roles: [] },
  { id: 'profil', icon: 'usercog', roles: null, hidden: true, subs: ['infos', 'parametres', 'parrainage', 'securite'] },
];

/** A group's child: its own roles, or everyone who sees the group. */
export const canSeeChild = (c: NavChild, roles: Role[], isAdmin: boolean) => isAdmin || !c.roles || c.roles.some((r) => roles.includes(r));

export function canSee(item: NavItem, roles: Role[], isAdmin: boolean): boolean {
  if (item.onlyIf && !item.onlyIf(roles, isAdmin)) return false;
  if (item.roles === null || isAdmin) return true;
  return item.roles.some((r) => roles.includes(r));
}

/** Where a user lands when the address doesn't match a page they can see. */
export function homeFor(roles: Role[], isAdmin: boolean): string {
  if (!isAdmin && roles.includes('livreur') && !roles.some((r) => ['confirmation', 'suivi', 'depot'].includes(r))) return 'tournee';
  if (!isAdmin && roles.includes('confirmation') && !roles.includes('vendeur') && roles.length === 1) return 'confirmation';
  return 'accueil';
}
