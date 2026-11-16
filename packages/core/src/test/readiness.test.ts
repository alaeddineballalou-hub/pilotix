// Produits › « Prêt » / « À faire »: a product sells only when it has an HD main photo, its prices, a description, a live
// landing page and a sales guide; until then Pilotix keeps it off (« À faire »), and puts it back on sale by itself.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, readinessOf, syncReadiness } from '../index';
import { EMAILS, makeReady, setup } from './harness';

let db: Db;
let admin: Ctx;
before(async () => {
  let as: (email: string) => Promise<Ctx>;
  ({ db, as } = await setup(60));
  admin = await as(EMAILS.admin);
});

const product = async (id: number) => (await db.query('SELECT active, ready_off FROM products WHERE id = $1', [id]))[0];
const missingOf = async (id: number) => (await readinessOf(db, [id])).get(id);

test('the demo products are Ready: nothing changes for them', async () => {
  const all = await readinessOf(db);
  assert.ok(all.size >= 10);
  for (const [, missing] of all) assert.deepEqual(missing, []);
  assert.equal(await syncReadiness(admin), 0);
  const r: any = await call('catalog.readiness', admin, {});
  assert.equal(r.hdMinWidth, 1080);
  assert.ok(r.products.every((p: any) => p.missing.length === 0));
});

test('a new product waits in « À faire », cannot be switched on, and goes on sale by itself once it has all five', async () => {
  const p: any = await call('catalog.saveProduct', admin, { name: 'Balançoire simple', price: 2500, cost: 1600, weightKg: 3, packs: [], linked: [], variants: [], maxDiscount: 0 });
  assert.deepEqual(await missingOf(p.id), ['photo', 'description', 'landing', 'guide']);
  assert.deepEqual(await product(p.id), { active: false, ready_off: true });
  const listed: any = await call('catalog.readiness', admin, {});
  assert.deepEqual(listed.products.find((x: any) => x.id === p.id), { id: p.id, missing: ['photo', 'description', 'landing', 'guide'], waiting: true });
  await assert.rejects(call('catalog.setAvailability', admin, { productId: p.id, active: true }), /n’est pas prêt : il manque photo HD.*description.*landing page.*guide de vente/);

  // a small photo is not HD
  await db.query(`INSERT INTO product_photos (product_id, kind, store, data, w, h, bytes, thumb, position) VALUES ($1, 'photo', 'local', 'x', 640, 800, 1, 'data:,', 0)`, [p.id]);
  await db.query(`UPDATE products SET description = 'Balançoire pour bébé, de 6 mois à 3 ans.' WHERE id = $1`, [p.id]);
  await db.query(`INSERT INTO landing_pages (product_id, slug, title) VALUES ($1, 'balancoire-simple', 'Balançoire')`, [p.id]);
  await db.query(`INSERT INTO product_guides (product_id, guide) VALUES ($1, '{}'::jsonb)`, [p.id]);
  await call('catalog.readiness', admin, {});
  assert.deepEqual(await missingOf(p.id), ['photo']);
  assert.equal((await product(p.id)).active, false);

  // an HD photo first: Ready, on sale with no click
  await db.query(`UPDATE product_photos SET w = 1080, h = 1350 WHERE product_id = $1`, [p.id]);
  await call('catalog.readiness', admin, {});
  assert.deepEqual(await missingOf(p.id), []);
  assert.deepEqual(await product(p.id), { active: true, ready_off: false });

  // its landing page taken offline: not sold again, and back on sale when it is online
  await db.query(`UPDATE landing_pages SET active = false WHERE product_id = $1`, [p.id]);
  await call('catalog.readiness', admin, {});
  assert.deepEqual(await product(p.id), { active: false, ready_off: true });
  await db.query(`UPDATE landing_pages SET active = true WHERE product_id = $1`, [p.id]);
  await call('catalog.readiness', admin, {});
  assert.deepEqual(await product(p.id), { active: true, ready_off: false });

  // switched off by the seller: stays off, even Ready (« Masqués »)
  await call('catalog.setAvailability', admin, { productId: p.id, active: false });
  await call('catalog.readiness', admin, {});
  assert.deepEqual(await product(p.id), { active: false, ready_off: false });
  await call('catalog.setAvailability', admin, { productId: p.id, active: true });
  assert.deepEqual(await product(p.id), { active: true, ready_off: false });
});

test('a change in the app checks again at once (no waiting for the server)', async () => {
  const p: any = await call('catalog.saveProduct', admin, { name: 'Tapis de jeu', price: 3200, cost: 1800, weightKg: 1, packs: [], linked: [], variants: [], maxDiscount: 0 });
  await db.query(`INSERT INTO product_photos (product_id, kind, store, data, w, h, bytes, thumb, position) VALUES ($1, 'photo', 'local', 'x', 1200, 1500, 1, 'data:,', 0)`, [p.id]);
  await db.query(`INSERT INTO landing_pages (product_id, slug, title) VALUES ($1, 'tapis-de-jeu', 'Tapis')`, [p.id]);
  await db.query(`INSERT INTO product_guides (product_id, guide) VALUES ($1, '{}'::jsonb)`, [p.id]);
  assert.equal((await product(p.id)).active, false);
  // the description written in the product's form (its « Actif » box ticked, as the form shows a waiting product): the
  // save itself puts it on sale
  const full: any = (await call('catalog.products', admin, {}) as any[]).find((x) => x.id === p.id);
  await call('catalog.saveProduct', admin, { ...full, active: true, description: 'Tapis de jeu musical, 5 jouets suspendus.' });
  assert.deepEqual(await product(p.id), { active: true, ready_off: false });
});

test('services are never checked', async () => {
  const svc = (await db.query(`SELECT id FROM products WHERE is_service LIMIT 1`))[0];
  if (!svc) return;
  assert.equal((await readinessOf(db, [Number(svc.id)])).size, 0);
});

test('the product form: « Actif » ticked keeps it waiting (on sale once Ready); unticked it is the seller’s own off', async () => {
  const p: any = await call('catalog.saveProduct', admin, { name: 'Porte-bébé', price: 4000, cost: 2000, weightKg: 1, packs: [], linked: [], variants: [], maxDiscount: 0 });
  const full = async () => ((await call('catalog.products', admin, {})) as any[]).find((x) => x.id === p.id);
  // saved again from its form, the box ticked (the form shows a waiting product ticked): still waiting
  await call('catalog.saveProduct', admin, { ...(await full()), active: true });
  assert.deepEqual(await product(p.id), { active: false, ready_off: true });
  // unticked: the seller's own « off »: not waiting any more, and still off once it is Ready (« Masqués »)
  await call('catalog.saveProduct', admin, { ...(await full()), active: false });
  assert.deepEqual(await product(p.id), { active: false, ready_off: false });
  await makeReady(db, p.id);
  const r: any = await call('catalog.readiness', admin, {});
  assert.deepEqual(await product(p.id), { active: false, ready_off: false });
  assert.deepEqual(r.products.find((x: any) => x.id === p.id), { id: p.id, missing: [], waiting: false });
  // the seller switches it on: Ready, so it sells
  await call('catalog.setAvailability', admin, { productId: p.id, active: true });
  assert.deepEqual(await product(p.id), { active: true, ready_off: false });
});

test('only what the shop can give is asked: no page without landing pages in its plan, no HD photo where none can be kept', async () => {
  const p: any = await call('catalog.saveProduct', admin, { name: 'Bavoir', price: 900, cost: 300, weightKg: 0.1, packs: [], linked: [], variants: [], maxDiscount: 0, description: 'Bavoir en silicone.' });
  await db.query(`INSERT INTO product_guides (product_id, guide) VALUES ($1, '{}'::jsonb)`, [p.id]);
  assert.deepEqual(await missingOf(p.id), ['photo', 'landing']);
  // a plan without landing pages, on a server with no place for HD photos: nothing more is asked, it sells
  const small: Ctx = { ...admin, shop: { id: 1, slug: 'demo', primary: true, features: ['produits', 'commandes'], locked: false, demo: false, maxUsers: null, maxDrivers: null } as any, server: {} as any };
  const r: any = await call('catalog.readiness', small, {});
  assert.deepEqual(r.checks, ['prices', 'description', 'guide']);
  assert.deepEqual(r.products.find((x: any) => x.id === p.id).missing, []);
  assert.deepEqual(await product(p.id), { active: true, ready_off: false });
  // the shop's own plan again: back in « À faire »
  await call('catalog.readiness', admin, {});
  assert.deepEqual(await product(p.id), { active: false, ready_off: true });
});
