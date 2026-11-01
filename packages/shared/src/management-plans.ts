/** Seller Management plan configuration, independent from existing partner invoice contracts. */
export type ManagementPlanKind = 'billing' | 'agent';
export type ManagementFeeMethod = 'none' | 'fixed' | 'percent' | 'tier';
export type ManagementUpsellMethod = 'double' | 'fixed' | 'percent';
export interface ManagementPlanConfig {
  method: ManagementFeeMethod;
  trigger: 'confirmed' | 'delivered';
  rate: number;
  tiers: [number, number, number]; // Legacy saved plans: 0–9999, 10000–19999, 20000+
  brackets?: { min: number; max: number | null; fee: number }[];
  monthly: number;
  bonus: { enabled: boolean; threshold: number; amount: number };
  upsell: { enabled: boolean; method: ManagementUpsellMethod; rate: number; trigger: 'confirmed' | 'delivered' };
}
export const DEFAULT_MANAGEMENT_PLAN: ManagementPlanConfig = {
  method: 'fixed', trigger: 'confirmed', rate: 0, tiers: [0,0,0], monthly: 0,
  bonus: { enabled: false, threshold: 100, amount: 0 },
  upsell: { enabled: false, method: 'fixed', rate: 0, trigger: 'delivered' },
};
export function priceBrackets(p: ManagementPlanConfig) {
  return p.brackets ?? [{min:0,max:9999,fee:p.tiers[0]},{min:10000,max:19999,fee:p.tiers[1]},{min:20000,max:null,fee:p.tiers[2]}];
}
export function validatePriceBrackets(b: ReturnType<typeof priceBrackets>) {
  if (b.length < 1 || b.length > 30 || b[0].min !== 0) throw new Error('La première tranche doit commencer à 0 DA');
  for(let i=0;i<b.length;i++) {
    const x=b[i];
    if(!Number.isSafeInteger(x.min)||x.min<0||!Number.isFinite(x.fee)||x.fee<0||x.fee>10000000) throw new Error('Tranche invalide');
    if(i===b.length-1 ? x.max!==null : x.max===null || !Number.isSafeInteger(x.max) || x.max<x.min || b[i+1].min!==x.max+1) throw new Error('Les tranches ne doivent avoir ni trou ni chevauchement; la dernière est sans limite');
  }
}
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
  if(p.method==='tier') validatePriceBrackets(priceBrackets(p));
  const fee = p.method === 'fixed' ? p.rate : p.method === 'percent' ? s.productPrice*p.rate/100 : p.method === 'tier' ? (priceBrackets(p).find(b=>s.productPrice>=b.min&&(b.max===null||s.productPrice<=b.max))?.fee ?? 0) : 0;
  if (p.upsell.enabled && p.upsell.method === 'double' && (p.method === 'none' || p.trigger !== 'confirmed')) throw new Error('Double confirmation nécessite une commission de confirmation');
  const upsellFee = !p.upsell.enabled ? 0 : p.upsell.method === 'double' ? fee : p.upsell.method === 'fixed' ? p.upsell.rate : s.incrementalValue*p.upsell.rate/100;
  const main = Math.round(fee*s.operations);
  const bonus = p.bonus.enabled && s.operations >= p.bonus.threshold ? p.bonus.amount : 0;
  const upsell = Math.round(upsellFee*s.upsells);
  return { monthly:p.monthly, main, bonus, upsell, total:Math.round(p.monthly+main+bonus+upsell) };
}
