// Point de vente: what its tabs share (the answers' types, the payments, the ticket's lines priced as the server prices them).
import { packTotal, POS_METHODS, type ClientLevel, type PosMethod } from '@pilotix/shared';
import type { Out } from '../../lib/backend';

export type PosState = Out<'pos.state'>;
export type PosProduct = PosState['products'][number];
export type PosVariant = PosProduct['variants'][number];
export type PosSale = Out<'pos.sell'>;
export type CartLine = { variantId: number; qty: number };
export type PosCustomer = { id: number; name: string; phone: string; score?: number; level?: ClientLevel };
export { POS_METHODS, type PosMethod };

export const METHOD_ICON: Record<PosMethod, string> = { cash: 'wallet', baridimob: 'phone', card: 'card' };
/** under this many left in the counter's dépôt, a product shows « Plus que … » */
export const LOW = 5;
export const ticketNo = (n: number | string) => String(n).padStart(4, '0');

/** The two first letters of a product's name, for its tile when it has no photo (« Poussette canne pliable » → PC). */
export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const long = words.filter((w) => w.length > 2 && !/^\d+$/.test(w));
  return (long.length >= 2 ? long : words)
    .slice(0, 2)
    .map((w) => Array.from(w)[0])
    .join('')
    .toUpperCase();
}

/** A caisse's name in the app's language: the main one, the bank, and « Caisse boutique » while it keeps its first name. */
export const caisseName = (t: (k: string) => string, c: { key: string | null; name: string }, own?: string | null) =>
  c.key === 'main' ? t('caisse.ph.main') : c.key === 'bank' ? t('caisse.ph.bank') : c.key === null || (c.key === own && c.name === 'Caisse boutique') ? t('pos.shopCaisse') : c.name;

/** Lower case without accents: « Écharpe » is found with « echarpe ». */
export const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Each product's variants by id, with their product (the ticket's lines name them). */
export function variantsOf(products: PosProduct[]) {
  const m = new Map<number, { p: PosProduct; v: PosVariant }>();
  for (const p of products) for (const v of p.variants) m.set(v.id, { p, v });
  return m;
}

/** A ticket line as it is shown and paid: the catalogue's price, its quantity packs (the same rule as the server). */
export function priced(lines: CartLine[], by: ReturnType<typeof variantsOf>) {
  const rows = lines.flatMap((l) => {
    const x = by.get(l.variantId);
    if (!x) return [];
    const r = packTotal(x.v.price, l.qty, x.p.packs);
    return [{ ...l, p: x.p, v: x.v, unit: x.v.price, before: x.v.price * l.qty, total: r.total, saved: r.saved, packs: r.packs, left: x.v.stock - l.qty }];
  });
  const items = rows.reduce((s, r) => s + r.qty, 0);
  const total = rows.reduce((s, r) => s + r.total, 0);
  const saved = rows.reduce((s, r) => s + r.saved, 0);
  return { rows, items, total, saved, before: total + saved };
}
export type PricedLine = ReturnType<typeof priced>['rows'][number];
