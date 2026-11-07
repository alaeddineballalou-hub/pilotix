// Gestion › Prix de livraison « par taille »: a size (variant) with its own client price list wins over its product's,
// in the order form's quote, the saved order, Confirmation, landing pages and the window that ticks the sizes.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { renderLanding } from '@pilotix/shared';
import { call, Ctx, Db } from '../index';
import { productContext } from '../modules/landing';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;
let productId = 0;
let small = 0; // a size that follows its product's list
let big = 0; // the size with its own list

before(async () => {
  const s = await setup(60);
  db = s.db;
  as = s.as;
  // a light product (no weight surcharge) with at least two named sizes / colours
  const rows = await db.query(
    `SELECT p.id, array_agg(v.id ORDER BY v.id) AS vids FROM products p JOIN product_variants v ON v.product_id = p.id AND v.title <> '' AND v.active
      WHERE p.active AND p.archived_at IS NULL AND p.weight_kg <= 5 GROUP BY p.id HAVING count(*) >= 2 ORDER BY p.id LIMIT 1`,
  );
  assert.ok(rows.length, 'a seeded product with two sizes');
  productId = Number(rows[0].id);
  [small, big] = (rows[0].vids as number[]).map(Number);
  const admin = await as(EMAILS.admin);
  await call('admin.fees.saveGrid', admin, { name: 'Velo 7', rows: { '16': { home: 700, desk: 600 }, '19': { home: 750, desk: 650 } } });
  await call('admin.fees.saveGrid', admin, { name: 'Velo 10', rows: { '16': { home: 1000, desk: 900 }, '19': { home: 1050, desk: 950 } } });
  await call('admin.fees.assign', admin, { name: 'Velo 7', productIds: [productId] });
  await call('admin.fees.assign', admin, { name: 'Velo 10', productIds: [], variantIds: [big] });
});

test('the delivery prices window lists the sizes and the one in its own list', async () => {
  const d: any = await call('admin.fees.get', await as(EMAILS.admin), {});
  const p = d.products.find((x: any) => x.id === productId);
  assert.equal(p.feeGrid, 'Velo 7');
  assert.ok(p.variants.length >= 2);
  assert.equal(p.variants.find((v: any) => v.id === big).feeGrid, 'Velo 10');
  assert.equal(p.variants.find((v: any) => v.id === small).feeGrid, null);
});

test('the order form quotes each size with its own list, the highest one for several lines', async () => {
  const ctx = await as(EMAILS.conf);
  const q = async (items: { productId: number; variantId?: number; qty: number }[], isStopdesk = false) =>
    ((await call('orders.quote', ctx, { wilayaId: 16, isStopdesk, items })) as any).fee;
  assert.equal(await q([{ productId, variantId: small, qty: 1 }]), 700);
  assert.equal(await q([{ productId, variantId: big, qty: 1 }]), 1000);
  assert.equal(await q([{ productId, variantId: big, qty: 1 }], true), 900);
  assert.equal(await q([{ productId, variantId: small, qty: 1 }, { productId, variantId: big, qty: 1 }]), 1000);
  // without its size the line takes its product's list
  assert.equal(await q([{ productId, qty: 1 }]), 700);
});

test('a new order without a typed fee charges its size list; Confirmation shows the same price', async () => {
  const ctx = await as(EMAILS.conf);
  const o: any = await call('orders.create', ctx, { customerName: 'Client Taille', phone: '0555123987', wilayaId: 16, commune: 'Kouba', items: [{ productId, variantId: big, qty: 1 }] });
  assert.equal(o.deliveryFee, 1000);
  const g: any = await call('confirmation.gridFee', ctx, { id: o.id });
  assert.equal(g.fee, 1000);
  assert.equal(((await call('confirmation.gridFee', ctx, { id: o.id, isStopdesk: true })) as any).fee, 900);
  assert.equal(((await call('confirmation.gridFee', ctx, { id: o.id, wilayaId: 19 })) as any).fee, 1050);
  const o2: any = await call('orders.create', ctx, { customerName: 'Client Petit', phone: '0555123988', wilayaId: 16, commune: 'Kouba', items: [{ productId, variantId: small, qty: 1 }] });
  assert.equal(o2.deliveryFee, 700);
});

test('a landing page switches to the size list when the customer picks that size', async () => {
  const pc = await productContext(db, productId);
  assert.equal(pc.fees[16], 700);
  assert.equal(pc.variantFee[big], 'Velo 10');
  assert.equal(pc.variantFee[small], undefined);
  assert.equal(pc.feeSets['Velo 10'][16], 1000);
  const html = renderLanding(
    { slug: 't', title: 'T', color: '#000', price: 1000, oldPrice: null, description: '', variantLabel: 'Taille', variants: pc.variants, images: [], fees: pc.fees, feeSets: pc.feeSets, variantFee: pc.variantFee, shopName: 'S' },
    { mode: 'preview', post: '', geo: '', challenge: 'x', bits: 1 },
  );
  assert.ok(html.includes(`"vf":{"${big}":"Velo 10"}`), 'the page knows the size list');
  assert.ok(html.includes('function fz()'), 'the page reads the picked size list');
});

test('renaming or deleting a list carries its sizes along', async () => {
  const admin = await as(EMAILS.admin);
  const grids: any = await call('admin.fees.get', admin, {});
  await call('admin.fees.saveGrid', admin, { name: 'Velo 10 kg', oldName: 'Velo 10', rows: grids.grids['Velo 10'] });
  let d: any = await call('admin.fees.get', admin, {});
  assert.equal(d.products.find((x: any) => x.id === productId).variants.find((v: any) => v.id === big).feeGrid, 'Velo 10 kg');
  await call('admin.fees.deleteGrid', admin, { name: 'Velo 10 kg' });
  d = await call('admin.fees.get', admin, {});
  assert.equal(d.products.find((x: any) => x.id === productId).variants.find((v: any) => v.id === big).feeGrid, null);
  const q: any = await call('orders.quote', await as(EMAILS.conf), { wilayaId: 16, items: [{ productId, variantId: big, qty: 1 }] });
  assert.equal(q.fee, 700);
});

test('ticking sizes is exact: the untick takes the size back to its product list', async () => {
  const admin = await as(EMAILS.admin);
  await call('admin.fees.saveGrid', admin, { name: 'Velo 20', rows: { '16': { home: 1500, desk: 1400 } } });
  await call('admin.fees.assign', admin, { name: 'Velo 20', productIds: [], variantIds: [small, big] });
  let d: any = await call('admin.fees.get', admin, {});
  let vs = d.products.find((x: any) => x.id === productId).variants;
  assert.equal(vs.find((v: any) => v.id === small).feeGrid, 'Velo 20');
  await call('admin.fees.assign', admin, { name: 'Velo 20', productIds: [], variantIds: [big] });
  d = await call('admin.fees.get', admin, {});
  vs = d.products.find((x: any) => x.id === productId).variants;
  assert.equal(vs.find((v: any) => v.id === small).feeGrid, null);
  assert.equal(vs.find((v: any) => v.id === big).feeGrid, 'Velo 20');
  // a product-only save (the old window) leaves the sizes alone
  await call('admin.fees.assign', admin, { name: 'Velo 20', productIds: [] });
  d = await call('admin.fees.get', admin, {});
  assert.equal(d.products.find((x: any) => x.id === productId).variants.find((v: any) => v.id === big).feeGrid, 'Velo 20');
});
