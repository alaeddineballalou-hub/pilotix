import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCompensation, type CompensationPlan } from '@pilotix/shared';

test('hybrid pay: fixed monthly + price-tier confirmation + incremental upsell + bonus', () => {
  const plan: CompensationPlan = {
    base: { mode: 'monthly', amount: 30000 },
    rules: [
      { id: 'confirmation', basis: 'confirmation', method: 'price_tier', amount: 0, enabled: true, tiers: [{from:0,to:9999,amount:30},{from:10000,to:null,amount:60}] },
      { id: 'upsell', basis: 'upsell', method: 'percent', amount: 10, enabled: true },
    ],
    bonuses: [{ id: 'goal', metric: 'confirmed', atLeast: 1, amount: 5000, repeat: 'once', enabled: true }],
  };
  const ctx = { hours: 0, days: 0, confirmed: 1, delivered: 0, upsells: 1, deliveryRate: 0,
    events: [{id:'confirmed-order-1', basis:'confirmation' as const,productPrice:16950},
             {id:'upsell-order-1',basis:'upsell' as const,productPrice:19950,incrementalValue:3000}] };
  const result = calculateCompensation(plan, ctx);
  assert.equal(result.base, 30000);
  assert.equal(result.commissions, 360);
  assert.equal(result.bonuses, 5000);
  assert.equal(result.total, 35360);
  assert.throws(() => calculateCompensation(plan, { ...ctx, events: [ctx.events[0], ctx.events[0]] }), /Duplicate eligible event/);
});

test('guaranteed minimum applies only a top-up and allows commission-only plans', () => {
  const plan: CompensationPlan = { base:{mode:'guaranteed_minimum',amount:25000},rules:[],bonuses:[] };
  const ctx = { events:[],hours:0,days:0,confirmed:0,delivered:0,upsells:0,deliveryRate:0 };
  assert.equal(calculateCompensation(plan,ctx).total,25000);
  assert.equal(calculateCompensation({ ...plan,base:{mode:'none'} },ctx).total,0);
});
