// Montage: one shared « Montage » service, switched on per product (price, cost, wilayas), instead of one hidden
// service product per product. Old « Montage — X » services are merged into the switch.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import m105 from '../migrations/105_montage';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;
before(async () => {
  ({ db, as } = await setup(60));
});

const base = { customerName: 'Client Montage', phone: '0555123987', commune: 'Kouba' };

test('montage: old per-product services merge into the switch', async () => {
  const depot = await as(EMAILS.depot);
  const p: any = await call('catalog.saveProduct', depot, { name: 'Lit bébé ancien', price: 30000, services: [{ name: 'Old', price: 1500, cost: 500 }, { name: 'Emballage cadeau', price: 300, cost: 100 }] });
  const oldId = p.services.find((s: any) => s.name === 'Old').id;
  // as it was saved before: a service named « Montage »
  await db.query(`UPDATE products SET services = replace(services::text, '"Old"', '"Montage"')::jsonb WHERE id = $1`, [p.id]);
  // the old way, now refused (the montage switch instead)
  await assert.rejects(call('catalog.saveProduct', depot, { name: 'Autre lit', price: 1, services: [{ name: 'Montage', price: 1, cost: 1 }] }), /bouton « Montage »/);
  for (const s of m105.split(/;\s*\n/).map((x) => x.trim()).filter((x) => x && !/^(--[^\n]*\n?)+$/.test(x))) await db.query(s);
  const after: any = (await call('catalog.products', depot, {}) as any[]).find((x: any) => x.id === p.id);
  assert.deepEqual(after.montage, { price: 1500, cost: 500, wilayas: null });
  assert.deepEqual(after.services.map((s: any) => s.name), ['Emballage cadeau']);
  assert.ok(!after.linked?.includes?.(oldId));
  const old = (await db.query('SELECT active FROM products WHERE id = $1', [oldId]))[0];
  assert.equal(old.active, false);
});

test('montage: one shared service, priced from the product, only in its wilayas', async () => {
  const depot = await as(EMAILS.depot);
  const conf = await as(EMAILS.admin); // samira only sees the products given to her
  const agent = await as(EMAILS.conf);
  const p: any = await call('catalog.saveProduct', depot, { name: 'Armoire 3 portes', price: 40000, montage: { price: 2000, cost: 800, wilayas: [16, 9] } });
  const q: any = await call('catalog.saveProduct', depot, { name: 'Commode', price: 20000, montage: { price: 1000, cost: 300, wilayas: null } });
  assert.deepEqual(p.montage, { price: 2000, cost: 800, wilayas: [9, 16] });
  const d: any = await call('orders.formData', conf, {});
  const mid = d.montage.productId;
  assert.ok(mid);
  // no new service product per product
  const n = Number((await db.query("SELECT count(*)::int AS n FROM products WHERE sku = 'SERVICE-MONTAGE'"))[0].n);
  assert.equal(n, 1);
  const pv = d.products.find((x: any) => x.id === p.id).variants[0].id;
  const qv = d.products.find((x: any) => x.id === q.id).variants[0].id;
  const items = [{ productId: p.id, variantId: pv, qty: 1 }, { productId: mid, variantId: null, qty: 1, forProductId: p.id }];
  const o: any = await call('orders.create', conf, { ...base, wilayaId: 16, items });
  const line = o.items.find((i: any) => i.forProductId === p.id);
  assert.equal(line.unitPrice, 2000);
  assert.match(line.name, /Montage — Armoire 3 portes/);
  assert.equal(o.subtotal, 42000);
  assert.ok(d.montage.variantId);
  await assert.rejects(call('orders.create', conf, { ...base, wilayaId: 16, items: [items[0], { ...items[1], qty: 2 }] }), /Plus de montages/);
  await assert.rejects(call('orders.create', conf, { ...base, wilayaId: 16, items: [...items, items[1]] }), /Deux lignes/);
  const withVar: any = await call('orders.create', conf, { ...base, wilayaId: 16, items: [items[0], { ...items[1], variantId: d.montage.variantId }] });
  assert.equal(withVar.subtotal, 42000);
  // not in Oran (31)
  await assert.rejects(call('orders.create', conf, { ...base, wilayaId: 31, items }), /Pas de montage/);
  // the montage alone, without its product
  await assert.rejects(call('orders.create', conf, { ...base, wilayaId: 16, items: [items[1], { productId: q.id, variantId: qv, qty: 1 }] }), /sans le produit/);
  // moving the order to Oran is refused while the montage is on it
  await assert.rejects(call('orders.update', conf, { id: o.id, wilayaId: 31 }), /Pas de montage/);
  // a product without montage
  const plain: any = await call('catalog.saveProduct', depot, { name: 'Tapis', price: 5000 });
  const tv = (await db.query('SELECT id FROM product_variants WHERE product_id = $1 LIMIT 1', [plain.id]))[0].id;
  await assert.rejects(call('orders.create', conf, { ...base, wilayaId: 16, items: [{ productId: plain.id, variantId: Number(tv), qty: 1 }, { productId: mid, variantId: null, qty: 1, forProductId: plain.id }] }), /n’a pas de montage/);
  // the shop list: empty = everywhere; Commode follows it
  const oran = [{ productId: q.id, variantId: qv, qty: 1 }, { productId: mid, variantId: null, qty: 1, forProductId: q.id }];
  const ok: any = await call('orders.create', conf, { ...base, wilayaId: 31, items: oran });
  assert.equal(ok.subtotal, 21000);
  await call('catalog.saveMontage', depot, { wilayas: [16] });
  assert.deepEqual(((await call('catalog.montage', agent, {})) as any).wilayas, [16]);
  await assert.rejects(call('orders.create', conf, { ...base, wilayaId: 31, items: oran }), /Pas de montage/);
  await call('catalog.saveMontage', depot, { wilayas: [] });
  // confirmation cannot change the shop list
  await assert.rejects(call('catalog.saveMontage', agent, { wilayas: [1] }), /Accès refusé/);
});
