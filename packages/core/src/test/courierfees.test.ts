// A parcel's fees come from the courier's API (ZR), not the price list: its delivery / return price, the weight it
// counted (it may weigh again a parcel declared under 5 kg) and its weight fee — 50 DA a kg above 5 kg, on the delivery
// and on the return — exact once it pays (« weightCost »). The reports, « Frais société » and the caisse count them.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { apiFees, saveCourierFees, weightFee, weightRuleOf, ZR_WEIGHT } from '../modules/courierfees';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(300));
});

const one = async (sql: string, args: unknown[] = []) => (await db.query(sql, args))[0];
const zrId = async () => Number((await one(`SELECT id FROM delivery_companies WHERE kind = 'zr' LIMIT 1`)).id);
const now = () => new Date().toISOString();

test('ZR’s weight fee: 50 DA a kg started above 5 kg, on the delivery and the return; a company’s own rule wins', () => {
  assert.deepEqual(weightRuleOf('zr', {}), ZR_WEIGHT);
  assert.equal(weightFee(5, ZR_WEIGHT), 0);
  assert.equal(weightFee(5.01, ZR_WEIGHT), 50);
  assert.equal(weightFee(7.2, ZR_WEIGHT), 150);
  assert.equal(weightFee(null, ZR_WEIGHT), 0);
  assert.deepEqual(weightRuleOf('yalidine', {}), { freeKg: 0, perKg: 0, onReturn: true });
  assert.deepEqual(weightRuleOf('zr', { overweight: { freeKg: 3, perKg: 40, onReturn: false } }), { freeKg: 3, perKg: 40, onReturn: false });
});

test('the courier’s numbers: counted from the weight it found, exact once it pays, kept by later statuses; the cost follows until cashed', async () => {
  const zr = await zrId();
  const o = await one(`SELECT id FROM orders WHERE company_id = $1 AND follow_status = 'out_for_delivery' AND NOT cashed ORDER BY id LIMIT 1`, [zr]);
  const id = Number(o.id);
  await db.query('UPDATE orders SET courier_fees = NULL WHERE id = $1', [id]);
  // a status: ZR weighed it 7.2 kg (declared under 5): 150 DA of weight fee counted on the 400 DA delivery
  assert.equal(await saveCourierFees(db, id, { delivery: 400, ret: 250, kg: 7.2 }, 'track', ZR_WEIGHT, now()), true);
  assert.equal(Number((await one('SELECT delivery_cost FROM orders WHERE id = $1', [id])).delivery_cost), 550);
  let f = apiFees((await one('SELECT courier_fees FROM orders WHERE id = $1', [id])).courier_fees)!;
  assert.deepEqual({ delivery: f.delivery, ret: f.ret, weight: f.weight, weightRet: f.weightRet, exact: f.exact }, { delivery: 400, ret: 250, weight: 150, weightRet: 150, exact: false });
  // the same answer again: nothing changes
  assert.equal(await saveCourierFees(db, id, { delivery: 400, ret: 250, kg: 7.2 }, 'track', ZR_WEIGHT, now()), false);
  // its payment: the exact weight fee (100 DA) — a later status keeps it
  await saveCourierFees(db, id, { delivery: 400, ret: 250, kg: 7, weight: 100 }, 'pay', ZR_WEIGHT, now());
  await saveCourierFees(db, id, { delivery: 400, ret: 250, kg: 9 }, 'track', ZR_WEIGHT, now());
  f = apiFees((await one('SELECT courier_fees FROM orders WHERE id = $1', [id])).courier_fees)!;
  assert.equal(f.weight, 100);
  assert.equal(f.exact, true);
  assert.equal(Number((await one('SELECT delivery_cost FROM orders WHERE id = $1', [id])).delivery_cost), 500);
  // the money is received: its cost no longer moves
  await db.query('UPDATE orders SET cashed = true, cashed_at = now() WHERE id = $1', [id]);
  await saveCourierFees(db, id, { delivery: 600, ret: 250 }, 'pay', ZR_WEIGHT, now());
  assert.equal(Number((await one('SELECT delivery_cost FROM orders WHERE id = $1', [id])).delivery_cost), 500);
});

test('« Frais société » and the Bilan: the courier’s own fees first; no weight fee guessed from the products for ZR', async () => {
  const zr = await zrId();
  const suivi = await as(EMAILS.suivi);
  const rows = await db.query(`SELECT id FROM orders WHERE company_id = $1 AND follow_status = 'delivered' AND NOT cashed ORDER BY id LIMIT 2`, [zr]);
  const [a, b] = rows.map((r: any) => Number(r.id));
  await db.query(`UPDATE orders SET courier_fees = $2 WHERE id = $1`, [a, JSON.stringify({ delivery: 430, ret: 200, kg: 6.4, weight: null, est: 100, estRet: 100, at: now(), src: 'track' })]);
  await db.query(`UPDATE orders SET courier_fees = NULL WHERE id = $1`, [b]);
  // b's products weigh a lot: ZR did not say it weighed it, so no weight fee is guessed
  const heavy = await one(`SELECT id FROM products ORDER BY weight_kg DESC NULLS LAST LIMIT 1`);
  await db.query(`UPDATE order_items SET product_id = $2, qty = 3 WHERE order_id = $1`, [b, heavy.id]);
  const fees: any = await call('orders.companyFees', suivi, { ids: [a, b] });
  assert.deepEqual({ fee: fees[a].fee, extra: fees[a].extra, fromApi: fees[a].fromApi }, { fee: 530, extra: 100, fromApi: true });
  assert.equal(fees[b].extra, 0);
  assert.equal(fees[b].fromApi, false);
  // a parcel coming back: ZR's return price + its weight fee in the report's return fees
  const r = await one(`SELECT id, coalesce(returned_at, returning_at, updated_at) AS at FROM orders WHERE company_id = $1 AND follow_status = 'returned' ORDER BY id LIMIT 1`, [zr]);
  const day = new Date(r.at).toISOString().slice(0, 10);
  const range = { from: `${day}T00:00:00.000Z`, to: new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString() };
  const before = ((await call('orders.deliveredReport', suivi, range)) as any).companies.find((c: any) => c.companyId === zr);
  await db.query(`UPDATE orders SET courier_fees = $2 WHERE id = $1`, [r.id, JSON.stringify({ delivery: 400, ret: 777, kg: 8, weight: 150, est: 150, estRet: 150, at: now(), src: 'pay' })]);
  const after = ((await call('orders.deliveredReport', suivi, range)) as any).companies.find((c: any) => c.companyId === zr);
  assert.ok(after.returnFees + after.returnOverweight - (before.returnFees + before.returnOverweight) > 0, 'the ZR return counts its own price');
  assert.equal(after.returnOverweight - before.returnOverweight >= 0, true);
});

test('the status sync and ZR’s payment lines bring its prices, weight and weight fee', async () => {
  const zr = await zrId();
  await db.query(`UPDATE delivery_companies SET credentials = '{"api_key":"k","tenant":"t"}', active = true WHERE id = $1`, [zr]);
  const o = await one(`SELECT id, tracking FROM orders WHERE company_id = $1 AND follow_status = 'shipped' AND tracking IS NOT NULL AND NOT cashed ORDER BY id LIMIT 1`, [zr]);
  const id = Number(o.id);
  await db.query('UPDATE orders SET courier_fees = NULL WHERE id = $1', [id]);
  const server = {
    courier: async (action: string, args: any) => {
      if (action === 'track') return args.items.filter((it: any) => Number(it.id) === id).map((it: any) => ({ id: it.id, key: 'vers_wilaya', status: 'Vers wilaya', at: null, costs: { delivery: 450, ret: 250, kg: 6.3 } }));
      throw new Error('unexpected ' + action);
    },
  } as any;
  const admin = await as(EMAILS.admin, server);
  await call('delivery.sync', admin, { companyId: zr });
  const fees: any = await call('orders.companyFees', admin, { ids: [id] });
  assert.deepEqual({ fee: fees[id].fee, extra: fees[id].extra }, { fee: 450 + 100, extra: 100 });
  const card: any = await call('orders.get', admin, { id });
  assert.deepEqual(card.courierFees, { delivery: 450, ret: 250, weight: 100, weightRet: 100, kg: 6.3, exact: false });

  // ZR pays a delivered parcel: its line says what it took on it (« weightCost » 200 DA for 8.5 kg): exact on the order
  const d = await one(`SELECT id, tracking FROM orders WHERE company_id = $1 AND follow_status = 'delivered' AND NOT cashed AND tracking IS NOT NULL ORDER BY id DESC LIMIT 1`, [zr]);
  const at = now();
  const payer = {
    courier: async (action: string) => {
      if (action === 'payBalance') return { paid: 0, ready: 0, delivered: 0, notReady: 0 };
      if (action === 'payRequests') return [];
      if (action === 'payments') return [{ extId: 'CF-P1', ref: 'PAY-CF1', amount: 1000, status: 'Accepted', done: true, at, doneAt: at, requestId: null, place: 'Hub', details: {} }];
      if (action === 'payLines') return [{ tracking: d.tracking, customer: 'X', type: 'Livré', amount: 1000, costs: 200, comment: null, fees: { delivery: 400, ret: 250, kg: 8.5, weight: 200 } }];
      throw new Error('unexpected ' + action);
    },
  } as any;
  await call('caisse.paySync', await as(EMAILS.admin, payer), { companyId: zr });
  const paid: any = await call('orders.get', admin, { id: Number(d.id) });
  assert.deepEqual(paid.courierFees, { delivery: 400, ret: 250, weight: 200, weightRet: 200, kg: 8.5, exact: true });
  assert.equal(paid.deliveryCost, 600, 'its cost is ZR’s, taken before the money came in');
  assert.equal(paid.cashed, true);
});
