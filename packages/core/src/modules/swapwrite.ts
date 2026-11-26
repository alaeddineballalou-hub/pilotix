// A swap written in Pilotix: the order B takes the parcel of the order A (its company, number, cost…), A becomes
// « Annulé · swappé ». Shared by « Swap » (suivi.ts: Pilotix makes it, by the company's API or alone) and by the courier
// sync (delivery.ts: a swap someone made in the company's own space, ZR › « Swaps », seen when Pilotix reads the parcel).
// Kept apart so the two modules never import each other.
import { Db, iso, num, numOrNull } from '../db';
import type { SwapSent } from '../couriers/types';
import { addEvent, releasePicked } from './orders';

/** Where a parcel can be swapped from: it is still with the courier or the livreur. */
export const SWAP_FROM = ['returning', 'failed', 'alert', 'out_for_delivery', 'shipped'] as const;

export interface SwapWrite {
  /** who made it (null: Pilotix itself, from the courier's answer) */
  me: number | null;
  /** made at the company (by its API, or seen there): its new number kept, never undone from Pilotix */
  sent: SwapSent | null;
  /** how it was made, said in both histories (« · fait chez ZR par API », « · fait dans l’espace ZR, vu par Pilotix ») */
  how: string;
  /** what the company takes for it (same wilaya or another): counted on A like a return fee */
  swapFee: number;
  sameWilaya: boolean;
  note?: string | null;
  /** something to check, added to B's history line (ZR collects another amount…) */
  warn?: string | null;
  nowIso: string;
  /** extra facts kept on both history lines (`seen`: made in the company's space) */
  extra?: Record<string, unknown>;
}

/** Writes the swap on the two locked rows (`A`, `B`: `SELECT * … FOR UPDATE` inside `tx`). */
export async function writeSwap(tx: Db, A: any, B: any, w: SwapWrite) {
  const { me, sent } = w;
  // what the depot had already picked for B goes back on the shelf (B leaves with A's parcel)
  if (B.follow_status === 'to_prepare') await releasePicked(tx, num(B.id));
  // The parcel (and its stock, already out of the depot) goes to B: no new stock out for B, no return for A. B is
  // followed like any parcel on the road: by its own suivi agent, else by the one who followed A (the same team)
  const fAgent = numOrNull(B.follow_agent_id) ?? (numOrNull(A.follow_agency_id) === numOrNull(B.follow_agency_id) ? numOrNull(A.follow_agent_id) : null);
  await tx.query(
    `UPDATE orders SET company_id=$2, delivery_cost=$3, tracking=$4, ext_id=$5, label_url=$6, ext_status=NULL, ext_status_at=NULL, taken_at=NULL,
       warehouse_id=COALESCE($7, warehouse_id), livreur_id=$8, follow_status='out_for_delivery', sub_status='livraison_swappe',
       prepared_at=COALESCE(prepared_at, $9::timestamptz), shipped_at=$9::timestamptz, follow_agent_id=$10, updated_at=now(), version=version+1 WHERE id=$1`,
    [B.id, A.company_id, num(A.delivery_cost) || num(B.delivery_cost), sent?.tracking ?? A.tracking, sent?.parcelExtId ?? A.ext_id, sent ? null : A.label_url, A.warehouse_id, A.livreur_id, w.nowIso, fAgent],
  );
  await tx.query(
    `UPDATE orders SET follow_status='cancelled', sub_status='annule_swappe', tracking=NULL, ext_id=NULL, label_url=NULL, ext_status=NULL, ext_status_at=NULL, taken_at=NULL,
       updated_at=now(), version=version+1 WHERE id=$1`,
    [A.id],
  );
  const n = w.note ? ` · ${w.note}` : '';
  const viaApi = !!sent;
  // A keeps the swap fee (its own swap step), counted like a return fee everywhere a return fee counts
  const fee = w.swapFee ? ` · frais d’échange ${w.swapFee} DA (${w.sameWilaya ? 'même wilaya' : 'autre wilaya'}), comptés sur ${A.ref} comme un retour` : '';
  await addEvent(tx, num(A.id), me, 'follow_status', A.follow_status, 'cancelled', `Colis swappé vers ${B.ref}${w.how}${fee}${n}`, {
    swap_to: num(B.id),
    tracking: A.tracking,
    via_api: viaApi,
    swap_ext: sent?.extId ?? null,
    swap_fee: w.swapFee,
    swap_same: w.sameWilaya,
    ...(w.extra ?? {}),
  });
  await addEvent(tx, num(A.id), me, 'sub_status', A.sub_status, 'annule_swappe', null);
  const was = B.follow_status === 'prepared' ? ' · était En dispatch (emballée) : colis à défaire' : ' · retirée de En préparation';
  const newNo = sent && sent.tracking !== A.tracking ? ` · nouveau n° ${sent.tracking}` : '';
  const warn = w.warn ? ` · ⚠ ${w.warn}` : '';
  // B's place before the swap: « Annuler le swap » puts it back (only a swap Pilotix made alone, never one made at ZR)
  const prev = { follow: B.follow_status ?? null, company: numOrNull(B.company_id), cost: num(B.delivery_cost), prepared: B.prepared_at ? iso(B.prepared_at) : null, warehouse: numOrNull(B.warehouse_id), livreur: numOrNull(B.livreur_id), fagent: numOrNull(B.follow_agent_id) };
  // (`fee_on`: the swap fee is A's — B's cost stays its normal delivery price)
  await addEvent(tx, num(B.id), me, 'follow_status', B.follow_status, 'out_for_delivery', `Colis swappé depuis ${A.ref} (${A.tracking ?? '—'})${w.how}${newNo}${was}${warn}${n}`, {
    swap_from: num(A.id),
    tracking: A.tracking,
    swap_fee: w.swapFee,
    fee_on: 'from',
    via_api: viaApi,
    swap_ext: sent?.extId ?? null,
    prev,
    ...(w.extra ?? {}),
  });
  await addEvent(tx, num(B.id), me, 'sub_status', B.sub_status, 'livraison_swappe', null);
}
