import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MANAGEMENT_PLAN, NO_AGENCY_PRICES, simulateManagementPlan, type ManagementPlanConfig } from '@pilotix/shared';
import { call, Ctx, login, migrate, migrateAll, pgliteTenancy, seedBase, shopCtx, shopStatus, provisionShop } from '../index';
import { period } from '../modules/planledger';

const PW='Agent-Pay-Tasks-123!';
const monthOf=(ms:number)=>new Date(ms+3600000).toISOString().slice(0,7);
const configuration=(task:'confirmation'|'suivi',extra:Partial<ManagementPlanConfig>={}):ManagementPlanConfig=>({
  ...structuredClone(DEFAULT_MANAGEMENT_PLAN),agentTask:task,trigger:task==='suivi'?'delivered':'confirmed',
  rate:task==='suivi'?40:100,monthly:0,
  upsell:{enabled:task==='confirmation',method:'qty',rate:0,trigger:'delivered',ruleVersion:2},...extra,
});

test('a suivi simulation never earns upsell, even from a forged or old configuration',()=>{
  for(const method of ['double','qty','percent','fixed'] as const){
    const plan=configuration('suivi',{upsell:{enabled:true,method,rate:100,trigger:'delivered',ruleVersion:2}});
    assert.deepEqual(simulateManagementPlan(plan,{productPrice:10000,operations:1,upsells:1,incrementalValue:50000,originalQty:5,deliveredQty:20}),
      {monthly:0,main:40,bonus:0,upsell:0,total:40});
  }
  assert.throws(()=>simulateManagementPlan(configuration('suivi',{trigger:'confirmed'}),{productPrice:10000,operations:1,upsells:0,incrementalValue:0}),/suivi.*livraison/);
});

test('Agent Pay types pay only their assigned task: role checks, dual-role agents, upsell exclusion, snapshots and tenant isolation',async()=>{
  const {PGlite}=await import('@electric-sql/pglite');const pg=new PGlite();const t=pgliteTenancy(pg as any);
  try{
    await migrate(t.shop('public'),sql=>t.exec('public',sql));
    await seedBase(t.shop('public'),{name:'Pilotix',email:'platform-tasks@example.dz',password:PW});await migrateAll(t);
    const biz=Number((await t.platform.query("SELECT id FROM platform.plans WHERE code='business'"))[0].id);
    const owner={name:'Owner',email:'owner-tasks@example.dz'};
    const store=await provisionShop(t,{name:'Assigned Seller',owner,password:PW,verified:true,kind:'store',planId:biz,trialDays:30});
    const agency=await provisionShop(t,{name:'Assigned Agency',owner,password:PW,verified:true,kind:'agency',planId:null,trialDays:0});
    let clock=Date.now()+60000;
    const ctx=async(s:any):Promise<Ctx>=>({db:t.shop(s.schema),session:await login(t.shop(s.schema),owner.email,PW),shop:shopCtx(s,shopStatus(s,clock,3)),t,now:()=>clock,emit:()=>{}});
    const chief=await ctx(agency),seller=await ctx(store);
    const rpc=(c:Ctx,n:string,i:any={})=>call(n,c,i) as Promise<any>;
    await t.platform.query('UPDATE platform.shops SET agency_verified_at=now() WHERE id=$1',[agency.id]);
    await rpc(chief,'agency.prices',{prices:{...NO_AGENCY_PRICES,perConfirmed:5}});
    const people:Record<string,number>={};
    const roles={conf:['confirmation'],follow:['suivi'],dualConf:['confirmation','suivi'],dualFollow:['confirmation','suivi'],idleConf:['confirmation'],idleFollow:['suivi'],late:['confirmation']};
    let pn=0;
    for(const [name,r] of Object.entries(roles))people[name]=(await rpc(chief,'users.create',{name,email:name.toLowerCase()+'-tasks@example.dz',phone:'071'+String(++pn).padStart(7,'0'),password:PW,roles:r})).id;
    const link=await rpc(chief,'agency.request',{storeId:store.id,tasks:['confirmation','suivi']});
    await rpc(seller,'partners.answer',{id:link.id,accept:true,products:null});
    const product=Number((await seller.db.query("INSERT INTO products(name,sku,price) VALUES('Original','ORIGINAL-TASKS',10000) RETURNING id"))[0].id);
    const extraProduct=Number((await seller.db.query("INSERT INTO products(name,sku,price) VALUES('Extra','EXTRA-TASKS',20000) RETURNING id"))[0].id);
    const confPlan=(await rpc(chief,'management.planSave',{kind:'agent',name:'Confirmation 100',configuration:configuration('confirmation')})).id;
    const suiviPlan=(await rpc(chief,'management.planSave',{kind:'agent',name:'Suivi 40',configuration:configuration('suivi')})).id;
    const legacy=(await rpc(chief,'management.planSave',{kind:'agent',name:'Default confirmation',configuration:{...DEFAULT_MANAGEMENT_PLAN,rate:10}})).id;
    assert.equal((await rpc(chief,'management.plans')).plans.find((p:any)=>p.id===legacy).configuration.agentTask,'confirmation');
    for(const badConfig of [configuration('suivi',{trigger:'confirmed'}),configuration('suivi',{upsell:{...configuration('confirmation').upsell}})])
      await assert.rejects(rpc(chief,'management.planSave',{kind:'agent',name:'Invalid suivi',configuration:badConfig}),/suivi/);
    await assert.rejects(rpc(chief,'management.planSave',{kind:'billing',name:'Wrong plan kind',configuration:configuration('suivi')}),/réservé/);
    await assert.rejects(rpc(chief,'management.planAssign',{targetKind:'agent',targetId:people.conf,planId:suiviPlan}),/rôle suivi/);
    await assert.rejects(rpc(chief,'management.planAssign',{targetKind:'agent',targetId:people.follow,planId:confPlan}),/rôle confirmation/);
    const clone=(await rpc(chief,'management.planClone',{id:suiviPlan})).id;
    assert.equal((await rpc(chief,'management.plans')).plans.find((p:any)=>p.id===clone).configuration.agentTask,'suivi');
    for(const name of ['conf','dualConf','idleConf'])await rpc(chief,'management.planAssign',{targetKind:'agent',targetId:people[name],planId:confPlan});
    for(const name of ['follow','dualFollow','idleFollow'])await rpc(chief,'management.planAssign',{targetKind:'agent',targetId:people[name],planId:suiviPlan});
    assert.equal((await chief.db.query('SELECT configuration FROM management_agent_terms WHERE profile_id=$1',[people.follow]))[0].configuration.agentTask,'suivi');
    await assert.rejects(rpc(chief,'management.planSave',{id:confPlan,kind:'agent',name:'Change linked task',configuration:configuration('suivi')}),/Plan affecté/);
    const bonus=await rpc(seller,'partners.requestBonus',{linkId:link.id,name:'Assigned delivery bonus',trigger:'delivered',threshold:1,amount:1000});
    await rpc(chief,'management.bonusRespond',{linkId:link.id,bonusId:bonus.id,accept:true});
    for(const name of ['dualConf','dualFollow'])await rpc(chief,'management.bonusOfferAgent',{linkId:link.id,bonusId:bonus.id,agentId:people[name],amount:500});
    const mapped=async(c:Ctx,name:string|null)=>name===null?null:Number((await c.db.query('SELECT id FROM profiles WHERE agency_id=$1 AND agency_profile_id=$2',[agency.id,people[name]]))[0].id);
    let phone=0;
    const make=async(conf:string|null,follow:string|null,opts:{delivered?:boolean;qty?:number;extra?:boolean;ctx?:Ctx;product?:number}={})=>{
      clock+=10000;const c=opts.ctx??seller,p=opts.product??product;
      const o=await rpc(c,'orders.create',{customerName:'Assigned client',phone:'066'+String(++phone).padStart(7,'0'),wilayaId:31,commune:'Oran',items:[{productId:p,variantId:null,qty:5}]});
      await c.db.query('UPDATE order_items SET qty=$2 WHERE order_id=$1',[o.id,opts.qty??7]);
      if(opts.extra)await c.db.query("INSERT INTO order_items(order_id,product_id,name,variant_title,qty,unit_price,purchase_price,is_upsell) VALUES($1,$2,'Extra','',2,20000,0,true)",[o.id,extraProduct]);
      await c.db.query("UPDATE orders SET conf_status='confirmed',confirmed_at=$2,agent_id=$3,follow_agent_id=$4,conf_agency_id=$5,follow_agency_id=$5,follow_status=$6,delivered_at=$7,has_upsell=true,upsell_value=20000 WHERE id=$1",
        [o.id,new Date(clock+1000).toISOString(),await mapped(c,conf),await mapped(c,follow),agency.id,opts.delivered?'delivered':'to_prepare',opts.delivered?new Date(clock+2000).toISOString():null]);
      clock+=3000;return {id:o.id,c};
    };
    const deliver=async(o:{id:number;c:Ctx})=>{clock+=10000;await o.c.db.query("UPDATE orders SET follow_status='delivered',delivered_at=$2 WHERE id=$1",[o.id,new Date(clock).toISOString()]);};
    const pay=async(name:string)=>{const p=await rpc(chief,'management.payroll',{month:monthOf(clock)});return p.rows.find((r:any)=>r.id===people[name])??{total:0,operations:0,lines:[]};};
    const pending=await make('conf','follow');
    assert.equal((await pay('conf')).total,100);assert.equal((await pay('follow')).total,0);
    await deliver(pending);
    assert.equal((await pay('conf')).total,300,'only its confirmation agent earns the delivered quantity upsell');
    assert.equal((await pay('follow')).total,40,'suivi receives one delivery commission, never upsell');
    await make(null,'dualConf',{delivered:true});
    await make('dualFollow',null,{delivered:true});
    await make(null,null,{delivered:true});
    const foreign=await make('conf',null,{delivered:true});
    await seller.db.query('UPDATE orders SET conf_agency_id=999999 WHERE id=$1',[foreign.id]);
    assert.equal((await pay('conf')).total,300,'a matching profile id cannot earn for another agency’s confirmation assignment');
    assert.equal((await pay('dualConf')).total,0,'confirmation plan cannot earn follow-only commissions or bonuses');
    assert.equal((await pay('dualFollow')).total,0,'suivi plan cannot earn confirmation-only commissions or bonuses');
    await make('dualConf','dualConf',{delivered:true});
    assert.equal((await pay('dualConf')).total,800,'100 + 200 upsell + one assigned-order bonus; no second task payment');
    // Defensive calculation must still ignore upsell if an older stored copy contains it.
    await chief.db.query("UPDATE management_agent_terms SET configuration=jsonb_set(configuration,'{upsell,enabled}','true') WHERE profile_id=$1",[people.dualFollow]);
    await make('dualFollow','dualFollow',{delivered:true});
    assert.equal((await pay('dualFollow')).total,540,'one suivi commission plus one bonus, without upsell or confirmation');
    await make(null,'follow',{delivered:true,extra:true});
    await make(null,'follow',{delivered:true,qty:20});
    assert.equal((await pay('follow')).total,120,'extra products and larger quantities do not create extra suivi payments');
    assert.equal((await pay('follow')).operations,3,'suivi counts delivered orders once');
    const returned=await make(null,'follow',{delivered:true});
    await seller.db.query("UPDATE orders SET follow_status='returned' WHERE id=$1",[returned.id]);
    assert.equal((await pay('follow')).total,120,'a returned parcel is not a delivered suivi operation');
    assert.equal((await pay('idleConf')).total,0);assert.equal((await pay('idleFollow')).total,0);
    const onDelivery=(await rpc(chief,'management.planSave',{kind:'agent',name:'Confirmation paid on delivery',configuration:configuration('confirmation',{trigger:'delivered',rate:70,upsell:{...configuration('suivi').upsell}})})).id;
    await rpc(chief,'management.planAssign',{targetKind:'agent',targetId:people.idleConf,planId:onDelivery});
    const confirmedOnly=await make('idleConf','follow');
    assert.equal((await pay('idleConf')).total,0);await deliver(confirmedOnly);
    assert.equal((await pay('idleConf')).total,70,'delivery-triggered confirmation pay still belongs to its confirmation agent');
    assert.equal((await pay('follow')).total,160);
    const late=await make('late',null);
    await rpc(chief,'management.planAssign',{targetKind:'agent',targetId:people.late,planId:confPlan});await deliver(late);
    assert.equal((await pay('late')).total,0,'a later plan assignment cannot back-pay an earlier confirmation or upsell');
    const oldTask=await make('dualConf','follow');
    await rpc(chief,'management.planAssign',{targetKind:'agent',targetId:people.dualConf,planId:suiviPlan});await deliver(oldTask);
    assert.equal((await pay('dualConf')).total,1100,'earned confirmation and its upsell retain their original confirmation snapshot');
    assert.equal((await pay('follow')).total,200);
    clock+=1000;await rpc(chief,'management.planAssign',{targetKind:'agent',targetId:people.follow,planId:null});
    await make(null,'follow',{delivered:true});assert.equal((await pay('follow')).total,200,'plan removal stops new commissions without erasing earned ones');
    const confId=await mapped(seller,'conf');
    await seller.db.query('UPDATE profiles SET agency_profile_id=999999 WHERE id=$1',[confId]);
    assert.equal((await pay('conf')).total,0,'an invalid stable identity cannot fall back to another person sharing an email');
    await seller.db.query('UPDATE profiles SET agency_profile_id=$2 WHERE id=$1',[confId,people.conf]);
    assert.equal((await pay('conf')).total,300);
    const secondStore=await provisionShop(t,{name:'Second assigned seller',owner,password:PW,verified:true,kind:'store',planId:biz,trialDays:30});
    const second=await ctx(secondStore);
    const secondLink=await rpc(chief,'agency.request',{storeId:secondStore.id,tasks:['confirmation','suivi']});
    await rpc(second,'partners.answer',{id:secondLink.id,accept:true,products:null});
    const secondProduct=Number((await second.db.query("INSERT INTO products(name,sku,price) VALUES('Second original','SECOND-TASKS',10000) RETURNING id"))[0].id);
    assert.equal(await mapped(second,'conf'),confId,'seller-local profile ids may repeat');
    await rpc(chief,'management.planAssign',{targetKind:'agent',targetId:people.follow,planId:suiviPlan});
    await make('conf','follow',{ctx:second,product:secondProduct,delivered:true});
    assert.equal((await pay('conf')).total,600);assert.equal((await pay('follow')).total,240);
    const month=monthOf(clock),before=await rpc(chief,'management.payroll',{month});
    clock=Date.parse(period(month).to)+1;await rpc(chief,'management.payrollClose',{month});
    await seller.db.query('UPDATE orders SET agent_id=NULL,follow_agent_id=NULL');
    await second.db.query('UPDATE orders SET agent_id=NULL,follow_agent_id=NULL');
    const frozen=await rpc(chief,'management.payroll',{month});assert.equal(frozen.total,before.total);assert.deepEqual(frozen.rows,before.rows);
  }finally{await pg.close()}
});
