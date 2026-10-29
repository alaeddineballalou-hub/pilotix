// Dépôt, from « À préparer » to « En dispatch »: picked whole with a company → « En dispatch » by itself; no company →
// « À attribuer », where only managers (ticked) and admins choose; a parcel the courier refuses stays in « En dispatch »
// with the reason and « Renvoyer »; a cancelled order's parcel is cancelled at the courier by itself.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let admin: Ctx;
let as: (email: string) => Promise<Ctx>;
let X: { productId: number; variantId: number };
let manual: number;
let noest: number;

before(async () => {
  ({ db, as } = await setup(40));
  admin = await as(EMAILS.admin);
  const wh = Number((await db.query('SELECT id FROM warehouses WHERE active ORDER BY is_default DESC, id LIMIT 1'))[0].id);
  const r = (await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id AND v.active WHERE p.active AND NOT p.is_service ORDER BY p.id DESC, v.id LIMIT 1`))[0];
  X = { productId: Number(r.id), variantId: Number(r.vid) };
  await db.query('INSERT INTO stock (variant_id, warehouse_id, qty) VALUES ($1, $2, 500) ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET qty = 500', [X.variantId, wh]);
  manual = Number((await db.query(`SELECT id FROM delivery_companies WHERE kind = 'manual' ORDER BY id LIMIT 1`))[0].id);
  noest = Number((await db.query(`SELECT id FROM delivery_companies WHERE kind = 'noest' ORDER BY id LIMIT 1`))[0].id);
  await db.query(`UPDATE settings SET value = jsonb_set(value, '{defaultCompanyId}', 'null') WHERE key = 'shop'`);
});

let n = 0;
const phone = () => `0695${String(600000 + ++n).slice(-6)}`;
/** a confirmed order of one piece; the depot then picks everything waiting for that variant */
async function confirmed(companyId: number | null) {
  const o = (await call('orders.create', admin, { customerName: `Attrib${n} Test`, phone: phone(), wilayaId: 16, commune: 'Kouba', items: [{ ...X, qty: 1 }], ...(companyId ? { companyId } : {}) })) as any;
  await call('orders.setConf', admin, { ids: [o.id], status: 'confirmed' });
  if (!companyId) await db.query('UPDATE orders SET company_id = NULL WHERE id = $1', [o.id]);
  return Number(o.id);
}
const pickAll = async (karim: Ctx) => {
  const row = ((await call('depot.pickList', karim, {})) as any[]).find((r) => r.variantId === X.variantId);
  return row ? ((await call('depot.pick', karim, { productId: X.productId, variantId: X.variantId, qty: row.need })) as any) : null;
};
const st = async (id: number) => (await db.query('SELECT follow_status, tracking, send_error, company_id, cancel_by_hand FROM orders WHERE id = $1', [id]))[0];

test('picked whole: with a company → « En dispatch » by itself; without → « À attribuer »', async () => {
  const karim = await as(EMAILS.depot);
  const withCo = await confirmed(manual);
  const without = await confirmed(null);
  const r = await pickAll(karim);
  assert.ok(r.dispatched >= 1);
  assert.equal((await st(withCo)).follow_status, 'prepared');
  assert.equal((await st(without)).follow_status, 'to_prepare');
  const list = (await call('depot.toAssign', karim, {})) as any;
  assert.ok(list.rows.some((o: any) => o.id === without));
  assert.equal(list.canAct, false, 'a depot agent sees it, a manager or an admin chooses');
  await assert.rejects(call('depot.assign', karim, { ids: [without], companyId: manual }), /managers et les admins/);
  // ticked in Utilisateurs: he chooses too
  await call('users.update', admin, { id: karim.session.profile.id, canAssign: true });
  const karim2 = await as(EMAILS.depot);
  assert.equal(((await call('depot.toAssign', karim2, {})) as any).canAct, true);
  await call('depot.assign', karim2, { ids: [without], companyId: manual });
  assert.deepEqual([(await st(without)).follow_status, Number((await st(without)).company_id)], ['prepared', manual]);
});

test('refused by the courier: stays in « En dispatch » with the reason; « Renvoyer » sends it once it is fixed', async () => {
  const karim = await as(EMAILS.depot);
  await db.query(`UPDATE delivery_companies SET credentials = '{}' WHERE id = $1`, [noest]);
  const o = await confirmed(noest);
  await pickAll(karim);
  const s = await st(o);
  assert.equal(s.follow_status, 'prepared');
  assert.equal(s.tracking, null);
  assert.match(s.send_error ?? '', /Clés API manquantes/);
  const alerts = (await call('depot.dispatchAlerts', karim, {})) as any;
  assert.ok(alerts.refused.some((x: any) => x.id === o && /Clés API/.test(x.error)));
  assert.ok(((await call('depot.counts', karim, {})) as any).prepAlerts >= 1);
  await db.query(`UPDATE delivery_companies SET credentials = '{"demo":true}' WHERE id = $1`, [noest]);
  await call('depot.resend', karim, { ids: [o] });
  const after = await st(o);
  assert.ok(after.tracking, 'sent');
  assert.equal(after.send_error, null);
});

test('a cancelled order: its parcel at the courier is cancelled there by itself', async () => {
  const karim = await as(EMAILS.depot);
  const o = await confirmed(noest);
  await pickAll(karim);
  assert.ok((await st(o)).tracking, 'its parcel is at the courier');
  await call('orders.setConf', admin, { ids: [o], status: 'cancelled', reason: 'test' });
  const s = await st(o);
  assert.equal(s.follow_status, 'cancelled');
  assert.equal(s.tracking, null, 'cancelled at the courier');
  assert.equal(s.cancel_by_hand, false);
});
