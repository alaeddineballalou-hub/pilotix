// API Integration: a company's prices come from its API (locked, taken again, « changed » counted), swap fees (ZR's by
// API, else 50 / 100 DA or typed) put on the order that gets a swapped parcel, a company's « Alertes » statuses, and the
// order card's payment step (not received → the company has it → paid, to pick up → received).
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(300));
});

const companyId = async (kind: string) => Number((await db.query('SELECT id FROM delivery_companies WHERE kind = $1 ORDER BY id LIMIT 1', [kind]))[0].id);

test('prices by API: locked, taken again from the API, with when and how many changed', async () => {
  const admin = await as(EMAILS.admin);
  const zr = await companyId('zr');
  const before: any = await call('delivery.feesInfo', admin, { companyId: zr });
  assert.equal(before.api, true);
  await assert.rejects(call('delivery.saveFees', admin, { companyId: zr, rows: [{ wilayaId: 16, home: 1, desk: 1, returnFee: 1 }] }), /viennent de son API/);
  // a price that moved at the company comes back as the company says, and is counted
  await db.query('UPDATE delivery_fees SET home = 12345 WHERE company_id = $1 AND wilaya_id = 16', [zr]);
  const r: any = await call('delivery.importFees', admin, { companyId: zr });
  assert.ok(r.changed >= 1, JSON.stringify({ changed: r.changed }));
  assert.notEqual(r.rows[15].home, 12345);
  const after: any = await call('delivery.feesInfo', admin, { companyId: zr });
  assert.ok(after.syncedAt, 'when it was taken');
  assert.equal(after.changed, r.changed);
  assert.equal(after.error, null);
  // a company without prices by API: typed by hand, as before
  const man: any = await call('delivery.feesInfo', admin, { companyId: await companyId('manual') });
  assert.equal(man.api, false);
});

test('a new company with prices by API gets them at once', async () => {
  const admin = await as(EMAILS.admin);
  const c: any = await call('delivery.saveCompany', admin, { name: 'DHD test', kind: 'ecotrack', active: true, phone: '', settings: { base_url: 'https://platform.dhd-dz.com' }, secret: { token: 'T-1' } });
  const fees: any[] = (await call('delivery.fees', admin, { companyId: c.id })) as any[];
  assert.ok(fees.filter((f) => f.home !== null).length > 40, 'prices there');
  assert.ok(((await call('delivery.feesInfo', admin, { companyId: c.id })) as any).syncedAt);
});

test('swap fees: ZR by its API (locked), others 50 / 100 DA or typed, none for our livreurs', async () => {
  const admin = await as(EMAILS.admin);
  const zr: any = await call('delivery.feesInfo', admin, { companyId: await companyId('zr') });
  assert.deepEqual(zr.swap, { same: 50, other: 100, fromApi: true });
  await assert.rejects(call('delivery.saveSwapFees', admin, { companyId: await companyId('zr'), same: 1, other: 2 }), /viennent de son API/);
  const yal = await companyId('yalidine');
  assert.deepEqual(((await call('delivery.feesInfo', admin, { companyId: yal })) as any).swap, { same: 50, other: 100, fromApi: false });
  assert.deepEqual(await call('delivery.saveSwapFees', admin, { companyId: yal, same: 70, other: 120 }), { same: 70, other: 120, fromApi: false });
  assert.deepEqual(((await call('delivery.feesInfo', admin, { companyId: yal })) as any).swap, { same: 70, other: 120, fromApi: false });
  const own = await companyId('own');
  assert.deepEqual(((await call('delivery.feesInfo', admin, { companyId: own })) as any).swap, { same: null, other: null, fromApi: false });
  await assert.rejects(call('delivery.saveSwapFees', admin, { companyId: own, same: 1, other: 2 }), /pas de frais/);
  await assert.rejects(call('delivery.saveSwapFees', await as(EMAILS.suivi), { companyId: yal, same: 1, other: 2 }), /Accès refusé/);
});

test('a swapped parcel: the swap fee is on the cost of the order that gets it', async () => {
  const suivi = await as(EMAILS.suivi);
  const zr = await companyId('zr');
  const a = (await db.query(`SELECT id, wilaya_id FROM orders WHERE follow_status = 'returning' AND shipped_at IS NOT NULL AND tracking IS NOT NULL ORDER BY id LIMIT 1`))[0];
  const b = (await db.query(`SELECT id, wilaya_id FROM orders WHERE conf_status = 'confirmed' AND follow_status = 'to_prepare' AND shipped_at IS NULL AND wilaya_id <> $1 ORDER BY id LIMIT 1`, [a.wilaya_id]))[0];
  await db.query('UPDATE orders SET company_id = $2, delivery_cost = 400 WHERE id = $1', [a.id, zr]);
  const r: any = await call('suivi.swap', suivi, { fromId: Number(a.id), toId: Number(b.id) });
  assert.equal(r.to.deliveryCost, 400 + 100, 'another wilaya: 100 DA more');
  const ev = (await db.query(`SELECT note FROM order_events WHERE order_id = $1 AND kind = 'follow_status' ORDER BY id DESC LIMIT 1`, [b.id]))[0];
  assert.match(ev.note, /frais d’échange 100 DA \(autre wilaya\)/);
});

test('a company’s « Alertes »: one or many of its statuses send the order to Suivi › Alertes', async () => {
  const admin = await as(EMAILS.admin);
  const all: any[] = (await call('delivery.alertStatuses', admin, {})) as any[];
  const co = all.find((c) => c.statuses.length >= 2);
  assert.ok(co, 'a company with statuses');
  const pick = co.statuses.slice(0, 2).map((s: any) => s.status);
  await call('delivery.saveAlertStatuses', admin, { companyId: co.companyId, alert: pick });
  const again = ((await call('delivery.alertStatuses', admin, {})) as any[]).find((c) => c.companyId === co.companyId);
  assert.deepEqual(again.statuses.filter((s: any) => s.alert).map((s: any) => s.status).sort(), [...pick].sort());
  await call('delivery.saveAlertStatuses', admin, { companyId: co.companyId, alert: [] });
  const none = ((await call('delivery.alertStatuses', admin, {})) as any[]).find((c) => c.companyId === co.companyId);
  assert.equal(none.statuses.filter((s: any) => s.alert).length, 0);
});

test('the order card: the payment step of a delivered parcel, from the company to the caisse', async () => {
  const admin = await as(EMAILS.admin);
  const zr = await companyId('zr');
  const o = (await db.query(`SELECT id FROM orders WHERE follow_status = 'delivered' AND NOT cashed ORDER BY id LIMIT 1`))[0];
  const oid = Number(o.id);
  await db.query(`UPDATE orders SET company_id = $2, tracking = 'ZR-PAY-1', ext_status = 'Livré' WHERE id = $1`, [oid, zr]);
  const step = async () => ((await call('orders.get', admin, { id: oid })) as any).pay;
  assert.equal((await step()).step, 'waiting');
  await db.query(`UPDATE orders SET ext_status = 'Encaissé' WHERE id = $1`, [oid]);
  assert.equal((await step()).step, 'collected');
  await db.query(`UPDATE orders SET ext_status = 'Livrée [ Encaisser ]' WHERE id = $1`, [oid]);
  assert.equal((await step()).step, 'waiting', '« to cash » is not cashed');
  await db.query(
    `INSERT INTO courier_payments (company_id, ext_id, ref, amount, status, done, at, lines) VALUES ($1, 'PAY-T1', 'P-77', 3000, 'Prêt', false, now(), $2)`,
    [zr, JSON.stringify([{ tracking: 'ZR-PAY-1', customer: 'X', type: 'Livré', amount: 3000, costs: 0, comment: null }])],
  );
  const ready = await step();
  assert.equal(ready.step, 'ready');
  assert.equal(ready.ref, 'P-77');
  await db.query(`UPDATE orders SET cashed = true, cashed_at = now() WHERE id = $1`, [oid]);
  const got = await step();
  assert.equal(got.step, 'received');
  assert.equal(got.ref, 'P-77');
  // not delivered: no payment step
  const road = (await db.query(`SELECT id FROM orders WHERE follow_status = 'out_for_delivery' AND NOT cashed LIMIT 1`))[0];
  assert.equal(((await call('orders.get', admin, { id: Number(road.id) })) as any).pay, null);
});
