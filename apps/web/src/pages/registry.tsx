import type { AppPage } from '@pilotix/shared';
import { ComponentType, lazy } from 'react';

/** Props every page receives: the sub-page from the address (#/page/sub). */
export interface PageProps {
  sub?: string;
  /** extra path parts after the sub-page (#/page/sub/x/y) */
  rest?: string[];
}

/**
 * A space's pages, by the word in their address (pilotix.online/<boutique>/<word>/…): only the words of APP_PAGES
 * (@pilotix/shared), which the web server sends to the app (deploy/Caddyfile) and no landing page or boutique can take.
 */
type Pages = Partial<Record<AppPage, ComponentType<PageProps>>>;

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
  cm: P(() => import('./cm'), 'Cm'),
  social: P(() => import('./social'), 'Social'),
  // AI Pilot › Espace créateur (under Pilot Content): the video pieces, on the user's computer only
  createur: P(() => import('./createur'), 'Createur'),
  notify: P(() => import('./notify'), 'Notify'),
  comptes: P(() => import('./comptes'), 'Comptes'),
  // AI Pilot › AI Spy (it was a tab of Marketing)
  spy: P(() => import('./ads/Spy'), 'SpyPage'),
  // Partenaires › Influenceurs (it was a tab of Marketing)
  influenceurs: P(() => import('./ads/Influenceurs'), 'InfluenceursPage'),
  marketing: P(() => import('./ads'), 'Marketing'),
  landing: P(() => import('./landing'), 'Landing'),
  caisse: P(() => import('./caisse'), 'Caisse'),
  macaisse: P(() => import('./caisse'), 'MaCaisse'),
  // Point de vente: the boutique's counter, once an administrator turns it on (Management › Modules)
  pos: P(() => import('./pos'), 'Pos'),
  livraison: P(() => import('./livraison'), 'Livraison'),
  utilisateurs: P(() => import('./admin'), 'Utilisateurs'),
  management: P(() => import('./admin'), 'Management'),
  reglages: P(() => import('./admin'), 'Reglages'),
  agences: P(() => import('./agences'), 'Agences'),
  marketers: P(() => import('./agences'), 'Marketers'),
  profil: P(() => import('./profil'), 'Profil'),
  boutiques: P(() => import('./boutiques'), 'Boutiques'),
} satisfies Pages;

/**
 * A confirmation agency's space: like a store's (its sellers' confirmation and suivi, one seller or all of them, its
 * users, its settings), plus its sellers and its bills.
 */
export const AGENCY_PAGES: Record<string, ComponentType<PageProps>> = {
  accueil: P(() => import('./agency'), 'AgencyHome'),
  analyse: P(() => import('./agency/stats'), 'AgencyAnalyse'),
  dashboard: P(() => import('./agency/stats'), 'AgencyDashboard'),
  confirmation: P(() => import('./agency/work'), 'AgencyConfirmation'),
  suivi: P(() => import('./agency/work'), 'AgencySuivi'),
  produits: P(() => import('./depot/AssignedCatalog'), 'AgencyProducts'),
  gains: P(() => import('./caisse'), 'MesGains'),
  equipe: P(() => import('./agency'), 'AgencyTeam'),
  vendeurs: P(() => import('./agency'), 'Vendeurs'),
  facturation: P(() => import('./agency'), 'Facturation'),
  utilisateurs: P(() => import('./agency'), 'AgencyUsers'),
  reglages: P(() => import('./agency'), 'AgencySettings'),
  profil: PAGES.profil,
  boutiques: PAGES.boutiques,
} satisfies Pages;

/**
 * A marketer's space: like a store's Marketing (its sellers' ads: Publicité and its ad sets, one seller or all of them),
 * its users, its settings, plus its sellers and its bills (the agency's pages, for a marketer).
 */
export const MARKETER_PAGES: Record<string, ComponentType<PageProps>> = {
  accueil: P(() => import('./marketer'), 'MarketerHome'),
  comptepro: P(() => import('./pro'), 'MarketerPro'),
  marketing: P(() => import('./marketer'), 'MarketerAds'),
  vendeurs: AGENCY_PAGES.vendeurs,
  facturation: AGENCY_PAGES.facturation,
  utilisateurs: AGENCY_PAGES.utilisateurs,
  reglages: AGENCY_PAGES.reglages,
  profil: PAGES.profil,
  boutiques: PAGES.boutiques,
} satisfies Pages;
