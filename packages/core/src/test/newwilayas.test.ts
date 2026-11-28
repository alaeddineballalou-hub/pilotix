// The 11 wilayas created in 2026 (59–69). The owner, 28 Nov 2026 (PX1463, Bou Saâda 68: « Aucune société ne livre à
// domicile à 68 Bou Saâda », it could not be confirmed): Pilotix keeps the 69; a company that still counts 58 gets a
// new wilaya as the one it was part of (68 → M'Sila 28), and where a company or a client price list has no price for a
// new wilaya yet, the old wilaya's price counts (his choice « A »).
import assert from 'node:assert/strict';
import { afterEach, before, test } from 'node:test';
import { oldWilaya, sameOldWilaya, wilayaAndOld, wilayaFamily } from '@pilotix/shared';
import { call, Ctx, Db } from '../index';
import { courierChange, courierCompany, courierParcel } from '../couriers/newwilayas';
import type { CourierCompany, Parcel } from '../couriers/types';
import { zr } from '../couriers/zr';
import { effectiveGrid, fillNewWilayas, withNewWilayas } from '../newwilayas';
import { clientFee, clientHomeFees, savFee } from '../settings';
import { EMAILS, setup } from './harness';

let db: Db;
let admin: Ctx;
let agent: Ctx;
/** a courier with a tariff (Yalidine in the demo) and a product on sale with stock */
let co: number;
let V: { productId: number; variantId: number };

before(async () => {
  let as: (email: string) => Promise<Ctx>;
  ({ db, as } = await setup(40));
  admin = await as(EMAILS.admin);
  agent = await as(EMAILS.conf);
  co = Number((await db.query(`SELECT id FROM delivery_companies WHERE kind = 'yalidine' LIMIT 1`))[0].id);
  const r = (await db.query(`SELECT p.id AS pid, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id AND v.active WHERE p.active AND NOT p.is_service ORDER BY p.id, v.id LIMIT 1`))[0];
  V = { productId: Number(r.pid), variantId: Number(r.vid) };
  const wh = Number((await db.query('SELECT id FROM warehouses WHERE active ORDER BY is_default DESC, id LIMIT 1'))[0].id);
  await db.query('DELETE FROM stock WHERE variant_id = $1', [V.variantId]);
  await db.query('INSERT INTO stock (variant_id, warehouse_id, qty) VALUES ($1, $2, 500)', [V.variantId, wh]);
  // as on the live server: the companies price the 58 wilayas only (they still count 58), no company on the order
  await db.query('DELETE FROM delivery_fees WHERE wilaya_id >= 59');
  await db.query(`UPDATE settings SET value = jsonb_set(value, '{defaultCompanyId}', 'null') WHERE key = 'shop'`);
});

const check = (extra: Record<string, unknown>) =>
  call('orders.confirmCheck', agent, { items: [{ ...V, qty: 1 }], wilayaId: 68, commune: 'Bou Saâda', isStopdesk: false, ...extra }) as Promise<any>;

test('PX1463: an order in Bou Saâda (68) can be confirmed — the company delivers it as M’Sila (28)', async () => {
  const none = await check({});
  assert.equal(none.deliver.ok, true, 'no company chosen: one of them delivers there');
  assert.equal(none.canConfirm, true);
  const withCo = await check({ companyId: co });
  assert.equal(withCo.deliver.ok, true);
  assert.equal(withCo.deliver.why, null);
  const o = (await call('orders.create', admin, { customerName: 'Nasser Bou Saada', phone: '0697123468', wilayaId: 68, commune: 'Bou Saâda', items: [{ ...V, qty: 1 }] })) as any;
  await db.query('UPDATE orders SET agent_id = $2 WHERE id = $1', [o.id, agent.session.profile.id]);
  await call('orders.setConf', agent, { ids: [o.id], status: 'confirmed' });
  assert.equal((await db.query('SELECT conf_status FROM orders WHERE id = $1', [o.id]))[0].conf_status, 'confirmed');
  // the price the company will charge (its tariff for M'Sila) is counted on the order
  const f28 = (await db.query('SELECT home FROM delivery_fees WHERE company_id = $1 AND wilaya_id = 28', [co]))[0];
  const q = (await call('orders.quote', agent, { wilayaId: 68, isStopdesk: false, companyId: co, items: [{ ...V, qty: 1 }] })) as any;
  assert.equal(q.served, true);
  assert.ok(Number(f28.home) > 0);
});

test('a company’s own price for a new wilaya counts — 0 there: it does not deliver there', async () => {
  await db.query('INSERT INTO delivery_fees (company_id, wilaya_id, home, desk, return_fee) VALUES ($1, 68, 0, 0, 0)', [co]);
  const r = await check({ companyId: co });
  assert.equal(r.deliver.ok, false);
  assert.equal(r.deliver.why, 'company');
  await db.query('UPDATE delivery_fees SET home = 777 WHERE company_id = $1 AND wilaya_id = 68', [co]);
  assert.equal((await check({ companyId: co })).deliver.ok, true);
  await db.query('DELETE FROM delivery_fees WHERE company_id = $1 AND wilaya_id = 68', [co]);
});

test('the bureaus a company keeps in the old wilaya are offered for the new one', async () => {
  await db.query('UPDATE delivery_fees SET desk = 450 WHERE company_id = $1 AND wilaya_id = 28', [co]);
  const desk = Number((await db.query(`INSERT INTO stopdesks (company_id, wilaya_id, commune, name, address) VALUES ($1, 28, 'Bou Saâda', 'Bureau Bou Saâda', 'Centre') RETURNING id`, [co]))[0].id);
  const opts = (await call('confirmation.deskOptions', agent, { wilayaId: 68 })) as any;
  const c = opts.companies.find((x: any) => x.id === co);
  assert.equal(c.home, true);
  assert.equal(c.desk, true);
  assert.ok(opts.desks.some((d: any) => d.id === desk), 'the M’Sila bureau is offered for Bou Saâda');
  // at a bureau with none chosen: choose it (the courier refuses a stop-desk parcel without its bureau)
  const noDesk = await check({ companyId: co, isStopdesk: true });
  assert.equal(noDesk.deliver.why, 'desk');
  const withDesk = await check({ companyId: co, isStopdesk: true, stopdeskId: desk });
  assert.equal(withDesk.deliver.ok, true);
  const list = (await call('delivery.stopdesks', admin, { companyId: co, wilayaId: 68 })) as any[];
  assert.ok(list.some((d) => d.id === desk));
  // an old wilaya does not get the new ones' bureaus
  assert.ok(!((await call('delivery.stopdesks', admin, { companyId: co, wilayaId: 16 })) as any[]).some((d) => d.id === desk));
});

test('client prices: a new wilaya with no price of its own takes the old wilaya’s, its own price stays', async () => {
  const grid = {
    '28': { home: 900, desk: 630 },
    '68': { home: 0, desk: 0 },
    '17': { home: 800, desk: 500 },
    '65': { home: 600, desk: 400 },
    '66': { home: 750, desk: 450 },
    '32': { home: 1150, desk: 730 },
    '16': { home: 0, desk: 0 },
  };
  await db.query(`INSERT INTO settings (key, value) VALUES ('clientFees', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ G: grid })]);
  await db.query(`INSERT INTO settings (key, value) VALUES ('defaultFeeGrid', '"G"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  assert.equal(await clientFee(db, 68, false), 900, 'empty (0 / 0): M’Sila’s');
  assert.equal(await clientFee(db, 68, true), 630);
  assert.equal(await clientFee(db, 65, false), 800, 'Pilotix’s old flat 600 / 400: Djelfa’s');
  assert.equal(await clientFee(db, 66, false), 750, 'its own price stays');
  assert.equal(await clientFee(db, 69, false), 1150, 'none: El Bayadh’s');
  assert.equal(await clientFee(db, 16, false), 0, 'an old wilaya is never touched (0 stays 0)');
  const home = await clientHomeFees(db);
  assert.equal(home[68], 900);
  assert.equal(home[69], 1150);
  const got = (await call('admin.fees.get', admin, {})) as any;
  assert.deepEqual(got.grids.G['68'], { home: 900, desk: 630 }, 'the price list shows what the customer pays');
  await db.query(`INSERT INTO settings (key, value) VALUES ('savFees', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ '28': { home: 500, desk: 300 } })]);
  assert.equal(await savFee(db, 68, false), 500);
});

test('price lists completed before they are saved (an API import, or typed by hand)', () => {
  const rows = fillNewWilayas([
    { wilayaId: 28, home: 850, desk: 580, returnFee: 250 },
    { wilayaId: 17, home: 900, desk: 600, returnFee: 250 },
    { wilayaId: 66, home: 0, desk: null, returnFee: null },
  ]);
  const by = Object.fromEntries(rows.map((r) => [r.wilayaId, [r.home, r.desk, r.returnFee]]));
  assert.deepEqual(by[68], [850, 580, 250]);
  assert.deepEqual(by[65], [900, 600, 250]);
  assert.deepEqual(by[66], [0, null, null], 'a price typed for it (even 0) stays');
  assert.equal(by[69], undefined, 'El Bayadh has no price: nothing to copy');
  const many = withNewWilayas([
    { company_id: 1, wilaya_id: 28, home: 850 },
    { company_id: 2, wilaya_id: 28, home: 700 },
    { company_id: 2, wilaya_id: 68, home: 720 },
  ]);
  assert.deepEqual(
    many.filter((r) => r.wilaya_id === 68).map((r) => [r.company_id, r.home]),
    [
      [2, 720],
      [1, 850],
    ],
  );
  const g: Record<string, { home: number; desk: number }> = { '28': { home: 1, desk: 2 } };
  assert.deepEqual(effectiveGrid(g)['68'], { home: 1, desk: 2 });
});

test('the wilaya helpers', () => {
  assert.equal(oldWilaya(68), 28);
  assert.equal(oldWilaya(16), 16);
  assert.deepEqual(wilayaAndOld(68), [68, 28]);
  assert.deepEqual(wilayaAndOld(28), [28]);
  assert.deepEqual(wilayaFamily(28), [28, 68]);
  assert.deepEqual(wilayaFamily(66).sort(), [17, 65, 66]);
  assert.equal(sameOldWilaya(68, 28), true);
  assert.equal(sameOldWilaya(68, 16), false);
});

const parcel = (w: number) => ({ id: 1, ref: 'PX1', wilaya_id: w, wilaya: 'Bou Saâda', wilaya_ar: 'بوسعادة', commune: 'Bou Saâda' }) as unknown as Parcel;
test('a company that counts 58 gets the new wilaya as its old one; ZR finds it itself', () => {
  const y = courierParcel('yalidine', parcel(68));
  assert.equal(y.wilaya_id, 28);
  assert.equal(y.wilaya, "M'Sila");
  assert.equal(y.commune, 'Bou Saâda');
  assert.equal(courierParcel('ecotrack', parcel(16)).wilaya_id, 16);
  assert.equal(courierParcel('zr', parcel(68)).wilaya_id, 68);
  assert.equal(courierChange('ecotrack', { item: {} as any, kind: 'address', wilayaId: 69 }).wilayaId, 32);
  assert.equal(courierChange('zr', { item: {} as any, kind: 'address', wilayaId: 69 }).wilayaId, 69);
  const shop = (kind: string) => ({ id: 1, name: 'X', kind, secret: {}, settings: {}, statusMap: {}, shop: { name: 'S', fromWilayaId: 68, fromWilaya: 'Bou Saâda' } }) as unknown as CourierCompany;
  assert.equal(courierCompany(shop('noest')).shop.fromWilayaId, 28);
  assert.equal(courierCompany(shop('zr')).shop.fromWilayaId, 68);
});

// ---- ZR: its own list of wilayas and communes (a fake ZR answering the territories search)
const real = globalThis.fetch;
afterEach(() => (globalThis.fetch = real));
function fakeZr(wilayas: any[], communes: any[]) {
  globalThis.fetch = (async (u: string, o: any) => {
    const m = `${o?.method ?? 'GET'} ${String(u).replace(/^.*\/api\/v1/, '')}`;
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (m === 'POST /territories/search') {
      const level = JSON.parse(o.body)?.advancedFilter?.filters?.[0]?.value;
      return json({ items: level === 'wilaya' ? wilayas : level === 'commune' ? communes : [...wilayas, ...communes], hasNext: false, totalPages: 1 });
    }
    return json({});
  }) as typeof fetch;
}
const zrCo = (id: number) => ({ id, name: 'ZR', kind: 'zr', secret: { api_key: 'k', tenant: 't' }, settings: {}, statusMap: {}, shop: { name: 'S', fromWilayaId: 16, fromWilaya: 'Alger' } }) as unknown as CourierCompany;
const W28 = { id: 'w28', code: '28', name: "M'Sila", level: 'wilaya' };
const BOU = { id: 'c1', code: '2801', name: 'Bou Saada', nameArabic: 'بوسعادة', level: 'commune', parentId: 'w28' };
const MSILA = { id: 'c2', code: '2802', name: "M'Sila", level: 'commune', parentId: 'w28' };

test('ZR still on 58: Bou Saâda (68) is found in M’Sila (28)', async () => {
  fakeZr([W28], [BOU, MSILA]);
  const list = await zr.communes!(zrCo(901), 68, false);
  assert.deepEqual(list.map((x) => x.name).sort(), ['Bou Saada', "M'Sila"]);
});

test('the day ZR has 68: its own communes there, and those it still keeps in 28', async () => {
  fakeZr([W28, { id: 'w68', code: '68', name: 'Bou Saada', level: 'wilaya' }], [{ ...BOU, id: 'c9', parentId: 'w68' }, MSILA]);
  const list = await zr.communes!(zrCo(902), 68, false);
  assert.deepEqual(list.map((x) => x.id).sort(), ['c2', 'c9']);
  // an old wilaya only gets its own
  assert.deepEqual((await zr.communes!(zrCo(902), 28, false)).map((x) => x.id), ['c2']);
});
