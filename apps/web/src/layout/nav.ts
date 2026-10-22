import type { Role } from '@pilotix/shared';

/**
 * The menu, as in the original Pilotix (final layout): sub-pages appear as a stage bar inside the page,
 * except the "Commandes" group whose stages stay in the menu with their counts.
 * roles: null = everyone, [] = admin only.
 */
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
  /** menu children (only for the Commandes group) */
  children?: { id: string; href: string; count?: string }[];
}

export const NAV: NavItem[] = [
  { id: 'accueil', icon: 'home', roles: null },
  { id: 'dashboard', icon: 'chart', roles: ['agent_manager', 'vendeur'], subs: ['overview', 'confirmation', 'depot', 'suivi', 'livreurs', 'sav'] },
  {
    id: 'commandes',
    icon: 'list',
    roles: ['confirmation', 'suivi', 'depot'],
    subs: ['tout', 'livrees', 'annulees'],
    children: [
      { id: 'confirmation', href: '#/confirmation', count: 'conf' },
      { id: 'depot', href: '#/depot', count: 'depot' },
      { id: 'suivi', href: '#/suivi', count: 'suivi' },
      { id: 'livrees', href: '#/commandes/livrees', count: 'delivered' },
      { id: 'annulees', href: '#/commandes/annulees', count: 'cancelled' },
    ],
  },
  { id: 'confirmation', icon: 'phone', roles: ['confirmation'], subs: ['nouvelles', 'attente', 'confirmees', 'terminees'], flow: true, hidden: true },
  { id: 'depot', icon: 'package', roles: ['depot'], subs: ['preparer', 'prepares', 'dispatchees', 'enlivraison', 'retours'], flow: true, hidden: true },
  { id: 'suivi', icon: 'route', roles: ['suivi'], subs: ['alertes', 'traites', 'livres', 'annules', 'reclamation', 'swap'], hidden: true },
  { id: 'scanner', icon: 'scanbar', roles: ['depot'] },
  { id: 'sav', icon: 'headset', roles: ['confirmation', 'suivi', 'depot'], subs: ['tickets', 'nouveau', 'attente', 'depot', 'livraison', 'livres', 'annules', 'stats'] },
  { id: 'tournee', icon: 'navigation', roles: ['livreur'], onlyIf: (r) => r.includes('livreur') },
  { id: 'produits', icon: 'layers', roles: ['depot'], subs: ['stock', 'produits', 'mouvements'] },
  { id: 'messages', icon: 'chat', roles: ['confirmation'] },
  { id: 'clients', icon: 'users', roles: ['confirmation', 'suivi'] },
  { id: 'marketing', icon: 'megaphone', roles: ['marketer'], subs: ['publicite', 'marketer'] },
  { id: 'caisse', icon: 'wallet', roles: [], subs: ['due', 'done', 'livreurs'] },
  { id: 'livraison', icon: 'truck', roles: [], subs: ['societes', 'api', 'livreurs'] },
  { id: 'utilisateurs', icon: 'usercog', roles: [], subs: ['roles', 'admins', 'vendeurs', 'agents', 'marketeurs', 'managers'] },
  { id: 'management', icon: 'briefcase', roles: [], subs: ['statuts', 'paie', 'prix', 'canaux'] },
  { id: 'reglages', icon: 'settings', roles: [] },
  { id: 'profil', icon: 'usercog', roles: null, hidden: true, subs: ['infos', 'parametres', 'parrainage', 'securite'] },
];

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
