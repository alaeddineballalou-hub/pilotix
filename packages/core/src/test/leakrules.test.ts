// Contrôle's rules, case by case (test/leakcases.ts: more than 1000 made-up situations, each company alone): every
// problem in a case is found, nothing else is (no false alarm), each one belongs to its own company, carries the money
// at stake, and keeps the same key from one check to the next (one case, closed once agreed — never a new one each time).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { COURIER_KINDS, LEAK_KIND_LIST } from '@pilotix/shared';
import { amountFits, findLeaks, meaningOf, stopWords } from '../leaks/rules';
import { leakCases, type LeakCase } from './leakcases';

const cases = leakCases();

test('more than 1000 different cases: every company, every kind of problem, and clean ones', () => {
  assert.ok(cases.length >= 1000, `${cases.length} cases`);
  assert.equal(new Set(cases.map((c) => c.name)).size, cases.length, 'each case is a different one');
  for (const k of COURIER_KINDS) assert.ok(cases.filter((c) => c.company === k).length >= 20, `few cases for ${k}`);
  for (const k of LEAK_KIND_LIST) assert.ok(cases.some((c) => c.expect.includes(k)), `no case finds ${k}`);
  assert.ok(cases.filter((c) => !c.expect.length).length >= 400, 'clean cases prove there is no false alarm');
});

function check(c: LeakCase) {
  const found = findLeaks(c.facts);
  assert.deepEqual(found.map((f) => f.kind).sort(), [...c.expect].sort());
  // each problem is its own company's
  if (c.owners) assert.deepEqual(found.map((f) => f.companyId).sort(), [...c.owners].sort());
  else for (const f of found) assert.equal(f.companyId, c.facts.companies[0]!.id);
  if (c.amount !== undefined) for (const f of found) assert.equal(f.amount, c.amount, `${f.kind}: ${f.amount} DA`);
  // the same facts, the same keys
  assert.deepEqual(findLeaks(c.facts).map((f) => f.key), found.map((f) => f.key));
  assert.equal(new Set(found.map((f) => f.key)).size, found.length);
}

for (const kind of COURIER_KINDS)
  describe(`Contrôle · ${kind}`, () => {
    for (const c of cases.filter((x) => x.company === kind)) test(c.name, () => check(c));
  });

test('the words that stop a parcel, in French, Arabic and English — and the ones that do not', () => {
  for (const w of ['Commande annulée', 'ANNULE', 'Refusé', 'Ne répond pas 3', 'ne repond pas (3)', '3ème tentative', 'Retour demandé', 'Faux numéro', 'ملغاة', 'رفض', 'مرتجع', 'Returned', 'cancelled'])
    assert.ok(stopWords(w), w);
  for (const w of ['Sortie en livraison', 'Ne répond pas', 'Client absent', 'Reporté', 'Appel téléphonique', 'Client injoignable', 'Vers wilaya', 'Livré', '', null])
    assert.ok(!stopWords(w), String(w));
});

test('a payment line fits its parcel when it is its price, less the delivery, less the costs (50 DA apart at most)', () => {
  assert.ok(amountFits({ amount: 4800, costs: 0, delivery: 400 }, 5200, 0));
  assert.ok(amountFits({ amount: 5200, costs: 0, delivery: 400 }, 5200, 0));
  assert.ok(amountFits({ amount: 4650, costs: 150, delivery: 400 }, 5200, 0));
  assert.ok(amountFits({ amount: 4850, costs: 0, delivery: null }, 5200, 400));
  assert.ok(amountFits({ amount: 1, costs: 0, delivery: null }, 5200, 0), 'no price known: not judged');
  assert.ok(!amountFits({ amount: 4100, costs: 0, delivery: 400 }, 5200, 0));
  assert.ok(!amountFits({ amount: 5300, costs: 0, delivery: 400 }, 5200, 0));
});

test('the meaning of the words counts only for the words it was read for', () => {
  assert.equal(meaningOf({ words: 'Livré', meaning: 'delivered', meaningWords: 'Livré' }), 'delivered');
  assert.equal(meaningOf({ words: 'Retour', meaning: 'delivered', meaningWords: 'Livré' }), null);
  assert.equal(meaningOf({ words: 'Livré', meaning: null, meaningWords: null }), null);
  assert.equal(meaningOf({ words: null, meaning: 'delivered', meaningWords: 'Livré' }), null);
});
