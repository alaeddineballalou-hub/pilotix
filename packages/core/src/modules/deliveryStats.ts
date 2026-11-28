// Suivi › Statistiques: one dispatch cohort and additive quantities, never averaged percentages.
import { kfRange, faultOfCourierWords } from '@pilotix/shared';
import { z } from 'zod';
import { Ctx, forbidden, proc } from '../rpc';
import { getSetting } from '../settings';
import { agencyLead, agencyOf, andSql, queueSql } from './agencyscope';
import { actedAtSql } from './alerttouch';

export const canDeliveryStats = (ctx: Ctx) => agencyOf(ctx) !== null
  ? agencyLead(ctx) && ctx.session.roles.includes('suivi')
  : ctx.shop?.kind !== 'agency' && ctx.shop?.kind !== 'marketer' &&
    (ctx.session.isAdmin || ctx.session.roles.includes('vendeur') || ctx.session.roles.includes('agent_manager'));

const input = z.object({
  per: z.enum(['today','yesterday','7','30','month','custom']).default('30'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type DeliveryTotals = { sent:number; delivered:number; without:number; with:number; returns:number; exchanges:number; active:number; other:number; damage:number; delayMs:number; delayN:number; attempts:number; attemptsN:number };
export const blankDeliveryTotals = (): DeliveryTotals => ({sent:0,delivered:0,without:0,with:0,returns:0,exchanges:0,active:0,other:0,damage:0,delayMs:0,delayN:0,attempts:0,attemptsN:0});
export function addDeliveryTotals(a: DeliveryTotals,b: DeliveryTotals): DeliveryTotals {
  const x = blankDeliveryTotals();
  for (const k of Object.keys(x) as (keyof DeliveryTotals)[]) x[k]=a[k]+b[k];
  return x;
}
export type DeliveryGroup = {key:string;name:string;totals:DeliveryTotals};
export type DeliveryStatsRow = {product: {key:string;name:string}; company:{key:string;name:string}; team:{key:string;name:string}; totals:DeliveryTotals};
export function summarizeDeliveryRows(rows:DeliveryStatsRow[]) {
  return rows.reduce((a,r)=>addDeliveryTotals(a,r.totals),blankDeliveryTotals());
}
export function groupDeliveryRows(rows:DeliveryStatsRow[], group:'product'|'company'|'team'): DeliveryGroup[] {
  const map = new Map<string,DeliveryGroup>();
  for (const r of rows) {
    const g=r[group]; const old=map.get(g.key);
    map.set(g.key,{...g,totals:addDeliveryTotals(old?.totals??blankDeliveryTotals(),r.totals)});
  }
  return [...map.values()];
}
async function deliveryStats(ctx:Ctx,i:z.infer<typeof input>) {
  if (!canDeliveryStats(ctx)) throw forbidden();
  const {a,b}=kfRange(ctx.now(),i);
  const teams=await getSetting(ctx.db,'teams');
  const scope=queueSql(ctx,'follow');
  // A manager's statistics contain only assigned orders in their follow-up teams, not the free queue.
  const manager=agencyOf(ctx)===null&&!ctx.session.isAdmin&&!ctx.session.roles.includes('vendeur');
  const managed=manager ? [...new Set([ctx.session.profile.id,...teams.filter(t=>t.managerId===ctx.session.profile.id).flatMap(t=>t.agentIds)])] : [];
  const rows=await ctx.db.query(`SELECT o.id,o.follow_status,o.sub_status,o.ext_status,o.shipped_at,o.delivered_at,o.delivery_attempts,
    o.follow_agent_id,o.follow_agency_id,o.company_id,co.name AS company_name,o.livreur_id,
    COALESCE(o.route_product_id, it.product_id) AS product_id,COALESCE(p.name,it.name) AS product_name,
    EXISTS(SELECT 1 FROM (${actedAtSql('o')}) a WHERE a.at>o.shipped_at AND a.at<=COALESCE(o.delivered_at,now())) AS acted,
    (EXISTS(SELECT 1 FROM claims c WHERE c.order_id=o.id AND c.reason='damaged')
      OR EXISTS(SELECT 1 FROM order_faults f WHERE f.order_id=o.id AND f.reason='broken')) AS damage
    FROM sales o LEFT JOIN delivery_companies co ON co.id=o.company_id
    LEFT JOIN LATERAL (SELECT product_id,name FROM order_items WHERE order_id=o.id ORDER BY is_upsell,id LIMIT 1) it ON true
    LEFT JOIN products p ON p.id=COALESCE(o.route_product_id,it.product_id)
    WHERE o.shipped_at >= $1 AND o.shipped_at < $2${andSql(scope)}
    ${manager?' AND o.follow_agent_id = ANY($3::bigint[])':''}`,
    [new Date(a).toISOString(),new Date(b).toISOString(),...(manager?[managed]:[])]);
  const grouped=new Map<string,DeliveryStatsRow>();
  for(const o of rows) {
    const product={key:String(o.product_id??'none'),name:String(o.product_name??'Sans produit')};
    const company={key:String(o.company_id??(o.livreur_id?'own':'none')),name:String(o.company_name??(o.livreur_id?'Livreurs internes':'Sans société'))};
    const t=teams.find(t=>t.agentIds.includes(Number(o.follow_agent_id))||t.managerId===Number(o.follow_agent_id));
    const team=o.follow_agency_id ? {key:'agency:'+o.follow_agency_id,name:'Agence #'+o.follow_agency_id} : t ? {key:t.id,name:t.name} : {key:'none',name:'Non assigné'};
    const k=JSON.stringify([product.key,company.key,team.key]);
    let row=grouped.get(k);
    if(!row){row={product,company,team,totals:blankDeliveryTotals()};grouped.set(k,row);}
    const v=row.totals; v.sent++;
    const status=String(o.follow_status??'');
    if(status==='delivered'){
      v.delivered++; if(o.acted)v.with++;else v.without++;
      const ms=Date.parse(String(o.delivered_at))-Date.parse(String(o.shipped_at));
      if(Number.isFinite(ms)&&ms>=0){v.delayMs+=ms;v.delayN++;}
    }else if(status==='in_exchange'||o.sub_status==='annule_swappe')v.exchanges++;
    else if(status==='returned'||status==='returning')v.returns++;
    else if(['shipped','out_for_delivery','failed','alert'].includes(status))v.active++;
    else v.other++;
    if(o.damage||faultOfCourierWords(o.ext_status)==='broken')v.damage++;
    // Pilotix's counter records failed attempts. A delivered order adds the successful attempt.
    // A zero on a non-delivered order is not evidence of a known attempt count.
    const failed=Number(o.delivery_attempts);
    if(Number.isFinite(failed)&&failed>=0&&(failed>0||status==='delivered')){v.attempts+=failed+(status==='delivered'?1:0);v.attemptsN++;}
  }
  return {rows:[...grouped.values()]};
}
export const deliveryStatsProcs={
  'suivi.statsOn':proc(null,z.object({}),async(ctx)=>({on:canDeliveryStats(ctx)})),
  'suivi.stats':proc(null,input,deliveryStats),
};
