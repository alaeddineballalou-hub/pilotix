// Marketing › Stratégies: a product's type for the ads, and the video formats recommended for it.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { DEFAULT_CREDITS } from '../platform/credits';
import { recommend, StratFormat } from '../modules/strategies';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;
before(async () => {
  ({ db, as } = await setup(20));
});

const lib: StratFormat[] = DEFAULT_CREDITS.strategies.map((x) => ({ key: x.key, name: x.name, desc: x.desc, kind: x.kind, style: x.style, credits: x.credits, trend: x.trend, types: x.types }));

test('the formats for each type: only recipes made for it, the most precise first, never an editing style', () => {
  const t2 = recommend(lib, 2).map((x) => x.key);
  assert.ok(t2.includes('comparaison') && t2.includes('details'));
  assert.ok(!t2.includes('livraison') && !t2.includes('tutoriel'));
  assert.ok(!t2.includes('ugly') && !t2.includes('propre'));
  // made for type 2 only, before the ones for every type
  assert.ok(t2.indexOf('comparaison') < t2.indexOf('offre'));
  const t3 = recommend(lib, 3).map((x) => x.key);
  assert.deepEqual(t3.slice(0, 3).sort(), ['coulisses', 'fidele', 'livraison']);
  assert.ok(!t3.includes('comparaison'));
  const t1 = recommend(lib, 1).map((x) => x.key);
  assert.ok(t1.includes('tutoriel') && t1.includes('microtrottoir') && !t1.includes('unboxing'));
});

test('a product gets its type; the marketer and the seller may, a confirmation agent may not', async () => {
  const mk = await as(EMAILS.marketer);
  const s: any = await call('strat.state', mk, {});
  assert.ok(s.products.length > 0);
  assert.ok(s.products.every((p: any) => p.type === null));
  assert.deepEqual(s.byType[2], recommend(lib, 2).map((x) => x.key));
  const id = s.products[0].id;
  await call('strat.setType', mk, { id, type: 2 });
  const after: any = await call('strat.state', await as(EMAILS.vendeur), {});
  assert.equal(after.products.find((p: any) => p.id === id).type, 2);
  await call('strat.setType', await as(EMAILS.vendeur), { id, type: null });
  assert.equal(num((await db.query('SELECT product_type FROM products WHERE id = $1', [id]))[0].product_type), null);
  await assert.rejects(call('strat.setType', await as(EMAILS.conf), { id, type: 1 }));
  await assert.rejects(call('strat.setType', mk, { id, type: 4 as any }));
  await assert.rejects(call('strat.setType', mk, { id: 999999, type: 1 }), /introuvable/);
});

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
