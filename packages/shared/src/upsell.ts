// Upsell, counted by Pilotix itself (no box to tick): every order keeps a copy of what the customer first ordered,
// and the upsell is what the customer now pays for products above that copy.

/** A product line as the customer first ordered it (kept on the order when it is created). */
export interface OrigLine {
  productId: number;
  variantId: number | null;
  qty: number;
  unitPrice: number;
}

type Line = { productId: number; variantId: number | null; qty: number; unitPrice: number };

const value = (L: Line[], pid?: number, vid?: number | null) =>
  L.reduce((s, l) => (pid === undefined || (l.productId === pid && (vid === undefined || l.variantId === vid)) ? s + l.qty * l.unitPrice : s), 0);

/**
 * The upsell of an order: what the products now cost above what the customer first ordered (more pieces or a pack,
 * a product added, a dearer product or variant), less any remise given since. Changing a colour or a size at the same
 * price, or taking a cheaper product, is not an upsell; neither is a pack the customer chose by themselves.
 * `flags`: for each line, whether it carries the upsell (a product not first ordered, or more of it than first ordered).
 */
export function upsellOf(orig: OrigLine[], origDiscount: number, lines: Line[], discount: number): { value: number; flags: boolean[] } {
  // the same pieces (same product, same variants, same quantities) typed at a higher price are no upsell — nothing was
  // sold in addition (a price raised by 1 DA, or the delivery moved into the price, earns no bonus)
  const shape = (L: Line[], pid: number) =>
    L.filter((l) => l.productId === pid)
      .map((l) => `${l.variantId ?? ''}:${l.qty}`)
      .sort()
      .join(',');
  const same = new Set([...new Set(lines.map((l) => l.productId))].filter((pid) => orig.some((o) => o.productId === pid) && shape(lines, pid) === shape(orig, pid)));
  const bumps = [...same].reduce((s, pid) => s + Math.max(0, value(lines, pid) - value(orig, pid)), 0);
  const gain = value(lines) - value(orig) - bumps - Math.max(0, discount - origDiscount);
  const v = Math.max(0, Math.round(gain));
  const flags = lines.map((l) => {
    if (v <= 0) return false;
    if (same.has(l.productId)) return false;
    if (!orig.some((o) => o.productId === l.productId)) return true;
    // a product first ordered: only when it now costs more than it did, and only the lines that grew
    if (value(lines, l.productId) <= value(orig, l.productId)) return false;
    return l.qty * l.unitPrice > value(orig, l.productId, l.variantId);
  });
  return { value: v, flags };
}

/** The copy kept when an order is created: its lines, without those already marked as sold in addition (an order typed during a call). */
export const origOf = (lines: (Line & { isUpsell?: boolean })[]): OrigLine[] =>
  lines.filter((l) => !l.isUpsell).map((l) => ({ productId: l.productId, variantId: l.variantId ?? null, qty: l.qty, unitPrice: l.unitPrice }));
