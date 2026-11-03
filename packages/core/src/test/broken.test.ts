// « Stock cassé »: a product that came back broken waits apart in its depot and is never sold — the old product of an
// SAV exchange for « Produit défectueux », or a return the depot finds broken (« Cassé » after the scan). Repaired: back
// on sale; thrown away: gone. Undoing the return puts both stocks back as they were.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { setFollow } from '../modules/orders';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (e: string) => Promise<Ctx>;
let depot: Ctx;
let suivi: Ctx;

before(async () => {
  ({ db, as } = await setup(200));
  [depot, suivi] = await Promise.all([as(EMAILS.depot), as(EMAILS.suivi)]);
});

const stockOf = async (v: number, w: number) => {
  const r = (await db.query('SELECT qty, broken FROM stock WHERE variant_id = $1 AND warehouse_id = $2', [v, w]))[0];
  return { qty: Number(r?.qty ?? 0), broken: Number(r?.broken ?? 0) };
};
const used = new Set<number>();
/** a parcel on its way back to the depot (the company said « retour »): its first product and how many came */
const comingBack = async () => {
  const p = (
    await db.query(
      `SELECT o.id, o.warehouse_id FROM orders o WHERE o.follow_status IN ('shipped', 'out_for_delivery') AND o.shipped_at IS NOT NULL AND o.warehouse_id IS NOT NULL
          AND NOT o.is_exchange AND NOT o.cashed AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.variant_id IS NOT NULL)
          AND NOT (o.id = ANY($1)) ORDER BY o.id LIMIT 1`,
      [[...used]],
    )
  )[0];
  assert.ok(p, 'a parcel on the road in the demo');
  const id = Number(p.id);
  used.add(id);
  await setFollow(suivi, { ids: [id], status: 'returning', note: 'Statut Retour' }, { system: true, courier: true });
  const lines = await db.query('SELECT variant_id, sum(qty)::int AS q FROM order_items WHERE order_id = $1 AND variant_id IS NOT NULL GROUP BY 1 ORDER BY 1', [id]);
  return { id, v: Number(lines[0].variant_id), w: Number(p.warehouse_id), q: Number(lines[0].q), all: lines.reduce((n: number, l: any) => n + Number(l.q), 0) };
};

test('a return found broken: out of the stock that is sold, into the broken stock — once; repaired: back on sale', async () => {
  const { id, v, w, q, all } = await comingBack();
  const s0 = await stockOf(v, w);
  const r: any = await call('depot.scan', depot, { orderId: id, code: '', mode: 'return' });
  assert.equal(r.kind, 'ok', r.why);
  assert.deepEqual(await stockOf(v, w), { qty: s0.qty + q, broken: s0.broken });
  // « Cassé »: every product of the parcel
  assert.deepEqual(await call('stock.markBroken', depot, { orderId: id }), { moved: all });
  assert.deepEqual(await stockOf(v, w), { qty: s0.qty, broken: s0.broken + q }, 'apart: never sold');
  await assert.rejects(call('stock.markBroken', depot, { orderId: id }), /Rien à mettre en stock cassé/);
  // the stock list shows it; the movements say it
  const line = ((await call('catalog.stock', depot, { variantIds: [v], warehouseId: w })) as any[])[0];
  assert.equal(line.broken, s0.broken + q);
  assert.equal(line.qty, s0.qty);
  const mv: any = await call('catalog.movements', depot, { variantId: v, reason: 'broken_return' });
  assert.equal(mv.rows[0].brokenDelta, q);
  assert.equal(mv.rows[0].delta, -q);
  // repaired: back on sale (never more than is there)
  await assert.rejects(call('stock.fixBroken', depot, { variantId: v, warehouseId: w, qty: s0.broken + q + 1, to: 'sell' }), /Seulement/);
  await call('stock.fixBroken', depot, { variantId: v, warehouseId: w, qty: 1, to: 'sell', note: 'réparé' });
  assert.deepEqual(await stockOf(v, w), { qty: s0.qty + 1, broken: s0.broken + q - 1 });
  // and it is not taken for broken a second time
  await assert.rejects(call('stock.markBroken', depot, { orderId: id }), /Rien à mettre en stock cassé/);
});

test('the return undone after « Cassé »: both stocks as before the return', async () => {
  const { id, v, w } = await comingBack();
  const s0 = await stockOf(v, w);
  await call('depot.scan', depot, { orderId: id, code: '', mode: 'return' });
  await call('stock.markBroken', depot, { orderId: id });
  const lc: any = await call('orders.lastChange', depot, { id });
  assert.equal(lc.to, 'returned');
  await call('orders.undo', depot, { id, eventId: lc.eventId });
  assert.deepEqual(await stockOf(v, w), s0);
  assert.equal(Number((await db.query(`SELECT count(*)::int AS n FROM stock_movements WHERE order_id = $1 AND reason IN ('returned', 'broken_return')`, [id]))[0].n), 0);
});

test('an SAV exchange for a defect: the old product comes back to the broken stock; for a wrong product, back on sale', async () => {
  const exchanged = async (type: 'defect' | 'wrong') => {
    const o = (
      await db.query(`SELECT o.id, o.warehouse_id FROM orders o WHERE o.follow_status = 'delivered' AND NOT o.is_exchange AND o.warehouse_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.variant_id IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM complaints c WHERE c.order_id = o.id) ORDER BY o.id LIMIT 1`)
    )[0];
    assert.ok(o, 'a delivered order in the demo');
    const t: any = await call('sav.create', suivi, { orderId: Number(o.id), type, details: 'test' });
    const g: any = await call('sav.get', suivi, { id: t.id });
    const line = g.order.items.find((i: any) => i.variantId);
    await call('sav.exchange', suivi, { id: t.id, kind: 'same', lines: [{ itemId: line.id, qty: 1 }] });
    const ex = Number((await db.query('SELECT exchange_order_id FROM complaints WHERE id = $1', [t.id]))[0].exchange_order_id);
    await db.query(`UPDATE orders SET follow_status = 'delivered', shipped_at = now(), delivered_at = now() WHERE id = $1`, [ex]);
    const v = Number(line.variantId);
    const w = Number(o.warehouse_id);
    const s0 = await stockOf(v, w);
    const r: any = await call('depot.scan', depot, { orderId: ex, code: '', mode: 'exchange' });
    assert.equal(r.kind, 'ok', r.why);
    return { r, v, w, s0, ex };
  };
  const a = await exchanged('defect');
  assert.match(a.r.why, /stock cassé/);
  assert.deepEqual(await stockOf(a.v, a.w), { qty: a.s0.qty, broken: a.s0.broken + 1 }, 'faulty: apart, never sold');
  // already in the broken stock: « Cassé » has nothing more to move
  await assert.rejects(call('stock.markBroken', depot, { orderId: a.ex }), /Rien à mettre en stock cassé/);
  // thrown away: gone from the broken stock, the stock that is sold does not move
  await call('stock.fixBroken', depot, { variantId: a.v, warehouseId: a.w, qty: 1, to: 'scrap' });
  assert.deepEqual(await stockOf(a.v, a.w), a.s0);
  const b = await exchanged('wrong');
  assert.doesNotMatch(b.r.why, /stock cassé/);
  assert.deepEqual(await stockOf(b.v, b.w), { qty: b.s0.qty + 1, broken: b.s0.broken }, 'a wrong product sent: back on sale');
  // the depot finds it broken after all: « Cassé » on the exchange parcel
  assert.deepEqual(await call('stock.markBroken', depot, { orderId: b.ex }), { moved: 1 });
  assert.deepEqual(await stockOf(b.v, b.w), { qty: b.s0.qty, broken: b.s0.broken + 1 });
});
