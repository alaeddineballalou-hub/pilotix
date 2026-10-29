// Control room › Sociétés de livraison › Tests: the team's test keys (write-only: never read back by the page) and a
// company's API checked step by step against a fake API — the full test creates a draft parcel, then cancels it.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { checkCourier } from '../couriers/check';
import { courierTestKeys, courierTestState, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, saveCourierTestResult, seedBase, staffLogin } from '../index';

const real = globalThis.fetch;
afterEach(() => (globalThis.fetch = real));

function fake(routes: [RegExp, unknown, number?][]) {
  const calls: string[] = [];
  globalThis.fetch = (async (u: string, o: any) => {
    const url = new URL(String(u));
    const m = `${o?.method ?? 'GET'} ${url.pathname}${url.search}`;
    calls.push(m);
    const hit = routes.find(([re]) => re.test(m));
    return new Response(JSON.stringify(hit ? hit[1] : {}), { status: hit?.[2] ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

test('a company checked step by step: connection, prices, offices, tracking; the full test creates then cancels a draft', async () => {
  const calls = fake([
    [/^GET \/api\/v3\/user/, { data: { id: 1 } }],
    [/^GET \/api\/v3\/my\/prices/, { data: [{ wilaya_id: 16, price: 400, stopdesk_price: 300 }] }],
    [/^GET \/api\/v3\/helpers\/offices/, { data: [{ id: 5, name: 'Bureau Alger', commune_id: 1 }] }],
    [/^GET \/api\/v3\/helpers\/communes/, { data: [{ id: 1, name: 'Alger Centre', wilaya_id: 16, wilaya: { id: 16, name: 'Alger' } }] }],
    [/^GET \/api\/v3\/helpers\/wilayas/, { data: [{ id: 16, name: 'Alger' }] }],
    [/^POST \/api\/v3\/packages$/, { data: { id: 9, tracking_code: 'ZIM-TEST-1' } }],
    [/^GET \/api\/v3\/packages\/status/, { data: [{ tracking_code: 'ZIM-TEST-1', status: 'Nouveau' }] }],
    [/^POST \/api\/v3\/packages\/labels/, { url: 'https://zimou.express/label.pdf' }],
  ]);
  const quick = await checkCourier('zimou', { api_token: 't' }, {}, { name: 'Zimou' });
  assert.deepEqual(quick.steps.map((s) => s.step), ['connection', 'fees', 'desks', 'tracking', 'parcel']);
  assert.equal(quick.steps[0].ok, true);
  assert.equal(quick.steps.at(-1)!.ok, null, 'no parcel without the full test');
  assert.ok(!calls.some((c) => c.startsWith('POST /api/v3/packages ') || /^POST \/api\/v3\/packages$/.test(c)), 'nothing created');

  const full = await checkCourier('zimou', { api_token: 't' }, {}, { deep: true, name: 'Zimou' });
  const names = full.steps.map((s) => s.step);
  assert.deepEqual(names.slice(-4), ['parcel', 'label', 'status', 'cancel']);
  assert.equal(full.steps.find((s) => s.step === 'parcel')!.ok, true);
  assert.ok(calls.some((c) => c.startsWith('DELETE /api/v3/packages/bulk')), 'the test parcel is cancelled');
});

test('keys refused: the connection fails and nothing else is tried', async () => {
  fake([[/./, { message: 'Unauthenticated.' }, 401]]);
  const r = await checkCourier('zimou', { api_token: 'bad' }, {}, { deep: true });
  assert.equal(r.ok, false);
  assert.equal(r.steps[0].ok, false);
  assert.ok(r.steps.slice(1).every((s) => s.ok === null), 'the other steps are skipped');
});

test('test keys: saved write-only (the page sees which ones are set, never the values); an empty box keeps a key', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { email: 'owner@boutique.dz', password: 'Owner-Password-1', name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, 'owner@boutique.dz', 'Owner-Password-1');
  const pctx: PCtx = { t, staff, now: () => Date.now() };
  await platformCall('p.couriers.saveKeys', pctx, { company: 'guepex', secret: { api_id: '123', api_token: 'secret-token', nope: 'x' }, settings: { base_url: '', from_wilaya_id: '16' } });
  // the page: which keys are set, the settings, never a value
  const st: any = await platformCall('p.couriers.tests', pctx, {});
  assert.deepEqual(st.guepex.keysSet.sort(), ['api_id', 'api_token']);
  assert.ok(!JSON.stringify(st).includes('secret-token'));
  // an empty box keeps the saved key; a new value replaces it; unknown keys are dropped
  await platformCall('p.couriers.saveKeys', pctx, { company: 'guepex', secret: { api_id: '', api_token: 'new-token' }, settings: {} });
  const raw = (await courierTestKeys(t)).guepex;
  assert.deepEqual(raw.secret, { api_id: '123', api_token: 'new-token' });
  // the last result is kept; deleting the keys deletes it too
  await saveCourierTestResult(t, 'guepex', { ok: true, deep: false, at: new Date().toISOString(), steps: [] });
  assert.equal((await courierTestState(t)).guepex.last?.ok, true);
  await platformCall('p.couriers.clearKeys', pctx, { company: 'guepex' });
  assert.equal((await courierTestState(t)).guepex, undefined);
  await assert.rejects(() => platformCall('p.couriers.saveKeys', pctx, { company: 'nobody', secret: {}, settings: {} }), /Société inconnue/);
});
