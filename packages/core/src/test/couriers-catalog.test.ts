// Every courier's declared abilities (kinds) match what its adapter really has, so the control room's Done / To do,
// the parcel page's buttons and the API calls never disagree.
import { COURIER_KINDS } from '@pilotix/shared';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADAPTERS } from '../couriers/adapters';
import { courierCatalog, COURIER_FEATURES } from '../couriers/catalog';
import { KINDS } from '../couriers/kinds';

test('every kind has an adapter and a catalog entry', () => {
  for (const k of COURIER_KINDS) {
    assert.ok(ADAPTERS[k], `adapter ${k}`);
    assert.ok(KINDS[k], `kind ${k}`);
  }
  const cat = courierCatalog();
  for (const k of COURIER_KINDS.filter((x) => KINDS[x].api && x !== 'custom')) assert.ok(cat.some((c) => c.kind === k), `catalog ${k}`);
  for (const c of cat) assert.equal(c.items.length, COURIER_FEATURES.length);
});

test('declared abilities match the adapters', () => {
  for (const k of COURIER_KINDS) {
    const a = ADAPTERS[k];
    const i = KINDS[k];
    if (!i.api) continue;
    const pairs: [string, boolean, boolean][] = [
      ['cancel', i.cancel, !!a.cancel],
      ['label', i.label_, !!a.label],
      ['fees', i.fees, !!a.fees],
      ['desks', i.desks, !!a.stopdesks],
      ['parcel', !!(i.parcel || i.zr), !!a.parcel],
      ['change', !!(i.change || i.zr), !!a.change],
      ['askReturn', !!i.askReturn, !!a.askReturn],
      ['retry', !!i.retry, !!a.retry],
      ['note', !!i.note, !!a.note],
      ['webhook', !!i.webhook, !!a.webhook],
      ['claims', !!i.claims, !!a.claim],
      ['payments', !!i.payments, !!a.payments],
    ];
    for (const [what, declared, has] of pairs) if (declared) assert.ok(has, `${k}: declares ${what} but the adapter has none`);
  }
});
