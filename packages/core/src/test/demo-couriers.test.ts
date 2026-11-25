import assert from 'node:assert/strict';
import { test } from 'node:test';
import { demoClaimState, fakeTracking, nextStep, word } from '../couriers/demo';

test('demo couriers give fake tracking identifiers and status changes', () => {
  assert.match(fakeTracking('zr', 'PX1001', 0), /^ZR-[0-9]{8}$/);
  assert.match(fakeTracking('yalidine', 'PX1001', 0), /^yal-[A-Z0-9]{6}$/);
  assert.equal(nextStep('shipped', true, 0.1), 'out_for_delivery');
  assert.equal(nextStep('alert', true, 0.25), null);
  assert.equal(nextStep('returning', true, 0.2, true), 'returned');
  assert.equal(nextStep('in_exchange', true, 0.2, true), 'exchanged');
  assert.equal(nextStep('returning', true, 0.95, true), null);
  assert.equal(word('zr', 'alert').includes('Echec livraison'), true);
});

test('the demo claim API advances without contacting a real delivery company', () => {
  const now = Date.parse('2026-11-09T08:00:00Z');
  const at = (h: number) => new Date(now - h * 3_600_000).toISOString();
  // ZR's own statuses (25 Nov 2026): En attente de traitement → Réclamation en traitement → Traitée
  assert.deepEqual(demoClaimState('demo-1', 3, at(1), now), {
    extId: 'demo-1', status: 'En attente de traitement', resolved: false, refused: false, closed: false, answer: null, messages: [],
  });
  assert.equal(demoClaimState('demo-1', 3, at(8), now).status, 'Réclamation en traitement');
  const answered = demoClaimState('demo-1', 3, at(30), now);
  assert.equal(answered.status, 'Réclamation en traitement');
  assert.ok(answered.answer);
  assert.equal(answered.messages?.length, 1);
  const done = demoClaimState('demo-1', 3, at(80), now);
  assert.equal(done.status, 'Traitée');
  assert.equal(done.resolved, true);
  assert.equal(done.closed, true);
  assert.equal(demoClaimState('demo-2', 4, at(80), now).resolved, false);
  // one made in ZR's app: ZR answered, the shop wrote back there, ZR still works on it
  const zr = demoClaimState('demo-zr-7', 9, at(40), now);
  assert.equal(zr.status, 'Réclamation en traitement');
  assert.equal(zr.closed, false);
  assert.equal(zr.messages?.length, 2);
});
