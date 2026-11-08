/** Payment rules, snapshotted when assigned to an agent or accepted by a seller. */
export type ManagementPlanKind = 'billing' | 'agent';
export type ManagementFeeMethod = 'none' | 'fixed' | 'percent' | 'tier';
export type ManagementUpsellMethod = 'double' | 'qty' | 'fixed' | 'percent';
/** The job a plan pays: confirming orders, following parcels, leading a team (its delivered orders), preparing parcels. */
export type AgentPlanTask = 'confirmation' | 'suivi' | 'superviseur' | 'depot';
export interface EditablePriceBracket {from:number;to:number|null;amount:number}
export interface ManagementPlanConfig {
  /** Agent Pay only. Plans created before task selection belong to confirmation. */
  agentTask?: AgentPlanTask;
  method: ManagementFeeMethod;
  /** the event that pays: a dépôt plan pays each order the first time it is prepared */
  trigger: 'confirmed' | 'delivered' | 'prepared';
  rate: number;
  tiers: [number, number, number];
  /** Upper bounds of the first two price brackets (defaults preserve existing plans). */
  thresholds?: [number, number];
  /** Variable-length editable ranges; legacy plans use tiers+thresholds. */
  ranges?: EditablePriceBracket[];
  monthly: number;
  bonus: { enabled: boolean; threshold: number; amount: number };
  upsell: { enabled: boolean; method: ManagementUpsellMethod; rate: number; trigger: 'confirmed' | 'delivered'; ruleVersion?: 2 };
}
export const DEFAULT_MANAGEMENT_PLAN: ManagementPlanConfig = {
  method: 'fixed', trigger: 'confirmed', rate: 0, tiers: [0,0,0], thresholds: [10000,20000], monthly: 0,
  bonus: { enabled: false, threshold: 100, amount: 0 },
  upsell: { enabled: false, method: 'double', rate: 0, trigger: 'delivered', ruleVersion: 2 },
};
export interface ManagementSimulation {
  productPrice: number;
  operations: number;
  upsells: number;
  incrementalValue: number;
  /** The quantity on the first accepted order and the actual delivered line quantity. */
  originalQty?: number;
  deliveredQty?: number;
}
export const agentPlanTask = (p: ManagementPlanConfig): AgentPlanTask => p.agentTask ?? 'confirmation';
export function planPriceBrackets(p: ManagementPlanConfig): EditablePriceBracket[] {
  if(p.ranges) return p.ranges;
  const [a,b]=p.thresholds??[10000,20000];
  return [{from:0,to:a-1,amount:p.tiers[0]},{from:a,to:b-1,amount:p.tiers[1]},{from:b,to:null,amount:p.tiers[2]}];
}
export function validatePriceBrackets(ranges: EditablePriceBracket[]): string|null {
  if(!ranges.length || ranges.length>100) return 'Entre 1 et 100 tranches nécessaires';
  for(let i=0;i<ranges.length;i++){
    const r=ranges[i];
    if(!Number.isSafeInteger(r.from)||r.from<0||!Number.isFinite(r.amount)||r.amount<0||r.amount>10000000||
      (r.to!==null&&(!Number.isSafeInteger(r.to)||r.to<r.from)))return 'Tranche invalide';
    if(i===0&&r.from!==0)return 'La première tranche commence à 0';
    if(i>0){const prev=ranges[i-1];if(prev.to===null)return 'Une tranche sans limite doit être la dernière';
      if(r.from!==prev.to+1)return r.from<=prev.to?'Tranches chevauchantes':'Intervalle non couvert';}
    if(i===ranges.length-1&&r.to!==null)return 'La dernière tranche doit être sans limite';
  }
  return null;
}
export function simulateManagementPlan(p: ManagementPlanConfig, s: ManagementSimulation) {
  // A suivi plan cannot earn upsell, including old or forged configuration copies.
  if (p.agentTask === 'suivi') {
    if (p.trigger !== 'delivered') throw new Error('Un plan de suivi est rémunéré à la livraison');
    p = { ...p, upsell: { ...p.upsell, enabled: false, rate: 0 } };
  }
  // a dépôt plan pays each prepared order and never an upsell; a team leader is paid when his team's orders are delivered
  if (p.agentTask === 'depot') {
    if (p.trigger !== 'prepared') throw new Error('Un plan de dépôt est rémunéré à la préparation');
    p = { ...p, upsell: { ...p.upsell, enabled: false, rate: 0 } };
  }
  if (p.agentTask === 'superviseur' && p.trigger !== 'delivered') throw new Error('Un plan de superviseur est rémunéré à la livraison des commandes de son équipe');
  if (p.agentTask !== 'depot' && p.trigger === 'prepared') throw new Error('Seul un plan de dépôt est rémunéré à la préparation');
  const nonnegative = (v: number) => Number.isFinite(v) && v >= 0;
  if (![s.productPrice,s.operations,s.upsells,s.incrementalValue,p.monthly,p.rate,...p.tiers,p.bonus.threshold,p.bonus.amount,p.upsell.rate,...(s.originalQty===undefined?[]:[s.originalQty]),...(s.deliveredQty===undefined?[]:[s.deliveredQty])].every(nonnegative)) throw new Error('Valeur invalide');
  if (!Number.isInteger(s.operations) || !Number.isInteger(s.upsells) || (s.originalQty!==undefined&&!Number.isInteger(s.originalQty)) || (s.deliveredQty!==undefined&&!Number.isInteger(s.deliveredQty))) throw new Error('Quantité invalide');
  if ((p.method === 'percent' && p.rate > 100) || (p.upsell.method === 'percent' && p.upsell.rate > 100)) throw new Error('Pourcentage invalide');
  const bounds = p.thresholds ?? [10000,20000];
  if (!p.ranges && (bounds.length !== 2 || !bounds.every(nonnegative) || bounds[0] <= 0 || bounds[1] <= bounds[0])) throw new Error('Tranches invalides : les seuils doivent être croissants');
  const brackets=planPriceBrackets(p);
  if(p.method==='tier'){const err=validatePriceBrackets(brackets);if(err)throw new Error(err);}
  const fee = p.method === 'fixed' ? p.rate : p.method === 'percent' ? s.productPrice*p.rate/100 : p.method === 'tier' ? (brackets.find(r=>s.productPrice>=r.from&&(r.to===null||s.productPrice<=r.to))?.amount??0) : 0;
  if (p.upsell.enabled && ['double','qty'].includes(p.upsell.method) && (p.method === 'none' || (!p.upsell.ruleVersion && p.trigger !== 'confirmed'))) throw new Error('Double confirmation ou QTY nécessite une commission principale');
  if (p.upsell.ruleVersion===2 && p.upsell.enabled && p.upsell.trigger!=='delivered') throw new Error('Upsell toujours à la livraison');
  const increase=(s.deliveredQty??0)-(s.originalQty??0);
  const eligible=p.upsell.ruleVersion===2 ? increase>0 : true;
  // New rules use the product UNIT price, never extended line or order totals.
  // QTY is the number of extra units; Double is capped at one extra base commission.
  const upsellFee = !p.upsell.enabled || !eligible ? 0 : p.upsell.method==='double' ? fee :
    p.upsell.method==='qty' ? fee*Math.max(0,increase) :
    p.upsell.method==='fixed' ? p.upsell.rate :
    p.upsell.ruleVersion===2 ? s.productPrice*p.upsell.rate/100 : s.incrementalValue*p.upsell.rate/100;
  const main = Math.round(fee)*s.operations;
  const bonus = p.bonus.enabled && s.operations >= p.bonus.threshold ? p.bonus.amount : 0;
  const upsell = Math.round(upsellFee)*s.upsells;
  return { monthly:p.monthly, main, bonus, upsell, total:Math.round(p.monthly+main+bonus+upsell) };
}
