// Pilotix as a service: what each shop may use, menu by menu (the same ids as the app's menu, apps/web/src/layout/nav.ts).
//
// A list of features (a plan's, or a shop's after its own changes) holds:
//   'produits'           → the menu item is included, with all its sub-menus
//   '-produits/achats'   → …except this sub-menu
//   '*'                  → every menu item (still minus the '-…' sub-menus listed)
// null = everything (a shop with no limits: the owner's own shop).
// Menu items added to Pilotix later are off for existing plans until the plan includes them; their sub-menus come
// with them (a sub-menu is on unless it is listed as '-…').

export interface FeatureNode {
  /** a menu item (nav id) */
  key: string;
  /** always on: the shop cannot work without it */
  always?: boolean;
  /** its sub-menus that can be turned off one by one */
  subs?: readonly string[];
}

export const FEATURES: readonly FeatureNode[] = [
  { key: 'accueil', always: true },
  { key: 'dashboard', subs: ['overview', 'confirmation', 'depot', 'suivi', 'livreurs', 'sav'] },
  { key: 'commandes', subs: ['confirmation', 'depot', 'suivi'] },
  { key: 'scanner' },
  { key: 'sav' },
  { key: 'tournee' },
  { key: 'produits', subs: ['stock', 'inventaire', 'produits', 'mouvements', 'alertes', 'achats', 'depots'] },
  { key: 'pilotai', subs: ['messages', 'cm', 'notify'] },
  { key: 'clients' },
  { key: 'marketing', subs: ['publicite', 'marketer', 'spy'] },
  { key: 'landing' },
  { key: 'caisse', subs: ['overview', 'due', 'done', 'livreurs', 'journal'] },
  { key: 'macaisse' },
  { key: 'livraison', subs: ['societes', 'api', 'livreurs'] },
  { key: 'utilisateurs', always: true },
  { key: 'management', subs: ['statuts', 'paie', 'prix', 'canaux'] },
  { key: 'reglages', always: true },
];

const TOP = new Map(FEATURES.map((f) => [f.key, f]));
const ALWAYS = new Set(FEATURES.filter((f) => f.always).map((f) => f.key));

/** Every key a list may hold: the menu items, and their sub-menus as 'item/sub'. */
export const FEATURE_KEYS: readonly string[] = FEATURES.flatMap((f) => [f.key, ...(f.subs ?? []).map((s) => `${f.key}/${s}`)]);

/** A key Pilotix knows ('dashboard', 'produits/achats'). */
export function isFeatureKey(key: string): boolean {
  const [top, sub, more] = key.split('/');
  const f = TOP.get(top);
  if (!f || more !== undefined) return false;
  return sub === undefined || !!f.subs?.includes(sub);
}

/** Is this menu item ('produits') or sub-menu ('produits/achats') on? */
export function featureOn(features: readonly string[] | null | undefined, key: string): boolean {
  if (!features) return true;
  const [top, sub] = key.split('/');
  if (ALWAYS.has(top)) return true;
  if (!features.includes('*') && !features.includes(top)) return false;
  return !sub || !features.includes(`-${top}/${sub}`);
}

/**
 * A shop's features: its plan's list, plus what was turned on for this shop, minus what was turned off (menu items or
 * sub-menus). null = everything.
 */
export function effectiveFeatures(plan: readonly string[] | null | undefined, on: readonly string[] = [], off: readonly string[] = []): string[] | null {
  const base = plan ?? ['*'];
  const all = base.includes('*');
  const minus = new Set(base.filter((k) => k.startsWith('-')).map((k) => k.slice(1)));
  if (all && !minus.size && !off.length) return null;
  const tops = new Set<string>(all ? FEATURES.map((f) => f.key) : base.filter((k) => TOP.has(k)));
  for (const k of on) {
    if (!isFeatureKey(k)) continue;
    if (k.includes('/')) {
      minus.delete(k);
      tops.add(k.split('/')[0]);
    } else tops.add(k);
  }
  for (const k of off) {
    if (!isFeatureKey(k)) continue;
    if (k.includes('/')) minus.add(k);
    else tops.delete(k);
  }
  for (const a of ALWAYS) tops.add(a);
  const subs = [...minus].filter((s) => isFeatureKey(s) && tops.has(s.split('/')[0])).map((s) => `-${s}`);
  return [...FEATURES.map((f) => f.key).filter((k) => tops.has(k)), ...subs.sort()];
}

/** The list a plan editor saves: the menu items ticked, and the sub-menus unticked under them. */
export function featureList(on: (key: string) => boolean): string[] {
  const out: string[] = [];
  for (const f of FEATURES) {
    if (!f.always && !on(f.key)) continue;
    out.push(f.key);
    for (const s of f.subs ?? []) if (!on(`${f.key}/${s}`)) out.push(`-${f.key}/${s}`);
  }
  return out;
}

/** Pages that belong to a menu group (Commandes, Pilot AI) or to another page. */
const PAGE_PARENT: Record<string, [string, string | null]> = {
  confirmation: ['commandes', 'confirmation'],
  depot: ['commandes', 'depot'],
  suivi: ['commandes', 'suivi'],
  livrees: ['commandes', null],
  retournees: ['commandes', null],
  messages: ['pilotai', 'messages'],
  cm: ['pilotai', 'cm'],
  notify: ['pilotai', 'notify'],
};

/** The features a page of the app needs (with its sub-page, e.g. produits + achats). Pages not listed need none. */
export function routeFeatures(page: string, sub?: string): string[] {
  const parent = PAGE_PARENT[page];
  if (parent) return parent[1] ? [parent[0], `${parent[0]}/${parent[1]}`] : [parent[0]];
  const f = TOP.get(page);
  if (!f) return [];
  return sub && f.subs?.includes(sub) ? [page, `${page}/${sub}`] : [page];
}

export const routeAllowed = (features: readonly string[] | null | undefined, page: string, sub?: string) => routeFeatures(page, sub).every((k) => featureOn(features, k));

/**
 * Actions that belong to a paid feature: refused by the server when the shop's plan does not include it (the menu
 * hides the page; this stops a direct call, a webhook or a scheduled job for it).
 */
export const PROC_FEATURES: readonly (readonly [prefix: string, feature: string])[] = [
  ['dellal.', 'pilotai/messages'],
  ['cm.', 'pilotai/cm'],
  ['notify.', 'pilotai/notify'],
  ['spy.', 'marketing/spy'],
  ['ads.', 'marketing/publicite'],
  ['mk.', 'marketing/marketer'],
  ['landing.', 'landing'],
  ['channels.sheet.', 'management/canaux'],
];

export function procFeature(name: string): string | null {
  for (const [p, f] of PROC_FEATURES) if (name.startsWith(p)) return f;
  return null;
}

// ---------------------------------------------------------------- the shop, as the app shows it
export type ShopState = 'trial' | 'active' | 'grace' | 'expired' | 'suspended' | 'archived';

/** What a logged-in user knows of their shop's subscription (a multi-shop server only). */
export interface ShopInfo {
  id: number;
  slug: string;
  name: string;
  /** the server owner's own shop (old links without /s/<slug> lead to it) */
  primary: boolean;
  demo: boolean;
  state: ShopState;
  plan: string | null;
  /** the plan's price per month (DA) */
  planPrice: number | null;
  trialEndsAt: string | null;
  paidUntil: string | null;
  /** days until the end of the trial / the paid period (grace: until the shop is locked) */
  daysLeft: number | null;
  /** unpaid or suspended: only the lock screen */
  locked: boolean;
  /** null = everything */
  features: string[] | null;
  maxUsers: number | null;
  /** how to pay (shown on the trial / renewal banners and the lock screen) */
  payment: { text: string; phone: string; whatsapp: string } | null;
  /** a message from Pilotix to every shop (maintenance, news) */
  notice: { text: string; tone: 'info' | 'warn' } | null;
  /** opened by Pilotix support (the name of the staff member) */
  support: string | null;
}
