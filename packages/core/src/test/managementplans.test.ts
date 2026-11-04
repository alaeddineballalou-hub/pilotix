import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MANAGEMENT_PLAN, simulateManagementPlan, validatePriceBrackets, type ManagementPlanConfig } from '@pilotix/shared';
const input={productPrice:16950,operations:100,upsells:10,incrementalValue:3000};

test('fixed confirmation and double-confirmation upsell pays one additional fee per upsell',()=>{
  const config:ManagementPlanConfig={...DEFAULT_MANAGEMENT_PLAN,method:'fixed',rate:100,upsell:{enabled:true,method:'double',rate:0,trigger:'delivered'}};
  assert.deepEqual(simulateManagementPlan(config,input),{monthly:0,main:10000,bonus:0,upsell:1000,total:11000});
});
test('percent upsell uses only the incremental merchandise value',()=>{
  const config:ManagementPlanConfig={...DEFAULT_MANAGEMENT_PLAN,method:'percent',rate:2,monthly:30000,bonus:{enabled:true,threshold:100,amount:5000},upsell:{enabled:true,method:'percent',rate:10,trigger:'delivered'}};
  const x=simulateManagementPlan(config,input);
  assert.equal(x.main,33900);assert.equal(x.upsell,3000);assert.equal(x.total,71900);
});
test('tier boundaries and salary-only plus bonus-only',()=>{
  const tier:ManagementPlanConfig={...DEFAULT_MANAGEMENT_PLAN,method:'tier',tiers:[20,40,70]};
  assert.equal(simulateManagementPlan(tier,{...input,productPrice:9999,operations:1,upsells:0}).main,20);
  assert.equal(simulateManagementPlan(tier,{...input,productPrice:10000,operations:1,upsells:0}).main,40);
  assert.equal(simulateManagementPlan(tier,{...input,productPrice:20000,operations:1,upsells:0}).main,70);
  const salary:ManagementPlanConfig={...DEFAULT_MANAGEMENT_PLAN,method:'none',monthly:35000,bonus:{enabled:true,threshold:100,amount:3000}};
  assert.equal(simulateManagementPlan(salary,input).total,38000);
});
test('invalid double confirmation, duplicated outcome and unsafe negative values are rejected',()=>{
  const invalid:ManagementPlanConfig={...DEFAULT_MANAGEMENT_PLAN,method:'none',upsell:{enabled:true,method:'double',rate:0,trigger:'delivered'}};
  assert.throws(()=>simulateManagementPlan(invalid,input),/Double confirmation/);
  assert.throws(()=>simulateManagementPlan(DEFAULT_MANAGEMENT_PLAN,{...input,operations:-1}),/invalide/i);
});

test('FIX 01: flexible boundaries, unlimited last tranche and calculation',()=>{
 const ranges=[{from:0,to:4999,amount:20},{from:5000,to:34999,amount:80},{from:35000,to:null,amount:200}];
 assert.equal(validatePriceBrackets(ranges),null);
 const plan:ManagementPlanConfig={...DEFAULT_MANAGEMENT_PLAN,method:'tier',ranges};
 for(const [price,fee] of [[0,20],[4999,20],[5000,80],[34999,80],[35000,200],[999999,200]]){
   assert.equal(simulateManagementPlan(plan,{...input,productPrice:price,operations:1,upsells:0}).main,fee);
 }
 assert.match(validatePriceBrackets([{from:0,to:5,amount:1},{from:7,to:null,amount:2}])!,/non couvert/);
 assert.match(validatePriceBrackets([{from:0,to:5,amount:1},{from:5,to:null,amount:2}])!,/chevauchantes/);
 assert.match(validatePriceBrackets([{from:0,to:5,amount:1}])!,/sans limite/);
});

test('payment plans V2: delivery-only QTY, Double, Percent and Fixed upsell, always unit price',()=>{
  const base={...structuredClone(DEFAULT_MANAGEMENT_PLAN),method:'fixed' as const,rate:100,bonus:{enabled:false,threshold:100,amount:0}};
  const simulation={productPrice:10000,operations:1,upsells:1,incrementalValue:200000,originalQty:5,deliveredQty:7};
  const calc=(method:'double'|'qty'|'percent'|'fixed',rate=0,deliveredQty=7)=>simulateManagementPlan({
    ...base,upsell:{enabled:true,method,rate,trigger:'delivered',ruleVersion:2},
  },{...simulation,deliveredQty});
  assert.equal(calc('double').upsell,100);
  assert.equal(calc('double').total,200);
  assert.equal(calc('double',0,20).total,200,'Double caps at one extra base commission');
  const sevenToTwenty=simulateManagementPlan({...base,upsell:{enabled:true,method:'double',rate:0,trigger:'delivered',ruleVersion:2}}, {...simulation,originalQty:7,deliveredQty:20});
  assert.equal(sevenToTwenty.total,200,'7 original -> 20 delivered is still exactly 2x normal confirmation fee');
  const fiveToSeven=simulateManagementPlan({...base,upsell:{enabled:true,method:'qty',rate:0,trigger:'delivered',ruleVersion:2}}, {...simulation,originalQty:5,deliveredQty:7});
  assert.equal(fiveToSeven.total,300,'5 original -> 7 delivered is exactly 3x normal confirmation fee');
  assert.equal(calc('qty').upsell,200,'5 original, 7 delivered -> 2 additional commission units');
  assert.equal(calc('qty').total,300,'base 100 + 2 extra units x 100');
  assert.equal(calc('percent',2).upsell,200,'2% of 10,000 DA unit price, not order total or incremental sales');
  assert.equal(calc('percent',2).total,300,'unit-price commission is added only once for the eligible product line');
  assert.equal(calc('percent',2,5).upsell,0,'same delivered quantity must not generate percent upsell');
  assert.equal(calc('fixed',75,5).upsell,0,'same delivered quantity must not generate fixed upsell');
  assert.equal(calc('fixed',75).upsell,75);
  assert.equal(calc('qty',0,5).upsell,0,'no quantity increase, no upsell');
  assert.equal(calc('percent',2,4).upsell,0,'fewer delivered units, no upsell');
  assert.throws(()=>simulateManagementPlan({...base,upsell:{enabled:true,method:'qty',rate:0,trigger:'confirmed',ruleVersion:2}},simulation),/livraison/);
});
