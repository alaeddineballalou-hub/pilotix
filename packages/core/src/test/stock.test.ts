// Products & stock: prices table, inventories, alerts, transfers, suppliers and purchases.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;
before(async () => {
  ({ db, as } = await setup(200));
});

const qty = async (vid: number, wid: number) => Number((await db.query('SELECT qty FROM stock WHERE variant_id = $1 AND warehouse_id = $2', [vid, wid]))[0]?.qty ?? 0);
const mainDepot = async () => Number((await db.query('SELECT id FROM warehouses WHERE active ORDER BY is_default DESC, id LIMIT 1'))[0].id);
const someVariants = async (n: number) =>
  (await db.query('SELECT v.id, p.id AS pid FROM product_variants v JOIN products p ON p.id = v.product_id WHERE NOT p.is_service AND p.active AND v.active ORDER BY v.id LIMIT $1', [n])).map((r: any) => ({ vid: Number(r.id), pid: Number(r.pid) }));

test('roles: depot and admin, not confirmation', async () => {
  const conf = await as(EMAILS.conf);
  await assert.rejects(call('suppliers.list', conf, {}), /Accès refusé/);
  await assert.rejects(call('purchases.list', conf, {}), /Accès refusé/);
  await assert.rejects(call('catalog.inventory', conf, { warehouseId: 1, lines: [{ variantId: 1, counted: 1 }] }), /Accès refusé/);
  await assert.rejects(call('catalog.setPrices', conf, { items: [{ id: 1, price: 1, cost: 1 }] }), /Accès refusé/);
  const depot = await as(EMAILS.depot);
  assert.ok(((await call('suppliers.list', depot, {})) as any[]).length >= 3, 'demo suppliers');
  const list: any = await call('purchases.list', depot, {});
  assert.ok(list.rows.length >= 4 && list.summary.due > 0, 'demo purchases, some not paid');
  assert.ok(((await call('catalog.inventories', depot, {})) as any[]).length >= 1, 'demo inventory');
});

test('prices: sale and purchase price for the depot, maximum discount for the administrator only', async () => {
  const depot = await as(EMAILS.depot);
  const admin = await as(EMAILS.admin);
  const p: any = ((await call('catalog.products', depot, {})) as any[]).find((x: any) => !x.isService && x.variants.length >= 2) ?? ((await call('catalog.products', depot, {})) as any[])[0];
  const r: any = await call('catalog.setPrices', depot, { items: [{ id: p.id, price: p.price + 500, cost: p.cost + 100, variants: [{ id: p.variants[0].id, price: p.price + 900 }] }] });
  assert.equal(r.changed, 2);
  const after: any = await call('catalog.product', depot, { id: p.id });
  assert.equal(after.price, p.price + 500);
  assert.equal(after.cost, p.cost + 100);
  assert.equal(after.variants[0].price, p.price + 900);
  assert.equal(after.maxDiscount, p.maxDiscount, 'unchanged when not sent');
  await assert.rejects(call('catalog.setPrices', depot, { items: [{ id: p.id, price: after.price, cost: after.cost, maxDiscount: 777 }] }), /administrateur/);
  await call('catalog.setPrices', admin, { items: [{ id: p.id, price: after.price, cost: after.cost, maxDiscount: 777, variants: [{ id: p.variants[0].id, price: null }] }] });
  const again: any = await call('catalog.product', depot, { id: p.id });
  assert.equal(again.maxDiscount, 777);
  assert.equal(again.variants[0].price, null);
  // nothing changed: nothing written
  assert.equal(((await call('catalog.setPrices', depot, { items: [{ id: p.id, price: again.price, cost: again.cost }] })) as any).changed, 0);
  // a variant of another product is refused
  const other = Number((await db.query('SELECT id FROM product_variants WHERE product_id <> $1 LIMIT 1', [p.id]))[0].id);
  await assert.rejects(call('catalog.setPrices', depot, { items: [{ id: p.id, price: again.price, cost: again.cost, variants: [{ id: other, price: 1 }] }] }), /autre produit/);
});

test('inventory: counted quantities become the stock in one go, untouched products stay, the record says what changed', async () => {
  const depot = await as(EMAILS.depot);
  const wid = await mainDepot();
  const [a, b, c] = await someVariants(3);
  const qa = await qty(a.vid, wid);
  const qb = await qty(b.vid, wid);
  const qc = await qty(c.vid, wid);
  const r: any = await call('catalog.inventory', depot, { warehouseId: wid, lines: [{ variantId: a.vid, counted: qa + 2 }, { variantId: b.vid, counted: qb }], note: 'Test' });
  assert.match(r.ref, /^INV-\d{4}$/);
  assert.equal(r.counted, 2);
  assert.equal(r.changed, 1);
  assert.equal(r.found, 2);
  assert.equal(r.missing, 0);
  assert.equal(await qty(a.vid, wid), qa + 2);
  assert.equal(await qty(b.vid, wid), qb);
  assert.equal(await qty(c.vid, wid), qc, 'not counted: unchanged');
  const mv: any = await call('catalog.movements', depot, { variantId: a.vid, pageSize: 1 });
  assert.equal(mv.rows[0].reason, 'count');
  assert.equal(mv.rows[0].inventoryRef, r.ref);
  assert.equal(mv.rows[0].delta, 2);
  const list: any[] = (await call('catalog.inventories', depot, {})) as any;
  assert.equal(list[0].ref, r.ref);
  assert.equal(list[0].note, 'Test');
  // the same product twice, or a negative count, is refused and nothing is written
  await assert.rejects(call('catalog.inventory', depot, { warehouseId: wid, lines: [{ variantId: a.vid, counted: 1 }, { variantId: a.vid, counted: 2 }] }), /double/);
  assert.equal(await qty(a.vid, wid), qa + 2);
  // missing pieces
  const r2: any = await call('catalog.inventory', depot, { warehouseId: wid, lines: [{ variantId: a.vid, counted: qa }] });
  assert.equal(r2.missing, 2);
  assert.ok(r2.value <= 0);
});

test('transfer of many products: all or nothing, and the list pairs both sides', async () => {
  const depot = await as(EMAILS.depot);
  const whs: any[] = (await call('catalog.warehouses', depot, {})) as any;
  const [a, b] = whs;
  const rows = await db.query('SELECT variant_id, qty FROM stock WHERE warehouse_id = $1 AND qty >= 3 ORDER BY variant_id LIMIT 2', [a.id]);
  const [v1, v2] = rows.map((r: any) => ({ vid: Number(r.variant_id), q: Number(r.qty) }));
  const b1 = await qty(v1.vid, b.id);
  await assert.rejects(call('catalog.transferMany', depot, { from: a.id, to: b.id, lines: [{ variantId: v1.vid, qty: 1 }, { variantId: v2.vid, qty: v2.q + 1 }] }), /insuffisant/);
  assert.equal(await qty(v1.vid, a.id), v1.q, 'nothing moved');
  await assert.rejects(call('catalog.transferMany', depot, { from: a.id, to: a.id, lines: [{ variantId: v1.vid, qty: 1 }] }), /autre dépôt/);
  const r: any = await call('catalog.transferMany', depot, { from: a.id, to: b.id, lines: [{ variantId: v1.vid, qty: 2 }, { variantId: v2.vid, qty: 1 }], note: 'Réassort Oran' });
  assert.equal(r.pieces, 3);
  assert.equal(await qty(v1.vid, a.id), v1.q - 2);
  assert.equal(await qty(v1.vid, b.id), b1 + 2);
  const list: any = await call('catalog.transfers', depot, { pageSize: 5 });
  const mine = list.rows.filter((x: any) => x.note === 'Réassort Oran');
  assert.equal(mine.length, 2);
  assert.ok(mine.every((x: any) => x.fromName === a.name && x.toName === b.name));
  const depots: any[] = (await call('catalog.depots', depot, {})) as any;
  assert.ok(depots.length >= 2 && depots[0].pieces > 0 && depots[0].value > 0);
});

test('suppliers: create, no two with the same name, archive', async () => {
  const depot = await as(EMAILS.depot);
  const s: any = await call('suppliers.save', depot, { name: 'Fournisseur Test', phone: '0555 00 11 22' });
  assert.equal(s.purchases, 0);
  await assert.rejects(call('suppliers.save', depot, { name: 'fournisseur test' }), /existe déjà/);
  await call('suppliers.save', depot, { id: s.id, name: 'Fournisseur Test', active: false });
  assert.ok(!((await call('suppliers.list', depot, {})) as any[]).some((x) => x.id === s.id), 'archived: hidden');
  assert.ok(((await call('suppliers.list', depot, { all: true })) as any[]).some((x) => x.id === s.id));
  const v = (await someVariants(1))[0];
  await assert.rejects(call('purchases.create', depot, { supplierId: s.id, warehouseId: await mainDepot(), lines: [{ variantId: v.vid, qty: 1, unitCost: 100 }] }), /archivé/);
});

test('purchase: stock comes in, the purchase price follows, payments up to the total', async () => {
  const depot = await as(EMAILS.depot);
  const wid = await mainDepot();
  const sup: any = await call('suppliers.save', depot, { name: 'Grossiste Blida' });
  const p: any = ((await call('catalog.products', depot, {})) as any[]).find((x: any) => !x.isService && x.variants.filter((v: any) => v.active).length >= 2);
  const [va, vb] = p.variants.filter((v: any) => v.active);
  const qa = await qty(va.id, wid);
  const r: any = await call('purchases.create', depot, {
    supplierId: sup.id,
    warehouseId: wid,
    lines: [{ variantId: va.id, qty: 10, unitCost: 1000 }, { variantId: vb.id, qty: 30, unitCost: 2000 }],
    paid: 20_000,
    note: 'Livraison du matin',
  });
  assert.match(r.ref, /^ACH-\d{4}$/);
  assert.equal(r.total, 70_000);
  assert.equal(r.due, 50_000);
  assert.equal(r.lineItems.length, 2);
  assert.equal(await qty(va.id, wid), qa + 10);
  // two variants of one product: the purchase price is their weighted average
  assert.equal(((await call('catalog.product', depot, { id: p.id })) as any).cost, 1750);
  const mv: any = await call('catalog.movements', depot, { variantId: va.id, pageSize: 1 });
  assert.equal(mv.rows[0].reason, 'purchase');
  assert.equal(mv.rows[0].purchaseRef, r.ref);
  await assert.rejects(call('purchases.pay', depot, { id: r.id, paid: 70_001 }), /dépasse/);
  const paid: any = await call('purchases.pay', depot, { id: r.id, paid: 70_000 });
  assert.equal(paid.due, 0);
  const s: any = ((await call('suppliers.list', depot, {})) as any[]).find((x) => x.id === sup.id);
  assert.equal(s.purchases, 1);
  assert.equal(s.total, 70_000);
  assert.equal(s.due, 0);
  // search by reference or product, and without changing the purchase price
  const found: any = await call('purchases.list', depot, { q: r.ref });
  assert.equal(found.rows[0].id, r.id);
  // « À payer »: only the purchases not fully paid, and their number in the summary
  const unpaid: any = await call('purchases.list', depot, { unpaid: true, pageSize: 200 });
  assert.ok(unpaid.rows.every((x: any) => x.due > 0));
  assert.equal(unpaid.total, unpaid.summary.unpaid);
  assert.ok(!unpaid.rows.some((x: any) => x.id === r.id), 'paid in full');
  await call('purchases.create', depot, { supplierId: null, warehouseId: wid, lines: [{ variantId: va.id, qty: 1, unitCost: 1 }], updateCost: false });
  assert.equal(((await call('catalog.product', depot, { id: p.id })) as any).cost, 1750);
  await assert.rejects(call('purchases.create', depot, { supplierId: null, warehouseId: wid, lines: [{ variantId: va.id, qty: 1, unitCost: 100 }], paid: 200 }), /dépasse/);
  const service = (await db.query('SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.is_service LIMIT 1'))[0];
  if (service) await assert.rejects(call('purchases.create', depot, { supplierId: null, warehouseId: wid, lines: [{ variantId: Number(service.id), qty: 1, unitCost: 100 }] }), /service/);
});

test('alerts: out of stock first, under the alert level next, with the last purchase', async () => {
  const depot = await as(EMAILS.depot);
  const wid = await mainDepot();
  const [x, y] = await someVariants(2);
  await call('catalog.inventory', depot, { warehouseId: wid, lines: [{ variantId: x.vid, counted: 0 }, { variantId: y.vid, counted: 50 }] });
  const yRow: any = ((await call('catalog.stock', depot, { variantIds: [y.vid], warehouseId: wid })) as any[])[0];
  await call('catalog.setAlert', depot, { variantId: y.vid, warehouseId: wid, alertQty: yRow.available + 5 });
  const alerts: any[] = (await call('catalog.alerts', depot, { warehouseId: wid })) as any;
  const ax = alerts.find((a) => a.variantId === x.vid);
  const ay = alerts.find((a) => a.variantId === y.vid);
  assert.equal(ax?.level, 'out');
  assert.equal(ay?.level, 'low');
  const lastOut = alerts.map((a) => a.level).lastIndexOf('out');
  assert.ok(alerts.findIndex((a) => a.level === 'low') > lastOut, 'out of stock first');
  const withPurchase = alerts.find((a) => a.lastPurchase);
  if (withPurchase) assert.match(withPurchase.lastPurchase.ref, /^ACH-/);
  // how many to buy: 30 days of sales plus the alert level, less what is left
  assert.equal(ay.suggest, Math.max(1, Math.max(ay.alertQty + 1, ay.sold30 + ay.alertQty) - ay.available));
  assert.ok(alerts.every((a) => a.suggest >= 1));
  // the menu's count is the length of the list, whatever the depot
  const all: any[] = (await call('catalog.alerts', depot, {})) as any;
  assert.equal(((await call('orders.counts', depot, {})) as any).lowStock, all.length);
  await call('catalog.setAlert', depot, { variantId: y.vid, warehouseId: wid, alertQty: 0 });
});
