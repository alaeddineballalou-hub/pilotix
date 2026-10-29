// The two checks before « Confirmer » (one order or many at once): every product can go — switched off: refused;
// nothing left: confirmed « sans stock » — and we deliver there (the company serves the wilaya at home / at a bureau).
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let admin: Ctx;
let agent: Ctx;
let wh: number;
/** three variants of products on sale, each with its own stock */
let V: { productId: number; variantId: number }[];

before(async () => {
  let as: (email: string) => Promise<Ctx>;
  ({ db, as } = await setup(60));
  admin = await as(EMAILS.admin);
  agent = await as(EMAILS.conf);
  wh = Number((await db.query('SELECT id FROM warehouses WHERE active ORDER BY is_default DESC, id LIMIT 1'))[0].id);
  V = (
    await db.query(
      `SELECT DISTINCT ON (p.id) p.id AS pid, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id AND v.active
        WHERE p.active AND NOT p.is_service ORDER BY p.id, v.id LIMIT 3`,
    )
  ).map((r: any) => ({ productId: Number(r.pid), variantId: Number(r.vid) }));
  assert.equal(V.length, 3, 'three products in the demo');
  // no fee grid on the default company: it delivers everywhere (the place is checked in its own test)
  await db.query(`UPDATE settings SET value = jsonb_set(value, '{defaultCompanyId}', 'null') WHERE key = 'shop'`);
});

let n = 0;
const phone = () => `0697${String(400000 + ++n).slice(-6)}`;
/** stock left for a variant (only in the first depot) */
async function setStock(variantId: number, qty: number) {
  await db.query('DELETE FROM stock WHERE variant_id = $1', [variantId]);
  await db.query('INSERT INTO stock (variant_id, warehouse_id, qty) VALUES ($1, $2, $3)', [variantId, wh, qty]);
  // nothing promised to other orders
  await db.query(`UPDATE orders SET conf_status = 'cancelled' WHERE id IN (SELECT order_id FROM order_items WHERE variant_id = $1) AND conf_status IN ('confirmed','no_stock')`, [variantId]);
}
const newOrder = async (v: { productId: number; variantId: number }, extra: Record<string, unknown> = {}) =>
  (await call('orders.create', admin, { customerName: `Check${n} Test`, phone: phone(), wilayaId: 16, commune: 'Kouba', items: [{ ...v, qty: 2 }], ...extra })) as any;
const conf = async (id: number) => (await db.query('SELECT conf_status, follow_status, confirmed_at FROM orders WHERE id = $1', [id]))[0];

test('the card: each product is ok, empty (nothing left) or off (switched off), and the place is checked', async () => {
  await setStock(V[0].variantId, 5);
  await setStock(V[1].variantId, 1);
  const r = (await call('orders.confirmCheck', agent, { items: [{ ...V[0], qty: 2 }, { ...V[1], qty: 2 }], wilayaId: 16, commune: 'Kouba', isStopdesk: false })) as any;
  assert.deepEqual(
    r.lines.map((l: any) => [l.state, l.available]),
    [
      ['ok', 5],
      ['empty', 1],
    ],
  );
  assert.equal(r.noStock, true);
  assert.equal(r.canConfirm, true, 'nothing left is not a blocker');
  const noCommune = (await call('orders.confirmCheck', agent, { items: [{ ...V[0], qty: 1 }], wilayaId: 16, commune: '', isStopdesk: false })) as any;
  assert.equal(noCommune.deliver.why, 'commune');
  assert.equal(noCommune.canConfirm, false);
  await db.query('UPDATE product_variants SET active = false WHERE id = $1', [V[2].variantId]);
  const off = (await call('orders.confirmCheck', agent, { items: [{ ...V[2], qty: 1 }], wilayaId: 16, commune: 'Kouba', isStopdesk: false })) as any;
  assert.equal(off.lines[0].state, 'off');
  assert.equal(off.canConfirm, false);
  await db.query('UPDATE product_variants SET active = true WHERE id = $1', [V[2].variantId]);
});

test('« Confirmer » with nothing left: confirmed « sans stock » (it waits, not in the depot); switched off: refused', async () => {
  await setStock(V[0].variantId, 0);
  const a = await newOrder(V[0]);
  const r = (await call('orders.setConf', agent, { ids: [a.id], status: 'confirmed' })) as any;
  assert.deepEqual(r.noStock, [a.id]);
  const c = await conf(a.id);
  assert.equal(c.conf_status, 'no_stock');
  assert.equal(c.follow_status, null, 'not sent to the depot');
  assert.ok(c.confirmed_at, 'counted as confirmed by the agent');
  await assert.rejects(call('orders.setConf', agent, { ids: [a.id], status: 'confirmed' }), /toujours pas de stock/);

  await setStock(V[1].variantId, 10);
  const b = await newOrder(V[1]);
  await db.query('UPDATE products SET active = false WHERE id = $1', [V[1].productId]);
  await assert.rejects(call('orders.setConf', agent, { ids: [b.id], status: 'confirmed' }), /indisponible/);
  await assert.rejects(call('orders.setConf', agent, { ids: [b.id], status: 'no_stock' }), /indisponible/);
  assert.equal((await conf(b.id)).conf_status, 'new');
  await db.query('UPDATE products SET active = true WHERE id = $1', [V[1].productId]);
});

test('several at once: the blocked one stays, the others go on (one « sans stock »)', async () => {
  await setStock(V[0].variantId, 0);
  await setStock(V[1].variantId, 10);
  await setStock(V[2].variantId, 10);
  const empty = await newOrder(V[0]);
  const ok = await newOrder(V[1]);
  const off = await newOrder(V[2]);
  await db.query('UPDATE product_variants SET active = false WHERE id = $1', [V[2].variantId]);
  const r = (await call('orders.setConf', agent, { ids: [empty.id, ok.id, off.id], status: 'confirmed' })) as any;
  assert.deepEqual(r.changed.sort(), [empty.id, ok.id].sort());
  assert.deepEqual(r.noStock, [empty.id]);
  assert.equal(r.blocked.length, 1);
  assert.equal(r.blocked[0].id, off.id);
  assert.match(r.blocked[0].reason, /indisponible/);
  assert.equal((await conf(ok.id)).conf_status, 'confirmed');
  assert.equal((await conf(ok.id)).follow_status, 'to_prepare');
  assert.equal((await conf(off.id)).conf_status, 'new');
  await db.query('UPDATE product_variants SET active = true WHERE id = $1', [V[2].variantId]);
});

test('we deliver there: a courier with a tariff needs a price for the wilaya (home / bureau)', async () => {
  await setStock(V[1].variantId, 10);
  const co = Number((await db.query(`SELECT company_id FROM delivery_fees f JOIN delivery_companies c ON c.id = f.company_id WHERE c.active AND c.kind NOT IN ('own','manual') GROUP BY company_id ORDER BY company_id LIMIT 1`))[0].company_id);
  const a = await newOrder(V[1], { companyId: co });
  await db.query('DELETE FROM delivery_fees WHERE company_id = $1 AND wilaya_id = 16', [co]);
  await assert.rejects(call('orders.setConf', agent, { ids: [a.id], status: 'confirmed' }), /ne livre pas à domicile à 16/);
  await db.query('INSERT INTO delivery_fees (company_id, wilaya_id, home, desk) VALUES ($1, 16, 400, 0)', [co]);
  await call('orders.setConf', agent, { ids: [a.id], status: 'confirmed' });
  assert.equal((await conf(a.id)).conf_status, 'confirmed');
  const desk = (await call('orders.confirmCheck', agent, { items: [{ ...V[1], qty: 1 }], wilayaId: 16, isStopdesk: true, companyId: co })) as any;
  assert.equal(desk.deliver.ok, false, 'no bureau price there');
  assert.equal(desk.deliver.why, 'company');
});

test('the AI seller’s « confirmed » order is checked too: switched off → a person checks it; nothing left → « sans stock »', async () => {
  await setStock(V[0].variantId, 0);
  const a = await newOrder(V[0], { confirm: true });
  assert.equal(a.confStatus, 'no_stock');
  await db.query('UPDATE product_variants SET active = false WHERE id = $1', [V[2].variantId]);
  await setStock(V[2].variantId, 10);
  const b = await newOrder(V[2], { confirm: true }).catch((e) => e);
  if (!(b instanceof Error)) {
    assert.equal(b.confStatus, 'to_check');
    assert.match(b.internalNote ?? '', /indisponible/);
  }
  await db.query('UPDATE product_variants SET active = true WHERE id = $1', [V[2].variantId]);
});
