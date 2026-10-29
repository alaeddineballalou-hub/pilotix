// The new couriers, against fake APIs: each sends a parcel to the right address and reads the courier's number back,
// reads its statuses, and the parcel actions (return, new try, note, change) call the right address.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ADAPTERS } from '../couriers/adapters';
import type { CourierCompany, Helpers, Parcel } from '../couriers/types';

const real = globalThis.fetch;
afterEach(() => (globalThis.fetch = real));

type Route = [RegExp, unknown];
/** fake courier: the first route whose « METHOD path » matches answers; every call is recorded */
function fake(routes: Route[]) {
  const calls: string[] = [];
  globalThis.fetch = (async (u: string, o: any) => {
    const url = new URL(String(u));
    const m = `${o?.method ?? 'GET'} ${url.pathname}${url.search}`;
    calls.push(m);
    const hit = routes.find(([re]) => re.test(m));
    const body = hit ? hit[1] : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}
const company = (kind: string, secret: Record<string, string>, settings: Record<string, unknown> = {}) =>
  ({ id: 1, name: kind, kind, secret, settings, statusMap: {}, shop: { name: 'Boutique', fromWilayaId: 16, fromWilaya: 'Alger' }, cacheKey: `t-${kind}-${Math.random()}` }) as unknown as CourierCompany;
const parcel = (o: Partial<Parcel> = {}): Parcel => ({
  id: 7, ref: 'PX1007', customer_name: 'Amine Hamidi', phone: '0555123456', phone2: null, wilaya_id: 16, wilaya: 'Alger', wilaya_ar: 'الجزائر',
  commune: 'Bab Ezzouar', address: 'Cité 500 logements', is_stopdesk: false, stopdesk_ext_id: null, stopdesk_name: null, stopdesk_commune: null,
  stopdesk_wilaya_id: null, total: 4100, subtotal: 3500, delivery_fee: 600, products: '1 × Écharpe', items: [{ name: 'Écharpe', sku: 'ECH', price: 3500, qty: 1 }],
  pieces: 1, weight: 1, delivery_note: '', is_exchange: false, tracking: null, ext_id: null, ...o,
});
const helpers: Helpers = { communeName: async (_p, load) => (await load(16))[0] ?? null };
const item = { id: 7, tracking: 'TRK1', extId: '55' };

test('Maystro: created on stores/orders/, cancelled and changed on stores/orders/{id}/', async () => {
  const calls = fake([
    [/^GET \/api\/base\/wilayas\/16\//, { communes: [{ id: 501, name: 'Bab Ezzouar', wilaya: 16 }] }],
    [/^POST \/api\/stores\/orders\//, { id: 55, display_id: 'MAY-77' }],
    [/^GET \/api\/stores\/orders\/55\//, { id: 55, status: 4 }],
  ]);
  const c = company('maystro', { token: 't' });
  const r = await ADAPTERS.maystro.create(c, parcel(), helpers);
  assert.equal(r.tracking, 'MAY-77');
  assert.equal(r.extId, '55');
  await ADAPTERS.maystro.cancel!(c, item);
  assert.ok(calls.some((x) => x.startsWith('PATCH /api/stores/orders/55/')));
  assert.ok(!calls.some((x) => /\/api\/orders\//.test(x)), 'no vargo paths (they do not exist)');
});

test('Zimou: created on /v3/packages, return asked on mark-as-returned', async () => {
  const calls = fake([
    [/^GET \/api\/v3\/helpers\/communes/, { data: [{ id: 5, name: 'Bab Ezzouar', wilaya_id: 16, wilaya: { id: 16, name: 'Alger' } }] }],
    [/^GET \/api\/v3\/helpers\/wilayas/, { data: [{ id: 16, name: 'Alger' }] }],
    [/^POST \/api\/v3\/packages$/, { data: { id: 9, tracking_code: 'ZIM-1' } }],
  ]);
  const c = company('zimou', { api_token: 't' });
  const r = await ADAPTERS.zimou.create(c, parcel(), helpers);
  assert.equal(r.tracking, 'ZIM-1');
  await ADAPTERS.zimou.askReturn!(c, item, '');
  assert.ok(calls.some((x) => x.startsWith('POST /api/v3/packages/mark-as-returned')));
});

test('Near: refuses home delivery, sends a pickup-point parcel', async () => {
  const c = company('near', { api_key: 'k', api_secret: 's' }, { sender_center_id: '3' });
  await assert.rejects(() => ADAPTERS.near.create(c, parcel(), helpers), /point de retrait/);
  const calls = fake([
    [/^GET \/api\/v1\/sender\/wilayas/, { data: [{ code: '16', name: 'Alger', communes: [{ id: 5, code: '1601', name: 'Bab Ezzouar' }] }] }],
    [/^POST \/api\/v1\/parcels/, { data: [{ tracking_number: 'NR-1', id: 12 }] }],
  ]);
  const r = await ADAPTERS.near.create(c, parcel({ is_stopdesk: true, stopdesk_ext_id: '44', stopdesk_commune: 'Bab Ezzouar', stopdesk_wilaya_id: 16 }), helpers);
  assert.equal(r.tracking, 'NR-1');
  assert.ok(calls.some((x) => x.startsWith('POST /api/v1/parcels')));
});

test('NOEST: return, new try and note from Pilotix', async () => {
  const calls = fake([[/./, { success: true }]]);
  const c = company('noest', { api_token: 't', user_guid: 'g' });
  await ADAPTERS.noest.askReturn!(c, item, '');
  await ADAPTERS.noest.retry!(c, item, '');
  await ADAPTERS.noest.note!(c, item, 'Rappeler après 18 h');
  assert.ok(calls.some((x) => x.startsWith('POST /api/public/ask/return')));
  assert.ok(calls.some((x) => x.startsWith('POST /api/public/ask/new-tentative')));
  assert.ok(calls.some((x) => x.startsWith('POST /api/public/add/maj')));
});

test('EcoTrack: return asked and note sent', async () => {
  const calls = fake([[/./, { success: true }]]);
  const c = company('ecotrack', { token: 't' }, { base_url: 'https://dhd.ecotrack.dz' });
  await ADAPTERS.ecotrack.askReturn!(c, item, '');
  await ADAPTERS.ecotrack.note!(c, item, 'Client disponible demain');
  assert.ok(calls.some((x) => x.startsWith('POST /api/v1/ask/for/order/return')));
  assert.ok(calls.some((x) => x.startsWith('POST /api/v1/add/maj')));
});

test('every courier with an API reads statuses without crashing on an empty answer', async () => {
  fake([[/./, {}]]);
  for (const [kind, secret] of Object.entries<Record<string, string>>({
    maystro: { token: 't' }, zimou: { api_token: 't' }, elogistia: { api_key: 'k' }, ecom: { token: 't', key: 'k' }, mdm: { api_key: 'k', store_id: 's' }, near: { api_key: 'k', api_secret: 's' },
  })) {
    const r = await (ADAPTERS as any)[kind].track(company(kind, secret), [item]);
    assert.ok(Array.isArray(r), kind);
  }
});
