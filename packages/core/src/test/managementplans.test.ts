import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MANAGEMENT_PLAN, simulateManagementPlan, type ManagementPlanConfig } from '@pilotix/shared';
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
