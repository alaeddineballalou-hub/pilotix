// « Toutes les boutiques » on or off, and the boutiques kept by its « Boutique » filter: this browser, this person.
// The screens use layout/AllBoutiques.tsx; the live updates read it here (another boutique's change refreshes the
// screen only when every boutique is shown).
import { store } from './store';

let key = '';
let on = false;
let shops: number[] | null = null;
const subs = new Set<() => void>();
const ping = () => subs.forEach((f) => f());
export const subscribeAll = (cb: () => void) => (subs.add(cb), () => void subs.delete(cb));

/** The person's choices, read again when another person logs in on this browser. */
export function initAll(email: string | undefined) {
  const k = email ? `all-bq-${email.toLowerCase()}` : '';
  if (k === key) return;
  key = k;
  on = !!k && store.get(k) === '1';
  const f = k ? store.json<number[] | null>(`${k}-f`, null) : null;
  shops = Array.isArray(f) && f.length ? f.filter((x) => Number.isSafeInteger(x)) : null;
}
export const allOnRaw = () => on;
export const keptShops = () => shops;
export function setAllOn(v: boolean) {
  if (v === on) return;
  on = v;
  if (key) store.set(key, v ? '1' : null);
  ping();
}
export function setShopFilter(v: number[] | null) {
  shops = v && v.length ? [...v] : null;
  if (key) store.set(`${key}-f`, shops ? JSON.stringify(shops) : null);
  ping();
}
/** a change of a list's filters (layout/AllBoutiques.tsx) */
export const pingAll = ping;
