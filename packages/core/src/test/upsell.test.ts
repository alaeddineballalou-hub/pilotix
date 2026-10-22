// Upsell counted by Pilotix itself: against what the customer first ordered, kept on each order.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { upsellOf } from '@pilotix/shared';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;

before(async () => {
  const s = await setup(120);
  db = s.db;
  as = s.as;
});

const L = (productId: number, variantId: number, qty: number, unitPrice: number) => ({ productId, variantId, qty, unitPrice });

test('the rule: more pieces, a pack, an added or dearer product count; same price, cheaper or the customer’s own pack do not', () => {
  const orig = [L(1, 10, 1, 3000)];
  // one more piece
  assert.deepEqual(upsellOf(orig, 0, [L(1, 10, 2, 3000)], 0), { value: 3000, flags: [true] });
  // a pack of 2 at its own price
  assert.deepEqual(upsellOf(orig, 0, [L(1, 10, 2, 2750)], 0), { value: 2500, flags: [true] });
  // another product added: only that line carries it
  assert.deepEqual(upsellOf(orig, 0, [L(1, 10, 1, 3000), L(2, 20, 1, 1800)], 0), { value: 1800, flags: [false, true] });
  // a dearer variant of the same product
  assert.deepEqual(upsellOf(orig, 0, [L(1, 11, 1, 3600)], 0), { value: 600, flags: [true] });
  // another colour at the same price, a cheaper product: no upsell
  assert.deepEqual(upsellOf(orig, 0, [L(1, 11, 1, 3000)], 0), { value: 0, flags: [false] });
  assert.deepEqual(upsellOf(orig, 0, [L(3, 30, 1, 2500)], 0), { value: 0, flags: [false] });
  // a colour swap plus an added product: only the added product
  assert.deepEqual(upsellOf(orig, 0, [L(1, 11, 1, 3000), L(2, 20, 1, 1800)], 0), { value: 1800, flags: [false, true] });
  // the customer chose the pack of 2 themselves: nothing changed, no upsell
  assert.equal(upsellOf([L(1, 10, 2, 2750)], 0, [L(1, 10, 2, 2750)], 0).value, 0);
  // a remise given since comes off; taking back a remise the customer had is not an upsell
  assert.equal(upsellOf(orig, 0, [L(1, 10, 2, 3000)], 500).value, 2500);
  assert.equal(upsellOf(orig, 500, [L(1, 10, 1, 3000)], 0).value, 0);
  assert.equal(upsellOf(orig, 0, [L(1, 10, 2, 3000)], 3500).value, 0);
});

test('orders count their upsell by themselves when products change, and only then', async () => {
  const conf = await as(EMAILS.conf);
  const d: any = await call('orders.formData', conf, {});
  const ps = d.products.filter((p: any) => p.active && !p.isService && p.variants.length);
  const p = ps.find((x: any) => x.variants.length >= 2) ?? ps[0];
  const q = ps.find((x: any) => x.id !== p.id);
  const pv = p.variants[0];
  const price = (pr: any, v: any) => v.price ?? pr.price;
  const o: any = await call('orders.create', conf, { customerName: 'Upsell Test', phone: '0555000444', wilayaId: 16, commune: 'Kouba', items: [{ productId: p.id, variantId: pv.id, qty: 1 }] });
  assert.equal(o.hasUpsell, false);
  assert.equal(o.upsellValue, 0);
  assert.deepEqual(o.origItems, [{ productId: p.id, variantId: pv.id, qty: 1, unitPrice: price(p, pv) }]);

  // the agent sells a second piece
  const two: any = await call('orders.update', conf, { id: o.id, items: [{ productId: p.id, variantId: pv.id, qty: 2 }] });
  assert.equal(two.hasUpsell, true);
  assert.equal(two.upsellValue, price(p, pv));
  assert.equal(two.items[0].isUpsell, true);
  // a remise given on top comes off the upsell
  const disc: any = await call('orders.update', conf, { id: o.id, discount: 200 });
  assert.equal(disc.upsellValue, price(p, pv) - 200);
  // back to what was ordered: no upsell any more
  const one: any = await call('orders.update', conf, { id: o.id, discount: 0, items: [{ productId: p.id, variantId: pv.id, qty: 1 }] });
  assert.equal(one.hasUpsell, false);
  assert.equal(one.upsellValue, 0);
  // another product added: only its line carries the upsell (a box ticked by the screen is not trusted)
  const add: any = await call('orders.update', conf, {
    id: o.id,
    items: [{ productId: p.id, variantId: pv.id, qty: 1, isUpsell: true }, { productId: q.id, variantId: q.variants[0].id, qty: 1, isUpsell: false }],
  });
  assert.equal(add.upsellValue, price(q, q.variants[0]));
  assert.deepEqual(add.items.map((i: any) => i.isUpsell), [false, true]);
  // what the customer first ordered never moves
  assert.deepEqual(add.origItems, o.origItems);

  // confirmed: the Confirmées figures count it, for its agent
  await call('orders.setConf', conf, { ids: [o.id], status: 'confirmed' });
  const mgr = await as(EMAILS.manager);
  const cf: any = await call('confirmation.confirmed', mgr, { per: 'today' });
  assert.ok(cf.upsellOrders >= 1 && cf.upsellValue >= price(q, q.variants[0]));
  assert.equal(cf.byAgent.reduce((s: number, a: any) => s + a.up, 0), cf.upsellOrders);
  assert.equal(cf.byAgent.reduce((s: number, a: any) => s + a.upValue, 0), cf.upsellValue);
});

test('always counted by Pilotix: a mark sent by a screen is not taken, a copy starts afresh, an exchange parcel never has one', async () => {
  const conf = await as(EMAILS.conf);
  const d: any = await call('orders.formData', conf, {});
  const ps = d.products.filter((p: any) => p.active && !p.isService && p.variants.length);
  const [p, q] = ps;
  // an order typed during a call: what is typed is what the customer ordered, even with a line marked upsell
  const o: any = await call('orders.create', conf, {
    customerName: 'Appel Test', phone: '0555000555', wilayaId: 16, commune: 'Kouba', channel: 'appel',
    items: [{ productId: p.id, variantId: p.variants[0].id, qty: 1 }, { productId: q.id, variantId: q.variants[0].id, qty: 1, isUpsell: true }],
  });
  assert.equal(o.hasUpsell, false);
  assert.equal(o.upsellValue, 0);
  assert.deepEqual(o.items.map((i: any) => i.isUpsell), [false, false]);
  assert.equal(o.origItems.length, 2);
  // a copy of an order with an upsell starts afresh
  const sold: any = await call('orders.update', conf, { id: o.id, items: [{ productId: p.id, variantId: p.variants[0].id, qty: 2 }, { productId: q.id, variantId: q.variants[0].id, qty: 1 }] });
  assert.equal(sold.hasUpsell, true);
  const dup: any = await call('orders.duplicate', conf, { ids: [o.id] });
  const copy: any = await call('orders.get', conf, { id: dup.ids[0] });
  assert.equal(copy.hasUpsell, false);
  assert.equal(copy.origItems.length, 2);

  const ex: any = await call('orders.create', conf, {
    customerName: 'Appel Test', phone: '0555000555', wilayaId: 16, isExchange: true, originalOrderId: o.id,
    items: [{ productId: p.id, variantId: p.variants[0].id, qty: 2, unitPrice: 0 }, { productId: q.id, variantId: q.variants[0].id, qty: 1, unitPrice: 0, isUpsell: true }],
  });
  assert.equal(ex.hasUpsell, false);
  assert.equal(ex.upsellValue, 0);

  // the demo orders (written straight into the database) got their copy, and the flag agrees with the value
  const bad = await db.query(`SELECT count(*)::int AS n FROM orders WHERE orig_items IS NULL OR has_upsell <> (upsell_value > 0)`);
  assert.equal(bad[0].n, 0);
});
