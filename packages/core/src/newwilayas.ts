// The 11 wilayas created in 2026 (59–69, decree n° 26-206). The owner's rule, 28 Nov 2026 (PX1463, Bou Saâda 68:
// « Aucune société ne livre à domicile à 68 Bou Saâda », the order could not be confirmed): Pilotix keeps the 69
// wilayas everywhere (orders, landing pages, stats); only a delivery company that still counts 58 gets a new wilaya as
// the one it was part of (68 → M'Sila 28, couriers/index.ts › courierParcel; ZR finds it itself, zr.ts › zrWilayas),
// and where a company or a client price list has no price for a new wilaya yet, the old wilaya's price counts (the
// owner chose « A »). A company that adds the new wilaya with its own price: that price counts.
import { NEW_WILAYA_PARENT, NEW_WILAYAS_OF, oldWilaya, wilayaAndOld } from '@pilotix/shared';
import type { FeeRow } from './couriers/types';
import { type Db, num } from './db';

/** SQL: the old wilaya of a wilaya column (itself for the 58). */
export const oldWilayaSql = (col: string) =>
  `(CASE ${col} ${Object.entries(NEW_WILAYA_PARENT)
    .map(([n, o]) => `WHEN ${n} THEN ${o}`)
    .join(' ')} ELSE ${col} END)`;

/** SQL: the wilaya whose price row counts for a company and a wilaya: its own row, else (a new wilaya) its old wilaya's. */
export const feeWilayaSql = (company: string, wilaya: string) =>
  `COALESCE((SELECT x.wilaya_id FROM delivery_fees x WHERE x.company_id = ${company} AND x.wilaya_id = ${wilaya}), ${oldWilayaSql(wilaya)})`;

/**
 * Price rows (delivery_fees) completed for the new wilayas a company has no row for: a copy of its old wilaya's row. For
 * the rows of one company (no company_id) or of many.
 */
export function withNewWilayas<R extends { wilaya_id: unknown; company_id?: unknown }>(rows: R[]): R[] {
  const key = (r: R, w: number) => `${r.company_id == null ? '' : num(r.company_id)}:${w}`;
  const have = new Set(rows.map((r) => key(r, num(r.wilaya_id))));
  const out = [...rows];
  for (const r of rows)
    for (const w of NEW_WILAYAS_OF[num(r.wilaya_id)] ?? []) {
      if (have.has(key(r, w))) continue;
      out.push({ ...r, wilaya_id: w });
      have.add(key(r, w));
    }
  return out;
}

/** A company's price list (from its API, or typed by hand) completed the same way before it is saved: a new wilaya
 *  without a price takes its old wilaya's (a price of 0 typed for it stays: the company does not deliver there). */
export function fillNewWilayas(rows: FeeRow[]): FeeRow[] {
  const priced = (r: FeeRow | undefined) => !!r && (r.home !== null || r.desk !== null);
  const by = new Map(rows.map((r) => [r.wilayaId, r]));
  for (const [n, o] of Object.entries(NEW_WILAYA_PARENT)) {
    const w = Number(n);
    const from = by.get(o);
    if (priced(by.get(w)) || !from || !priced(from)) continue;
    by.set(w, { wilayaId: w, home: from.home, desk: from.desk, returnFee: from.returnFee });
  }
  return [...by.values()].sort((a, b) => a.wilayaId - b.wilayaId);
}

/** One company's price row for a wilaya: its own, else (a new wilaya) its old wilaya's; null: none. */
export async function feeRowOf(db: Db, companyId: number, wilayaId: number): Promise<{ wilaya_id: unknown; home: unknown; desk: unknown; return_fee: unknown } | null> {
  const rows = await db.query('SELECT wilaya_id, home, desk, return_fee FROM delivery_fees WHERE company_id = $1 AND wilaya_id = ANY($2::int[])', [companyId, wilayaAndOld(wilayaId)]);
  return rows.find((r: any) => num(r.wilaya_id) === wilayaId) ?? rows.find((r: any) => num(r.wilaya_id) === oldWilaya(wilayaId)) ?? null;
}

/** The flat price Pilotix itself wrote into a new client price list for every place the copied company had no price
 *  for (admin.ts › gridFromCompany, until 28 Nov 2026): never a price someone chose for a new wilaya. */
const FLAT = { home: 600, desk: 400 };

/**
 * A client price list (wilaya → home / bureau: Gestion › Prix de livraison, the SAV's) as it counts: a new wilaya with no
 * price of its own there — none, 0 and 0 (left empty), or that old flat 600 / 400 — takes its old wilaya's price
 * (Bou Saâda 68 → M'Sila 28). Every other line is the shop's own, untouched.
 */
export function effectiveGrid<G extends Record<string, { home: number; desk: number }>>(grid: G): G;
export function effectiveGrid<G extends Record<string, { home: number; desk: number }>>(grid: G | undefined | null): G | undefined | null;
export function effectiveGrid<G extends Record<string, { home: number; desk: number }>>(grid: G | undefined | null): G | undefined | null {
  if (!grid) return grid;
  let out: Record<string, { home: number; desk: number }> = grid;
  for (const [n, o] of Object.entries(NEW_WILAYA_PARENT)) {
    const r = grid[n];
    const none = !r || (num(r.home) === 0 && num(r.desk) === 0) || (num(r.home) === FLAT.home && num(r.desk) === FLAT.desk);
    const from = grid[String(o)];
    if (!none || !from) continue;
    if (out === grid) out = { ...grid };
    out[n] = { home: num(from.home), desk: num(from.desk) };
  }
  return out as G;
}
