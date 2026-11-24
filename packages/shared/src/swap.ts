// Swap: a parcel the customer did not take goes to another customer straight from the delivery company (no return).
// ZR's rules (its « Swaps » page, read 24 Nov 2026): only while ZR says « Ne répond pas 3 » or « Commande annulée » and
// before the parcel leaves for its return, 2 swaps at most per parcel, 50 DA in the same wilaya and 100 DA to another
// one, and a parcel in one of 11 southern wilayas only inside its own wilaya. ZR applies a swap at once (no undo there).

/** ZR: a parcel in one of these wilayas can only be swapped inside its own wilaya. */
export const SWAP_SAME_WILAYA_ONLY: readonly number[] = [1, 8, 11, 30, 32, 45, 49, 52, 53, 54, 58];

/** The delivery companies whose API makes the swap itself (ZR's « parcel-modification-requests/swap »). */
export const SWAP_API_KINDS: readonly string[] = ['zr'];

const plain = (s: unknown) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '');

/** ZR's situations that open a swap: the customer cancelled, or did not answer three times. */
const SWAP_SITUATIONS = ['commandeannulee', 'nerepondpas3'];
/** ZR's states while the parcel is still at its destination (not sent back yet): confirmé au bureau, en livraison, sortie
 *  en livraison, disponible au bureau, en attente du client, échec de livraison. */
const AT_DESTINATION = ['confirme', 'enlivraison', 'sortieenlivraison', 'disponible', 'enattente', 'echec'];

/** A ZR status line as Pilotix keeps it (« Sortie en livraison · Commande annulée ») that ZR lets swap. */
export function zrSwapStatus(extStatus: string | null | undefined): boolean {
  const [state, ...rest] = String(extStatus ?? '').split(' · ');
  if (!SWAP_SITUATIONS.includes(plain(rest.join(' ')))) return false;
  const st = plain(state);
  return AT_DESTINATION.some((w) => st.startsWith(w));
}

/**
 * What « Swap » does on an order: 'api' = its delivery company swaps it itself through its API (ZR, while ZR allows it),
 * 'manual' = Pilotix moves the orders and someone tells the company or the livreur (a parcel coming back, with a company
 * that has no swap API or our own livreurs); null = no swap.
 */
export type SwapWay = 'api' | 'manual' | null;
export function swapWayOf(o: { followStatus: string | null; extStatus?: string | null; shippedAt?: string | null }, companyKind: string | null | undefined): SwapWay {
  if (!o.shippedAt) return null;
  if (companyKind && SWAP_API_KINDS.includes(companyKind))
    return ['shipped', 'out_for_delivery', 'failed', 'alert', 'returning'].includes(o.followStatus ?? '') && zrSwapStatus(o.extStatus) ? 'api' : null;
  return o.followStatus === 'returning' ? 'manual' : null;
}

/** An order's products as « product:variant » → quantity: two orders can take each other's parcel only when they match. */
export function itemsKey(items: readonly { productId: number; variantId?: number | null; qty: number; isUpsell?: boolean | null }[]): string {
  const m = new Map<string, number>();
  for (const i of items) {
    const k = `${i.productId}:${i.variantId ?? 0}`;
    m.set(k, (m.get(k) ?? 0) + (Number(i.qty) || 0));
  }
  return [...m]
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${k}x${n}`)
    .join(',');
}
