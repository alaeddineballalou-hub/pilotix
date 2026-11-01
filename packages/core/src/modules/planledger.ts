// Effective-dated, immutable assignment copies. Editing a template never reprices past work.
import { AgencyCounts, BillLine, ManagementPlanConfig, NO_COUNTS, partnerBill, simulateManagementPlan } from '@pilotix/shared';
import { Db, iso, num } from '../db';
import { bad, Ctx, forbidden, notFound } from '../rpc';
import type { Tenancy } from '../platform/tenancy';
import type { Link } from './agencies';

export const json = (x: any): any => typeof x === 'string' ? JSON.parse(x) : x;
export function agencyAdmin(ctx: Ctx) {
  if (!ctx.session.isAdmin || ctx.shop?.kind !== 'agency' || !ctx.t) throw forbidden('Réservé à l’administrateur de l’agence');
  return ctx.t;
}
export function period(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw bad('Mois invalide');
  const [y,m] = month.split('-').map(Number);
  return { from:new Date(Date.UTC(y,m-1,1)-3600000).toISOString(), to:new Date(Date.UTC(y,m,1)-3600000).toISOString() };
}
interface Term {
  id:number; target:number; planId:number|null; name:string; config:ManagementPlanConfig|null; at:string;
}
const term = (r:any, target:string):Term => ({id:num(r.id),target:num(r[target]),planId:r.plan_id===null?null:num(r.plan_id),name:r.name,config:json(r.configuration),at:iso(r.effective_at)});
// Product-specific terms override the contract default; removing that override falls back to the default.
function chosen(terms:Term[], target:number, at:string):Term|undefined {
  const latest=(key:number)=>terms.filter(t=>t.target===key&&t.at<=at).sort((a,b)=>b.at.localeCompare(a.at)||b.id-a.id)[0];
  const own=latest(target);
  return target!==0 && !own?.config ? latest(0) : own ?? latest(0);
}
const cutoff = (to:string, now:number) => new Date(Math.min(Date.parse(to)-1,now)).toISOString();
function inRange(at:any, from:string, to:string) { return !!at && iso(at)>=from && iso(at)<to; }
interface Operation { price:number; product:number; upsell:number; confirmed:string|null; delivered:string|null; row:any; }
async function operations(db:Db, agency:number, from:string, to:string):Promise<Operation[]> {
  const rows=await db.query(`SELECT o.*, (SELECT unit_price FROM order_items WHERE order_id=o.id ORDER BY id LIMIT 1) AS first_price,
    (SELECT product_id FROM order_items WHERE order_id=o.id ORDER BY id LIMIT 1) AS first_product
    FROM sales o WHERE (o.conf_agency_id=$1 OR o.follow_agency_id=$1)
    AND ((o.confirmed_at >= $2 AND o.confirmed_at < $3) OR (o.delivered_at >= $2 AND o.delivered_at < $3))`,[agency,from,to]);
  return rows.map(r=>{
    const original=json(r.orig_items)?.[0];
    return {price:num(original?.unitPrice??r.first_price), product:num(r.route_product_id??original?.productId??r.first_product),upsell:num(r.upsell_value),
      confirmed:r.confirmed_at?iso(r.confirmed_at):null,delivered:r.delivered_at&&['delivered','exchanged'].includes(r.follow_status)?iso(r.delivered_at):null,row:r};
  });
}
interface Bucket { term:Term; main:number; upsell:number; count:number; upsells:number; }
function addEvent(buckets:Map<number,Bucket>, t:Term, o:Operation, event:'confirmed'|'delivered', upsellOwner=true) {
  if(!t.config) return;
  const p=t.config;
  const main=p.trigger===event;
  const up=upsellOwner&&o.upsell>0&&p.upsell.enabled&&p.upsell.trigger===event;
  if(!main&&!up) return;
  const calc=simulateManagementPlan({...p,monthly:0,bonus:{...p.bonus,enabled:false}},
    {productPrice:o.price,operations:main?1:0,upsells:up?1:0,incrementalValue:o.upsell});
  const b=buckets.get(t.id)??{term:t,main:0,upsell:0,count:0,upsells:0};
  b.main+=calc.main; b.upsell+=calc.upsell;b.count+=main?1:0;b.upsells+=up?1:0;buckets.set(t.id,b);
}
function planLines(buckets:Map<number,Bucket>, active:Term[]):BillLine[] {
  const lines:BillLine[]=[];
  const add=(label:string,qty:number,amount:number)=>{if(amount>0) lines.push({key:'plan',label,qty,price:qty?amount/qty:amount,amount});};
  for(const b of buckets.values()) {
    add(`${b.term.name} · ${b.term.config?.trigger==='confirmed'?'Confirmations':'Livraisons'}`,b.count,b.main);
    add(`${b.term.name} · Upsells`,b.upsells,b.upsell);
  }
  for(const t of active) {
    if(!t.config) continue;
    add(`${t.name} · Forfait mensuel`,1,t.config.monthly);
    const count=[...buckets.values()].filter(b=>b.term.target===t.target).reduce((n,b)=>n+b.count,0);
    if(t.config.bonus.enabled&&count>=t.config.bonus.threshold) add(`${t.name} · Prime d’objectif`,1,t.config.bonus.amount);
  }
  return lines;
}

/** A contract's actual bill, using accepted rules at the time of each operation. */
export async function contractBill(t:Tenancy,L:Link,month:string,counts:AgencyCounts,now:number) {
  const {from,to}=period(month);
  const monthly=!!L.info.startedAt&&L.info.startedAt<to&&(!L.info.endedAt||L.info.endedAt>=from);
  const legacy=()=>partnerBill(L.info.kind,L.info.prices,counts,{monthly});
  if(L.info.kind!=='agency'||!L.storeOk) return legacy();
  const rows=await t.shop(L.agencySchema).query(`SELECT * FROM management_billing_terms WHERE link_id=$1 AND status='accepted' AND effective_at<$2 ORDER BY effective_at,id`,[L.info.id,to]);
  if(!rows.length) return legacy();
  const terms=rows.map(r=>term(r,'product_id'));
  const old:AgencyCounts={...NO_COUNTS,received:counts.received,returned:counts.returned};
  const buckets=new Map<number,Bucket>();
  for(const o of await operations(t.shop(L.storeSchema),L.info.agency.id,from,to)) {
    for(const event of ['confirmed','delivered'] as const) {
      const at=o[event];
      if(!inRange(at,from,to)||at!<L.info.startedAt!||(L.info.endedAt&&at!>=L.info.endedAt)) continue;
      // Confirmation work belongs only to the agency that confirmed the order.
      if(event==='confirmed'&&num(o.row.conf_agency_id)!==L.info.agency.id) continue;
      // Once confirmed under a plan, the whole order (including later delivery/upsell) keeps that copy.
      const original=o.confirmed?chosen(terms,o.product,o.confirmed):undefined;
      const use=original?.config?original:chosen(terms,o.product,at!);
      if(use?.config) addEvent(buckets,use,o,event);
      else if(event==='confirmed') old.confirmed++;
      else {old.delivered++;if(o.upsell>0)old.upsells++;}
    }
  }
  const end=cutoff(to,Math.min(now,L.info.endedAt?Date.parse(L.info.endedAt)-1:now));
  const active=[...new Set(terms.map(t=>t.target))].map(target=>terms.filter(t=>t.target===target&&t.at<=end).sort((a,b)=>b.at.localeCompare(a.at)||b.id-a.id)[0]).filter((t):t is Term=>!!t);
  const defaultPlan=active.find(t=>t.target===0);
  const oldBill=partnerBill('agency',{...L.info.prices,monthly:defaultPlan?.config?0:L.info.prices.monthly},old,{monthly});
  const lines=[...oldBill.lines,...planLines(buckets,active)];
  return {lines,total:lines.reduce((n,l)=>n+l.amount,0)};
}

export async function billingTargets(ctx:Ctx) {
  const t=agencyAdmin(ctx);
  const links=await t.platform.query(`SELECT l.id,l.products,s.name,s.schema_name FROM platform.agency_links l JOIN platform.shops s ON s.id=l.store_id WHERE l.agency_id=$1 AND l.status='active' ORDER BY s.name,l.id`,[ctx.shop!.id]);
  const out=[];
  for(const l of links) {
    const products=await t.shop(l.schema_name).query(`SELECT id,name FROM products WHERE active AND archived_at IS NULL ${l.products?'AND id=ANY($1)':''} ORDER BY name`,l.products?[json(l.products)]:[]);
    const terms=await ctx.db.query(`SELECT id,product_id,plan_id,name,configuration,status,effective_at FROM management_billing_terms WHERE link_id=$1 AND status<>'rejected' ORDER BY proposed_at DESC,id DESC`,[l.id]);
    out.push({id:num(l.id),name:l.name as string,products:products.map(p=>({id:num(p.id),name:p.name as string})),terms:terms.map(r=>({id:num(r.id),productId:num(r.product_id),planId:r.plan_id===null?null:num(r.plan_id),name:r.name as string,configuration:json(r.configuration) as ManagementPlanConfig|null,status:r.status as string,effectiveAt:r.effective_at?iso(r.effective_at):null}))});
  }
  return out;
}
export async function proposeBilling(ctx:Ctx,i:{linkId:number;productId:number;planId:number|null}) {
  const t=agencyAdmin(ctx);
  const l=(await t.platform.query(`SELECT l.*,s.schema_name FROM platform.agency_links l JOIN platform.shops s ON s.id=l.store_id WHERE l.id=$1 AND l.agency_id=$2 AND l.status='active'`,[i.linkId,ctx.shop!.id]))[0];
  if(!l)throw notFound('Contrat actif introuvable');
  if(i.productId) {
    if(l.products&&!json(l.products).map(Number).includes(i.productId))throw forbidden('Produit non confié à votre agence');
    if(!(await t.shop(l.schema_name).query('SELECT 1 FROM products WHERE id=$1 AND active AND archived_at IS NULL',[i.productId])).length)throw notFound('Produit introuvable');
  }
  const p=i.planId===null?null:(await ctx.db.query(`SELECT * FROM management_payment_plans WHERE id=$1 AND kind='billing' AND active`,[i.planId]))[0];
  if(i.planId!==null&&!p)throw bad('Plan de facturation incompatible ou inactif');
  await ctx.db.tx(async db=>{
    // Serialize proposals for this contract and slot. Historical accepted copies are never updated.
    const active=(await db.query('SELECT status,agency_id FROM platform.agency_links WHERE id=$1 FOR UPDATE',[i.linkId]))[0];
    if(active?.status!=='active'||num(active.agency_id)!==ctx.shop!.id)throw bad('Ce contrat n’est plus actif');
    await db.query(`UPDATE management_billing_terms SET status='rejected' WHERE link_id=$1 AND product_id=$2 AND status='pending'`,[i.linkId,i.productId]);
    await db.query(`INSERT INTO management_billing_terms(link_id,product_id,plan_id,name,configuration,proposed_at) VALUES($1,$2,$3,$4,$5,$6)`,[i.linkId,i.productId,p?.id??null,p?.name??'Tarif historique / plan du contrat',p?JSON.stringify(json(p.configuration)):null,new Date(ctx.now()).toISOString()]);
  });
  return {ok:true};
}
/** The seller's view and decision are always checked against their own contract. */
export async function contractTerms(t:Tenancy,L:Link) {
  if(L.info.kind!=='agency')return [];
  const products=await t.shop(L.storeSchema).query('SELECT id,name FROM products');
  const names=new Map(products.map(p=>[num(p.id),String(p.name)]));
  return (await t.shop(L.agencySchema).query(`SELECT * FROM management_billing_terms WHERE link_id=$1 AND status<>'rejected' ORDER BY proposed_at DESC,id DESC`,[L.info.id])).map(r=>({id:num(r.id),productId:num(r.product_id),productName:num(r.product_id)?names.get(num(r.product_id))??'Produit archivé':'Tous les produits',name:String(r.name),configuration:json(r.configuration) as ManagementPlanConfig|null,status:String(r.status),effectiveAt:r.effective_at?iso(r.effective_at):null}));
}
export async function decideTerms(ctx:Ctx,L:Link,termId:number,accept:boolean) {
  if(!ctx.session.isAdmin||ctx.shop?.kind!=='store'||L.info.store.id!==ctx.shop.id||L.info.status!=='active')throw forbidden();
  const t=ctx.t!;
  await t.shop(L.agencySchema).tx(async db=>{
    const active=(await db.query('SELECT status,store_id FROM platform.agency_links WHERE id=$1 FOR UPDATE',[L.info.id]))[0];
    if(active?.status!=='active'||num(active.store_id)!==ctx.shop!.id)throw bad('Ce contrat n’est plus actif');
    const r=(await db.query(`SELECT * FROM management_billing_terms WHERE id=$1 AND link_id=$2 AND status='pending' FOR UPDATE`,[termId,L.info.id]))[0];
    if(!r)throw notFound('Proposition en attente introuvable');
    if(accept&&num(r.product_id)&&L.info.products&&!L.info.products.includes(num(r.product_id)))throw bad('Ce produit n’est plus confié à l’agence');
    await db.query(`UPDATE management_billing_terms SET status=$2,effective_at=$3 WHERE id=$1`,[termId,accept?'accepted':'rejected',accept?new Date(ctx.now()).toISOString():null]);
  });
  return {ok:true};
}

/** Closing an employee closes future assignment accrual, while keeping their history. */
export async function stopAgentPlan(ctx:Ctx,id:number) {
  await ctx.db.tx(async db=>{
    const p=(await db.query('SELECT active,roles FROM profiles WHERE id=$1 FOR UPDATE',[id]))[0];
    if(p?.active&&p.roles.some((r:string)=>['confirmation','suivi','agent_manager'].includes(r)))return;
    if(!(await db.query("SELECT 1 FROM management_plan_assignments WHERE target_kind='agent' AND target_id=$1",[id])).length)return;
    await db.query('INSERT INTO management_agent_terms(profile_id,plan_id,name,configuration,effective_at) VALUES($1,NULL,$2,NULL,$3)',[id,'Affectation terminée',new Date(ctx.now()).toISOString()]);
    await db.query("DELETE FROM management_plan_assignments WHERE target_kind='agent' AND target_id=$1",[id]);
  });
}
/** A fixed monthly salary is counted once if its assignment worked in this month, including a final month. */
function salaryTerm(history:Term[],from:string,end:string):Term|undefined {
  const sorted=[...history].sort((a,b)=>a.at.localeCompare(b.at)||a.id-b.id);
  return sorted.filter((t,i)=>t.config&&t.at<=end&&(!sorted[i+1]||sorted[i+1].at>from)&&(sorted[i+1]?.at!==t.at)).pop();
}

export async function agencyPayroll(ctx:Ctx,month:string) {
  const t=agencyAdmin(ctx);const {from,to}=period(month);
  const frozen=(await ctx.db.query('SELECT details,closed_at,total FROM management_payrolls WHERE month=$1',[month]))[0];
  if(frozen)return {month,rows:json(frozen.details) as {id:number;name:string;operations:number;lines:BillLine[];total:number}[],total:num(frozen.total),closedAt:iso(frozen.closed_at)};
  const people=await ctx.db.query('SELECT id,name,email FROM profiles WHERE agency_id IS NULL ORDER BY name');
  const terms=(await ctx.db.query('SELECT * FROM management_agent_terms WHERE effective_at<$1 ORDER BY effective_at,id',[to])).map(r=>term(r,'profile_id'));
  const links=await t.platform.query(`SELECT DISTINCT s.schema_name FROM platform.agency_links l JOIN platform.shops s ON s.id=l.store_id WHERE l.agency_id=$1 AND l.started_at IS NOT NULL AND s.status<>'deleted'`,[ctx.shop!.id]);
  const byEmail=new Map(people.map(p=>[String(p.email).toLowerCase(),num(p.id)]));
  const buckets=new Map<number,Map<number,Bucket>>();
  for(const l of links) {
    const db=t.shop(l.schema_name);
    const profiles=await db.query('SELECT id,email,agency_profile_id FROM profiles WHERE agency_id=$1',[ctx.shop!.id]);
    const owned=new Set(people.map(p=>num(p.id)));
    const ids=new Map(profiles.map(p=>[num(p.id),owned.has(num(p.agency_profile_id))?num(p.agency_profile_id):byEmail.get(String(p.email).toLowerCase())]));
    for(const o of await operations(db,ctx.shop!.id,from,to))for(const event of ['confirmed','delivered'] as const) {
      const at=o[event];if(!inRange(at,from,to))continue;
      const actors=new Set<number>();
      const conf=num(o.row.conf_agency_id)===ctx.shop!.id?ids.get(num(o.row.agent_id)):undefined;
      if(conf)actors.add(conf);
      if(event==='delivered'&&num(o.row.follow_agency_id)===ctx.shop!.id){const f=ids.get(num(o.row.follow_agent_id));if(f)actors.add(f);}
      for(const id of actors){const history=terms.filter(t=>t.target===id);
        const original=id===conf&&o.confirmed?chosen(history,id,o.confirmed):undefined;
        const use=original?.config?original:chosen(history,id,at!);if(!use?.config)continue;
        const b=buckets.get(id)??new Map<number,Bucket>();addEvent(b,use,o,event,id===conf);buckets.set(id,b);}
    }
  }
  const rows=people.filter(p=>terms.some(t=>t.target===num(p.id))).map(p=>{
    const id=num(p.id);const active=salaryTerm(terms.filter(t=>t.target===id),from,cutoff(to,ctx.now()));
    const b=buckets.get(id)??new Map<number,Bucket>();
    const lines=planLines(b,active?[active]:[]);
    return {id,name:String(p.name),operations:[...b.values()].reduce((n,b)=>n+b.count,0),lines,total:lines.reduce((n,l)=>n+l.amount,0)};
  });
  return {month,rows,total:rows.reduce((n,r)=>n+r.total,0),closedAt:null as string|null};
}
