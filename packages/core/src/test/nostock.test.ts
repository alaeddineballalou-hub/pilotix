// « Confirmée sans stock »: when stock comes back the oldest waiting orders that can be served whole go to « À préparer »
// by themselves; the « Sans stock » list shows how long each waits (late after the shop's number of days); the pick
// cards say each variant's colour.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let admin: Ctx;
let karim: Ctx;
let wh: number;
let X: { productId: number; variantId: number };

before(async () => {
  let as: (email: string) => Promise<Ctx>;
  ({ db, as } = await setup(40));
  admin = await as(EMAILS.admin);
  karim = await as(EMAILS.depot);
  wh = Number((await db.query('SELECT id FROM warehouses WHERE active ORDER BY is_default DESC, id LIMIT 1'))[0].id);
  const r = (await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id AND v.active WHERE p.active AND NOT p.is_service ORDER BY p.id, v.id LIMIT 1`))[0];
  X = { productId: Number(r.id), variantId: Number(r.vid) };
  await db.query(`UPDATE settings SET value = jsonb_set(value, '{defaultCompanyId}', 'null') WHERE key = 'shop'`);
  // nothing in stock, nothing promised: a clean start for this variant
  await db.query('DELETE FROM stock WHERE variant_id = $1', [X.variantId]);
  await db.query(`UPDATE orders SET conf_status = 'cancelled', follow_status = CASE WHEN follow_status IN ('to_prepare','prepared') THEN 'cancelled' ELSE follow_status END
                   WHERE id IN (SELECT order_id FROM order_items WHERE variant_id = $1) AND conf_status IN ('confirmed','no_stock')`, [X.variantId]);
});

let n = 0;
const phone = () => `0696${String(500000 + ++n).slice(-6)}`;
const waitingOrder = async (qty: number) => {
  const o = (await call('orders.create', admin, { customerName: `Attente${n} Test`, phone: phone(), wilayaId: 16, commune: 'Kouba', items: [{ ...X, qty }] })) as any;
  await call('orders.setConf', admin, { ids: [o.id], status: 'confirmed' });
  return Number(o.id);
};
const state = async (id: number) => (await db.query('SELECT conf_status, follow_status FROM orders WHERE id = $1', [id]))[0];
const entry = (qty: number) => call('catalog.move', karim, { variantId: X.variantId, warehouseId: wh, kind: 'entry', qty, unitCost: 1000 });

test('stock comes back: the oldest that can be served whole goes to « À préparer » by itself', async () => {
  const a = await waitingOrder(1);
  const b = await waitingOrder(1);
  assert.equal((await state(a)).conf_status, 'no_stock');
  assert.equal((await state(b)).conf_status, 'no_stock');
  await entry(1);
  assert.deepEqual(await state(a), { conf_status: 'confirmed', follow_status: 'to_prepare' }, 'the oldest first');
  assert.equal((await state(b)).conf_status, 'no_stock');
  // a confirmed order cancelled gives its piece back: the next waiting one gets it
  await call('orders.setConf', admin, { ids: [a], status: 'cancelled', reason: 'test' });
  assert.deepEqual(await state(b), { conf_status: 'confirmed', follow_status: 'to_prepare' });
  await call('orders.setConf', admin, { ids: [b], status: 'cancelled', reason: 'test' });
});

test('an older order the stock cannot serve whole does not hold the newer ones back', async () => {
  await db.query('DELETE FROM stock WHERE variant_id = $1', [X.variantId]);
  const big = await waitingOrder(3);
  const small = await waitingOrder(1);
  await entry(2);
  assert.equal((await state(big)).conf_status, 'no_stock', 'needs 3, only 2 there');
  assert.equal((await state(small)).conf_status, 'confirmed');
  await entry(2);
  assert.equal((await state(big)).conf_status, 'confirmed', '1 + 2 more: served whole');
  for (const id of [big, small]) await call('orders.setConf', admin, { ids: [id], status: 'cancelled', reason: 'test' });
});

test('the « Sans stock » list: oldest first, days waited, late after the shop’s number of days', async () => {
  await db.query('DELETE FROM stock WHERE variant_id = $1', [X.variantId]);
  const old = await waitingOrder(1);
  const recent = await waitingOrder(1);
  await db.query(`UPDATE orders SET confirmed_at = now() - interval '5 days' WHERE id = $1`, [old]);
  const r = (await call('depot.noStock', karim, {})) as any;
  assert.equal(r.days, 3);
  const mine = r.list.filter((x: any) => x.id === old || x.id === recent);
  assert.deepEqual(mine.map((x: any) => x.id), [old, recent]);
  assert.equal(mine[0].late, true);
  assert.ok(mine[0].days >= 5);
  assert.equal(mine[1].late, false);
  assert.equal(mine[0].items[0].missing, true);
  const c = (await call('depot.counts', karim, {})) as any;
  assert.ok(c.noStock >= 2 && c.noStockLate >= 1);
});

test('the pick cards say the variant’s colour (from the product’s options, or a known colour name)', async () => {
  const p = (await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id AND v.active WHERE p.active AND NOT p.is_service AND p.id <> $1 ORDER BY p.id, v.id LIMIT 1`, [X.productId]))[0];
  await db.query(`UPDATE products SET options = '[{"name":"Couleur","values":["Vert"]},{"name":"Taille","values":["12 pouces"]}]' WHERE id = $1`, [p.id]);
  await db.query(`UPDATE product_variants SET title = 'Vert / 12 pouces' WHERE id = $1`, [p.vid]);
  await db.query('INSERT INTO stock (variant_id, warehouse_id, qty) VALUES ($1, $2, 50) ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET qty = 50', [p.vid, wh]);
  const o = (await call('orders.create', admin, { customerName: 'Vélo Test', phone: phone(), wilayaId: 16, commune: 'Kouba', items: [{ productId: Number(p.id), variantId: Number(p.vid), qty: 2 }] })) as any;
  await call('orders.setConf', admin, { ids: [o.id], status: 'confirmed' });
  const row = ((await call('depot.pickList', karim, {})) as any[]).find((r) => r.variantId === Number(p.vid));
  assert.ok(row);
  assert.deepEqual(row.look.color, { name: 'Vert', hex: '#2E9D4F' });
  assert.equal(row.look.size, '12 pouces');
});
