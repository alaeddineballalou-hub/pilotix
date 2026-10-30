// Catalog, stock and depot rules.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;
before(async () => {
  ({ db, as } = await setup(250));
});

const qty = async (vid: number, wid: number) => Number((await db.query('SELECT qty FROM stock WHERE variant_id = $1 AND warehouse_id = $2', [vid, wid]))[0]?.qty ?? 0);

test('roles: depot and admin manage stock, confirmation cannot', async () => {
  const conf = await as(EMAILS.conf);
  await assert.rejects(call('catalog.stock', conf, {}), /Accès refusé/);
  await assert.rejects(call('catalog.move', conf, { variantId: 1, warehouseId: 1, kind: 'entry', qty: 1 }), /Accès refusé/);
  const rows: any = await call('catalog.stock', await as(EMAILS.depot), {});
  assert.ok(rows.length > 5);
  assert.ok((await call('catalog.stock', await as(EMAILS.admin), {}) as any).length === rows.length);
  // the product picker is for everybody
  const found: any = await call('catalog.search', conf, { q: 'pous' });
  assert.ok(found.length >= 1 && found[0].variants.length >= 1 && 'available' in found[0].variants[0]);
});

test('stock: entry, count, loss write stock and movements; reserved = confirmed not shipped', async () => {
  const depot = await as(EMAILS.depot);
  const rows: any[] = (await call('catalog.stock', depot, {})) as any;
  const r = rows.find((x) => x.reserved > 0) ?? rows[0];
  const wid = r.warehouseId;
  const before = await qty(r.variantId, wid);
  const reserved = Number(
    (await db.query(
      `SELECT COALESCE(sum(i.qty),0)::int AS n FROM order_items i JOIN orders o ON o.id = i.order_id WHERE i.variant_id = $1 AND o.conf_status IN ('confirmed','no_stock') AND (o.follow_status IS NULL OR o.follow_status IN ('to_prepare','prepared'))`,
      [r.variantId],
    ))[0].n,
  );
  assert.equal(r.reserved, reserved);
  assert.equal(r.available, r.qty - r.reserved);

  await call('catalog.move', depot, { variantId: r.variantId, warehouseId: wid, kind: 'entry', qty: 7, unitCost: 1200, note: 'Arrivage' });
  assert.equal(await qty(r.variantId, wid), before + 7);
  await call('catalog.move', depot, { variantId: r.variantId, warehouseId: wid, kind: 'loss', qty: 2 });
  assert.equal(await qty(r.variantId, wid), before + 5);
  const c: any = await call('catalog.move', depot, { variantId: r.variantId, warehouseId: wid, kind: 'count', qty: 3 });
  assert.equal(c.qty, 3);
  assert.equal(await qty(r.variantId, wid), 3);
  const mv: any = await call('catalog.movements', depot, { variantId: r.variantId, pageSize: 3 });
  assert.deepEqual(mv.rows.map((m: any) => m.reason), ['count', 'loss', 'entry']);
  assert.equal(mv.rows[0].delta, 3 - (before + 5));
  // sum of movements of a fresh variant equals its stock
  await assert.rejects(call('catalog.move', depot, { variantId: r.variantId, warehouseId: wid, kind: 'entry', qty: 0, unitCost: 1200 }), /Quantité/);
});

test('transfer keeps the total and refuses more than available', async () => {
  const depot = await as(EMAILS.depot);
  const whs: any[] = (await call('catalog.warehouses', depot, {})) as any;
  assert.ok(whs.length >= 2);
  const [a, b] = whs;
  const v = Number((await db.query('SELECT variant_id FROM stock WHERE warehouse_id = $1 AND qty >= 4 ORDER BY variant_id LIMIT 1', [a.id]))[0].variant_id);
  const total = async () => Number((await db.query('SELECT COALESCE(sum(qty),0)::int AS n FROM stock WHERE variant_id = $1', [v]))[0].n);
  const t0 = await total();
  const a0 = await qty(v, a.id);
  await call('catalog.transfer', depot, { variantId: v, from: a.id, to: b.id, qty: 3 });
  assert.equal(await total(), t0);
  assert.equal(await qty(v, a.id), a0 - 3);
  await assert.rejects(call('catalog.transfer', depot, { variantId: v, from: a.id, to: b.id, qty: 100000 }), /insuffisant/);
  await assert.rejects(call('catalog.transfer', depot, { variantId: v, from: a.id, to: a.id, qty: 1 }), /autre dépôt/);
  const mv: any = await call('catalog.movements', depot, { variantId: v, pageSize: 2 });
  assert.equal(mv.rows.reduce((s: number, m: any) => s + m.delta, 0), 0);
});

test('alert threshold and "only missing" filter', async () => {
  const depot = await as(EMAILS.depot);
  const r: any = ((await call('catalog.stock', depot, {})) as any[]).find((x: any) => x.available > 0);
  await call('catalog.setAlert', depot, { variantId: r.variantId, warehouseId: r.warehouseId, alertQty: r.available + 1 });
  const missing: any[] = (await call('catalog.stock', depot, { missingOnly: true })) as any;
  assert.ok(missing.some((x) => x.variantId === r.variantId && x.warehouseId === r.warehouseId));
  await call('catalog.setAlert', depot, { variantId: r.variantId, warehouseId: r.warehouseId, alertQty: 0 });
  const missing2: any[] = (await call('catalog.stock', depot, { missingOnly: true })) as any;
  assert.ok(!missing2.some((x) => x.variantId === r.variantId && x.warehouseId === r.warehouseId));
});

test('products: create with variants, packs, linked; rename and disable a variant; max discount is admin only', async () => {
  const depot = await as(EMAILS.depot);
  const admin = await as(EMAILS.admin);
  const other: any = (await call('catalog.products', depot, {}) as any[])[0];
  const p: any = await call('catalog.saveProduct', depot, {
    name: 'Trottinette 3 roues', price: 6500, cost: 3000, weightKg: 2, packs: [{ qty: 2, price: 12000 }], linked: [other.id],
    variants: [{ title: 'Rose' }, { title: 'Bleu' }], parts: [{ name: 'Roue avant', max: 1 }], maxDiscount: 0,
  });
  assert.equal(p.variants.filter((v: any) => v.active).length, 2);
  assert.ok(p.sku.length > 0);
  assert.deepEqual(p.packs, [{ qty: 2, price: 12000 }]);
  assert.deepEqual(p.linked, [other.id]);
  const rose = p.variants.find((v: any) => v.title === 'Rose');
  const p2: any = await call('catalog.saveProduct', depot, {
    id: p.id, name: p.name, price: 6900, cost: 3000, maxDiscount: 0,
    variants: [{ id: rose.id, title: 'Rose pâle', active: true }, { id: p.variants[1].id, title: 'Bleu', active: false }],
  });
  assert.equal(p2.price, 6900);
  assert.equal(p2.variants.find((v: any) => v.id === rose.id).title, 'Rose pâle');
  assert.equal(p2.variants.find((v: any) => v.title === 'Bleu').active, false);
  await assert.rejects(call('catalog.saveProduct', depot, { id: p.id, name: p.name, price: 6900, maxDiscount: 500 }), /administrateur/);
  const p3: any = await call('catalog.saveProduct', admin, { id: p.id, name: p.name, price: 6900, maxDiscount: 500 });
  assert.equal(p3.maxDiscount, 500);
  await assert.rejects(call('catalog.saveProduct', depot, { name: 'Doublon', sku: other.sku, price: 1 }), /SKU/);
  // a product without named variant gets the hidden "no variant" one
  const plain: any = await call('catalog.saveProduct', depot, { name: 'Gigoteuse', price: 2500 });
  assert.equal(plain.variants.length, 1);
  assert.equal(plain.variants[0].title, '');
});

test('products: the form\'s details and alert level; a stock entry with a new purchase price', async () => {
  const depot = await as(EMAILS.depot);
  const p: any = await call('catalog.saveProduct', depot, {
    name: 'Lampe de chevet', price: 3200, cost: 1500, barcode: '6130000000017', brand: 'Lumo', externalId: 'SH-77', pageUrl: 'https://shop.example/lampe',
    description: 'Lampe LED', alertQty: 4, maxDiscount: 0,
  });
  assert.equal(p.barcode, '6130000000017');
  assert.equal(p.brand, 'Lumo');
  assert.equal(p.alertQty, 4);
  const wid = Number((await db.query('SELECT id FROM warehouses WHERE active ORDER BY is_default DESC, id LIMIT 1'))[0].id);
  const vid = p.variants[0].id;
  assert.equal(Number((await db.query('SELECT alert_qty FROM stock WHERE variant_id = $1 AND warehouse_id = $2', [vid, wid]))[0].alert_qty), 4);
  // an older caller that sends only the first fields keeps the details
  const p2: any = await call('catalog.saveProduct', depot, { id: p.id, name: p.name, price: 3300, cost: 1500, maxDiscount: 0 });
  assert.equal(p2.brand, 'Lumo');
  assert.equal(p2.alertQty, 4);
  // the supplier raised its price: the entry's price becomes the product's purchase price
  await call('catalog.move', depot, { variantId: vid, warehouseId: wid, kind: 'entry', qty: 5, unitCost: 1700 });
  assert.equal(((await call('catalog.product', depot, { id: p.id })) as any).cost, 1700);
  assert.equal(await qty(vid, wid), 5);
  const mv: any = await call('catalog.movements', depot, { q: p.sku });
  assert.match(mv.rows[0].note, /Prix d’achat du lot 1700 DA\/unité/);
});

test('picking: quantities to prepare and stock', async () => {
  const depot = await as(EMAILS.depot);
  const rows: any[] = (await call('catalog.picking', depot, {})) as any;
  const sum = rows.reduce((s, r) => s + r.toPrepare, 0);
  const expected = Number(
    (await db.query(`SELECT COALESCE(sum(i.qty),0)::int AS n FROM order_items i JOIN orders o ON o.id = i.order_id JOIN products p ON p.id = i.product_id WHERE o.conf_status='confirmed' AND o.follow_status='to_prepare' AND NOT p.is_service`))[0].n,
  );
  assert.equal(sum, expected);
  const counts: any = await call('depot.counts', depot, {});
  assert.equal(typeof counts.preparer, 'number');
});

test('scanner: dispatch, double scan, return (stock back), refusals', async () => {
  const depot = await as(EMAILS.depot);
  await call('depot.resetTestParcels', depot, {});
  const ok: any = await call('depot.scan', depot, { code: 'px90001', mode: 'dispatch' });
  assert.equal(ok.kind, 'ok', ok.why);
  assert.equal(ok.order.followStatus, 'shipped');
  const again: any = await call('depot.scan', depot, { code: 'PX90001', mode: 'dispatch' });
  assert.equal(again.kind, 'bad');
  assert.match(again.why, /Déjà dispatchée/);
  assert.match(((await call('depot.scan', depot, { code: 'PX90004', mode: 'dispatch' })) as any).why, /À rappeler/);
  assert.match(((await call('depot.scan', depot, { code: 'PX90005', mode: 'dispatch' })) as any).why, /Aucune société/);
  assert.match(((await call('depot.scan', depot, { code: 'PX90006', mode: 'dispatch' })) as any).why, /étiquette Pilotix ne suffit pas/);
  assert.match(((await call('depot.scan', depot, { code: 'PX90007', mode: 'dispatch' })) as any).why, /Pas encore préparée/);
  assert.match(((await call('depot.scan', depot, { code: 'INCONNU-1', mode: 'dispatch' })) as any).why, /n’existe pas/);
  // « Expédier » only on the parcel's own label: a phone number finds orders but never sends one
  const byPhone: any = await call('depot.scan', depot, { code: '0555990014', mode: 'dispatch' });
  assert.equal(byPhone.kind, 'bad');
  assert.match(byPhone.why, /pas l’étiquette/);
  const two = await db.query(`SELECT id FROM orders WHERE phone = '0555990014' ORDER BY id`);
  assert.equal(two.length, 2);
  const chosen: any = await call('depot.scan', depot, { orderId: Number(two[0].id), code: '', mode: 'dispatch' });
  assert.equal(chosen.kind, 'ok', chosen.why);

  const o20 = (await db.query(`SELECT o.id, i.variant_id, o.warehouse_id FROM orders o JOIN order_items i ON i.order_id = o.id WHERE o.ref = 'PX90020'`))[0];
  const s0 = await qty(Number(o20.variant_id), Number(o20.warehouse_id));
  const back: any = await call('depot.scan', depot, { code: 'ZR-TEST-0020', mode: 'back' });
  assert.equal(back.kind, 'ok', back.why);
  assert.equal(back.order.followStatus, 'returned');
  assert.equal(await qty(Number(o20.variant_id), Number(o20.warehouse_id)), s0 + 1);
  assert.match(((await call('depot.scan', depot, { code: 'ZR-TEST-0020', mode: 'back' })) as any).why, /déjà reçu/);
  assert.match(((await call('depot.scan', depot, { code: 'ZR-TEST-0022', mode: 'back' })) as any).why, /Livrée selon Pilotix/);

  const ex: any = await call('depot.scan', depot, { code: 'ZR-TEST-0030', mode: 'back' });
  assert.equal(ex.kind, 'ok', ex.why);
  assert.match(((await call('depot.scan', depot, { code: 'ZR-TEST-0031', mode: 'back' })) as any).why, /déjà reçu/);
  assert.match(((await call('depot.scan', depot, { code: 'ZR-TEST-0034', mode: 'back' })) as any).why, /sans commande d’origine/);

  const conf = await as(EMAILS.conf);
  await assert.rejects(call('depot.scan', conf, { code: 'PX90002', mode: 'dispatch' }), /Accès refusé/);
});

test('receive a return from the Retours page, and "Retirer" from dispatch', async () => {
  const depot = await as(EMAILS.depot);
  await call('depot.resetTestParcels', depot, {});
  const found: any[] = (await call('depot.find', depot, { code: 'zr-test-0020' })) as any;
  assert.equal(found.length, 1);
  const r: any = await call('depot.receiveReturn', depot, { id: found[0].id });
  assert.equal(r.followStatus, 'returned');
  await assert.rejects(call('depot.receiveReturn', depot, { id: found[0].id }), /déjà reçu/);
  const prepared: any = (await call('depot.find', depot, { code: 'PX90001' }) as any[])[0];
  const un: any = await call('depot.unassign', depot, { id: prepared.id });
  assert.equal(un.followStatus, 'to_prepare');
  assert.equal(un.companyId, null);
  // a parcel already at the company is cancelled there (its number goes), then back to « À préparer »
  const sent: any = (await call('depot.find', depot, { code: 'ZR-TEST-0002' }) as any[])[0];
  const back: any = await call('depot.unassign', depot, { id: sent.id });
  assert.equal(back.followStatus, 'to_prepare');
  assert.equal(back.tracking, null);
});


test('paid montage, per-variant availability and zero-stock confirmation rules', async () => {
  const admin = await as(EMAILS.admin);
  const p: any = await call('catalog.saveProduct', admin, {
    name: 'Montage option test product', price: 10000, cost: 6000, weightKg: 5,
    variants: [{ title: 'Gris', price: 10000, cost: 6000 }],
    services: [{ name: 'Montage', price: 1500, cost: 500 }],
  });
  assert.equal(p.services.length, 1);
  const svc: any = (await call('catalog.product', admin, { id: p.services[0].id }));
  assert.equal(svc.isService, true);
  assert.equal(svc.price, 1500);
  assert.equal(svc.cost, 500);
  assert.equal(svc.weightKg, 0);
  assert.ok(p.linked.includes(svc.id));
  const variant = p.variants.find((v: any) => v.title === 'Gris');
  const { checkLines } = await import('../modules/confirmcheck');
  const line = [{ productId: p.id, variantId: variant.id, qty: 1 }];
  assert.equal((await checkLines(db, line, null))[0].state, 'empty');
  await call('catalog.setAvailability', admin, { variantId: variant.id, active: false });
  assert.equal((await checkLines(db, line, null))[0].state, 'off');
  await call('catalog.setAvailability', admin, { variantId: variant.id, active: true });
  assert.equal((await checkLines(db, line, null))[0].state, 'empty');
  await call('catalog.setAvailability', admin, { productId: p.id, active: false });
  assert.equal((await checkLines(db, line, null))[0].state, 'off');
  const updated: any = await call('catalog.product', admin, { id: svc.id });
  assert.equal(updated.active, false);
});
