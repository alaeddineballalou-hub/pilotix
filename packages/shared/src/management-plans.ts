/** Seller Management plan configuration, independent from existing partner invoice contracts. */
export type ManagementPlanKind = 'billing' | 'agent';
export type ManagementFeeMethod = 'none' | 'fixed' | 'percent' | 'tier';
export type ManagementUpsellMethod = 'double' | 'fixed' | 'percent';
export interface PriceTier { from: number; to: number | null; amount: number }
export interface ManagementPlanConfig {
  method: ManagementFeeMethod;
  trigger: 'confirmed' | 'delivered';
  rate: number;
  tiers: PriceTier[];
  monthly: number;
  bonus: { enabled: boolean; threshold: number; amount: number };
  upsell: { enabled: boolean; method: ManagementUpsellMethod; rate: number; trigger: 'confirmed' | 'delivered' };
}
export const DEFAULT_MANAGEMENT_PLAN: ManagementPlanConfig = {
  method: 'fixed', trigger: 'confirmed', rate: 0, tiers: [{from:0,to:9999,amount:0},{from:10000,to:19999,amount:0},{from:20000,to:null,amount:0}], monthly: 0,
  bonus: { enabled: false, threshold: 100, amount: 0 },
  upsell: { enabled: false, method: 'fixed', rate: 0, trigger: 'delivered' },
};
export interface ManagementSimulation {
  productPrice: number;
  operations: number;
  upsells: number;
  incrementalValue: number;
}
export function validatePriceTiers(tiers: PriceTier[]): string | null {
  if (!tiers.length) return 'Ajoutez au moins une tranche';
  if (tiers.length > 100) return 'Maximum 100 tranches';
  for (let i=0;i<tiers.length;i++){
    const t=tiers[i];
    if (!Number.isSafeInteger(t.from) || t.from<0 || !Number.isFinite(t.amount) || t.amount<0 || t.amount>10000000 ||
      (t.to!==null && (!Number.isSafeInteger(t.to)||t.to<t.from))) return 'Tranche invalide';
    if (i===0 && t.from!==0) return 'La première tranche doit commencer à 0';
    if(i>0){const prev=tiers[i-1];if(prev.to===null)return 'Une tranche illimitée doit être la dernière';if(t.from!==prev.to+1)return t.from<=prev.to?'Tranches chevauchantes':'Intervalle non couvert entre les tranches';}
    if(i===tiers.length-1 && t.to!==null)return 'La dernière tranche doit être sans limite';
  }
  return null;
}
export function simulateManagementPlan(p: ManagementPlanConfig, s: ManagementSimulation) {
  const nonnegative = (v: number) => Number.isFinite(v) && v >= 0;
  if (![s.productPrice,s.operations,s.upsells,s.incrementalValue,p.monthly,p.rate,...p.tiers.map(t=>t.amount),p.bonus.threshold,p.bonus.amount,p.upsell.rate].every(nonnegative)) throw new Error('Valeur invalide');
  if (!Number.isInteger(s.operations) || !Number.isInteger(s.upsells)) throw new Error('Quantité invalide');
  if ((p.method === 'percent' && p.rate > 100) || (p.upsell.method === 'percent' && p.upsell.rate > 100)) throw new Error('Pourcentage invalide');
  if (p.method === 'tier') { const error = validatePriceTiers(p.tiers); if (error) throw new Error(error); }
  const fee = p.method === 'fixed' ? p.rate : p.method === 'percent' ? s.productPrice*p.rate/100 : p.method === 'tier' ? (p.tiers.find(t=>s.productPrice >= t.from && (t.to === null || s.productPrice <= t.to))?.amount ?? 0) : 0;
  if (p.upsell.enabled && p.upsell.method === 'double' && (p.method === 'none' || p.trigger !== 'confirmed')) throw new Error('Double confirmation nécessite une commission de confirmation');
  const upsellFee = !p.upsell.enabled ? 0 : p.upsell.method === 'double' ? fee : p.upsell.method === 'fixed' ? p.upsell.rate : s.incrementalValue*p.upsell.rate/100;
  const main = Math.round(fee*s.operations);
  const bonus = p.bonus.enabled && s.operations >= p.bonus.threshold ? p.bonus.amount : 0;
  const upsell = Math.round(upsellFee*s.upsells);
  return { monthly:p.monthly, main, bonus, upsell, total:Math.round(p.monthly+main+bonus+upsell) };
}
