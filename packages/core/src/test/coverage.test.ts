// Pilot Auto Assign › « À corriger »: communes written another way corrected once and remembered, companies whose
// tariffs were never imported, tariffs imported again.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { autoCommune, canonCommune, closestCommune, soundKey } from '../modules/coverage';
import { EMAILS, setup } from './harness';

let db: Db;
let admin: Ctx;
let as: (email: string) => Promise<Ctx>;
let yal: number, zr: number, own: number;
let X: { productId: number; variantId: number };

before(async () => {
  ({ db, as } = await setup(40));
  admin = await as(EMAILS.admin);
  const cos = await db.query('SELECT id, kind FROM delivery_companies');
  const k = (kind: string) => Number(cos.find((c: any) => c.kind === kind)?.id);
  [yal, zr, own] = [k('yalidine'), k('zr'), k('own')];
  const r = (await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id AND v.active WHERE p.active AND NOT p.is_service ORDER BY p.id, v.id LIMIT 1`))[0];
  X = { productId: Number(r.id), variantId: Number(r.vid) };
});

let n = 0;
const order = async (w: number, commune: string) =>
  (await call('orders.create', admin, { customerName: `Client Couverture ${++n}`, phone: `0696${String(100000 + n).slice(-6)}`, wilayaId: w, commune, address: 'Rue 1', items: [{ ...X, qty: 1 }] })) as any;

test('a company with an API whose tariffs were never imported goes on « À corriger »', async () => {
  await db.query('DELETE FROM delivery_fees WHERE company_id = $1', [zr]);
  const f = (await call('coverage.toFix', admin, {})) as any;
  assert.ok(f.prices.some((p: any) => p.companyId === zr));
  await call('coverage.refresh', admin, {});
  assert.ok(!((await call('coverage.toFix', admin, {})) as any).prices.some((p: any) => p.companyId === zr), 'imported again');
});

test('a commune written another way: on « À corriger » with the closest name; corrected once, remembered, orders fixed, Pilot matches it', async () => {
  assert.equal(await canonCommune(db, 16, 'bab-azzouar'), 'Bab Azzouar');
  assert.equal(await canonCommune(db, 16, 'باب الزوار'), 'Bab Azzouar', 'the Arabic name');
  assert.equal(await canonCommune(db, 16, 'BEZ'), null, 'too far: not matched');
  assert.equal(closestCommune(16, 'Bab Ezzouar'), 'Bab Azzouar');
  await call('pilot.save', admin, {
    mode: 'auto',
    rules: [{ id: 'r1', wilayas: [16], except: false, communes: [{ w: 16, c: 'Bab Azzouar' }], products: [], to: own, strict: true, on: true }],
    clashes: [],
  });
  const a = await order(16, 'BEZ');
  assert.equal(Number((await db.query('SELECT company_id FROM orders WHERE id = $1', [a.id]))[0].company_id), yal, 'not recognized yet: the default');
  const f = (await call('coverage.toFix', admin, {})) as any;
  const row = f.communes.find((c: any) => c.wilayaId === 16 && c.commune === 'BEZ');
  assert.ok(row && row.count >= 1);
  const r = (await call('coverage.fixCommune', admin, { wilayaId: 16, from: 'BEZ', to: 'Bab Azzouar' })) as any;
  assert.ok(r.fixed >= 1);
  const after = (await db.query('SELECT commune, company_id FROM orders WHERE id = $1', [a.id]))[0];
  assert.deepEqual([after.commune, Number(after.company_id)], ['Bab Azzouar', own], 'fixed, and Pilot chose again');
  const b = await order(16, 'bez');
  assert.equal(Number((await db.query('SELECT company_id FROM orders WHERE id = $1', [b.id]))[0].company_id), own, 'remembered for the next orders');
  await assert.rejects(call('coverage.fixCommune', admin, { wilayaId: 16, from: 'X', to: 'Oran' }), /n’est pas une commune/);
  await call('pilot.save', admin, { mode: 'manual', rules: [], clashes: [] });
});

test('a commune written another way is matched by Pilotix itself when only one commune sounds the same', async () => {
  assert.equal(soundKey('Bab Ezzouar'), soundKey('Bab Azzouar'));
  for (const [w, text, to] of [
    [16, 'Bab Ezzouar', 'Bab Azzouar'],
    [16, 'bab ezouar', 'Bab Azzouar'],
    [16, 'Bordj el Kifane', 'Bordj El Kiffan'],
    [16, 'Kuba', 'Kouba'],
  ] as const)
    assert.equal(await canonCommune(db, w, text), to, text);
  assert.equal(autoCommune(16, 'Oran'), null, 'nothing alike: not matched');
  await call('pilot.save', admin, {
    mode: 'auto',
    rules: [{ id: 'r1', wilayas: [16], except: false, communes: [{ w: 16, c: 'Bab Azzouar' }], products: [], to: own, strict: true, on: true }],
    clashes: [],
  });
  const a = await order(16, 'Bab Ezouar');
  assert.equal(Number((await db.query('SELECT company_id FROM orders WHERE id = $1', [a.id]))[0].company_id), own, 'Pilot follows the rule at once');
  const f = (await call('coverage.toFix', admin, {})) as any;
  assert.ok(!f.communes.some((c: any) => c.commune === 'Bab Ezouar'), 'nothing to correct');
  assert.ok(f.auto.some((c: any) => c.commune === 'Bab Ezouar' && c.to === 'Bab Azzouar'), 'shown as matched, to change if wrong');
  await call('pilot.save', admin, { mode: 'manual', rules: [], clashes: [] });
});

test('« Mettre à jour maintenant »: tariffs and bureaus of the companies with an API imported again; rule writers only', async () => {
  const r = (await call('coverage.refresh', admin, {})) as any;
  assert.ok(r.results.some((x: any) => x.companyId === yal && x.ok));
  assert.ok(((await call('coverage.toFix', admin, {})) as any).refresh.at);
  await assert.rejects(call('coverage.refresh', await as(EMAILS.conf), {}));
});
