import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MANAGEMENT_PLAN, NO_AGENCY_PRICES } from '@pilotix/shared';
import { call, Ctx, login, migrate, migrateAll, pgliteTenancy, seedBase, shopCtx, shopStatus, provisionShop } from '../index';

const PW='Agency-Test-Password-123!';
const ym=(ms:number)=>new Date(ms+3600000).toISOString().slice(0,7);

test('V2 agency billing, agent payroll and separately accepted bonuses use real delivered quantity and unit price',async()=>{
 const {PGlite}=await import('@electric-sql/pglite');const pg=new PGlite();const t=pgliteTenancy(pg as any);
 try{
  await migrate(t.shop('public'),sql=>t.exec('public',sql));
  await seedBase(t.shop('public'),{name:'Pilotix',email:'platform-test@example.dz',password:PW});
  await migrateAll(t);
  const business=(await t.platform.query("SELECT id FROM platform.plans WHERE code='business'"))[0];
  const owner={name:'Owner',email:'owner-ppm@example.dz'};
  const store=await provisionShop(t,{name:'Example Seller',owner,password:PW,verified:true,kind:'store',planId:Number(business.id),trialDays:30});
  const agency=await provisionShop(t,{name:'Example Agency',owner,password:PW,verified:true,kind:'agency',planId:null,trialDays:0});
  let clock=Date.now()+60000;
  const ctx=async(s:any,email=owner.email):Promise<Ctx>=>({db:t.shop(s.schema),session:await login(t.shop(s.schema),email,PW),shop:shopCtx(s,shopStatus(s,clock,3)),t,now:()=>clock,emit:()=>{}});
  const chief=await ctx(agency),seller=await ctx(store);
  const rpc=(c:Ctx,n:string,i:any={})=>call(n,c,i) as Promise<any>;
  await t.platform.query('UPDATE platform.shops SET agency_verified_at=now() WHERE id=$1',[agency.id]);
  await rpc(chief,'agency.prices',{prices:{...NO_AGENCY_PRICES,perConfirmed:5}});
  const product=Number((await seller.db.query("INSERT INTO products(name,sku,price) VALUES('Velo','VELO-V2',10000) RETURNING id"))[0].id);
  const created=await rpc(chief,'users.create',{name:'Nora',email:'nora-ppm@example.dz',phone:'0712345678',password:PW,roles:['confirmation']});
  const link=await rpc(chief,'agency.request',{storeId:store.id,tasks:['confirmation','suivi']});
  await rpc(seller,'partners.answer',{id:link.id,accept:true,products:null});
  const mapped=Number((await seller.db.query('SELECT id FROM profiles WHERE agency_id=$1 AND agency_profile_id=$2',[agency.id,created.id]))[0].id);
  const cfg=(mode:'qty'|'double'|'percent'|'fixed',rate=0)=>({...structuredClone(DEFAULT_MANAGEMENT_PLAN),method:'fixed' as const,rate:100,monthly:0,bonus:{enabled:false,threshold:100,amount:0},upsell:{enabled:true,method:mode,rate,trigger:'delivered' as const,ruleVersion:2 as const}});
  const agentPlan=await rpc(chief,'management.planSave',{name:'Agent QTY',kind:'agent',configuration:cfg('qty')});
  const billPlan=await rpc(chief,'management.planSave',{name:'Seller QTY',kind:'billing',configuration:cfg('qty')});
  await rpc(chief,'management.planAssign',{targetKind:'agent',targetId:created.id,planId:agentPlan.id});
  await rpc(chief,'management.billingPropose',{linkId:link.id,productId:0,planId:billPlan.id});
  const proposal=(await rpc(seller,'partners.link',{id:link.id})).planTerms.find((x:any)=>x.status==='pending');
  await rpc(seller,'partners.decidePlan',{id:link.id,termId:proposal.id,accept:true});
  const order=await rpc(seller,'orders.create',{customerName:'Client',phone:'0661556600',wilayaId:31,commune:'Oran',items:[{productId:product,variantId:null,qty:5}]});
  const original=(await seller.db.query('SELECT orig_items FROM orders WHERE id=$1',[order.id]))[0].orig_items;
  assert.equal(Number((typeof original==='string'?JSON.parse(original):original)[0].qty),5);
  await seller.db.query('UPDATE order_items SET qty=7 WHERE order_id=$1',[order.id]);
  await seller.db.query("UPDATE orders SET conf_status='confirmed',confirmed_at=$2,agent_id=$3,conf_agency_id=$4,follow_status='to_prepare',upsell_value=20000,has_upsell=true WHERE id=$1",[order.id,new Date(clock+1000).toISOString(),mapped,agency.id]);
  clock+=1500;
  assert.equal((await rpc(seller,'partners.link',{id:link.id})).bill.total,100,'confirmation only earns base 100 even after qty increased');
  assert.equal((await rpc(chief,'management.payroll',{month:ym(clock)})).total,100,'no upsell prime before delivery');
  await seller.db.query("UPDATE orders SET follow_status='delivered',delivered_at=$2,follow_agent_id=$3,follow_agency_id=$4 WHERE id=$1",[order.id,new Date(clock+1000).toISOString(),mapped,agency.id]);
  clock+=1500;
  const beforeBill=(await rpc(seller,'partners.link',{id:link.id})).bill;
  assert.equal(beforeBill.total,300,'5 -> 7 units: one normal 100 DA and two extra at 100 DA');
  assert.equal((await rpc(chief,'management.payroll',{month:ym(clock)})).total,300);
  await assert.rejects(rpc(chief,'management.planDelete',{id:billPlan.id}),/affecté/);
  const aBonus=await rpc(chief,'management.bonusSave',{kind:'agent',name:'Prime 1 livraison',trigger:'delivered',threshold:1,amount:500});
  await rpc(chief,'management.bonusAssign',{targetKind:'agent',targetId:created.id,bonusId:aBonus.id,enabled:true});
  const sBonus=await rpc(chief,'management.bonusSave',{kind:'billing',name:'Bonus 1 livraison',trigger:'delivered',threshold:1,amount:700});
  const pending=await rpc(chief,'management.bonusAssign',{targetKind:'seller',targetId:link.id,bonusId:sBonus.id,enabled:true});
  assert.equal(pending.status,'pending','seller must approve bonus');
  assert.equal((await rpc(seller,'partners.link',{id:link.id})).bill.total,300,'pending seller bonus cannot be billed');
  assert.equal((await rpc(chief,'management.payroll',{month:ym(clock)})).total,300,'bonus effective only for future operations');
  await rpc(seller,'partners.decideBonus',{linkId:link.id,bonusId:sBonus.id,accept:true});
  const bonusTerms=(await rpc(seller,'partners.link',{id:link.id})).bonusTerms;
  assert.equal(bonusTerms.find((x:any)=>x.id===sBonus.id).status,'accepted');
  await assert.rejects(rpc(chief,'management.bonusDelete',{id:sBonus.id}),/affectations/);
  // A second eligible delivery after the seller accepts unlocks the independent monthly bonus.
  clock+=5000;
  const second=await rpc(seller,'orders.create',{customerName:'Client2',phone:'0661556601',wilayaId:31,commune:'Oran',items:[{productId:product,variantId:null,qty:5}]});
  await seller.db.query("UPDATE orders SET conf_status='confirmed',confirmed_at=$2,agent_id=$3,conf_agency_id=$4,follow_status='delivered',delivered_at=$5,follow_agent_id=$3,follow_agency_id=$4 WHERE id=$1",[second.id,new Date(clock+1000).toISOString(),mapped,agency.id,new Date(clock+2000).toISOString()]);
  clock+=3000;
  assert.equal((await rpc(seller,'partners.link',{id:link.id})).bill.total,1100,'300 + 100 + 700 seller bonus once');
  assert.equal((await rpc(chief,'management.payroll',{month:ym(clock)})).total,900,'300 + 100 + 500 agent bonus once');
  // Seller bonus changes affect only the future, without altering earlier accepted contract snapshots.
  await rpc(chief,'management.bonusAssign',{targetKind:'seller',targetId:link.id,bonusId:sBonus.id,enabled:false});
  const removed=await rpc(chief,'management.bonusDelete',{id:sBonus.id});
  assert.equal(removed.archived,true,'historical bonuses are archived, never destructively deleted');
 }finally{await pg.close()}
});
