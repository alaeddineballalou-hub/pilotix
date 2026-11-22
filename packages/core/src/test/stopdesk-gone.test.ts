// Bureaus (stop desks) a delivery company closed (22 Nov 2026): the import only added and updated them, so a bureau ZR
// closed stayed offered — an agent confirmed an order there and the depot's sending was refused (« Bureau ZR
// introuvable »). Now a bureau the company no longer gives is closed: hidden from the choices, the order card says so
// before « Confirmer », its orders still name it. ZR's own list of bureaus is read again every hour.
import assert from 'node:assert/strict';
import { afterEach, before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { zr } from '../couriers/zr';
import { listClock } from '../couriers/util';
import type { CourierCompany } from '../couriers/types';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(120));
});

const real = globalThis.fetch;
const clock = listClock.now;
afterEach(() => {
  globalThis.fetch = real;
  listClock.now = clock;
});

/** a ZR account of its own (the demo's ZR has bureaus of its own) */
const newZr = async (name: string) =>
  Number((await db.query(`INSERT INTO delivery_companies (name, kind, credentials, active) VALUES ($1, 'zr', '{"demo":true}', true) RETURNING id`, [name]))[0].id);
const desk = (extId: string, name: string) => ({ extId, name, wilayaId: 15, commune: 'Tizi Ouzou', address: 'Centre' });
/** a server whose courier answers `stopdesks` with `list` */
const server = (list: unknown[]) => ({ courier: async (action: string) => (action === 'stopdesks' ? list : []) }) as unknown as Ctx['server'];
const gone = async (co: number, extId: string | null, name?: string) =>
  (await db.query(`SELECT gone_at FROM stopdesks WHERE company_id = $1 AND ${extId ? 'ext_id = $2' : 'name = $2'}`, [co, extId ?? name]))[0]?.gone_at ?? null;

test('the import closes a bureau the company no longer gives, opens it again when it comes back', async () => {
  const co = await newZr('ZR bureaux 1');
  await db.query(`INSERT INTO stopdesks (company_id, wilaya_id, commune, name, address) VALUES ($1, 15, 'Azazga', 'Bureau tapé à la main', '')`, [co]);
  const import1 = (await call('delivery.importStopdesks', await as(EMAILS.admin, server([desk('t1', 'ZR Tizi Centre'), desk('t2', 'ZR Tizi Gare')])), { companyId: co })) as any;
  assert.deepEqual(import1, { imported: 2, closed: 0 });
  assert.equal(await gone(co, 't2'), null);
  // ZR closed « Gare »
  const import2 = (await call('delivery.importStopdesks', await as(EMAILS.admin, server([desk('t1', 'ZR Tizi Centre')])), { companyId: co })) as any;
  assert.deepEqual(import2, { imported: 1, closed: 1 });
  assert.notEqual(await gone(co, 't2'), null, 'closed');
  assert.equal(await gone(co, 't1'), null);
  assert.equal(await gone(co, null, 'Bureau tapé à la main'), null, 'a bureau typed by hand is never closed');
  // an empty answer (the company did not answer well) closes nothing
  assert.equal(((await call('delivery.importStopdesks', await as(EMAILS.admin, server([])), { companyId: co })) as any).closed, 0);
  assert.equal(await gone(co, 't1'), null);
  // « Gare » is back
  await call('delivery.importStopdesks', await as(EMAILS.admin, server([desk('t1', 'ZR Tizi Centre'), desk('t2', 'ZR Tizi Gare')])), { companyId: co });
  assert.equal(await gone(co, 't2'), null, 'open again');
  // the Livraison list: open bureaus only
  const list = (await call('delivery.stopdesks', await as(EMAILS.admin), { companyId: co })) as any[];
  assert.deepEqual(list.map((d: any) => d.name).sort(), ['Bureau tapé à la main', 'ZR Tizi Centre', 'ZR Tizi Gare']);
});

test('a closed bureau is not offered, and an order sent there cannot be confirmed: the agent is told why', async () => {
  const co = await newZr('ZR bureaux 2');
  await call('delivery.importStopdesks', await as(EMAILS.admin, server([desk('g1', 'ZR Boghni'), desk('g2', 'ZR Azeffoun')])), { companyId: co });
  await call('delivery.importStopdesks', await as(EMAILS.admin, server([desk('g1', 'ZR Boghni')])), { companyId: co });
  const closed = Number((await db.query(`SELECT id FROM stopdesks WHERE company_id = $1 AND ext_id = 'g2'`, [co]))[0].id);
  const samira = await as(EMAILS.conf);
  const opts = (await call('confirmation.deskOptions', samira, { wilayaId: 15 })) as any;
  assert.ok(opts.desks.some((d: any) => d.name === 'ZR Boghni'));
  assert.ok(!opts.desks.some((d: any) => d.id === closed), 'not offered');
  const lookups = (await call('orders.formData', samira, {})) as any;
  if (lookups?.stopdesks) assert.ok(!lookups.stopdesks.some((d: any) => d.id === closed), 'not in the order form either');
  const v = (await db.query(`SELECT v.id, v.product_id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.active AND v.active ORDER BY v.id LIMIT 1`))[0];
  const items = [{ productId: Number(v.product_id), variantId: Number(v.id), qty: 1 }];
  const r = (await call('orders.confirmCheck', samira, { items, wilayaId: 15, commune: '', isStopdesk: true, stopdeskId: closed, companyId: co })) as any;
  assert.equal(r.canConfirm, false);
  assert.equal(r.deliver.why, 'deskGone');
  assert.equal(r.deliver.deskName, 'ZR Azeffoun');
  // a saved order there: « Confirmer » refused in the agent's words
  const o = (await db.query(`SELECT id FROM orders WHERE conf_status = 'new' ORDER BY id LIMIT 1`))[0];
  await db.query(`UPDATE orders SET wilaya_id = 15, is_stopdesk = true, stopdesk_id = $2, company_id = $3, wilaya_guess = NULL WHERE id = $1`, [o.id, closed, co]);
  await assert.rejects(call('orders.setConf', await as(EMAILS.admin), { ids: [Number(o.id)], status: 'confirmed' }), /a fermé le bureau « ZR Azeffoun »/);
  // another bureau: confirmed
  const open = Number((await db.query(`SELECT id FROM stopdesks WHERE company_id = $1 AND ext_id = 'g1'`, [co]))[0].id);
  await db.query(`UPDATE orders SET stopdesk_id = $2 WHERE id = $1`, [o.id, open]);
  await call('orders.setConf', await as(EMAILS.admin), { ids: [Number(o.id)], status: 'confirmed' });
  assert.match((await db.query('SELECT conf_status FROM orders WHERE id = $1', [o.id]))[0].conf_status, /^(confirmed|no_stock)$/);
});

test('ZR’s bureaus are read again every hour (a bureau it opens or closes is seen by the next import)', async () => {
  let calls = 0;
  globalThis.fetch = (async (u: string, o: any) => {
    const path = String(u).replace(/^.*\/api\/v1/, '');
    if (path.startsWith('/hubs')) calls++;
    const items = path.startsWith('/hubs')
      ? [{ id: 'h1', name: 'ZR Tizi', isPickupPoint: true, address: { cityTerritoryId: 'w15', district: 'Tizi Ouzou' } }]
      : JSON.parse(o.body)?.advancedFilter
        ? [{ id: 'w15', code: '15', name: 'Tizi Ouzou', level: 'wilaya' }]
        : [];
    return new Response(JSON.stringify({ items, hasNext: false }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const c = { id: 9151, name: 'ZR', kind: 'zr', secret: { api_key: 'k2', tenant: 't2' }, settings: {}, statusMap: {}, shop: { name: 'S', fromWilayaId: 16, fromWilaya: 'Alger' } } as unknown as CourierCompany;
  assert.equal((await zr.stopdesks!(c))[0]?.wilayaId, 15);
  await zr.stopdesks!(c);
  assert.equal(calls, 1, 'kept');
  const t = listClock.now() + 3600_000 + 1000;
  listClock.now = () => t;
  await zr.stopdesks!(c);
  assert.equal(calls, 2, 'read again after an hour');
});
