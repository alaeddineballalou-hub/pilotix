// A confirmation agency's space works on its sellers' orders: the picker at the top of the page chooses one seller (a
// store) or « Tous les vendeurs ». A part of the screen works for one seller (SellerScope): its actions on orders carry
// that seller to the server (the X-Seller header), which runs them inside that store.
import { createContext, createElement, ReactNode, useContext, useLayoutEffect, useSyncExternalStore } from 'react';
import { store } from './store';

export type Seller = number | 'all';

// ---------------------------------------------------------------- the seller chosen at the top of the page
let chosen: Seller = 'all';
let key = '';
const subs = new Set<() => void>();
const parse = (v: string | null): Seller => (v && /^\d+$/.test(v) ? Number(v) : 'all');

/** The agency's space opened (its id): the seller chosen last time in this browser comes back. */
export function initSeller(agencyId: number) {
  const k = `seller-${agencyId}`;
  if (k === key) return;
  key = k;
  chosen = parse(store.get(k));
}
export const getSeller = () => chosen;
export function setSeller(v: Seller) {
  if (v === chosen) return;
  chosen = v;
  if (key) store.set(key, String(v));
  subs.forEach((f) => f());
}
export const useSeller = () =>
  useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => chosen,
  );

// ---------------------------------------------------------------- the seller of a part of the screen
const ScopeCtx = createContext<Seller | null>(null);
/** The seller of the part of the screen this component is in (null: the agency itself, or a store's own app). */
export const useScope = () => useContext(ScopeCtx);

/**
 * The parts of the screen working for a seller, the innermost last: an action called outside React's hooks (a click
 * handler calling rpc) goes to the seller of what is open on top (an order opened from « Tous les vendeurs »).
 */
const open: Seller[] = [];
export const ambientSeller = (): Seller | undefined => open[open.length - 1];

export function SellerScope({ seller, children }: { seller: Seller; children: ReactNode }) {
  useLayoutEffect(() => {
    open.push(seller);
    return () => {
      const i = open.lastIndexOf(seller);
      if (i >= 0) open.splice(i, 1);
    };
  }, [seller]);
  return createElement(ScopeCtx.Provider, { value: seller }, children);
}
