// ---------------------------------------------------------------- the app's addresses
// On the real site an address is pilotix.online/<boutique>/<page>/<sub>…: the boutique's link name first (chosen when the
// boutique, the agency or the marketer's space is created; it never changes), then the page. Pages anyone opens without
// a boutique start with one of PUBLIC_ROOTS (pilotix.online/conditions, /inscription, /reset/<secret>…).
//
// A landing page is pilotix.online/<boutique>/<landing page>, so a landing page is never named like an app page, and a
// boutique is never named like one of these words: the web server (deploy/Caddyfile) sends /<boutique>/<app page> to the
// app and every other /<boutique>/<name> to the landing pages. A test checks the Caddyfile lists exactly these words.

/** First words of the addresses that belong to no boutique (pages open to everyone, e-mail links, the control room). */
export const PUBLIC_ROOTS = [
  'conditions',
  'pro',
  'platform',
  'reset',
  'invite',
  'signup',
  'verify',
  'inscription',
  'inscription-agence',
  'inscription-marketer',
  'confirmer',
] as const;

/**
 * The pages of a boutique's space (a store's, a confirmation agency's, a marketer's), the menu's groups and the old
 * short links: the word after the boutique's name. A page added to the app is added here (the page list in
 * apps/web/src/pages/registry.tsx only takes these words) and to deploy/Caddyfile.
 */
export const APP_PAGES = [
  // a store
  'accueil',
  'dashboard',
  'commandes',
  'livrees',
  'retournees',
  'confirmation',
  'depot',
  'scanner',
  'produits',
  'suivi',
  'sav',
  'tournee',
  'clients',
  'messages',
  'cm',
  'social',
  // AI Pilot › Espace créateur (the video pieces stay on the user's computer)
  'createur',
  'notify',
  'comptes',
  'marketing',
  'landing',
  'caisse',
  'macaisse',
  // Point de vente (a module the boutique turns on in Management › Modules)
  'pos',
  'livraison',
  'utilisateurs',
  'management',
  'reglages',
  'agences',
  'marketers',
  'influenceurs',
  'profil',
  'boutiques',
  'aide',
  // a confirmation agency, a marketer
  'analyse',
  'vendeurs',
  'facturation',
  'affectation',
  'comptepro',
  // an agency's agent: his pay (« Mes gains »)
  'gains',
  // the menu's groups without a page of their own
  'partenaires',
  'pilotai',
  // old short links (they open the page they moved to)
  'livreurs',
  'publicite',
  'marketer',
  'spy',
  'equipe',
  'tarifs',
  'adsets',
] as const;

export type AppPage = (typeof APP_PAGES)[number];

export const isAppPage = (w: string | undefined): w is AppPage => !!w && (APP_PAGES as readonly string[]).includes(w);
export const isPublicRoot = (w: string | undefined): boolean => !!w && (PUBLIC_ROOTS as readonly string[]).includes(w);
