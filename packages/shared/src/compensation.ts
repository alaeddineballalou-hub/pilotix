/**
 * Configurable rates used by agency client invoices and employee Service Fee plans.
 * Pure calculator only: callers must supply authenticated, eligible, deduplicated events.
 * Monetary inputs are DA (integer); percentages are 0..100.
 *
 * No side effects, payroll authorization, event attribution, or payout persistence here.
 */
export type FeeBasis = 'confirmation' | 'delivery' | 'upsell' | 'task';
export type FeeMethod = 'fixed' | 'percent' | 'price_tier';
export interface PriceTier { from: number; to: number | null; amount: number; }
export interface FeeRule {
  id: string;
  basis: FeeBasis;
  method: FeeMethod;
  amount: number;
  tiers?: PriceTier[];
  /** Higher-level workflow decides which events are payable. */
  enabled: boolean;
}
export interface PerformanceBonus {
  id: string;
  metric: 'confirmed' | 'delivered' | 'upsells' | 'delivery_rate';
  atLeast: number;
  amount: number;
  repeat: 'once' | 'per_unit_above';
  enabled: boolean;
}
export type BasePay =
  | { mode: 'none' }
  | { mode: 'monthly'; amount: number }
  | { mode: 'hourly'; amount: number }
  | { mode: 'daily'; amount: number }
  | { mode: 'guaranteed_minimum'; amount: number };
export interface CompensationPlan {
  base: BasePay;
  rules: FeeRule[];
  bonuses: PerformanceBonus[];
}
export interface EligibleEvent {
  /** Stable per-event key, unique within the billing period. */
  id: string;
  basis: FeeBasis;
  /** Eligible merchandise base, excluding shipping and pre-existing upsell value. */
  productPrice: number;
  /** Only for upsells: positive net added merchandise value. */
  incrementalValue?: number;
}
export interface CompensationContext {
  events: EligibleEvent[];
  hours: number;
  days: number;
  confirmed: number;
  delivered: number;
  upsells: number;
  deliveryRate: number;
}
export interface CompensationBreakdown {
  base: number;
  commissions: number;
  bonuses: number;
  minimumTopUp: number;
  total: number;
  lines: { label: string; amount: number; sourceId?: string }[];
}
const validMoney = (v: number) => Number.isSafeInteger(v) && v >= 0;
const assertMoney = (v: number) => { if (!validMoney(v)) throw new Error('Invalid nonnegative DA amount'); };
const assertPct = (v: number) => { if (!Number.isFinite(v) || v < 0 || v > 100) throw new Error('Invalid percent'); };
const round = (v: number) => {
  if (!Number.isFinite(v) || v < 0 || v > Number.MAX_SAFE_INTEGER) throw new Error('Invalid calculated amount');
  return Math.round(v);
};
function tierPrice(tiers: PriceTier[], price: number): number {
  const sorted = [...tiers].sort((a, b) => a.from - b.from);
  let previousEnd = -1;
  for (const t of sorted) {
    assertMoney(t.from); assertMoney(t.amount);
    if (t.to !== null && (!validMoney(t.to) || t.to < t.from)) throw new Error('Invalid price tier');
    if (t.from <= previousEnd) throw new Error('Overlapping price tiers');
    if (previousEnd === Infinity) throw new Error('Tiers after open-ended tier');
    previousEnd = t.to ?? Infinity;
  }
  const hit = sorted.find(t => price >= t.from && (t.to === null || price <= t.to));
  if (!hit) throw new Error('Missing price tier');
  return hit.amount;
}
export function calculateCompensation(plan: CompensationPlan, ctx: CompensationContext): CompensationBreakdown {
  if (!Array.isArray(ctx.events)) throw new Error('Missing eligible events');
  for (const n of [ctx.hours, ctx.days, ctx.confirmed, ctx.delivered, ctx.upsells]) {
    if (!Number.isFinite(n) || n < 0) throw new Error('Invalid activity');
  }
  assertPct(ctx.deliveryRate);
  const ids = new Set<string>();
  const ruleIds = new Set<string>();
  const bonusIds = new Set<string>();
  let base = 0;
  if (plan.base.mode !== 'none') {
    assertMoney(plan.base.amount);
    if (plan.base.mode === 'monthly') base = plan.base.amount;
    if (plan.base.mode === 'daily') base = round(plan.base.amount * ctx.days);
    if (plan.base.mode === 'hourly') base = round(plan.base.amount * ctx.hours);
  }
  const lines: CompensationBreakdown['lines'] = [];
  if (base) lines.push({ label: 'base', amount: base });
  let commissions = 0;
  for (const r of plan.rules) {
    if (!r.id || ruleIds.has(r.id)) throw new Error('Duplicate fee rule ID');
    ruleIds.add(r.id);
    if (!r.enabled) continue;
    assertMoney(r.amount);
    if (r.method === 'percent') assertPct(r.amount);
  }
  for (const event of ctx.events) {
    if (!event.id || ids.has(event.id)) throw new Error('Duplicate eligible event');
    ids.add(event.id);
    assertMoney(event.productPrice);
    if (event.incrementalValue !== undefined) assertMoney(event.incrementalValue);
    for (const rule of plan.rules) {
      if (!rule.enabled || rule.basis !== event.basis) continue;
      const amount = event.basis === 'upsell' ? (event.incrementalValue ?? 0) : event.productPrice;
      const fee = rule.method === 'fixed' ? rule.amount : rule.method === 'percent' ? round(amount * rule.amount / 100) : tierPrice(rule.tiers ?? [], amount);
      commissions = round(commissions + fee);
      if (fee) lines.push({ label: rule.id, amount: fee, sourceId: event.id });
    }
  }
  let bonuses = 0;
  for (const bonus of plan.bonuses) {
    if (!bonus.id || bonusIds.has(bonus.id)) throw new Error('Duplicate bonus ID');
    bonusIds.add(bonus.id);
    if (!bonus.enabled) continue;
    assertMoney(bonus.amount);
    if (!Number.isFinite(bonus.atLeast) || bonus.atLeast < 0) throw new Error('Invalid bonus threshold');
    const actual = ctx[bonus.metric === 'delivery_rate' ? 'deliveryRate' : bonus.metric];
    const units = actual >= bonus.atLeast ? bonus.repeat === 'once' ? 1 : Math.floor(actual - bonus.atLeast) : 0;
    const value = round(units * bonus.amount);
    bonuses = round(bonuses + value);
    if (value) lines.push({ label: bonus.id, amount: value });
  }
  const minimumTopUp = plan.base.mode === 'guaranteed_minimum' ? Math.max(0, plan.base.amount - commissions - bonuses) : 0;
  if (minimumTopUp) lines.push({ label: 'minimumTopUp', amount: minimumTopUp });
  return { base, commissions, bonuses, minimumTopUp, total: round(base + commissions + bonuses + minimumTopUp), lines };
}
