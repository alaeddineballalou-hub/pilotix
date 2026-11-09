import assert from 'node:assert/strict';
import { test } from 'node:test';
import { demoClaimState, fakeTracking, nextStep, word } from '../couriers/demo';

test('demo couriers give fake tracking identifiers and status changes', () => {
  assert.match(fakeTracking('zr', 'PX1001', 0), /^ZR-[0-9]{8}$/);
  assert.match(fakeTracking('yalidine', 'PX1001', 0), /^yal-[A-Z0-9]{6}$/);
  assert.equal(nextStep('shipped', true, 0.1), 'out_for_delivery');
  assert.equal(nextStep('alert', true, 0.25), 'returning');
  assert.equal(nextStep('returning', true, 0.2), 'returned');
  assert.equal(nextStep('in_exchange', true, 0.2), 'exchanged');
  assert.equal(nextStep('returning', true, 0.95), null);
  assert.equal(word('zr', 'alert').includes('Echec livraison'), true);
});

test('the demo claim API advances without contacting a real delivery company', () => {
  const now = Date.parse('2026-11-09T08:00:00Z');
  const at = (h: number) => new Date(now - h * 3_600_000).toISOString();
  assert.deepEqual(demoClaimState('demo-1', 3, at(1), now), {
    extId: 'demo-1', status: 'Nouvelle', resolved: false, answer: null,
  });
  assert.equal(demoClaimState('demo-1', 3, at(8), now).status, 'En cours de traitement');
  assert.equal(demoClaimState('demo-1', 3, at(30), now).status, 'Réponse apportée');
  assert.equal(demoClaimState('demo-1', 3, at(80), now).resolved, true);
  assert.equal(demoClaimState('demo-2', 4, at(80), now).resolved, false);
});
