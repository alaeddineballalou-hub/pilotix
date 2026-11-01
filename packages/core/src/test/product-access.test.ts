import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, makeSession } from '../index';
import { getSetting, setSetting } from '../settings';
import { EMAILS, setup } from './harness';

let db: Db, as: (email: string) => Promise<Ctx>, admin: Ctx, conf: Ctx, suivi: Ctx;
let a: number, b: number, c: number, va: number;
const rpc = (ctx: Ctx, name: string, input: any = {}): Promise<any> => call(name, ctx, input);
const forbidden = (e: any) => e.code === 'forbidden';
function noCosts(value: any) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!['cost', 'purchasePrice', 'purchase_price', 'unitCost', 'unit_cost'].includes(key), `private field ${key}`);
    noCosts(child);
  }
}

before(async () => {
  ({ db, as } = await setup(30));
  admin = await as(EMAILS.admin); conf = await as(EMAILS.conf); suivi = await as(EMAILS.suivi);
  [a, b, c] = (await db.query('SELECT id FROM products WHERE active AND NOT is_service AND archived_at IS NULL ORDER BY id LIMIT 3')).map((r) => Number(r.id));
  va = Number((await db.query('SELECT id FROM product_variants WHERE product_id=$1 AND active ORDER BY id LIMIT 1', [a]))[0].id);
  await db.query('UPDATE products SET cost=8123456, linked=$2 WHERE id=$1', [a, [b]]);
  await db.query('UPDATE product_variants SET cost=7123456 WHERE product_id=$1', [a]);
  const config = await getSetting(db, 'autoAssign');
  config.agents[String(conf.session.profile.id)] = { ...config.agents[String(conf.session.profile.id)], products: [a] } as any;
  config.agents[String(suivi.session.profile.id)] = { ...config.agents[String(suivi.session.profile.id)], products: [b] } as any;
  await setSetting(db, 'autoAssign', config);
});

test('assigned catalog and every product picker enforce person scope and omit purchase costs', async () => {
  for (const [ctx, product] of [[conf, a], [suivi, b]] as const) {
    const catalog = await rpc(ctx, 'catalog.assigned');
    assert.equal(catalog.total, 1);
    assert.deepEqual(catalog.rows.map((p: any) => p.id), [product]);
    noCosts(catalog);
    const row = catalog.rows[0];
    assert.ok(row.variants.length);
    for (const v of row.variants) {
      assert.ok('available' in v && 'price' in v);
      for (const key of ['stock', 'qty', 'reserved', 'warehouseId', 'warehouseName', 'alertQty']) assert.ok(!(key in v));
    }
    const found = await rpc(ctx, 'catalog.search', { ids: [a, b, c] });
    assert.deepEqual(found.map((p: any) => p.id), [product]);
    assert.deepEqual(found[0].linked, []);
    noCosts(found);
    const form = await rpc(ctx, 'orders.formData');
    assert.deepEqual(form.products.map((p: any) => p.id), [product]);
    noCosts(form);
  }
  assert.deepEqual((await rpc(conf, 'confirmation.catalog')).map((p: any) => p.id), [a]);
  assert.deepEqual(await rpc(conf, 'catalog.search', { ids: [b] }), []);
  assert.equal((await rpc(conf, 'catalog.assigned', { q: 'impossible-product-name' })).total, 0);
});

test('agents cannot bypass the read-only catalog with IDs, order quotes, purchases or stock mutations', async () => {
  const warehouse = Number((await db.query('SELECT id FROM warehouses WHERE active LIMIT 1'))[0].id);
  for (const ctx of [conf, suivi]) {
    for (const [name, input] of [
      ['catalog.products', {}], ['catalog.product', { id: a }], ['catalog.stock', {}], ['catalog.warehouses', {}],
      ['catalog.movements', {}], ['catalog.move', { variantId: va, warehouseId: warehouse, kind: 'entry', qty: 1, unitCost: 1 }],
      ['catalog.transfer', {}], ['catalog.setAvailability', { productId: a, active: false }], ['purchases.list', {}], ['purchases.get', { id: 1 }], ['catalog.inventories', {}], ['catalog.depots', {}],
    ] as const) await assert.rejects(rpc(ctx, name, input), (e: any) => ['forbidden', 'not_found'].includes(e.code), name);
    const other = ctx === conf ? b : a;
    await assert.rejects(rpc(ctx, 'orders.quote', { wilayaId: 16, items: [{ productId: other, qty: 1 }] }), forbidden);
    await assert.rejects(rpc(ctx, 'orders.create', { customerName: 'Scope', phone: '0690909090', wilayaId: 16, commune: 'Kouba', address: 'x', items: [{ productId: other, qty: 1 }] }), forbidden);
  }
  assert.equal((await rpc(conf, 'orders.counts')).lowStock, 0);
  for (const ctx of [admin, await as(EMAILS.depot)]) {
    assert.equal((await rpc(ctx, 'catalog.product', { id: a })).cost, 8123456);
    assert.ok((await rpc(ctx, 'catalog.stock')).some((v: any) => v.productId === a && v.cost === 7123456));
  }
});

test('nested order responses never disclose line purchase prices to agents', async () => {
  const order = await rpc(admin, 'orders.create', { customerName: 'Cost privacy', phone: '0690909091', wilayaId: 16, commune: 'Kouba', address: 'x', items: [{ productId: a, variantId: va, qty: 1 }] });
  await db.query('UPDATE orders SET agent_id=$2 WHERE id=$1', [order.id, conf.session.profile.id]);
  assert.ok(order.items[0].purchasePrice > 0);
  noCosts(await rpc(conf, 'orders.get', { id: order.id }));
  noCosts(await rpc(conf, 'orders.list'));
  noCosts(await rpc(conf, 'confirmation.list', { sub: 'nouvelles' }));
  await assert.rejects(rpc(conf, 'orders.update', { id: order.id, items: [{ productId: b, qty: 1 }] }), forbidden);
});

test('agency contract and person product scopes intersect, including stale or revoked assignments', async () => {
  await db.query("INSERT INTO agency_routes (agency_id,task,product_id) VALUES (900,'confirmation',$1),(900,'confirmation',$2)", [a, b]);
  const agent: Ctx = { ...conf, session: makeSession({ ...conf.session.profile, agencyId: 900, agencyProducts: [b, c] }) };
  assert.deepEqual((await rpc(agent, 'catalog.assigned')).rows.map((p: any) => p.id), [b]);
  assert.deepEqual((await rpc(agent, 'confirmation.catalog')).map((p: any) => p.id), [b]);
  assert.deepEqual((await rpc(agent, 'orders.formData')).products.map((p: any) => p.id), [b]);
  await assert.rejects(rpc(agent, 'orders.quote', { wilayaId: 16, items: [{ productId: c, qty: 1 }] }), forbidden);
  await assert.rejects(rpc(agent, 'catalog.movements', {}), forbidden);
  const lead = { ...agent, session: makeSession({ ...agent.session.profile, agencyProducts: null }) };
  assert.deepEqual((await rpc(lead, 'catalog.assigned')).rows.map((p: any) => p.id).sort((x: number, y: number) => x-y), [a, b]);
  await db.query('DELETE FROM agency_routes WHERE agency_id=900 AND product_id=$1', [b]);
  assert.equal((await rpc(agent, 'catalog.assigned')).total, 0);
  const none = { ...agent, session: makeSession({ ...agent.session.profile, agencyProducts: [] }) };
  assert.equal((await rpc(none, 'catalog.assigned')).total, 0);
});

test('confirmation agents can read delivery progress without gaining follow-up mutation permissions', async () => {
  const active = ['shipped', 'out_for_delivery', 'failed', 'alert', 'in_exchange'];
  const ids: number[] = [];
  for (const [n, status] of [...active, 'delivered', 'returning', 'returned', 'cancelled'].entries()) {
    const order = await rpc(admin, 'orders.create', { customerName: 'Delivery scope', wilayaId: 16, commune: 'Kouba', address: 'x', phone: `06909091${String(n).padStart(2,'0')}`, items: [{ productId: a, variantId: va, qty: 1 }] });
    await db.query("UPDATE orders SET conf_status='confirmed', follow_status=$2, shipped_at=now(), agent_id=$3, conf_agency_id=NULL, follow_agency_id=NULL, sub_status=CASE WHEN $2='out_for_delivery' THEN 'alert_traitee' ELSE NULL END WHERE id=$1", [order.id, status, conf.session.profile.id]);
    if (active.includes(status)) ids.push(order.id);
  }
  const delivery = await rpc(conf, 'suivi.list', { tab: 'enlivraison', pageSize: 500 });
  for (const id of ids) assert.ok(delivery.rows.some((o: any) => o.id === id));
  assert.ok(delivery.rows.every((o: any) => active.includes(o.followStatus) && o.agentId === conf.session.profile.id));
  const alerts = await rpc(conf, 'suivi.list', { tab: 'alertes' });
  assert.ok(alerts.rows.every((o: any) => o.followStatus === 'alert'));
  const counts = await rpc(conf, 'suivi.counts');
  assert.equal(counts.enlivraison, delivery.total); assert.equal(counts.alertes, alerts.total);
  noCosts(delivery);
  await assert.rejects(rpc(conf, 'suivi.act', { id: ids[0], action: 'realert' }), forbidden);
});

test('an agent with no product assignment or assigned orders sees an empty catalog', async () => {
  const config = await getSetting(db, 'autoAssign');
  delete config.agents[String(conf.session.profile.id)]; await setSetting(db, 'autoAssign', config);
  await db.query('UPDATE orders SET agent_id=NULL, follow_agent_id=NULL WHERE agent_id=$1 OR follow_agent_id=$1', [conf.session.profile.id]);
  assert.equal((await rpc(conf, 'catalog.assigned')).total, 0);
  assert.deepEqual(await rpc(conf, 'catalog.search', { ids: [a, b, c] }), []);
  assert.deepEqual((await rpc(conf, 'orders.formData')).products, []);
});
