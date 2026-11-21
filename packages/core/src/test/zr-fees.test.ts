// ZR's prices (« Tarifs »): the shop's own wilaya (Alger) is priced commune by commune — « tarifs locaux », one line
// per commune and none for the wilaya. It must still get its price, or Pilotix says « ZR ne livre pas à Alger ».
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { zr } from '../couriers/zr';
import type { CourierCompany } from '../couriers/types';

const real = globalThis.fetch;
afterEach(() => (globalThis.fetch = real));

// each test its own company id: ZR's wilayas and communes are kept in memory per company
const company = (id: number, fromWilayaId = 16) =>
  ({ id, name: 'ZR', kind: 'zr', secret: { api_key: 'k', tenant: 't' }, settings: {}, statusMap: {}, shop: { name: 'S', fromWilayaId, fromWilaya: 'Alger' } }) as unknown as CourierCompany;

const prices = (home: number, desk: number, ret: number) => [
  { deliveryType: 'home', price: home - 50, priceTtc: home, isSpecificPrice: false },
  { deliveryType: 'pickup-point', price: desk, isSpecificPrice: false },
  { deliveryType: 'return', price: ret, isSpecificPrice: false },
];
const WILAYAS = [
  { id: 'w16', code: '16', name: 'Alger', level: 'wilaya' },
  { id: 'w31', code: '31', name: 'Oran', level: 'wilaya' },
];
const COMMUNES = [
  { id: 'c1', code: '1601', name: 'Baraki', level: 'commune', parentId: 'w16' },
  { id: 'c2', code: '1602', name: 'Hydra', level: 'commune', parentId: 'w16' },
  { id: 'c3', code: '1603', name: 'Ouled Fayet', level: 'commune', parentId: 'w16' },
  { id: 'c9', code: '1', name: 'Bir El Djir', level: 'commune', parentId: 'w31' },
];
const oran = { toTerritoryId: 'w31', toTerritoryCode: '31', toTerritoryName: 'Oran', toTerritoryLevel: 'wilaya', deliveryPrices: prices(800, 500, 300) };
const local = (id: string, code: string, p: ReturnType<typeof prices>) => ({ toTerritoryId: id, toTerritoryCode: code, toTerritoryName: id, toTerritoryLevel: 'commune', deliveryPrices: p });

/** fake ZR: its price list, its wilayas and communes, and the one-place prices (`one`); records every call */
function fakeZr(rates: unknown[], one: (id: string) => unknown = () => null, territoriesFail = false) {
  const calls: string[] = [];
  globalThis.fetch = (async (u: string, o: any) => {
    const m = `${o?.method ?? 'GET'} ${String(u).replace(/^.*\/api\/v1/, '')}`;
    calls.push(m);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (m === 'GET /delivery-pricing/rates') return json({ rates, appliedDiscounts: [] });
    if (m.startsWith('GET /delivery-pricing/rates/')) {
      const r = one(decodeURIComponent(m.slice('GET /delivery-pricing/rates/'.length)));
      return r ? json(r) : json({ detail: 'Not found' }, 404);
    }
    if (m === 'POST /territories/search') {
      if (territoriesFail) return json({ detail: 'boom' }, 500);
      const level = JSON.parse(o.body)?.advancedFilter?.filters?.[0]?.value;
      return json({ items: level === 'wilaya' ? WILAYAS : level === 'commune' ? COMMUNES : [...WILAYAS, ...COMMUNES], hasNext: false, totalPages: 1 });
    }
    return json({});
  }) as typeof fetch;
  return calls;
}
const byWilaya = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.wilayaId, [r.home, r.desk, r.returnFee]]));

test('Alger priced commune by commune: it gets the price most of its communes have', async () => {
  fakeZr([oran, local('c1', '1601', prices(500, 400, 250)), local('c2', '1602', prices(500, 400, 250)), local('c3', '1603', prices(600, 400, 250)), local('c9', '1', prices(300, 200, 100))]);
  const rows = await zr.fees!(company(101));
  assert.deepEqual(byWilaya(rows), {
    16: [500, 400, 250],
    // Oran's own line stays: its commune line does not change it
    31: [800, 500, 300],
  });
  // a commune whose code looks like a wilaya number (« 1 ») never becomes wilaya 1
  assert.ok(!rows.some((r: any) => r.wilayaId === 1));
});

test('the same price for every commune (as ZR has it today): exactly that price', async () => {
  fakeZr([oran, ...['c1', 'c2', 'c3'].map((id, k) => local(id, `160${k + 1}`, prices(500, 400, 250)))]);
  assert.deepEqual(byWilaya(await zr.fees!(company(102)))[16], [500, 400, 250]);
});

test('Alger not in the price list: ZR is asked for Alger directly', async () => {
  const calls = fakeZr([oran], (id) => (id === 'w16' ? { toTerritoryId: 'w16', toTerritoryLevel: 'wilaya', deliveryPrices: prices(450, 350, 200) } : null));
  assert.deepEqual(byWilaya(await zr.fees!(company(103))), { 16: [450, 350, 200], 31: [800, 500, 300] });
  assert.ok(!calls.some((x) => /rates\/c\d/.test(x)), 'no commune asked once Alger has its price');
});

test('Alger has no price of its own: each of its communes is asked, the most common price kept', async () => {
  const per: Record<string, ReturnType<typeof prices>> = { c1: prices(500, 400, 250), c2: prices(500, 400, 250), c3: prices(550, 400, 250) };
  const calls = fakeZr([oran], (id) => (per[id] ? { toTerritoryId: id, toTerritoryLevel: 'commune', deliveryPrices: per[id] } : null));
  assert.deepEqual(byWilaya(await zr.fees!(company(104)))[16], [500, 400, 250]);
  // only Alger's own communes (not Oran's)
  assert.deepEqual(calls.filter((x) => x.startsWith('GET /delivery-pricing/rates/')).sort(), ['GET /delivery-pricing/rates/c1', 'GET /delivery-pricing/rates/c2', 'GET /delivery-pricing/rates/c3', 'GET /delivery-pricing/rates/w16']);
});

test('every wilaya has its own line (Alger too): read as before, nothing more asked', async () => {
  const calls = fakeZr([oran, { toTerritoryId: 'w16', toTerritoryCode: '16', toTerritoryLevel: 'wilaya', deliveryPrices: prices(400, 300, 200) }]);
  assert.deepEqual(byWilaya(await zr.fees!(company(105))), { 16: [400, 300, 200], 31: [800, 500, 300] });
  assert.deepEqual(calls, ['GET /delivery-pricing/rates']);
});

test('ZR’s communes cannot be read: the other wilayas still get their prices', async () => {
  fakeZr([oran, local('c1', '1601', prices(500, 400, 250))], () => null, true);
  assert.deepEqual(byWilaya(await zr.fees!(company(106))), { 31: [800, 500, 300] });
});
