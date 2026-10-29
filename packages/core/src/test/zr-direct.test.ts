// ZR: a parcel not locked yet (not picked up) is changed directly; a locked one gets a modification request.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { zr } from '../couriers/zr';
import type { CourierCompany } from '../couriers/types';

const c = { id: 1, name: 'ZR', kind: 'zr', secret: { api_key: 'k', tenant: 't' }, settings: {}, statusMap: {}, shop: { name: 'S', fromWilayaId: 16, fromWilaya: 'Alger' } } as unknown as CourierCompany;
const item = { id: 7, tracking: '15-ABC-ZR', extId: 'p-1' };
const real = globalThis.fetch;
afterEach(() => (globalThis.fetch = real));

/** fake ZR: answers the parcel with this lock state and records every call */
function fakeZr(locked: boolean | undefined, refuseRequest = false) {
  const calls: string[] = [];
  globalThis.fetch = (async (u: string, o: any) => {
    const m = `${o?.method ?? 'GET'} ${String(u).replace(/^.*\/api\/v1/, '')}`;
    calls.push(m);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (m === 'GET /parcels/p-1') return json({ id: 'p-1', state: locked === undefined ? { name: 'x' } : { name: 'x', isLocked: locked }, customer: { name: 'Ali' } });
    if (m === 'POST /parcel-modification-requests')
      return refuseRequest ? json({ detail: 'The parcel with the identifier p-1 is not in a locked state and can be modified directly.' }, 400) : json({ id: 'req-9' });
    return json({});
  }) as typeof fetch;
  return calls;
}

test('not locked: the amount is changed directly, applied at once', async () => {
  const calls = fakeZr(false);
  const r: any = await zr.change!(c, { item, kind: 'amount', amount: 3400 }, {} as any, null);
  assert.equal(r.approved, true);
  assert.equal(r.direct, true);
  assert.ok(calls.includes('PATCH /parcels/p-1/amount'));
  assert.ok(!calls.some((x) => x.includes('modification-requests')));
});

test('not locked: the phone is changed directly on the customer', async () => {
  const calls = fakeZr(false);
  const r: any = await zr.change!(c, { item, kind: 'phone', phone: '0555123456' }, {} as any, null);
  assert.equal(r.direct, true);
  assert.ok(calls.includes('PATCH /parcels/p-1/customer'));
});

test('locked: a modification request, waiting for ZR', async () => {
  const calls = fakeZr(true);
  const r: any = await zr.change!(c, { item, kind: 'amount', amount: 3400 }, {} as any, null);
  assert.equal(r.approved, null);
  assert.equal(r.extId, 'req-9');
  assert.ok(calls.includes('POST /parcel-modification-requests'));
});

test('lock state unknown and ZR says « modify directly »: done directly', async () => {
  const calls = fakeZr(undefined, true);
  const r: any = await zr.change!(c, { item, kind: 'amount', amount: 3400 }, {} as any, null);
  assert.equal(r.direct, true);
  assert.ok(calls.includes('PATCH /parcels/p-1/amount'));
});
