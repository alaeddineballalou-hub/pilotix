import { ComponentType, lazy } from 'react';

/** Props every page receives: the sub-page from the address (#/page/sub). */
export interface PageProps {
  sub?: string;
  /** extra path parts after the sub-page (#/page/sub/x/y) */
  rest?: string[];
}

// Each feature folder exports its pages by name.
const P = <K extends string>(loader: () => Promise<Record<K, ComponentType<PageProps>>>, name: K) =>
  lazy(async () => ({ default: (await loader())[name] }));

export const PAGES: Record<string, ComponentType<PageProps>> = {
  accueil: P(() => import('./home'), 'Home'),
  dashboard: P(() => import('./dashboard'), 'Dashboard'),
  commandes: P(() => import('./orders'), 'Commandes'),
  livrees: P(() => import('./orders'), 'Livrees'),
  retournees: P(() => import('./orders'), 'Retournees'),
  confirmation: P(() => import('./confirmation'), 'Confirmation'),
  depot: P(() => import('./depot'), 'Depot'),
  scanner: P(() => import('./depot'), 'Scanner'),
  produits: P(() => import('./depot'), 'Produits'),
  suivi: P(() => import('./suivi'), 'Suivi'),
  sav: P(() => import('./sav'), 'Sav'),
  tournee: P(() => import('./tournee'), 'Tournee'),
  clients: P(() => import('./clients'), 'Clients'),
  messages: P(() => import('./messages'), 'Messages'),
  publicite: P(() => import('./ads'), 'Publicite'),
  caisse: P(() => import('./caisse'), 'Caisse'),
  livraison: P(() => import('./livraison'), 'Livraison'),
  utilisateurs: P(() => import('./admin'), 'Utilisateurs'),
  management: P(() => import('./admin'), 'Management'),
  reglages: P(() => import('./admin'), 'Reglages'),
  profil: P(() => import('./profil'), 'Profil'),
};
