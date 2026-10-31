import { z } from 'zod';
import { proc, forbidden, bad, notFound } from '../rpc';
import { DEFAULT_MANAGEMENT_PLAN, simulateManagementPlan } from '@pilotix/shared';

const Amount = z.number().finite().min(0).max(10_000_000);
const Pct = z.number().finite().min(0).max(100);
const Config = z.object({
  method: z.enum(['none','fixed','percent','tier']),
  trigger: z.enum(['confirmed','delivered']),
  rate: Amount,
  tiers: z.tuple([Amount,Amount,Amount]),
  monthly: Amount,
  bonus: z.object({ enabled:z.boolean(),threshold:z.number().int().min(0).max(1_000_000),amount:Amount }),
  upsell: z.object({ enabled:z.boolean(),method:z.enum(['double','fixed','percent']),rate:Amount,trigger:z.enum(['confirmed','delivered']) }),
}).strict();
const Kind = z.enum(['billing','agent']);
const Id = z.number().int().positive();
function needSellerAdmin(ctx: any) {
  if (ctx.shop?.kind === 'marketer' || !ctx.session?.isAdmin) throw forbidden('Réservé à l’administrateur de la boutique ou de l’agence');
}
function validPlan(c: z.infer<typeof Config>) {
  if (c.method === 'percent' && c.rate > 100) throw bad('Le pourcentage ne peut pas dépasser 100');
  if (c.upsell.method === 'percent' && c.upsell.rate > 100) throw bad('Le pourcentage upsell ne peut pas dépasser 100');
  if (c.upsell.enabled && c.upsell.method === 'double' && (c.method === 'none' || c.trigger !== 'confirmed')) throw bad('Double confirmation nécessite une commission de confirmation');
  // Validate with the same calculator used for the UI simulation.
  simulateManagementPlan(c, {productPrice:16950,operations:1,upsells:1,incrementalValue:1000});
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
      const old = (await ctx.db.query('SELECT kind FROM management_payment_plans WHERE id=$1',[i.id]))[0];
      if (!old) throw notFound('Plan introuvable');
      if (old.kind !== i.kind) throw bad('Le type de plan ne peut pas changer');
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
    const r=(await ctx.db.query("INSERT INTO management_payment_plans(kind,name,configuration) VALUES($1,$2,$3) RETURNING id",[old.kind,old.name+' — Copie',JSON.stringify(old.configuration)]))[0];
    return {id:Number(r.id)};
  }),
  'management.planAssign': proc([], z.object({targetKind:z.enum(['product','agent']),targetId:Id,planId:Id.nullable()}), async (ctx,i)=>{
    needSellerAdmin(ctx);
    if (i.planId===null){await ctx.db.query('DELETE FROM management_plan_assignments WHERE target_kind=$1 AND target_id=$2',[i.targetKind,i.targetId]);return {ok:true};}
    const plan=(await ctx.db.query('SELECT kind FROM management_payment_plans WHERE id=$1 AND active=true',[i.planId]))[0];
    if (!plan || plan.kind !== (i.targetKind==='agent'?'agent':'billing')) throw bad('Plan incompatible ou inactif');
    const target= i.targetKind==='product' ? (await ctx.db.query('SELECT id FROM products WHERE id=$1',[i.targetId]))[0] : (await ctx.db.query('SELECT id FROM profiles WHERE id=$1',[i.targetId]))[0];
    if(!target) throw notFound('Utilisateur ou produit introuvable');
    await ctx.db.query('INSERT INTO management_plan_assignments(target_kind,target_id,plan_id) VALUES($1,$2,$3) ON CONFLICT(target_kind,target_id) DO UPDATE SET plan_id=EXCLUDED.plan_id,updated_at=now()',[i.targetKind,i.targetId,i.planId]);
    return {ok:true};
  }),
  'management.planArchive': proc([],z.object({id:Id}),async(ctx,i)=>{
    needSellerAdmin(ctx);
    const refs=(await ctx.db.query('SELECT count(*)::int AS n FROM management_plan_assignments WHERE plan_id=$1',[i.id]))[0]?.n;
    if(Number(refs)>0) throw bad('Retirez les affectations avant d’archiver le plan');
    await ctx.db.query('UPDATE management_payment_plans SET active=false,updated_at=now() WHERE id=$1',[i.id]);
    return {ok:true};
  }),
};
