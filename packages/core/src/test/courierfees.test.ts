// A parcel's fees come from the courier's API (ZR), not the price list: its delivery / return price, the weight it
// counted (it may weigh again a parcel declared under 5 kg) and its weight fee — 50 DA a kg above 5 kg, on the delivery
// and on the return — exact once it pays (« weightCost »). The reports, « Frais société » and the caisse count them.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { ordersOf } from '../modules/ads';
import { apiFees, ruleFee, saveCourierFees, weightFee, weightRuleOf, ZR_WEIGHT } from '../modules/courierfees';
import { setCourierCost } from '../modules/orders';
import { weighed, weightIn } from '../couriers/util';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(300));
});

const one = async (sql: string, args: unknown[] = []) => (await db.query(sql, args))[0];
const zrId = async () => Number((await one(`SELECT id FROM delivery_companies WHERE kind = 'zr' LIMIT 1`)).id);
const now = () => new Date().toISOString();

test('ZR’s weight fee: whole kilos (no comma) — 5 kg → 0, 6 kg → 50 DA, 7 kg → 100 DA; a company’s own rule wins', () => {
  assert.deepEqual(weightRuleOf('zr', {}), ZR_WEIGHT);
  assert.equal(weightFee(5, ZR_WEIGHT), 0);
  assert.equal(weightFee(6, ZR_WEIGHT), 50);
  assert.equal(weightFee(7, ZR_WEIGHT), 100);
  // a weight the API writes as a decimal (5.0, 6.000001) is its whole kilo
  assert.equal(weightFee(5.0000001, ZR_WEIGHT), 0);
  assert.equal(weightFee(5.999999, ZR_WEIGHT), 50);
  assert.equal(weightFee(null, ZR_WEIGHT), 0);
  assert.deepEqual(weightRuleOf('yalidine', {}), { freeKg: 0, perKg: 0, onReturn: true });
  assert.deepEqual(weightRuleOf('zr', { overweight: { freeKg: 3, perKg: 40, onReturn: false } }), { freeKg: 3, perKg: 40, onReturn: false });
});

test('the courier’s numbers: counted from the weight it found, exact once it pays, kept by later statuses; the cost follows until cashed', async () => {
  const zr = await zrId();
  const o = await one(`SELECT id FROM orders WHERE company_id = $1 AND follow_status = 'out_for_delivery' AND NOT cashed ORDER BY id LIMIT 1`, [zr]);
  const id = Number(o.id);
  await db.query('UPDATE orders SET courier_fees = NULL WHERE id = $1', [id]);
  // a status: ZR weighed it 8 kg (declared under 5): 150 DA of weight fee counted on the 400 DA delivery
  assert.equal(await saveCourierFees(db, id, { delivery: 400, ret: 250, kg: 8 }, 'track', ZR_WEIGHT, now()), true);
  assert.equal(Number((await one('SELECT delivery_cost FROM orders WHERE id = $1', [id])).delivery_cost), 550);
  let f = apiFees((await one('SELECT courier_fees FROM orders WHERE id = $1', [id])).courier_fees)!;
  assert.deepEqual({ delivery: f.delivery, ret: f.ret, weight: f.weight, weightRet: f.weightRet, exact: f.exact }, { delivery: 400, ret: 250, weight: 150, weightRet: 150, exact: false });
  // the same answer again: nothing changes
  assert.equal(await saveCourierFees(db, id, { delivery: 400, ret: 250, kg: 8 }, 'track', ZR_WEIGHT, now()), false);
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
      if (action === 'track') return args.items.filter((it: any) => Number(it.id) === id).map((it: any) => ({ id: it.id, key: 'vers_wilaya', status: 'Vers wilaya', at: null, costs: { delivery: 450, ret: 250, kg: 7 } }));
      throw new Error('unexpected ' + action);
    },
  } as any;
  const admin = await as(EMAILS.admin, server);
  await call('delivery.sync', admin, { companyId: zr });
  const fees: any = await call('orders.companyFees', admin, { ids: [id] });
  assert.deepEqual({ fee: fees[id].fee, extra: fees[id].extra }, { fee: 450 + 100, extra: 100 });
  const card: any = await call('orders.get', admin, { id });
  const { declaredKg, ...rest } = card.courierFees;
  assert.deepEqual(rest, { delivery: 450, ret: 250, weight: 100, weightRet: 100, kg: 7, exact: false });
  assert.ok(declaredKg >= 1, 'the weight Pilotix declared to ZR');

  // ZR pays a delivered parcel: its line says what it took on it (« weightCost » 200 DA for 9 kg): exact on the order
  const d = await one(`SELECT id, tracking FROM orders WHERE company_id = $1 AND follow_status = 'delivered' AND NOT cashed AND tracking IS NOT NULL ORDER BY id DESC LIMIT 1`, [zr]);
  const at = now();
  const payer = {
    courier: async (action: string) => {
      if (action === 'payBalance') return { paid: 0, ready: 0, delivered: 0, notReady: 0 };
      if (action === 'payRequests') return [];
      if (action === 'payments') return [{ extId: 'CF-P1', ref: 'PAY-CF1', amount: 1000, status: 'Accepted', done: true, at, doneAt: at, requestId: null, place: 'Hub', details: {} }];
      if (action === 'payLines') return [{ tracking: d.tracking, customer: 'X', type: 'Livré', amount: 1000, costs: 200, comment: null, fees: { delivery: 400, ret: 250, kg: 9, weight: 200 } }];
      throw new Error('unexpected ' + action);
    },
  } as any;
  await call('caisse.paySync', await as(EMAILS.admin, payer), { companyId: zr });
  const paid: any = await call('orders.get', admin, { id: Number(d.id) });
  const { declaredKg: _d, ...got } = paid.courierFees;
  assert.deepEqual(got, { delivery: 400, ret: 250, weight: 200, weightRet: 200, kg: 9, exact: true });
  assert.equal(paid.deliveryCost, 600, 'its cost is ZR’s, taken before the money came in');
  assert.equal(paid.cashed, true);
});

test('Dashboard › Suivi › « Surpoids »: the parcels ZR weighed heavier than declared, per product, and what it cost', async () => {
  const zr = await zrId();
  const suivi = await as(EMAILS.suivi);
  const o = await one(`SELECT o.id, o.delivered_at FROM orders o WHERE o.company_id = $1 AND o.follow_status = 'delivered' ORDER BY o.id LIMIT 1`, [zr]);
  const prod = await one(`SELECT id, name FROM products WHERE weight_kg > 0 ORDER BY weight_kg LIMIT 1`);
  await db.query(`DELETE FROM order_items WHERE order_id = $1 AND id <> (SELECT min(id) FROM order_items WHERE order_id = $1)`, [o.id]);
  await db.query(`UPDATE order_items SET product_id = $2, variant_id = NULL, qty = 1 WHERE order_id = $1`, [o.id, prod.id]);
  // declared 1 kg (a light product), ZR weighed 8 kg: 150 DA
  await db.query(`UPDATE orders SET courier_fees = $2 WHERE id = $1`, [o.id, JSON.stringify({ delivery: 400, ret: 250, kg: 8, weight: null, est: 150, estRet: 150, at: now(), src: 'track' })]);
  const day = new Date(o.delivered_at).toISOString().slice(0, 10);
  const range = { from: `${day}T00:00:00.000Z`, to: new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString() };
  const r: any = await call('delivery.overweight', suivi, range);
  const p = r.parcels.find((x: any) => x.id === Number(o.id));
  assert.ok(p, 'the parcel is there');
  assert.equal(p.zr, 8);
  assert.equal(p.fee, 150);
  assert.ok(p.declared < 8);
  const g = r.products.find((x: any) => x.productId === Number(prod.id));
  assert.ok(g && g.parcels >= 1 && g.fees >= 150 && g.zrMax >= 8);
  assert.ok(r.total.fees >= 150 && r.total.parcels >= 1);
  // ZR weighed it as declared: not there
  await db.query(`UPDATE orders SET courier_fees = $2 WHERE id = $1`, [o.id, JSON.stringify({ delivery: 400, ret: 250, kg: p.declared, weight: 0, est: 0, estRet: 0, at: now(), src: 'pay' })]);
  const again: any = await call('delivery.overweight', suivi, range);
  assert.ok(!again.parcels.some((x: any) => x.id === Number(o.id)));
  await assert.rejects(call('delivery.overweight', await as(EMAILS.conf), range), /Accès refusé/);
});

test('another company’s « Surpoids » (Tarifs): whole kilos like ZR, on the delivery and the return; never for ZR nor our livreurs', () => {
  const rule = { freeKg: 5, perKg: 50, onReturn: true };
  // the weight declared, whole kilos: 5,4 kg → 5 kg (nothing), 5,6 kg → 6 kg (50 DA), 7,4 kg → 7 kg (100 DA)
  assert.equal(ruleFee('yalidine', rule, 5.4), 0);
  assert.equal(ruleFee('yalidine', rule, 5.6), 50);
  assert.equal(ruleFee('noest', rule, 7.4), 100);
  assert.equal(ruleFee('manual', rule, 0), 0);
  // ZR gives its own weight fee by its API; our own livreurs take none
  assert.equal(ruleFee('zr', ZR_WEIGHT, 9), 0);
  assert.equal(ruleFee('own', rule, 9), 0);
  // the old ZR (Procolis) has no API for it: ZR's rule on the weight declared
  assert.equal(ruleFee('zr_legacy', weightRuleOf('zr_legacy', {}), 6), 50);
});

test('« Tarifs › Surpoids » of Yalidine: saved, the unpaid parcels follow, sending counts it, the order card and the profit show it (return too)', async () => {
  const yal = Number((await one(`SELECT id FROM delivery_companies WHERE kind = 'yalidine' LIMIT 1`)).id);
  const zr = await zrId();
  const admin = await as(EMAILS.admin);
  const suivi = await as(EMAILS.suivi);

  // ZR's is its own (locked), Yalidine's is not set yet, our livreurs have none
  let info: any = await call('delivery.feesInfo', admin, { companyId: zr });
  assert.deepEqual(info.weight, { freeKg: 5, perKg: 50, onReturn: true, locked: true, set: true });
  await assert.rejects(call('delivery.saveWeightRule', admin, { companyId: zr, freeKg: 3, perKg: 10, onReturn: false }), /API/);
  const own = await one(`SELECT id FROM delivery_companies WHERE kind = 'own' LIMIT 1`);
  if (own) {
    assert.equal(((await call('delivery.feesInfo', admin, { companyId: Number(own.id) })) as any).weight, null);
    await assert.rejects(call('delivery.saveWeightRule', admin, { companyId: Number(own.id), freeKg: 5, perKg: 50, onReturn: true }), /livreurs/);
  }
  info = await call('delivery.feesInfo', admin, { companyId: yal });
  assert.deepEqual(info.weight, { freeKg: 0, perKg: 0, onReturn: true, locked: false, set: false });
  await assert.rejects(call('delivery.saveWeightRule', suivi, { companyId: yal, freeKg: 5, perKg: 50, onReturn: true }), /Accès refusé/);

  // a heavy product: 7,4 kg declared → 7 kg → 2 kilos above 5 → 100 DA
  const prod = await one(`SELECT id FROM products ORDER BY id DESC LIMIT 1`);
  await db.query(`UPDATE products SET weight_kg = 7.4 WHERE id = $1`, [prod.id]);
  const heavy = async (orderId: unknown) => {
    await db.query(`DELETE FROM order_items WHERE order_id = $1 AND id <> (SELECT min(id) FROM order_items WHERE order_id = $1)`, [orderId]);
    await db.query(`UPDATE order_items SET product_id = $2, variant_id = NULL, qty = 1 WHERE order_id = $1`, [orderId, prod.id]);
  };
  // a parcel on its way, not paid: its cost so far is the price list's
  const o = await one(
    `SELECT o.id, o.delivery_cost, o.is_stopdesk, f.home, f.desk, f.return_fee FROM orders o JOIN delivery_fees f ON f.company_id = o.company_id AND f.wilaya_id = o.wilaya_id
      WHERE o.company_id = $1 AND o.follow_status IN ('shipped','out_for_delivery') AND NOT o.cashed AND o.delivery_cost > 0 AND o.livreur_id IS NULL AND o.tracking IS NOT NULL ORDER BY o.id LIMIT 1`,
    [yal],
  );
  await heavy(o.id);
  const tariff = Number(o.is_stopdesk ? o.desk : o.home);
  // Yalidine said it weighed it 7,4 kg (the products' weight never counts)
  await db.query(`UPDATE orders SET delivery_cost = $2, courier_fees = '{"kg":7.4,"src":"track","at":"2026-10-30T00:00:00Z"}' WHERE id = $1`, [o.id, tariff]);
  const saved: any = await call('delivery.saveWeightRule', admin, { companyId: yal, freeKg: 5, perKg: 50, onReturn: true });
  assert.deepEqual(saved.weight, { freeKg: 5, perKg: 50, onReturn: true, locked: false, set: true });
  assert.ok(saved.moved >= 1, 'the unpaid parcels follow');
  const cost = async (id: unknown) => Number((await one('SELECT delivery_cost FROM orders WHERE id = $1', [id])).delivery_cost);
  assert.equal(await cost(o.id), tariff + 100);
  // « Frais société » and the order card: price list + 100 DA of weight (7 kg declared)
  const fees: any = await call('orders.companyFees', suivi, { ids: [Number(o.id)] });
  assert.deepEqual({ fee: fees[o.id].fee, extra: fees[o.id].extra, fromApi: fees[o.id].fromApi }, { fee: tariff + 100, extra: 100, fromApi: false });
  const card: any = await call('orders.get', admin, { id: Number(o.id) });
  assert.deepEqual(card.courierFees, { delivery: tariff, ret: Number(o.return_fee), weight: 100, weightRet: 100, kg: 7, declaredKg: 7, exact: false, byRule: true });
  // not on the return any more: the delivery keeps it, the return does not
  const noRet: any = await call('delivery.saveWeightRule', admin, { companyId: yal, freeKg: 5, perKg: 50, onReturn: false });
  assert.equal(await cost(o.id), tariff + 100);
  assert.equal(noRet.moved, 0);
  assert.equal(((await call('orders.get', admin, { id: Number(o.id) })) as any).courierFees.weightRet, 0);
  // free up to 6 kg: 50 DA (one kilo above), the cost moves by −50
  await call('delivery.saveWeightRule', admin, { companyId: yal, freeKg: 6, perKg: 50, onReturn: true });
  assert.equal(await cost(o.id), tariff + 50);
  // the cost computed again (its place changed): price list + weight
  await db.query('UPDATE orders SET delivery_cost = 0 WHERE id = $1', [o.id]);
  await setCourierCost(db, [Number(o.id)]);
  assert.equal(await cost(o.id), tariff + 50);
  await call('delivery.saveWeightRule', admin, { companyId: yal, freeKg: 5, perKg: 50, onReturn: true });
  assert.equal(await cost(o.id), tariff + 100);

  // sending a heavy parcel to Yalidine
  const p = await one(`SELECT id, wilaya_id, is_stopdesk FROM orders WHERE conf_status = 'confirmed' AND follow_status = 'prepared' AND tracking IS NULL AND wilaya_id IN (SELECT wilaya_id FROM delivery_fees WHERE company_id = $1) ORDER BY id LIMIT 1`, [yal]);
  await heavy(p.id);
  await db.query('UPDATE orders SET company_id = $2, livreur_id = NULL WHERE id = $1', [p.id, yal]);
  const r: any = await call('delivery.send', admin, { ids: [Number(p.id)] });
  assert.equal(r.sent, 1, JSON.stringify(r));
  const pf = await one('SELECT home, desk FROM delivery_fees WHERE company_id = $1 AND wilaya_id = $2', [yal, p.wilaya_id]);
  // sent: its price list only — the weight fee comes once Yalidine says the weight it found
  assert.equal(await cost(p.id), Number(p.is_stopdesk ? pf.desk : pf.home));

  // a parcel that came back: the profit counts the return price + the weight fee on the return
  const b = await one(`SELECT o.id, o.created_at, f.return_fee FROM sales o JOIN delivery_fees f ON f.company_id = o.company_id AND f.wilaya_id = o.wilaya_id WHERE o.company_id = $1 AND o.follow_status = 'returned' AND o.livreur_id IS NULL ORDER BY o.id LIMIT 1`, [yal]);
  await heavy(b.id);
  await db.query(`UPDATE orders SET courier_fees = '{"kg":7.4,"src":"track","at":"2026-10-30T00:00:00Z"}' WHERE id = $1`, [b.id]);
  // its creation day, one day around (Algiers days)
  const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const at = new Date(b.created_at).getTime();
  const back = async () => (await ordersOf(db, [Number(prod.id)], dayOf(at - 86_400_000), dayOf(at + 86_400_000))).find((x: any) => Number(x.id) === Number(b.id));
  assert.equal(Number((await back()).return_fee), Number(b.return_fee) + 100);
  await call('delivery.saveWeightRule', admin, { companyId: yal, freeKg: 5, perKg: 50, onReturn: false });
  assert.equal(Number((await back()).return_fee), Number(b.return_fee));
  // the Bilan no longer asks for Yalidine (its « Surpoids » is set), nor for ZR
  const range = { from: '2020-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z' };
  const rep: any = await call('orders.deliveredReport', suivi, range);
  const yname = (await one('SELECT name FROM delivery_companies WHERE id = $1', [yal])).name;
  assert.ok(!rep.noOverweightRule.includes(yname));
  // « No » (it takes none): the weight leaves the unpaid parcels' cost
  await call('delivery.saveWeightRule', admin, { companyId: yal, freeKg: 5, perKg: 0, onReturn: true });
  assert.equal(await cost(o.id), tariff);
  info = await call('delivery.feesInfo', admin, { companyId: yal });
  assert.deepEqual(info.weight, { freeKg: 5, perKg: 0, onReturn: true, locked: false, set: true });
  assert.equal(((await call('orders.get', admin, { id: Number(o.id) })) as any).courierFees, null);
});

test('the weight a company found, in its tracking answer: its real / billed weight first, grams read as kilos', () => {
  assert.equal(weightIn({ weight: 6 }), 6);
  assert.equal(weightIn({ weight: '5,5' }), 5.5);
  assert.equal(weightIn({ weight: 3, real_weight: 8 }), 8);
  assert.equal(weightIn({ poids: '7 kg' }), 7);
  assert.equal(weightIn({ weight: 6500 }), 6.5);
  assert.equal(weightIn({ weight: 0 }, { poids: 4 }), 4);
  assert.equal(weightIn({ status: 'Livré' }), null);
  assert.equal(weightIn(null, undefined), null);
});

test('Yalidine says it weighed a parcel 9 kg (declared 6): its « Surpoids » counts 9 kg — cost, order card, Surpoids card, return', async () => {
  const yal = Number((await one(`SELECT id FROM delivery_companies WHERE kind = 'yalidine' LIMIT 1`)).id);
  await db.query(`UPDATE delivery_companies SET credentials = '{"api_id":"a","api_token":"t"}', active = true WHERE id = $1`, [yal]);
  const admin0 = await as(EMAILS.admin);
  await call('delivery.saveWeightRule', admin0, { companyId: yal, freeKg: 5, perKg: 50, onReturn: true });
  const prod = await one(`SELECT id FROM products ORDER BY id LIMIT 1`);
  await db.query(`UPDATE products SET weight_kg = 6 WHERE id = $1`, [prod.id]);
  const o = await one(
    `SELECT o.id, o.tracking, o.is_stopdesk, f.home, f.desk FROM orders o JOIN delivery_fees f ON f.company_id = o.company_id AND f.wilaya_id = o.wilaya_id
      WHERE o.company_id = $1 AND o.follow_status IN ('shipped','out_for_delivery') AND NOT o.cashed AND o.livreur_id IS NULL AND o.tracking IS NOT NULL ORDER BY o.id DESC LIMIT 1`,
    [yal],
  );
  await db.query(`DELETE FROM order_items WHERE order_id = $1 AND id <> (SELECT min(id) FROM order_items WHERE order_id = $1)`, [o.id]);
  await db.query(`UPDATE order_items SET product_id = $2, variant_id = NULL, qty = 1 WHERE order_id = $1`, [o.id, prod.id]);
  const tariff = Number(o.is_stopdesk ? o.desk : o.home);
  // declared 6 kg: 50 DA
  // not weighed yet: its price list only
  await db.query('UPDATE orders SET delivery_cost = $2, courier_fees = NULL WHERE id = $1', [o.id, tariff]);
  const server = {
    courier: async (action: string, args: any) => {
      if (action === 'track') return args.items.filter((it: any) => Number(it.id) === Number(o.id)).map((it: any) => ({ id: it.id, status: 'Livré', at: null, costs: { delivery: null, ret: null, kg: 9 } }));
      throw new Error('unexpected ' + action);
    },
  } as any;
  const admin = await as(EMAILS.admin, server);
  await call('delivery.sync', admin, { companyId: yal });
  const cost = Number((await one('SELECT delivery_cost FROM orders WHERE id = $1', [o.id])).delivery_cost);
  assert.equal(cost, tariff + 200, 'weighed 9 kg: 4 kilos above 5');
  const card: any = await call('orders.get', admin, { id: Number(o.id) });
  assert.deepEqual(
    { weight: card.courierFees.weight, kg: card.courierFees.kg, declaredKg: card.courierFees.declaredKg, byRule: card.courierFees.byRule },
    { weight: 200, kg: 9, declaredKg: 6, byRule: true },
  );
  const fees: any = await call('orders.companyFees', admin, { ids: [Number(o.id)] });
  assert.equal(fees[o.id].extra, 200);
  // the same weight again: nothing moves
  await call('delivery.sync', admin, { companyId: yal });
  assert.equal(Number((await one('SELECT delivery_cost FROM orders WHERE id = $1', [o.id])).delivery_cost), tariff + 200);
  // Dashboard › « Surpoids des colis »: the parcel is there (9 kg found, 6 declared, 200 DA)
  const d = await one('SELECT delivered_at FROM orders WHERE id = $1', [o.id]);
  if (d.delivered_at) {
    const at = new Date(d.delivered_at).getTime();
    const r: any = await call('delivery.overweight', admin, { from: new Date(at - 86_400_000).toISOString(), to: new Date(at + 86_400_000).toISOString() });
    const p = r.parcels.find((x: any) => x.id === Number(o.id));
    assert.ok(p, 'in the Surpoids card');
    assert.deepEqual({ zr: p.zr, declared: p.declared, fee: p.fee }, { zr: 9, declared: 6, fee: 200 });
  }
});

test('a company’s own prices for a parcel in its answer: delivery, return (0 = a free return), weight', async () => {
  assert.deepEqual(weighed({ delivery_fee: '450', taxe_retour: 0, weight: 7 }), { costs: { delivery: 450, ret: 0, kg: 7 } });
  assert.deepEqual(weighed({ status: 'Livré' }), {});
  // Yalidine answers with its prices: they count, a free return is 0, its « Surpoids » on its weight
  const yal = Number((await one(`SELECT id FROM delivery_companies WHERE kind = 'yalidine' LIMIT 1`)).id);
  const admin0 = await as(EMAILS.admin);
  await call('delivery.saveWeightRule', admin0, { companyId: yal, freeKg: 5, perKg: 50, onReturn: true });
  const o = await one(`SELECT o.id FROM orders o WHERE o.company_id = $1 AND o.follow_status IN ('shipped','out_for_delivery') AND NOT o.cashed AND o.livreur_id IS NULL AND o.tracking IS NOT NULL ORDER BY o.id LIMIT 1`, [yal]);
  await db.query('UPDATE orders SET courier_fees = NULL WHERE id = $1', [o.id]);
  const server = {
    courier: async (action: string, args: any) => {
      if (action === 'track') return args.items.filter((it: any) => Number(it.id) === Number(o.id)).map((it: any) => ({ id: it.id, status: 'En livraison', at: null, costs: { delivery: 480, ret: 0, kg: 7 } }));
      throw new Error('unexpected ' + action);
    },
  } as any;
  const admin = await as(EMAILS.admin, server);
  await call('delivery.sync', admin, { companyId: yal });
  assert.equal(Number((await one('SELECT delivery_cost FROM orders WHERE id = $1', [o.id])).delivery_cost), 480 + 100);
  const card: any = await call('orders.get', admin, { id: Number(o.id) });
  assert.deepEqual({ d: card.courierFees.delivery, r: card.courierFees.ret, w: card.courierFees.weight, wr: card.courierFees.weightRet }, { d: 480, r: 0, w: 100, wr: 100 });
  const fees: any = await call('orders.companyFees', admin, { ids: [Number(o.id)] });
  assert.deepEqual({ fee: fees[o.id].fee, fromApi: fees[o.id].fromApi }, { fee: 580, fromApi: true });
});
