/** Payment rules, snapshotted when assigned to an agent or accepted by a seller. */
export type ManagementPlanKind = 'billing' | 'agent';
export type ManagementFeeMethod = 'none' | 'fixed' | 'percent' | 'tier';
export type ManagementUpsellMethod = 'double' | 'fixed' | 'percent';
export interface ManagementPlanConfig {
  method: ManagementFeeMethod;
  trigger: 'confirmed' | 'delivered';
  rate: number;
  tiers: [number, number, number];
  /** Upper bounds of the first two price brackets (defaults preserve existing plans). */
  thresholds?: [number, number];
  monthly: number;
  bonus: { enabled: boolean; threshold: number; amount: number };
  upsell: { enabled: boolean; method: ManagementUpsellMethod; rate: number; trigger: 'confirmed' | 'delivered' };
}
export const DEFAULT_MANAGEMENT_PLAN: ManagementPlanConfig = {
  method: 'fixed', trigger: 'confirmed', rate: 0, tiers: [0,0,0], thresholds: [10000,20000], monthly: 0,
  bonus: { enabled: false, threshold: 100, amount: 0 },
  upsell: { enabled: false, method: 'fixed', rate: 0, trigger: 'delivered' },
};
export interface ManagementSimulation {
  productPrice: number;
  operations: number;
  upsells: number;
  incrementalValue: number;
}
export function simulateManagementPlan(p: ManagementPlanConfig, s: ManagementSimulation) {
  const nonnegative = (v: number) => Number.isFinite(v) && v >= 0;
  if (![s.productPrice,s.operations,s.upsells,s.incrementalValue,p.monthly,p.rate,...p.tiers,p.bonus.threshold,p.bonus.amount,p.upsell.rate].every(nonnegative)) throw new Error('Valeur invalide');
  if (!Number.isInteger(s.operations) || !Number.isInteger(s.upsells)) throw new Error('Quantité invalide');
  if ((p.method === 'percent' && p.rate > 100) || (p.upsell.method === 'percent' && p.upsell.rate > 100)) throw new Error('Pourcentage invalide');
  const bounds = p.thresholds ?? [10000,20000];
  if (bounds.length !== 2 || !bounds.every(nonnegative) || bounds[0] <= 0 || bounds[1] <= bounds[0]) throw new Error('Tranches invalides : les seuils doivent être croissants');
  const fee = p.method === 'fixed' ? p.rate : p.method === 'percent' ? s.productPrice*p.rate/100 : p.method === 'tier' ? p.tiers[s.productPrice < bounds[0] ? 0 : s.productPrice < bounds[1] ? 1 : 2] : 0;
  if (p.upsell.enabled && p.upsell.method === 'double' && (p.method === 'none' || p.trigger !== 'confirmed')) throw new Error('Double confirmation nécessite une commission de confirmation');
  const upsellFee = !p.upsell.enabled ? 0 : p.upsell.method === 'double' ? fee : p.upsell.method === 'fixed' ? p.upsell.rate : s.incrementalValue*p.upsell.rate/100;
  const main = Math.round(fee)*s.operations;
  const bonus = p.bonus.enabled && s.operations >= p.bonus.threshold ? p.bonus.amount : 0;
  const upsell = Math.round(upsellFee)*s.upsells;
  return { monthly:p.monthly, main, bonus, upsell, total:Math.round(p.monthly+main+bonus+upsell) };
}
