import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MANAGEMENT_PLAN, NO_AGENCY_PRICES, simulateManagementPlan } from '@pilotix/shared';
import { call, Ctx, login, migrate, migrateAll, pgliteTenancy, seedBase, shopCtx, shopStatus, provisionShop, loadShop, storeChoices } from '../index';

import migration from '../migrations/067_agency_plan_terms';

const PW='Agency-Owner-Password-123';
const config=(rate:number,extra:any={})=>({...structuredClone(DEFAULT_MANAGEMENT_PLAN),rate,...extra});
const monthOf=(ms:number)=>new Date(ms+3600000).toISOString().slice(0,7);

test('agency payment plans: real dispatch, tenant isolation, seller acceptance, effective rates and frozen history',async()=>{
  const {PGlite}=await import('@electric-sql/pglite');const pg=new PGlite();const t=pgliteTenancy(pg as any);
  try {
    await migrate(t.shop('public'),s=>t.exec('public',s));
    await seedBase(t.shop('public'),{name:'Pilotix',email:'platform@example.dz',password:PW});await migrateAll(t);
    const plan=(await t.platform.query("SELECT id FROM platform.plans WHERE code='business'"))[0];
    const owner={name:'Ala Owner',email:'ala@example.dz'};
    const store=await provisionShop(t,{name:'Baby Joy',owner,password:PW,verified:true,kind:'store',planId:Number(plan.id),trialDays:30});
    const agency=await provisionShop(t,{name:'The Closer',owner,password:PW,verified:true,kind:'agency',planId:null,trialDays:0});
    const other=await provisionShop(t,{name:'Other Agency',owner:{name:'Other',email:'other@example.dz'},password:PW,verified:true,kind:'agency',planId:null,trialDays:0});
    assert.equal(store.ownerAccountId,agency.ownerAccountId);
    const choices=await storeChoices(t,owner.email);assert.deepEqual(choices.map(c=>[c.name,c.kind,c.owner]).sort(),[['Baby Joy','store',true],['The Closer','agency',true]]);
    let clock=Date.now()+60000;
    const as=async(s:any,email=owner.email):Promise<Ctx>=>({db:t.shop(s.schema),session:await login(t.shop(s.schema),email,PW),shop:shopCtx(s,shopStatus(s,clock,3)),t,now:()=>clock,emit:()=>{}});
    const chief=await as(agency),seller=await as(store),outsider=await as(other,'other@example.dz');
    const rpc=(ctx:Ctx,name:string,input:any={})=>call(name,ctx,input) as Promise<any>;
    assert.deepEqual((await rpc(chief,'management.plans')).plans,[]);
    assert.deepEqual((await rpc(seller,'management.plans')).plans,[]);
    const billing=await rpc(chief,'management.planSave',{name:'Billing 100',kind:'billing',configuration:config(100)});
    const agentPlan=await rpc(chief,'management.planSave',{name:'Agent 20',kind:'agent',configuration:config(20,{monthly:30000,upsell:{enabled:true,method:'percent',rate:10,trigger:'delivered'}})});
    const clone=await rpc(chief,'management.planClone',{id:billing.id});assert.notEqual(clone.id,billing.id);
    await rpc(chief,'management.planArchive',{id:clone.id});
    await assert.rejects(rpc(outsider,'management.planClone',{id:billing.id}),/introuvable/);
    await assert.rejects(rpc(chief,'management.planSave',{name:'Bad',kind:'billing',configuration:config(1,{thresholds:[20000,10000]})}),/Tranches invalides/);
    await assert.rejects(rpc(chief,'management.planAssign',{targetKind:'product',targetId:1,planId:billing.id}),/contrat vendeur/);
    await chief.db.query("UPDATE profiles SET phone='0710000001' WHERE id=$1",[chief.session.profile.id]);
    let agentEmail='nora@example.dz';
    const agent=await rpc(chief,'users.create',{name:'Nora',email:'nora@example.dz',phone:'0710000002',password:PW,roles:['confirmation']});
    await rpc(chief,'management.planAssign',{targetKind:'agent',targetId:agent.id,planId:agentPlan.id});
    await t.exec(agency.schema,migration);
    assert.equal(Number((await chief.db.query('SELECT count(*) AS n FROM management_agent_terms WHERE profile_id=$1',[agent.id]))[0].n),1,'repeating a migration does not duplicate assignment copies');
    await assert.rejects(rpc(chief,'management.planAssign',{targetKind:'agent',targetId:chief.session.profile.id,planId:agentPlan.id}),/agent actif/);
    await assert.rejects(rpc(chief,'management.planAssign',{targetKind:'agent',targetId:agent.id,planId:billing.id}),/incompatible/);
    await assert.rejects(rpc(chief,'management.planArchive',{id:agentPlan.id}),/affectations/);
    const person=await as(agency,'nora@example.dz');
    await assert.rejects(rpc(person,'management.plans'),/Accès refusé/);
    await assert.rejects(rpc(person,'management.payroll',{month:monthOf(clock)}),/Accès refusé/);
    await t.platform.query('UPDATE platform.shops SET agency_verified_at=now() WHERE id=$1',[agency.id]);
    await rpc(chief,'agency.prices',{prices:{...NO_AGENCY_PRICES,perConfirmed:5}});
    const product1=Number((await seller.db.query("INSERT INTO products(name,sku,price) VALUES('Vélo','VELO',9000) RETURNING id"))[0].id);
    const product2=Number((await seller.db.query("INSERT INTO products(name,sku,price) VALUES('Poussette','POUS',22000) RETURNING id"))[0].id);
    const link=await rpc(chief,'agency.request',{storeId:store.id,tasks:['confirmation']});
    await rpc(seller,'partners.answer',{id:link.id,accept:true,products:null});
    const mapped=Number((await seller.db.query('SELECT id FROM profiles WHERE email=$1 AND agency_id=$2',[agentEmail,agency.id]))[0].id);
    const event=async(product:number,at:number,upsell=0,sc:Ctx=seller)=>{
      const order=await rpc(sc,'orders.create',{customerName:'Client',phone:`0661${String(++phone).padStart(6,'0')}`,wilayaId:31,commune:'Oran',items:[{productId:product,variantId:null,qty:1}]});
      const who=Number((await sc.db.query('SELECT id FROM profiles WHERE email=$1 AND agency_id=$2',[agentEmail,agency.id]))[0].id);
      await sc.db.query("UPDATE orders SET conf_status='confirmed',confirmed_at=$2,agent_id=$3,conf_agency_id=$4,follow_status='delivered',delivered_at=$5,upsell_value=$6,has_upsell=$7 WHERE id=$1",[order.id,new Date(at).toISOString(),who,agency.id,new Date(at+1000).toISOString(),upsell,upsell>0]);
      return order.id;
    };
    let phone=0;
    clock+=1000;await event(product1,clock); // old contract fee = 5, agent = 20
    clock+=2000;
    await rpc(chief,'management.billingPropose',{linkId:link.id,productId:0,planId:billing.id});
    let detail=await rpc(seller,'partners.link',{id:link.id});const proposal=detail.planTerms.find((p:any)=>p.status==='pending');
    assert.equal(detail.bill.total,5);assert.equal(proposal.configuration.rate,100);
    await assert.rejects(rpc(outsider,'management.billingPropose',{linkId:link.id,productId:0,planId:billing.id}),/introuvable/);
    await assert.rejects(rpc(outsider,'partners.decidePlan',{id:link.id,termId:proposal.id,accept:true}),/agence/);
    // Editing a template never changes a proposal the seller is about to accept.
    await rpc(chief,'management.planSave',{id:billing.id,name:'Billing 200',kind:'billing',configuration:config(200)});
    await rpc(seller,'partners.decidePlan',{id:link.id,termId:proposal.id,accept:true});
    clock+=2000;await event(product1,clock,3000); // accepted snapshot is still 100
    detail=await rpc(seller,'partners.link',{id:link.id});assert.equal(detail.bill.total,105);
    let pay=await rpc(chief,'management.payroll',{month:monthOf(clock)});assert.equal(pay.rows.find((p:any)=>p.id===agent.id).total,30340);
    await rpc(chief,'management.planSave',{id:agentPlan.id,name:'Agent 40',kind:'agent',configuration:config(40,{monthly:35000})});
    assert.equal((await rpc(chief,'management.payroll',{month:monthOf(clock)})).total,30340);
    clock+=2000;await rpc(chief,'management.planAssign',{targetKind:'agent',targetId:agent.id,planId:agentPlan.id});
    const tier=await rpc(chief,'management.planSave',{name:'Product tiers',kind:'billing',configuration:config(0,{method:'tier',thresholds:[5000,15000],tiers:[10,30,70]})});
    await rpc(chief,'management.billingPropose',{linkId:link.id,productId:product2,planId:tier.id});
    detail=await rpc(seller,'partners.link',{id:link.id});const specific=detail.planTerms.find((p:any)=>p.status==='pending');
    await rpc(seller,'partners.decidePlan',{id:link.id,termId:specific.id,accept:true});
    clock+=2000;await event(product2,clock); // override = 70 (not default 100), agent 40
    detail=await rpc(seller,'partners.link',{id:link.id});assert.equal(detail.bill.total,175);
    pay=await rpc(chief,'management.payroll',{month:monthOf(clock)});assert.equal(pay.total,35380);assert.equal(pay.rows.length,1);
    // A second seller can have the same local order/profile ids: amounts add up, salary is paid only once.
    const second=await provisionShop(t,{name:'Second Seller',owner,password:PW,verified:true,kind:'store',planId:Number(plan.id),trialDays:30});
    const seller2=await as(second);
    const secondProduct=Number((await seller2.db.query("INSERT INTO products(name,sku,price) VALUES('Second product','SECOND',8000) RETURNING id"))[0].id);
    await rpc(chief,'agency.prices',{prices:NO_AGENCY_PRICES});
    const link2=await rpc(chief,'agency.request',{storeId:second.id,tasks:['confirmation'],planId:billing.id});
    assert.equal((await rpc(seller2,'partners.link',{id:link2.id})).planTerms[0].configuration.rate,200);
    await rpc(seller2,'partners.answer',{id:link2.id,accept:true,products:null});
    clock+=2000;await event(secondProduct,clock,0,seller2);
    assert.equal((await rpc(seller2,'partners.link',{id:link2.id})).bill.total,200);
    assert.equal((await rpc(chief,'management.payroll',{month:monthOf(clock)})).total,35420);
    await assert.rejects(rpc(seller2,'partners.decidePlan',{id:link.id,termId:specific.id,accept:true}),/introuvable/);
    // E-mail changes must preserve seller profile ids and all earned commissions.
    agentEmail='nora.changed@example.dz';
    await rpc(chief,'users.update',{id:agent.id,email:agentEmail});
    assert.equal(Number((await seller.db.query('SELECT id FROM profiles WHERE agency_id=$1 AND agency_profile_id=$2',[agency.id,agent.id]))[0].id),mapped);
    assert.equal((await rpc(chief,'management.payroll',{month:monthOf(clock)})).total,35420);
    // An issued invoice cannot be silently repriced or augmented by new operations.
    await rpc(chief,'agency.billRequest',{id:link.id,month:monthOf(clock)});
    clock+=2000;await event(product1,clock);
    assert.equal((await rpc(chief,'agency.billing',{month:monthOf(clock)})).rows[0].bill.total,175);
    assert.equal((await rpc(chief,'agency.billRequest',{id:link.id,month:monthOf(clock)})).amount,175);
    const bill=(await rpc(seller,'partners.link',{id:link.id})).bills[0];
    await rpc(seller,'partners.billPaid',{billId:bill.id});await rpc(chief,'agency.billReceived',{billId:bill.id});
    await assert.rejects(rpc(chief,'management.payrollClose',{month:monthOf(clock)}),/fin du mois/);
    const month=monthOf(clock);clock=Date.parse(periodEnd(month))+1000;
    await rpc(chief,'management.payrollClose',{month});
    pay=await rpc(chief,'management.payroll',{month});assert.equal(pay.total,35460);assert.ok(pay.closedAt);
    await seller.db.query('UPDATE orders SET upsell_value=999999');
    assert.equal((await rpc(chief,'management.payroll',{month})).total,35460);
    // Real percentage billing and double confirmation use the same calculator as the editor.
    const pct=await rpc(chief,'management.planSave',{name:'Percentage',kind:'billing',configuration:config(2,{method:'percent',upsell:{enabled:true,method:'percent',rate:10,trigger:'delivered'}})});
    await rpc(chief,'management.billingPropose',{linkId:link.id,productId:0,planId:pct.id});
    const pendingPct=(await rpc(seller,'partners.link',{id:link.id})).planTerms.find((p:any)=>p.status==='pending');
    await rpc(seller,'partners.decidePlan',{id:link.id,termId:pendingPct.id,accept:true});
    clock+=2000;const nextOrder=await event(product1,clock,3000);
    assert.equal((await rpc(seller,'partners.link',{id:link.id})).bill.total,480);
    // Switching from confirmation pay to delivery pay must not pay a second base fee on an old order.
    clock+=2000;
    await rpc(chief,'management.planSave',{id:agentPlan.id,name:'Delivered 55',kind:'agent',configuration:config(55,{trigger:'delivered',monthly:35000})});
    await rpc(chief,'management.planAssign',{targetKind:'agent',targetId:agent.id,planId:agentPlan.id});
    await seller.db.query('UPDATE orders SET delivered_at=$2 WHERE id=$1',[nextOrder,new Date(clock+1000).toISOString()]);
    assert.equal((await rpc(chief,'management.payroll',{month:monthOf(clock)})).total,35040);
    clock+=2000;await event(product1,clock);
    assert.equal((await rpc(chief,'management.payroll',{month:monthOf(clock)})).total,35095);
    // Deactivating an agent keeps earned pay and the final month's salary, but stops later salaries.
    clock+=2000;await rpc(chief,'users.update',{id:agent.id,active:false});
    assert.equal((await rpc(chief,'management.payroll',{month:monthOf(clock)})).total,35095);
    clock=Date.parse(periodEnd(monthOf(clock)))+1000;
    assert.equal((await rpc(chief,'management.payroll',{month:monthOf(clock)})).total,0);
    // A marketer is not an agency. Same owner identity does not bypass workspace permissions.
    const mk=await provisionShop(t,{name:'Media Buyer',owner,password:PW,verified:true,kind:'marketer',planId:null,trialDays:0});
    await assert.rejects(rpc(await as(mk),'management.plans'),/espace d’un marketer/);
    await assert.rejects(rpc(person,'management.billingPropose',{linkId:link.id,productId:0,planId:billing.id}),/Accès refusé/);
    assert.equal((await loadShop(t,{id:agency.id}))?.kind,'agency');
  } finally {await pg.close();}
});
function periodEnd(month:string){const [y,m]=month.split('-').map(Number);return new Date(Date.UTC(y,m,1)-3600000).toISOString();}

test('editable brackets and percentage upsell use merchandise price and incremental value',()=>{
  const p=config(0,{method:'tier',thresholds:[5000,15000],tiers:[10,30,70],upsell:{enabled:true,method:'percent',rate:10,trigger:'delivered'}});
  const calc=(price:number)=>simulateManagementPlan(p,{productPrice:price,operations:1,upsells:1,incrementalValue:3000});
  assert.equal(calc(4999).main,10);assert.equal(calc(5000).main,30);assert.equal(calc(14999).main,30);assert.equal(calc(15000).main,70);assert.equal(calc(22000).upsell,300);
  assert.throws(()=>calc(-1),/invalide/i);
});
