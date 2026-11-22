// Confirmation: at home with a company that keeps its own list of communes (ZR…), the order's commune must be on it
// (22 Nov 2026: PX1226, « Azzefoun » unknown at ZR, was confirmed, then refused by ZR at the depot — and the red screen
// asked for a label that never existed). The courier is asked on the server; it can't say (preview, no answer): go on.
import assert from 'node:assert/strict';
import { afterEach, before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { zr } from '../couriers/zr';
import { bestMatch, nearest } from '../couriers/util';
import type { CourierCompany } from '../couriers/types';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(120));
});

const real = globalThis.fetch;
afterEach(() => (globalThis.fetch = real));

/** ZR's own names for wilaya 15 (as its territories give them) */
const ZR_15 = ['Tizi Ouzou', 'Azeffoun', 'Tigzirt', 'Draa Ben Khedda'];

test('ZR lists its own communes of a wilaya (from its territories, kept in memory)', async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (u: string, o: any) => {
    calls.push(`${o?.method ?? 'GET'} ${String(u).replace(/^.*\/api\/v1/, '')}`);
    const level = JSON.parse(o.body)?.advancedFilter?.filters?.[0]?.value;
    const items =
      level === 'wilaya'
        ? [{ id: 'w15', code: '15', name: 'Tizi Ouzou', level: 'wilaya' }, { id: 'w16', code: '16', name: 'Alger', level: 'wilaya' }]
        : [...ZR_15.map((name, k) => ({ id: `c${k}`, name, level: 'commune', parentId: 'w15' })), { id: 'h1', name: 'Hydra', level: 'commune', parentId: 'w16' }];
    return new Response(JSON.stringify({ items, hasNext: false }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const c = { id: 9150, name: 'ZR', kind: 'zr', secret: { api_key: 'k', tenant: 't' }, settings: {}, statusMap: {}, shop: { name: 'S', fromWilayaId: 16, fromWilaya: 'Alger' } } as unknown as CourierCompany;
  assert.deepEqual((await zr.communes!(c, 15)).map((x) => x.name), ZR_15);
  assert.deepEqual((await zr.communes!(c, 16)).map((x) => x.name), ['Hydra']);
  assert.deepEqual(await zr.communes!(c, 33), [], 'a wilaya ZR does not have');
  assert.equal(calls.length, 2, 'asked once, then kept in memory');
});

test('« Azzefoun » is not on ZR’s list (2 letters away from « Azeffoun »): the closest name is shown', () => {
  assert.equal(bestMatch('Azzefoun', ZR_15), null);
  assert.deepEqual(nearest('Azzefoun', ZR_15), ['Azeffoun']);
  assert.equal(bestMatch('Tizi Ouzou', ZR_15), 'Tizi Ouzou');
  assert.deepEqual(nearest('Bab Ezzouar', ZR_15), [], 'nothing close: no suggestion');
});

/** a server whose couriers answer `communes` with `names` (or fail); records the calls */
function server(names: string[] | 'fail') {
  const calls: { action: string; args: any }[] = [];
  return {
    calls,
    server: {
      courier: async (action: string, args: unknown) => {
        calls.push({ action, args });
        if (action !== 'communes') throw new Error(`unexpected ${action}`);
        if (names === 'fail') throw new Error('ZR ne répond pas');
        return names;
      },
    } as unknown as Ctx['server'],
  };
}

const zrId = async () => Number((await db.query(`SELECT id FROM delivery_companies WHERE kind = 'zr' ORDER BY id LIMIT 1`))[0].id);
const anItem = async () => {
  const v = (await db.query(`SELECT v.id, v.product_id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.active AND v.active ORDER BY v.id LIMIT 1`))[0];
  return { productId: Number(v.product_id), variantId: Number(v.id), qty: 1 };
};
const check = async (ctx: Ctx, commune: string, isStopdesk = false) =>
  (await call('orders.confirmCheck', ctx, { items: [await anItem()], wilayaId: 15, commune, isStopdesk, companyId: await zrId() })) as any;

test('the order card: a commune ZR does not know cannot be confirmed with ZR at home', async () => {
  const f = server(ZR_15);
  const samira = await as(EMAILS.conf, f.server);
  const r = await check(samira, 'Azzefoun');
  assert.equal(r.canConfirm, false);
  assert.equal(r.deliver.why, 'courierCommune');
  assert.equal(r.deliver.commune, 'Azzefoun');
  assert.deepEqual(r.deliver.near, ['Azeffoun']);
  assert.deepEqual(f.calls[0], { action: 'communes', args: { companyId: await zrId(), wilayaId: 15 } });
  // a commune ZR knows: fine
  assert.equal((await check(samira, 'Tizi Ouzou')).canConfirm, true);
  // at a ZR office (stop desk): ZR's hub, not the commune list
  const n = f.calls.length;
  assert.equal((await check(samira, 'Azzefoun', true)).deliver.why === 'courierCommune', false);
  assert.equal(f.calls.length, n, 'not asked for a stop desk');
});

test('ZR does not answer, or the browser preview: the order is not blocked (the depot’s sending still tells)', async () => {
  assert.equal((await check(await as(EMAILS.conf, server('fail').server), 'Azzefoun')).canConfirm, true);
  assert.equal((await check(await as(EMAILS.conf, server([]).server), 'Azzefoun')).canConfirm, true, 'an empty list says nothing');
  assert.equal((await check(await as(EMAILS.conf), 'Azzefoun')).canConfirm, true, 'no server: the preview');
});

test('« Confirmer » on a saved order: refused with the reason in the agent’s words', async () => {
  const o = (await db.query(`SELECT id, ref FROM orders WHERE conf_status = 'new' AND NOT is_stopdesk ORDER BY id LIMIT 1`))[0];
  assert.ok(o, 'an order to call');
  await db.query(`UPDATE orders SET wilaya_id = 15, commune = 'Azzefoun', company_id = $2, wilaya_guess = NULL WHERE id = $1`, [o.id, await zrId()]);
  const admin = await as(EMAILS.admin, server(ZR_15).server);
  await assert.rejects(
    call('orders.setConf', admin, { ids: [Number(o.id)], status: 'confirmed' }),
    (e: any) => {
      assert.match(e.message, /ne trouve pas la commune « Azzefoun »/);
      assert.match(e.message, /Le plus proche chez .+ : Azeffoun/);
      return true;
    },
  );
  assert.equal((await db.query('SELECT conf_status FROM orders WHERE id = $1', [o.id]))[0].conf_status, 'new');
  // fixed with the customer (a commune ZR knows): confirmed
  await db.query(`UPDATE orders SET commune = 'Tigzirt' WHERE id = $1`, [o.id]);
  await call('orders.setConf', admin, { ids: [Number(o.id)], status: 'confirmed' });
  assert.match((await db.query('SELECT conf_status FROM orders WHERE id = $1', [o.id]))[0].conf_status, /^(confirmed|no_stock)$/);
});
