import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MANAGEMENT_PLAN, priceBrackets, simulateManagementPlan, validatePriceBrackets } from '@pilotix/shared';
const simulation=(productPrice:number)=>({productPrice,operations:1,upsells:0,incrementalValue:0});
test('legacy three-bracket plans preserve original price boundaries',()=>{
 const p={...DEFAULT_MANAGEMENT_PLAN,method:'tier' as const,tiers:[20,40,60] as [number,number,number]};
 assert.equal(simulateManagementPlan(p,simulation(9999)).main,20);
 assert.equal(simulateManagementPlan(p,simulation(10000)).main,40);
 assert.equal(simulateManagementPlan(p,simulation(20000)).main,60);
 assert.equal(priceBrackets(p).length,3);
});
test('new custom bracket count and arbitrary boundaries',()=>{
 const p={...DEFAULT_MANAGEMENT_PLAN,method:'tier' as const,brackets:[{min:0,max:14999,fee:30},{min:15000,max:34999,fee:85},{min:35000,max:49999,fee:130},{min:50000,max:null,fee:200}]};
 for(const [price,expected] of [[0,30],[14999,30],[15000,85],[34999,85],[35000,130],[49999,130],[50000,200],[999999,200]]) assert.equal(simulateManagementPlan(p,simulation(price)).main,expected);
});
test('reject overlaps, gaps, missing unlimited final range and negative fees',()=>{
 for(const invalid of [
 [{min:0,max:9999,fee:50},{min:9999,max:null,fee:60}],
 [{min:0,max:9999,fee:50},{min:10001,max:null,fee:60}],
 [{min:0,max:9999,fee:50}],
 [{min:0,max:null,fee:-1}],
 ]) assert.throws(()=>validatePriceBrackets(invalid));
});
