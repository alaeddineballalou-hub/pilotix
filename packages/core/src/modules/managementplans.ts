import { z } from 'zod';
import { proc, forbidden, bad, notFound } from '../rpc';
import { simulateManagementPlan, validatePriceBrackets } from '@pilotix/shared';

import { agencyAdmin, agencyPayroll, billingTargets, json, period, proposeBilling } from './planledger';

const Amount = z.number().finite().min(0).max(10_000_000);
const Pct = z.number().finite().min(0).max(100);
const Config = z.object({
  method: z.enum(['none','fixed','percent','tier']),
  trigger: z.enum(['confirmed','delivered']),
  rate: Amount,
  tiers: z.tuple([Amount,Amount,Amount]),
  thresholds: z.tuple([Amount,Amount]).optional(),
  ranges: z.array(z.object({from:z.number().int().min(0),to:z.number().int().min(0).nullable(),amount:Amount})).min(1).max(100).optional(),
  monthly: Amount,
  bonus: z.object({ enabled:z.boolean(),threshold:z.number().int().min(0).max(1_000_000),amount:Amount }),
  upsell: z.object({ enabled:z.boolean(),method:z.enum(['double','qty','fixed','percent']),rate:Amount,trigger:z.enum(['confirmed','delivered']),ruleVersion:z.literal(2).optional() }),
}).strict();
const Kind = z.enum(['billing','agent']);
const Id = z.number().int().positive();
function needSellerAdmin(ctx: any) {
  if (ctx.shop?.kind === 'marketer' || !ctx.session?.isAdmin) throw forbidden('Réservé à l’administrateur de la boutique ou de l’agence');
}
function validPlan(c: z.infer<typeof Config>) {
  if (c.method === 'percent' && c.rate > 100) throw bad('Le pourcentage ne peut pas dépasser 100');
  if (c.upsell.method === 'percent' && c.upsell.rate > 100) throw bad('Le pourcentage upsell ne peut pas dépasser 100');
  if (c.upsell.enabled && ['double','qty'].includes(c.upsell.method) && (c.method === 'none' || (!c.upsell.ruleVersion && c.trigger !== 'confirmed'))) throw bad('Double confirmation ou QTY nécessite une commission principale');
  if (c.upsell.ruleVersion===2 && c.upsell.enabled && c.upsell.trigger!=='delivered') throw bad('Upsell uniquement à la livraison');
  if (c.upsell.ruleVersion===2 && c.bonus.enabled) throw bad('Configurez les bonus dans leur onglet séparé');
  if(c.method==='tier'&&c.ranges){const err=validatePriceBrackets(c.ranges);if(err)throw bad(err);}
  // Validate with the same calculator used for the UI simulation.
  try { simulateManagementPlan(c, {productPrice:16950,operations:1,upsells:1,incrementalValue:1000}); }
  catch(e) { throw bad(e instanceof Error?e.message:'Configuration invalide'); }
}
export const managementPlanProcs = {
  'management.plans': proc([], z.object({}), async ctx => {
    needSellerAdmin(ctx);
    const plans = await ctx.db.query('SELECT id, kind, name, configuration, active FROM management_payment_plans ORDER BY id DESC');
    const assignments = await ctx.db.query('SELECT target_kind, target_id, plan_id FROM management_plan_assignments');
    return { plans: plans.map(p=>({id:Number(p.id),kind:p.kind,name:p.name,configuration:typeof p.configuration==='string'?JSON.parse(p.configuration):p.configuration,active:p.active})),
      assignments:assignments.map(a=>({targetKind:a.target_kind as string,targetId:Number(a.target_id),planId:Number(a.plan_id)})) };
  }),
  'management.planSave': proc([], z.object({ id:Id.optional(),kind:Kind,name:z.string().trim().min(1).max(100),configuration:Config }), async (ctx,i) => {
    needSellerAdmin(ctx); validPlan(i.configuration);
    if (i.id) {
      const old = (await ctx.db.query('SELECT kind FROM management_payment_plans WHERE id=$1 AND active=true',[i.id]))[0];
      if (!old) throw notFound('Plan introuvable');
      if (old.kind !== i.kind) throw bad('Le type de plan ne peut pas changer');
      if((await ctx.db.query("SELECT 1 FROM management_plan_assignments WHERE plan_id=$1 UNION ALL SELECT 1 FROM management_billing_terms WHERE plan_id=$1 AND status IN ('pending','accepted') LIMIT 1",[i.id])).length)throw bad('Plan affecté : dupliquez-le avant modification');
      await ctx.db.query('UPDATE management_payment_plans SET name=$2,configuration=$3,updated_at=now() WHERE id=$1',[i.id,i.name,JSON.stringify(i.configuration)]);
      return { id:i.id };
    }
    const saved=(await ctx.db.query('INSERT INTO management_payment_plans (kind,name,configuration) VALUES ($1,$2,$3) RETURNING id',[i.kind,i.name,JSON.stringify(i.configuration)]))[0];
    return { id:Number(saved.id) };
  }),
  'management.planClone': proc([], z.object({id:Id}), async (ctx,i) => {
    needSellerAdmin(ctx);
    const old=(await ctx.db.query('SELECT kind,name,configuration FROM management_payment_plans WHERE id=$1',[i.id]))[0];
    if (!old) throw notFound('Plan introuvable');
    const r=(await ctx.db.query("INSERT INTO management_payment_plans(kind,name,configuration) VALUES($1,$2,$3) RETURNING id",[old.kind,old.name+' — Copie',JSON.stringify(json(old.configuration))]))[0];
    return {id:Number(r.id)};
  }),
  'management.planAssign': proc([], z.object({targetKind:z.enum(['product','agent']),targetId:Id,planId:Id.nullable()}), async (ctx,i)=>{
    needSellerAdmin(ctx);
    if(ctx.shop?.kind==='agency' && i.targetKind==='product') throw bad('Affectez un plan au contrat vendeur et à ses produits');
    await ctx.db.tx(async db=>{
      const target=(await db.query(i.targetKind==='product'?'SELECT id FROM products WHERE id=$1 FOR UPDATE':'SELECT id,roles,agency_id,active FROM profiles WHERE id=$1 FOR UPDATE',[i.targetId]))[0];
      if(!target)throw notFound('Utilisateur ou produit introuvable');
      if(i.targetKind==='agent' && (target.agency_id || !target.active || !target.roles.some((r:string)=>['confirmation','suivi','agent_manager'].includes(r)))) throw bad('Choisissez un agent actif de votre équipe');
      const plan=i.planId===null?null:(await db.query('SELECT * FROM management_payment_plans WHERE id=$1 AND active=true',[i.planId]))[0];
      if(i.planId!==null && (!plan || plan.kind!==(i.targetKind==='agent'?'agent':'billing')))throw bad('Plan incompatible ou inactif');
      if(i.targetKind==='agent') await db.query('INSERT INTO management_agent_terms(profile_id,plan_id,name,configuration,effective_at) VALUES($1,$2,$3,$4,$5)',[i.targetId,i.planId,plan?.name??'Aucun plan',plan?JSON.stringify(json(plan.configuration)):null,new Date(ctx.now()).toISOString()]);
      if(i.planId===null)await db.query('DELETE FROM management_plan_assignments WHERE target_kind=$1 AND target_id=$2',[i.targetKind,i.targetId]);
      else await db.query('INSERT INTO management_plan_assignments(target_kind,target_id,plan_id) VALUES($1,$2,$3) ON CONFLICT(target_kind,target_id) DO UPDATE SET plan_id=EXCLUDED.plan_id,updated_at=now()',[i.targetKind,i.targetId,i.planId]);
    });
    return {ok:true};
  }),
  'management.billingTargets': proc([],z.object({}),billingTargets),
  'management.billingPropose': proc([],z.object({linkId:Id,productId:z.number().int().min(0).default(0),planId:Id.nullable()}),proposeBilling),
  'management.payroll': proc([],z.object({month:z.string()}),(ctx,i)=>agencyPayroll(ctx,i.month)),
  'management.payrollClose': proc([],z.object({month:z.string()}),async(ctx,i)=>{
    agencyAdmin(ctx);
    const {to}=period(i.month);
    if(Date.parse(to)>ctx.now())throw bad('Attendez la fin du mois avant de valider la paie');
    const pay=await agencyPayroll(ctx,i.month);
    if(!pay.closedAt)await ctx.db.query('INSERT INTO management_payrolls(month,details,total,closed_at) VALUES($1,$2,$3,$4) ON CONFLICT(month) DO NOTHING',[i.month,JSON.stringify(pay.rows),pay.total,new Date(ctx.now()).toISOString()]);
    return {ok:true};
  }),
  'management.planDelete': proc([],z.object({id:Id}),async(ctx,i)=>{
    needSellerAdmin(ctx);
    return ctx.db.tx(async db=>{
      const p=(await db.query('SELECT id FROM management_payment_plans WHERE id=$1 AND active FOR UPDATE',[i.id]))[0];
      if(!p)throw notFound('Plan introuvable');
      const active=(await db.query("SELECT 1 FROM management_plan_assignments WHERE plan_id=$1 UNION ALL SELECT 1 FROM management_billing_terms WHERE plan_id=$1 AND status='pending' LIMIT 1",[i.id])).length;
      if(active)throw bad('Plan affecté : retirez les affectations avant de supprimer');
      const history=(await db.query("SELECT 1 FROM management_billing_terms WHERE plan_id=$1 UNION ALL SELECT 1 FROM management_agent_terms WHERE plan_id=$1 LIMIT 1",[i.id])).length;
      if(history)await db.query('UPDATE management_payment_plans SET active=false,updated_at=now() WHERE id=$1',[i.id]);
      else await db.query('DELETE FROM management_payment_plans WHERE id=$1',[i.id]);
      return {ok:true,archived:!!history};
    });
  }),
  'management.planArchive': proc([],z.object({id:Id}),async(ctx,i)=>{
    needSellerAdmin(ctx);
    const refs=(await ctx.db.query(`SELECT (SELECT count(*) FROM management_plan_assignments WHERE plan_id=$1) + (SELECT count(*) FROM management_billing_terms WHERE plan_id=$1 AND status='pending') AS n`,[i.id]))[0]?.n;
    if(Number(refs)>0) throw bad('Retirez les affectations avant d’archiver le plan');
    await ctx.db.query('UPDATE management_payment_plans SET active=false,updated_at=now() WHERE id=$1',[i.id]);
    return {ok:true};
  }),
};
