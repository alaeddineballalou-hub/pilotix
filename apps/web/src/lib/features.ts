// The shop of the logged-in user (a multi-shop server): its plan's menus, kept here so the menu, the stage bars and
// the public links can ask without passing the session around. Set by the session (lib/session.tsx).
import { FEATURES, featureOn, routeAllowed, ShopInfo } from '@pilotix/shared';

let shop: ShopInfo | null = null;

export function setShop(s: ShopInfo | null | undefined) {
  shop = s ?? null;
}
export const currentShop = () => shop;

/** Is this menu item ('landing') or sub-menu ('produits/achats') in the shop's plan? (no shop = everything) */
export const featureIsOn = (key: string) => featureOn(shop?.features, key);

/** Can this page (and sub-page) be opened? */
export const pageIsOn = (page: string, sub?: string) => routeAllowed(shop?.features, page, sub);

/** A link of the app ('#/produits/achats'): is its page in the plan? */
export function hrefIsOn(href: string): boolean {
  const [page, sub] = href.replace(/^#\/?/, '').split('/');
  return !page || routeAllowed(shop?.features, page, sub);
}

/** The first sub-page of a page that is in the plan (null = none of them, or the page has none). */
export function firstSubOn(page: string): string | null {
  const f = FEATURES.find((x) => x.key === page);
  return f?.subs?.find((s) => featureOn(shop?.features, `${page}/${s}`)) ?? null;
}

/** Does this page have sub-pages listed in the plans? */
export const hasPlanSubs = (page: string) => !!FEATURES.find((x) => x.key === page)?.subs?.length;
