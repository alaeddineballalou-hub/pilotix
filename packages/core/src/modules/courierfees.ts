// What a courier itself charges for each parcel, read from its API (ZR): its delivery price, its return price, the
// weight it counts and its weight fee. Pilotix counts these instead of the price list (Bilan des livraisons, « Frais
// société », the caisse, the profit): a parcel declared under 5 kg that ZR weighs again pays ZR's weight fee — 50 DA a
// kg above 5 kg — on its delivery and on its return. The fee is exact once ZR pays (« weightCost » of its payment);
// before, it is counted from the weight ZR found (« effectiveWeight »).
import type { CourierCosts } from '../couriers/types';
import type { Db } from '../db';
import { num } from '../db';

/** Kinds whose API gives each parcel's own prices: their fees come from there, never from the products' weights. */
export const FEES_BY_API = ['zr'] as const;
export const feesByApi = (kind: unknown) => (FEES_BY_API as readonly string[]).includes(String(kind));

export interface WeightRule {
  freeKg: number;
  perKg: number;
  onReturn: boolean;
}
/** ZR's weight fee: 50 DA a kg above 5 kg, on the delivery and on the return. */
export const ZR_WEIGHT: WeightRule = { freeKg: 5, perKg: 50, onReturn: true };
const NONE: WeightRule = { freeKg: 0, perKg: 0, onReturn: true };

/** A company's weight rule: its own (config « overweight »), else ZR's for ZR, else none. */
export function weightRuleOf(kind: unknown, config: unknown): WeightRule {
  const cfg = (typeof config === 'string' ? JSON.parse(config) : config ?? {}) as any;
  const w = cfg.overweight ?? cfg.weight;
  if (w && (w.perKg ?? w.per_kg) !== undefined)
    return { freeKg: Number(w.freeKg ?? w.free_kg ?? 0) || 0, perKg: Number(w.perKg ?? w.per_kg ?? 0) || 0, onReturn: w.onReturn !== false && w.on_return !== false };
  return kind === 'zr' || kind === 'zr_legacy' ? ZR_WEIGHT : NONE;
}

/** ZR weighs in whole kilos (no comma): 5 kg → none above, 6 kg → 1 kg above. */
export const wholeKg = (kg: number | null | undefined) => (kg && isFinite(kg) && kg > 0 ? Math.round(kg) : null);

/** The weight fee for this weight: every whole kilo above the free ones (ZR: 5 kg → 0, 6 kg → 50 DA, 7 kg → 100 DA). */
export function weightFee(kg: number | null | undefined, r: WeightRule): number {
  const w = wholeKg(kg);
  if (w === null || r.perKg <= 0) return 0;
  const above = w - Math.round(r.freeKg);
  return above > 0 ? above * r.perKg : 0;
}

/** The weight Pilotix declares to the courier for a parcel: its products' weight, whole kilos, at least 1 kg. */
export const declaredKg = (productsKg: unknown) => Math.max(1, Math.round(Number(productsKg) || 0));

/** orders.courier_fees */
export interface CourierFees {
  delivery: number | null;
  ret: number | null;
  /** the weight the courier counts */
  kg: number | null;
  /** its weight fee, exact (from its payment) */
  weight: number | null;
  /** the weight fee counted from `kg` (delivery, return) until the exact one comes */
  est: number;
  estRet: number;
  at: string;
  src: 'send' | 'track' | 'pay';
}

export function courierFeesOf(v: unknown): CourierFees | null {
  const f = (typeof v === 'string' ? JSON.parse(v) : v) as Partial<CourierFees> | null;
  if (!f || typeof f !== 'object') return null;
  const n = (x: unknown) => (x === null || x === undefined || !isFinite(Number(x)) ? null : Number(x));
  return { delivery: n(f.delivery), ret: n(f.ret), kg: n(f.kg), weight: n(f.weight), est: n(f.est) ?? 0, estRet: n(f.estRet) ?? 0, at: String(f.at ?? ''), src: (f.src as CourierFees['src']) ?? 'track' };
}

/** A parcel's fees by the courier's API: what it takes on the delivery and on a return (price + weight fee); null = none known. */
export function apiFees(v: unknown) {
  const f = courierFeesOf(v);
  if (!f || (f.delivery === null && f.ret === null)) return null;
  const weight = f.weight ?? f.est;
  const weightRet = f.weight ?? f.estRet;
  return { delivery: f.delivery, ret: f.ret, weight, weightRet, kg: f.kg, exact: f.weight !== null, src: f.src };
}

/**
 * Keeps what the courier says for a parcel (at sending, in a status, in a payment) — an exact weight fee is never lost to
 * a later status — and, while its money is not received, the order's courier cost (what the caisse takes off) follows:
 * the courier's delivery price + its weight fee. Returns whether something changed.
 */
export async function saveCourierFees(db: Db, orderId: number, c: CourierCosts, src: CourierFees['src'], rule: WeightRule, nowIso: string): Promise<boolean> {
  const row = (await db.query('SELECT courier_fees FROM orders WHERE id = $1', [orderId]))[0];
  if (!row) return false;
  const cur = courierFeesOf(row.courier_fees);
  const keep = <T>(v: T | null | undefined, old: T | null | undefined) => (v === null || v === undefined ? (old ?? null) : v);
  const kg = keep(c.kg, cur?.kg);
  const next: CourierFees = {
    delivery: keep(c.delivery, cur?.delivery),
    ret: keep(c.ret, cur?.ret),
    kg,
    weight: src === 'pay' ? keep(c.weight, cur?.weight) : (cur?.weight ?? null),
    est: weightFee(kg, rule),
    estRet: rule.onReturn ? weightFee(kg, rule) : 0,
    at: nowIso,
    src: cur?.src === 'pay' && src !== 'pay' ? 'pay' : src,
  };
  if (cur && cur.delivery === next.delivery && cur.ret === next.ret && cur.kg === next.kg && cur.weight === next.weight && cur.est === next.est) return false;
  const cost = next.delivery === null ? null : next.delivery + (next.weight ?? next.est);
  await db.query(`UPDATE orders SET courier_fees = $2, delivery_cost = CASE WHEN $3::int IS NOT NULL AND NOT cashed THEN $3::int ELSE delivery_cost END WHERE id = $1`, [orderId, JSON.stringify(next), cost]);
  return true;
}

/** A company's weight rule, read once. */
export async function companyWeightRule(db: Db, companyId: number): Promise<WeightRule> {
  const c = (await db.query('SELECT kind, config FROM delivery_companies WHERE id = $1', [companyId]))[0];
  return weightRuleOf(c?.kind, c?.config);
}

/** A courier payment's parcels: each one's fees as the courier counted them (its prices, its exact weight fee). */
export async function applyPayFees(db: Db, companyId: number, lines: { tracking: string | null; fees?: CourierCosts }[], nowIso: string): Promise<number> {
  const withFees = lines.filter((l) => l.tracking && l.fees);
  if (!withFees.length) return 0;
  const rule = await companyWeightRule(db, companyId);
  const orders = await db.query('SELECT id, tracking FROM orders WHERE company_id = $1 AND tracking = ANY($2)', [companyId, withFees.map((l) => l.tracking)]);
  let n = 0;
  for (const o of orders) {
    const l = withFees.find((x) => x.tracking === o.tracking)!;
    if (await saveCourierFees(db, num(o.id), l.fees!, 'pay', rule, nowIso)) n++;
  }
  return n;
}
