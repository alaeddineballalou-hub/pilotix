// Communes written another way matched by sound (or left empty), companies whose tariffs were never imported, tariffs
// imported again.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { autoCommune, officialCommune, soundKey } from '../modules/coverage';
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

test('a commune written another way is matched by sound when only one commune fits; none fits: left empty for the agent', async () => {
  assert.equal(soundKey('Bab Ezzouar'), soundKey('Bab Azzouar'));
  for (const [text, to] of [
    ['bab-azzouar', 'Bab Azzouar'],
    ['باب الزوار', 'Bab Azzouar'],
    ['Bab Ezzouar', 'Bab Azzouar'],
    ['bab ezouar', 'Bab Azzouar'],
    ['Bordj el Kifane', 'Bordj El Kiffan'],
    ['Kuba', 'Kouba'],
  ] as const)
    assert.equal(officialCommune(16, text), to, text);
  assert.equal(autoCommune(16, 'Oran'), null, 'nothing alike: not matched');
  await call('pilot.save', admin, {
    mode: 'auto',
    rules: [{ id: 'r1', wilayas: [16], except: false, communes: [{ w: 16, c: 'Bab Azzouar' }], products: [], to: own, strict: true, on: true }],
    clashes: [],
  });
  const a = await order(16, 'Bab Ezouar');
  const ra = (await db.query('SELECT commune, company_id FROM orders WHERE id = $1', [a.id]))[0];
  assert.deepEqual([ra.commune, Number(ra.company_id)], ['Bab Azzouar', own], 'the official name saved, Pilot follows the rule');
  const b = await order(16, 'Cité 1200 logements');
  assert.equal((await db.query('SELECT commune FROM orders WHERE id = $1', [b.id]))[0].commune, '', 'not matched: empty, the agent asks');
  await call('pilot.save', admin, { mode: 'manual', rules: [], clashes: [] });
});

test('« Mettre à jour maintenant »: tariffs and bureaus of the companies with an API imported again; rule writers only', async () => {
  const r = (await call('coverage.refresh', admin, {})) as any;
  assert.ok(r.results.some((x: any) => x.companyId === yal && x.ok));
  assert.ok(((await call('coverage.toFix', admin, {})) as any).refresh.at);
  await assert.rejects(call('coverage.refresh', await as(EMAILS.conf), {}));
});
