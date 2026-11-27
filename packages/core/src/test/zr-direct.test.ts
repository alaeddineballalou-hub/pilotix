// ZR: a parcel not locked yet (not picked up) is changed directly; a locked one gets a modification request.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setLateWait, zr } from '../couriers/zr';
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

// ---------------------------------------------------------------- leak 3: one order, never two parcels at ZR
const parcel = { id: 9, ref: 'BJ-1234', customer_name: 'Ali', phone: '0555123456', phone2: null, wilaya_id: 16, wilaya: 'Alger', wilaya_ar: '', commune: 'Hydra', address: 'x', is_stopdesk: false, stopdesk_ext_id: null, stopdesk_name: null, stopdesk_commune: null, stopdesk_wilaya_id: null, total: 3000, subtotal: 2600, delivery_fee: 400, products: '1 × X', items: [{ name: 'X', sku: null, price: 2600, qty: 1 }], pieces: 1, weight: 1, delivery_note: '', is_exchange: false, tracking: null, ext_id: null } as any;

test('sent again after a failed try: the parcel ZR already made for the order is taken back, not made twice', async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (u: string, o: any) => {
    const m = `${o?.method ?? 'GET'} ${String(u).replace(/^.*\/api\/v1/, '')}`;
    calls.push(m);
    if (m.startsWith('GET /parcels/search/global')) return new Response(JSON.stringify([{ id: 'p-77', trackingNumber: '16-XYZ-ZR', externalId: 'BJ-1234' }]), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const r: any = await zr.create!(c, { ...parcel, retry: true }, {} as any);
  assert.deepEqual([r.tracking, r.extId], ['16-XYZ-ZR', 'p-77']);
  assert.ok(!calls.some((x) => x.startsWith('POST /parcels')), 'no second parcel');
});

test('ZR made the parcel but its number could not be read: kept with its id, never seen as refused', async () => {
  globalThis.fetch = (async (u: string, o: any) => {
    const m = `${o?.method ?? 'GET'} ${String(u).replace(/^.*\/api\/v1/, '')}`;
    if (m === 'POST /parcels') return new Response(JSON.stringify({ id: 'p-88' }), { status: 201, headers: { 'content-type': 'application/json' } });
    if (m === 'GET /parcels/p-88') return new Response('{"detail":"boom"}', { status: 500, headers: { 'content-type': 'application/json' } });
    if (m === 'POST /hubs/search') return new Response(JSON.stringify({ items: [{ id: 'h-1', name: 'Bureau', address: {} }], hasNext: false, totalPages: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('{"id":"cu-1"}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const r: any = await zr.create!(c, { ...parcel, is_stopdesk: true, stopdesk_ext_id: 'h-1' }, {} as any).catch((e: Error) => ({ error: e.message }));
  assert.equal(r.extId, 'p-88', JSON.stringify(r));
});

test('ZR does not answer in time: Pilotix looks for the parcel at once, by itself, and keeps it (no « Renvoyer » needed)', async () => {
  setLateWait(0);
  const calls: string[] = [];
  globalThis.fetch = (async (u: string, o: any) => {
    const m = `${o?.method ?? 'GET'} ${String(u).replace(/^.*\/api\/v1/, '')}`;
    calls.push(m);
    if (m === 'POST /parcels') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (m.startsWith('GET /parcels/search/global')) return new Response(JSON.stringify([{ id: 'p-99', trackingNumber: '16-LATE-ZR', externalId: 'BJ-1234' }]), { status: 200, headers: { 'content-type': 'application/json' } });
    if (m === 'POST /hubs/search') return new Response(JSON.stringify({ items: [{ id: 'h-1', name: 'Bureau', address: {} }], hasNext: false, totalPages: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('{"id":"cu-1"}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const r: any = await zr.create!(c, { ...parcel, is_stopdesk: true, stopdesk_ext_id: 'h-1' }, {} as any);
  assert.deepEqual([r.tracking, r.extId], ['16-LATE-ZR', 'p-99']);
  assert.equal(calls.filter((x) => x === 'POST /parcels').length, 1, 'made once');
});

test('ZR clearly refuses (wrong address…): no search, the refusal is shown', async () => {
  setLateWait(0);
  const calls: string[] = [];
  globalThis.fetch = (async (u: string, o: any) => {
    const m = `${o?.method ?? 'GET'} ${String(u).replace(/^.*\/api\/v1/, '')}`;
    calls.push(m);
    if (m === 'POST /parcels') return new Response('{"detail":"Adresse invalide"}', { status: 400, headers: { 'content-type': 'application/json' } });
    if (m === 'POST /hubs/search') return new Response(JSON.stringify({ items: [{ id: 'h-1', name: 'Bureau', address: {} }], hasNext: false, totalPages: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('{"id":"cu-1"}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  await assert.rejects(zr.create!(c, { ...parcel, is_stopdesk: true, stopdesk_ext_id: 'h-1' }, {} as any), /Adresse invalide/);
  assert.ok(!calls.some((x) => x.startsWith('GET /parcels/search')));
});

// ---------------------------------------------------------------- ZR says « not locked », its change says « locked »
// PX1312 (27 Nov 2026): out for delivery, « Commune erronée »; ZR's state said isLocked: false, so Pilotix changed it
// directly and ZR answered « … is in a locked state and cannot be modified ». A modification request instead.
function fakeLockedLiar() {
  const calls: string[] = [];
  const bodies: Record<string, any> = {};
  globalThis.fetch = (async (u: string, o: any) => {
    const m = `${o?.method ?? 'GET'} ${String(u).replace(/^.*\/api\/v1/, '')}`;
    calls.push(m);
    if (o?.body) bodies[m] = JSON.parse(o.body);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (m === 'GET /parcels/p-1') return json({ id: 'p-1', state: { name: 'En livraison', isLocked: false }, customer: { name: 'Ali' }, deliveryAddress: { cityTerritoryId: 'w-52', districtTerritoryId: 'd-1', street: 'x' } });
    if (m.startsWith('PATCH /parcels/p-1/')) return json({ detail: 'The parcel with the identifier p-1 is in a locked state and cannot be modified' }, 400);
    if (m === 'POST /hubs/search') return json({ items: [{ id: 'h-1', name: 'Hub Beni Abbes 52', address: { cityTerritoryId: 'w-52', districtTerritoryId: 'd-2' } }], hasNext: false, totalPages: 1 });
    if (m === 'POST /parcel-modification-requests') return json({ id: 'req-9' });
    return json({});
  }) as typeof fetch;
  return { calls, bodies };
}

test('ZR says « not locked » but refuses the direct change as « locked »: a modification request, waiting for ZR', async () => {
  const { calls } = fakeLockedLiar();
  const r: any = await zr.change!(c, { item, kind: 'amount', amount: 3400 }, {} as any, null);
  assert.equal(r.approved, null);
  assert.equal(r.extId, 'req-9');
  assert.ok(!r.direct, 'not shown as « Modifié directement »');
  assert.deepEqual(calls, ['GET /parcels/p-1', 'PATCH /parcels/p-1/amount', 'POST /parcel-modification-requests']);
});

test('the same for Domicile → Stop desk: the request carries the stop desk (pickup-point) and its hub', async () => {
  const { calls, bodies } = fakeLockedLiar();
  const r: any = await zr.change!(c, { item, kind: 'delivery', stopdesk: true, hubExtId: 'h-1', wilayaId: 52, commune: 'Beni-Abbes' }, {} as any, parcel);
  assert.equal(r.approved, null);
  assert.equal(r.extId, 'req-9');
  assert.ok(calls.includes('PATCH /parcels/p-1/deliveryAddress'));
  const req = bodies['POST /parcel-modification-requests'];
  assert.equal(req.deliveryType, 'pickup-point');
  assert.equal(req.hubId, 'h-1');
  assert.equal(req.parcelId, 'p-1');
});

test('another refusal of the direct change is shown as it is (no request sent)', async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (u: string, o: any) => {
    const m = `${o?.method ?? 'GET'} ${String(u).replace(/^.*\/api\/v1/, '')}`;
    calls.push(m);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (m === 'GET /parcels/p-1') return json({ id: 'p-1', state: { name: 'x', isLocked: false }, customer: { name: 'Ali' } });
    if (m === 'PATCH /parcels/p-1/amount') return json({ detail: 'Amount must be positive' }, 400);
    return json({});
  }) as typeof fetch;
  await assert.rejects(zr.change!(c, { item, kind: 'amount', amount: 3400 }, {} as any, null), /Amount must be positive/);
  assert.ok(!calls.some((x) => x.includes('modification-requests')));
});

test('« Pas encore enlevé » never shown for a ZR parcel ZR already has (taken_at)', async () => {
  const { takenNotDirect } = await import('../modules/parcels');
  const info = { direct: true, canModify: true };
  assert.equal(takenNotDirect({ kind: 'zr', taken_at: '2026-11-24T15:54:00Z' }, info).direct, false);
  assert.equal(takenNotDirect({ kind: 'zr', taken_at: null }, info).direct, true, 'not taken yet: still direct');
  assert.equal(takenNotDirect({ kind: 'yalidine', taken_at: '2026-11-24T15:54:00Z' }, info).direct, true, 'other companies unchanged');
});
