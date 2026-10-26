// Produits › « Importer Excel »: lines grouped into products, the preview (dry run) equal to the import, stock entries.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;
before(async () => {
  ({ db, as } = await setup(50));
});

const ROWS = [
  { line: 2, name: 'T-shirt Import', sku: 'TS-IMP', cost: 800, price: '2 500', variant: 'Rouge', variantSku: 'TS-IMP-R', stock: 10, weightKg: '0,3', maxDiscount: 200 },
  { line: 3, name: 't-shirt import', variant: 'Bleu', stock: '4' },
  { line: 4, name: 'Montre Import', cost: '1500', price: '4900 DA', stock: 7 },
  { line: 5, name: 'Sac Import', price: 'abc' },
  { line: 6, name: '', price: 100 },
  { line: 7, name: 'Casquette Import', price: 900, variant: 'Noir', variantSku: 'TS-IMP-R' },
];

test('import: roles, preview = import, products, variants and stock entries', async () => {
  await assert.rejects(call('catalog.importProducts', await as(EMAILS.conf), { rows: ROWS }), /Accès refusé/);
  const admin = await as(EMAILS.admin);
  const count = async () => Number((await db.query('SELECT count(*)::int AS n FROM products'))[0].n);
  const n0 = await count();

  const plan: any = await call('catalog.importProducts', admin, { rows: ROWS });
  assert.equal(plan.dryRun, true);
  assert.equal(await count(), n0, 'the preview writes nothing');
  const by = (r: any, name: string) => r.products.find((p: any) => p.name === name);
  assert.deepEqual(plan.products.map((p: any) => [p.name, p.status]), [
    ['T-shirt Import', 'ready'],
    ['Montre Import', 'ready'],
    ['Sac Import', 'error'],
    ['Casquette Import', 'error'],
  ]);
  assert.deepEqual(by(plan, 'T-shirt Import').variants.map((v: any) => [v.title, v.stock]), [['Rouge', 10], ['Bleu', 4]]);
  assert.equal(by(plan, 'T-shirt Import').price, 2500);
  assert.equal(by(plan, 'T-shirt Import').weightKg, 0.3);
  assert.equal(by(plan, 'Montre Import').price, 4900);
  assert.match(by(plan, 'Sac Import').errors[0], /Ligne 5 : Prix de vente invalide/);
  assert.match(by(plan, 'Casquette Import').errors[0], /TS-IMP-R.*ligne 2/);
  assert.deepEqual(plan.lineErrors, [{ line: 6, message: 'Nom manquant' }]);

  const done: any = await call('catalog.importProducts', admin, { rows: ROWS, dryRun: false });
  assert.deepEqual(done.products.map((p: any) => p.status), ['created', 'created', 'error', 'error']);
  assert.equal(done.created, 2);
  assert.equal(await count(), n0 + 2);
  const ts: any = await call('catalog.product', admin, { id: by(done, 'T-shirt Import').productId });
  assert.equal(ts.sku, 'TS-IMP');
  assert.equal(ts.cost, 800);
  assert.equal(ts.maxDiscount, 200);
  assert.deepEqual(ts.variants.filter((v: any) => v.active).map((v: any) => v.title).sort(), ['Bleu', 'Rouge']);
  assert.equal(ts.variants.find((v: any) => v.title === 'Rouge').sku, 'TS-IMP-R');
  // the stock went in the default depot, through a stock entry (movement « entry »)
  const wid = done.warehouse.id;
  const stockOf = async (vid: number) => Number((await db.query('SELECT qty FROM stock WHERE variant_id = $1 AND warehouse_id = $2', [vid, wid]))[0]?.qty ?? 0);
  const red = ts.variants.find((v: any) => v.title === 'Rouge');
  assert.equal(await stockOf(red.id), 10);
  const mv: any = await call('catalog.movements', admin, { variantId: red.id, pageSize: 5 });
  assert.deepEqual(mv.rows.map((m: any) => [m.reason, m.delta, m.note]), [['entry', 10, 'Import Excel']]);
  const watch: any = await call('catalog.product', admin, { id: by(done, 'Montre Import').productId });
  assert.deepEqual(watch.variants.map((v: any) => v.title), ['']);
  assert.equal(await stockOf(watch.variants[0].id), 7);

  // the same file again: the product with a SKU is skipped, the one without is announced as a double
  const again: any = await call('catalog.importProducts', admin, { rows: ROWS.slice(0, 3) });
  assert.equal(by(again, 'T-shirt Import').status, 'skip');
  assert.equal(by(again, 'Montre Import').status, 'ready');
  assert.match(by(again, 'Montre Import').warnings[0], /même nom/);
});

test('import: only the administrator sets the maximum discount; a variant line without a name is refused', async () => {
  const depot = await as(EMAILS.depot);
  const r: any = await call('catalog.importProducts', depot, {
    rows: [
      { line: 2, name: 'Lampe Import', price: 1200, maxDiscount: 100, stock: 3 },
      { line: 2, name: 'Bol Import', price: 300, variant: 'Grand' },
      { line: 3, name: 'Bol Import', price: 300 },
    ],
    dryRun: false,
  });
  assert.equal(r.products[0].status, 'created');
  assert.match(r.products[0].warnings[0], /Remise max ignorée/);
  const p: any = await call('catalog.product', depot, { id: r.products[0].productId });
  assert.equal(p.maxDiscount, 0);
  assert.equal(r.products[1].status, 'error');
  assert.match(r.products[1].errors.join(), /Variante manquante/);
});
