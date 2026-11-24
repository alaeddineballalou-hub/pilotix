// A boutique's optional modules: each one is off until one of its administrators turns it on (Management › Modules).
// While a module is off its actions refuse and the app hides its page and its menu line.
export const SHOP_MODULES = [
  // Point de vente: the boutique's counter (sell, the day's sales, the clôture)
  'pos',
  // Rendez-vous: the sessions of a service (a training's dates and seats), booked on the website, confirmed by a call
  'rdv',
] as const;
export type ShopModule = (typeof SHOP_MODULES)[number];
