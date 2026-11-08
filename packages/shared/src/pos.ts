// Point de vente (shop sales): one rule for the price of a line, the same on the server (the sale) and in the page (the
// ticket while it is being filled).

/** A quantity pack of a product: `qty` items for `price` DA (« 3 pour 3 900 DA »). */
export interface PosPack {
  qty: number;
  price: number;
}

/**
 * The best price for `qty` items at `unit` DA each when the product has quantity packs: packs as many times as they
 * help, singles for the rest (5 biberons with « 3 pour 3 900 »: one pack + 2 singles). Never above `qty × unit`.
 */
export function packTotal(unit: number, qty: number, packs: readonly PosPack[] = []): { total: number; saved: number; packs: { qty: number; times: number }[] } {
  const n = Math.max(0, Math.floor(qty));
  const usable = packs.filter((p) => Number.isFinite(p.qty) && Number.isFinite(p.price) && p.qty >= 2 && p.price > 0 && p.qty <= n);
  const best: number[] = [0];
  const last: number[] = [0];
  for (let k = 1; k <= n; k++) {
    let b = best[k - 1] + unit;
    let h = 0;
    for (const p of usable) {
      if (p.qty <= k && best[k - p.qty] + p.price < b) {
        b = best[k - p.qty] + p.price;
        h = p.qty;
      }
    }
    best.push(b);
    last.push(h);
  }
  const used = new Map<number, number>();
  for (let k = n; k > 0; ) {
    const h = last[k];
    if (h) {
      used.set(h, (used.get(h) ?? 0) + 1);
      k -= h;
    } else k -= 1;
  }
  const total = best[n];
  return { total, saved: unit * n - total, packs: [...used].map(([q, times]) => ({ qty: q, times })).sort((a, b) => b.qty - a.qty) };
}

/** The ways a shop sale is paid (a payment method's word on the ticket and in the Caisse). */
export const POS_METHODS = ['cash', 'baridimob', 'card'] as const;
export type PosMethod = (typeof POS_METHODS)[number];
