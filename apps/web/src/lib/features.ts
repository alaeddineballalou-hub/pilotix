// The shop of the logged-in user (a multi-shop server): its plan's menus, kept here so the menu, the stage bars and
// the public links can ask without passing the session around. Set by the session (lib/session.tsx).
import { effectiveFeatures, FEATURES, featureOn, payIsOn, routeAllowed, routeFeatures, ShopInfo, soonHas } from '@pilotix/shared';

let shop: ShopInfo | null = null;
/** The platform's « Bientôt » list when the session carries no shop (the in-browser demo's own store, lib/backend.ts). */
let soonAll: string[] = [];
let soonAllFeatures: string[] | null = null;
export function setSoonAll(list: readonly string[]) {
  soonAll = [...list];
  soonAllFeatures = soonAll.length ? effectiveFeatures(['*'], [], soonAll) : null;
}
/** The shop's features (null: everything), its « Bientôt » ones off. */
const features = () => (shop ? shop.features : soonAllFeatures);
/** What the « Bientôt » list closes in this shop (control room › Réglages). */
const soonList = () => (shop ? shop.soon ?? [] : soonAll);

export function setShop(s: ShopInfo | null | undefined) {
  shop = s ?? null;
}
export const currentShop = () => shop;

/** Is this menu item ('landing') or sub-menu ('produits/achats') in the shop's plan? (no shop = everything) */
export const featureIsOn = (key: string) => featureOn(features(), key);

/** Can this page (and sub-page) be opened? */
export const pageIsOn = (page: string, sub?: string) => routeAllowed(features(), page, sub);

/**
 * « Bientôt » (control room › Réglages): a page the shop's plan includes but Pilotix keeps closed for now. Its menu line
 * shows greyed with « Bientôt » and does not open.
 */
export const pageIsSoon = (page: string, sub?: string) => {
  const soon = soonList();
  return !!soon.length && !pageIsOn(page, sub) && routeFeatures(page, sub).some((k) => soonHas(soon, k));
};

/** Agent pay (Caisse › Paie, the pay in Ma caisse): a store whose plan has it, and a confirmation agency (Facturation ›
 *  Paie, « Mes gains »). A marketer's space pays its own way. */
export const payOn = () => payIsOn(shop) && (shop?.kind === 'agency' || pageIsOn('caisse', 'paie'));
/** In a confirmation agency's own space. */
export const inAgency = () => shop?.kind === 'agency';

/** A link of the app ('#/produits/achats'): is its page in the plan? */
export function hrefIsOn(href: string): boolean {
  const [page, sub] = href.replace(/^#\/?/, '').split('/');
  return !page || routeAllowed(features(), page, sub);
}

/** The first sub-page of a page that is in the plan (null = none of them, or the page has none). */
export function firstSubOn(page: string): string | null {
  const f = FEATURES.find((x) => x.key === page);
  return f?.subs?.find((s) => featureOn(features(), `${page}/${s}`)) ?? null;
}

/** Does this page have sub-pages listed in the plans? */
export const hasPlanSubs = (page: string) => !!FEATURES.find((x) => x.key === page)?.subs?.length;
