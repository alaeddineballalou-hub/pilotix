// Dépôt picking (phones): products first, oldest orders first, whole lines only, a pool for the spare units,
// "À ramener au dépôt" for what is missing, and the orders that have all their products.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;

before(async () => {
  const s = await setup(200);
  db = s.db;
  as = s.as;
});

/** The waiting lines of a product, in the order the depot serves them. */
const linesOf = async (productId: number, variantId: number | null) =>
  db.query(
    `SELECT i.id, i.order_id, i.qty, i.picked_qty FROM order_items i JOIN orders o ON o.id = i.order_id
     WHERE o.conf_status = 'confirmed' AND o.follow_status = 'to_prepare' AND i.product_id = $1 AND i.variant_id IS NOT DISTINCT FROM $2 AND i.picked_qty < i.qty
     ORDER BY o.confirmed_at NULLS LAST, o.created_at, o.id, i.id`,
    [productId, variantId],
  );

test('the pick list shows only products and how many to take', async () => {
  const depot = await as(EMAILS.depot);
  const list = (await call('depot.pickList', depot, {})) as any[];
  assert.ok(list.length > 0, 'the demo has orders to prepare');
  for (const r of list) {
    assert.ok(r.need > 0 && r.orders > 0);
    assert.equal(typeof r.name, 'string');
    assert.equal('customerName' in r, false);
  }
});

test('taking fewer than needed serves whole lines, oldest first; rupture keeps the rest to bring', async () => {
  const depot = await as(EMAILS.depot);
  const list = (await call('depot.pickList', depot, {})) as any[];
  // a product with several waiting lines
  const p = list.filter((r) => r.orders >= 2).sort((a, b) => b.need - a.need)[0] ?? list[0];
  const lines = (await linesOf(p.productId, p.variantId)).map((l: any) => ({ id: Number(l.id), need: Number(l.qty) - Number(l.picked_qty) }));
  const take = Math.max(0, p.need - 1);
  // what the rule should give: in order, a line is served when it fits in what is left
  let left = take;
  const served = new Set<number>();
  for (const l of lines) if (l.need <= left) (served.add(l.id), (left -= l.need));
  const r: any = await call('depot.pick', depot, { productId: p.productId, variantId: p.variantId, qty: take, rupture: true });
  assert.equal(r.waiting, left, 'units no whole line could use wait in the pool');
  assert.equal(r.missing, p.need - take);
  for (const l of lines) {
    const row = (await db.query('SELECT qty, picked_qty FROM order_items WHERE id = $1', [l.id]))[0];
    assert.equal(Number(row.picked_qty) === Number(row.qty), served.has(l.id), `line ${l.id} served as the rule says`);
  }
  const rest = (await call('depot.restock', depot, {})) as any[];
  const mine = rest.find((x) => x.productId === p.productId && x.variantId === p.variantId);
  assert.equal(mine?.qty, p.need - take, 'on « À ramener au dépôt »');
  const after = (await call('depot.pickList', depot, {})) as any[];
  const now = after.find((x) => x.productId === p.productId && x.variantId === p.variantId);
  assert.equal(now?.pool ?? 0, left);
  assert.equal(now?.restock ?? 0, p.need - take);

  // the rest arrives and is taken: nothing waits, nothing to bring
  const r2: any = await call('depot.pick', depot, { productId: p.productId, variantId: p.variantId, qty: p.need - take, rupture: false });
  assert.equal(r2.missing, 0);
  assert.equal(r2.waiting, 0);
  const rest2 = (await call('depot.restock', depot, {})) as any[];
  assert.equal(rest2.some((x) => x.productId === p.productId && x.variantId === p.variantId), false);
  assert.equal((await linesOf(p.productId, p.variantId)).length, 0);
});

test('an order is ready only when all its products are taken; with a company it then goes to « En dispatch » by itself', async () => {
  const depot = await as(EMAILS.depot);
  const withCompany = (
    await db.query(`SELECT o.id FROM orders o JOIN delivery_companies c ON c.id = o.company_id AND c.active AND c.kind NOT IN ('own')
                     WHERE o.conf_status = 'confirmed' AND o.follow_status = 'to_prepare'`)
  ).map((r: any) => Number(r.id));
  assert.ok(withCompany.length > 0);
  // take everything that is in stock
  for (const r of (await call('depot.pickList', depot, {})) as any[]) await call('depot.pick', depot, { productId: r.productId, variantId: r.variantId, qty: r.need, rupture: false });
  // what waits now has every product taken, and no company (« À attribuer »)
  for (const o of (await call('depot.ready', depot, {})) as any[]) {
    assert.equal(o.followStatus, 'to_prepare');
    const open = await db.query(`SELECT 1 FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = $1 AND NOT p.is_service AND i.picked_qty < i.qty`, [o.id]);
    assert.equal(open.length, 0);
    assert.ok(!withCompany.includes(o.id), `${o.ref} has a company: it went to « En dispatch »`);
  }
  const moved = (await db.query(`SELECT count(*)::int AS n FROM orders WHERE id = ANY($1) AND follow_status = 'prepared'`, [withCompany]))[0].n;
  assert.ok(moved > 0, 'picked whole with a company: in « En dispatch »');
  const list = (await call('depot.pickList', depot, {})) as any[];
  assert.equal(list.length, 0, 'nothing left to take');
});
