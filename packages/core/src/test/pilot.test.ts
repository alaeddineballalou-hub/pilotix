// « Pilot Auto Assign »: the rules choose who delivers each order (strict beats soft, clashes answered when saving),
// « Manuel » follows the Préférences, Pilot chooses again when the place changes, people's hand changes follow the
// Préférences (strict rules locked), the waiting orders follow a new rule on request, and « Livraison privée » orders
// waiting too long go to the backup company.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { clashesOf, pickRule, type PilotRule } from '@pilotix/shared';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let admin: Ctx;
let as: (email: string) => Promise<Ctx>;
let yal: number, zr: number, own: number, noest: number;
let X: { productId: number; variantId: number };
let BIG: { productId: number; variantId: number };

const rule = (id: string, p: Partial<PilotRule> & { to: number }): PilotRule => ({ id, wilayas: [], except: false, communes: [], products: [], strict: false, on: true, ...p });

before(async () => {
  ({ db, as } = await setup(40));
  admin = await as(EMAILS.admin);
  const cos = await db.query('SELECT id, kind FROM delivery_companies');
  const k = (kind: string) => Number(cos.find((c: any) => c.kind === kind)?.id);
  [yal, zr, own, noest] = [k('yalidine'), k('zr'), k('own'), k('noest')];
  const wh = Number((await db.query('SELECT id FROM warehouses WHERE active ORDER BY is_default DESC, id LIMIT 1'))[0].id);
  const two = await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id AND v.active WHERE p.active AND NOT p.is_service ORDER BY p.id, v.id`);
  X = { productId: Number(two[0].id), variantId: Number(two[0].vid) };
  const other = two.find((r: any) => Number(r.id) !== X.productId);
  BIG = { productId: Number(other.id), variantId: Number(other.vid) };
  for (const v of [X.variantId, BIG.variantId]) await db.query('INSERT INTO stock (variant_id, warehouse_id, qty) VALUES ($1, $2, 500) ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET qty = 500', [v, wh]);
});

let n = 0;
const phone = () => `0695${String(100000 + ++n).slice(-6)}`;
const order = async (w: number, commune: string, items = [{ ...X, qty: 1 }], more: Record<string, unknown> = {}) =>
  (await call('orders.create', admin, { customerName: `Client Pilot ${n}`, phone: phone(), wilayaId: w, commune, address: 'Cité 5', items, ...more })) as any;
const row = async (id: number) => (await db.query('SELECT company_id, livreur_id, pilot_by, pilot_rule, pilot_why, follow_status, tracking FROM orders WHERE id = $1', [id]))[0];
const save = (cfg: { mode: 'auto' | 'manual'; rules: PilotRule[]; clashes?: { a: string; b: string; win: string }[] }, more: Record<string, unknown> = {}) =>
  call('pilot.save', admin, { clashes: [], ...cfg, ...more }) as Promise<any>;

test('the rules, by themselves: places keep rules apart, products never do; strict beats soft; a clash waits for its answer', () => {
  const oran = rule('r1', { wilayas: [31], to: 2 });
  const bir = rule('r2', { wilayas: [31], communes: [{ w: 31, c: 'Bir El Djir' }], to: 3 });
  const alger = rule('r3', { wilayas: [16], to: 4 });
  const c1 = clashesOf({ rules: [oran, bir, alger], clashes: [] });
  assert.equal(c1.length, 1, 'only Oran and Bir El Djir meet');
  assert.equal(c1[0].kind, 'ask');
  assert.deepEqual(c1[0].example, { wilayaId: 31, commune: 'Bir El Djir', products: [] });
  // two product rules always meet: one order can hold both products
  const p1 = rule('r4', { products: [10], to: 2 });
  const p2 = rule('r5', { products: [11], to: 3, strict: true });
  const c2 = clashesOf({ rules: [p1, p2], clashes: [] });
  assert.equal(c2.length, 1);
  assert.equal(c2[0].kind, 'strict', 'a strict rule against a soft one: strict wins by itself');
  assert.deepEqual(c2[0].example.products, [10, 11]);
  const o = { wilayaId: 31, commune: 'bir el-djir', productIds: [10, 11] };
  assert.equal((pickRule({ rules: [p1, p2], clashes: [] }, o) as any).rule.id, 'r5', 'strict beats soft');
  assert.deepEqual((pickRule({ rules: [oran, bir], clashes: [] }, o) as any).conflict, ['r1', 'r2'], 'no answer yet: a person chooses');
  assert.equal((pickRule({ rules: [oran, bir], clashes: [{ a: 'r1', b: 'r2', win: 'r2' }] }, o) as any).rule.id, 'r2');
  assert.ok('conflict' in pickRule({ rules: [oran, bir], clashes: [{ a: 'r2', b: 'r1', win: 'assign' }] }, o));
  assert.equal((pickRule({ rules: [oran, bir], clashes: [] }, { ...o, commune: 'Es Senia' }) as any).rule.id, 'r1', 'only Oran there');
  assert.ok('none' in pickRule({ rules: [oran, bir], clashes: [] }, { ...o, wilayaId: 16 }));
  assert.equal((pickRule({ rules: [rule('r6', { wilayas: [31], except: true, to: 2 })], clashes: [] }, { ...o, wilayaId: 16 }) as any).rule.id, 'r6', '« toutes sauf Oran »');
});

test('« Manuel »: the default company counts as chosen, or the order waits for a person (Préférences)', async () => {
  await save({ mode: 'manual', rules: [] });
  const a = await order(16, 'Hydra');
  assert.equal(Number((await row(a.id)).company_id), yal);
  assert.equal((await row(a.id)).pilot_by, 'default');
  const p = ((await call('prefs.get', admin, {})) as any).prefs;
  await call('prefs.set', admin, { ...p, manualDefault: false });
  const b = await order(16, 'Hydra');
  const r = await row(b.id);
  assert.equal(r.company_id, null, 'a manager chooses in « À attribuer »');
  assert.equal(r.pilot_why, 'manual');
  await call('prefs.set', admin, { ...p, manualDefault: true });
});

test('« Pilot Auto Assign »: the rules choose on arrival, and again — silently — when the commune changes during the call', async () => {
  await save({
    mode: 'auto',
    rules: [rule('r1', { wilayas: [31], to: zr }), rule('r2', { wilayas: [31], communes: [{ w: 31, c: 'Bir El Djir' }], to: own })],
    clashes: [{ a: 'r1', b: 'r2', win: 'r2' }],
  });
  const a = await order(31, 'Es Senia');
  assert.deepEqual([Number((await row(a.id)).company_id), (await row(a.id)).pilot_by, (await row(a.id)).pilot_rule], [zr, 'rule', 'r1']);
  const b = await order(31, 'Bir El Djir');
  assert.equal(Number((await row(b.id)).company_id), own, 'the answer: Bir El Djir with our livreurs');
  await call('orders.update', admin, { id: b.id, commune: 'Es Senia' });
  assert.equal(Number((await row(b.id)).company_id), zr, 'moved to ZR by itself');
  const c = await order(16, 'Hydra');
  assert.deepEqual([Number((await row(c.id)).company_id), (await row(c.id)).pilot_by], [yal, 'default'], 'no rule: the default company');
});

test('a company that does not deliver there is skipped; nobody delivers: a person chooses', async () => {
  // NOEST has no bureau price in Tamanrasset (11)
  await save({ mode: 'auto', rules: [rule('r1', { wilayas: [11], to: noest })] });
  const a = await order(11, 'Tamanrasset', [{ ...X, qty: 1 }], { isStopdesk: true });
  assert.deepEqual([Number((await row(a.id)).company_id), (await row(a.id)).pilot_by], [yal, 'default']);
  const home = await order(11, 'Tamanrasset');
  assert.equal(Number((await row(home.id)).company_id), noest, 'at home NOEST goes there');
  await save({ mode: 'auto', rules: [rule('r1', { wilayas: [11], to: noest })] }, { defaultCompanyId: null });
  const b = await order(11, 'Tamanrasset', [{ ...X, qty: 1 }], { isStopdesk: true });
  assert.deepEqual([(await row(b.id)).company_id, (await row(b.id)).pilot_why], [null, 'nobody']);
  await save({ mode: 'auto', rules: [] }, { defaultCompanyId: yal });
});

test('saving: two soft rules that meet need an answer; « À attribuer » sends their orders to a person', async () => {
  const rules = [rule('r1', { products: [X.productId], to: zr }), rule('r2', { wilayas: [16], to: noest })];
  await assert.rejects(save({ mode: 'auto', rules }), /se contredisent/);
  const prev = (await call('pilot.preview', admin, { mode: 'auto', rules, clashes: [] })) as any;
  assert.equal(prev.clashes.length, 1);
  assert.equal(prev.clashes[0].win, null);
  await save({ mode: 'auto', rules, clashes: [{ a: 'r1', b: 'r2', win: 'assign' }] });
  const a = await order(16, 'Kouba');
  assert.deepEqual([(await row(a.id)).company_id, (await row(a.id)).pilot_why], [null, 'conflict:1,2']);
  const b = await order(16, 'Kouba', [{ ...BIG, qty: 1 }]);
  assert.equal(Number((await row(b.id)).company_id), noest, 'only the Alger rule');
  // a strict rule beats them both
  await save({ mode: 'auto', rules: [...rules, rule('r3', { products: [X.productId], to: yal, strict: true })], clashes: [{ a: 'r1', b: 'r2', win: 'assign' }] });
  const c = await order(16, 'Kouba');
  assert.deepEqual([Number((await row(c.id)).company_id), (await row(c.id)).pilot_by], [yal, 'strict']);
});

test('hand changes follow the Préférences: a strict rule is locked for agents; a hand-given order is left alone', async () => {
  await save({ mode: 'auto', rules: [rule('r1', { products: [BIG.productId], to: yal, strict: true }), rule('r2', { wilayas: [31], to: zr })] });
  const a = await order(16, 'Hydra', [{ ...BIG, qty: 1 }]);
  assert.equal((await row(a.id)).pilot_by, 'strict');
  const samira = await as(EMAILS.conf);
  await assert.rejects(call('orders.assignCompany', samira, { ids: [a.id], companyId: zr }), /règle stricte/);
  await db.query(`UPDATE profiles SET can_assign = true WHERE email = $1`, [EMAILS.manager]);
  const yacine = await as(EMAILS.manager);
  await call('orders.assignCompany', yacine, { ids: [a.id], companyId: zr });
  assert.deepEqual([Number((await row(a.id)).company_id), (await row(a.id)).pilot_by], [zr, 'hand'], 'a manager may');
  // an agent on an order a soft rule placed: allowed (Préférences: agents yes); then the rules leave it alone
  const b = await order(31, 'Oran');
  await call('orders.assignCompany', samira, { ids: [b.id], companyId: noest });
  await call('orders.update', admin, { id: b.id, commune: 'Es Senia' });
  assert.deepEqual([Number((await row(b.id)).company_id), (await row(b.id)).pilot_by], [noest, 'hand']);
  // the depot may not (Préférences: dépôt no)
  const c = await order(31, 'Oran');
  await assert.rejects(call('orders.assignCompany', await as(EMAILS.depot), { ids: [c.id], companyId: noest }), /Préférences/);
});

test('a new rule: « Déplacer les N commandes en attente aussi ? » — orders given by hand never move', async () => {
  await save({ mode: 'auto', rules: [] });
  const a = await order(19, 'Sétif');
  const b = await order(19, 'El Eulma', [{ ...X, qty: 1 }], { companyId: yal });
  assert.equal((await row(b.id)).pilot_by, 'hand');
  const next = { mode: 'auto' as const, rules: [rule('r1', { wilayas: [19], to: zr })], clashes: [] };
  const p = (await call('pilot.preview', admin, next)) as any;
  assert.ok(p.waiting >= 1);
  assert.ok(p.sample.length && p.sample.every((s: any) => s.to === 'ZR Express' && s.id !== b.id));
  const r = await save(next, { move: true });
  assert.ok(r.moved >= 1);
  assert.deepEqual([Number((await row(a.id)).company_id), (await row(a.id)).pilot_rule], [zr, 'r1']);
  assert.equal(Number((await row(b.id)).company_id), yal, 'given by hand: stays');
});

test('only admins and the kinds of people ticked in Préférences write the rules', async () => {
  const samira = await as(EMAILS.conf);
  const seen = (await call('pilot.get', samira, {})) as any;
  assert.equal(seen.canEdit, false, 'she sees the rules, without changing them');
  assert.ok(seen.companies.length && seen.products.length);
  assert.equal(((await call('pilot.get', admin, {})) as any).canEdit, true);
  await assert.rejects(call('pilot.save', samira, { mode: 'manual', rules: [], clashes: [] }), /Seuls les admins/);
  const p = ((await call('prefs.get', admin, {})) as any).prefs;
  await call('prefs.set', admin, { ...p, rulesBy: { ...p.rulesBy, confirmation: true } });
  assert.equal(((await call('pilot.get', samira, {})) as any).canEdit, true);
  await call('pilot.save', samira, { mode: 'auto', rules: [], clashes: [] });
  await call('prefs.set', admin, { ...p, rulesBy: { ...p.rulesBy, confirmation: false } });
  await assert.rejects(call('pilot.save', samira, { mode: 'manual', rules: [], clashes: [] }), /Seuls les admins/);
});

test('« Livraison privée » waiting too long in « À attribuer » goes to the backup company (when it delivers there)', async () => {
  await save({ mode: 'auto', rules: [rule('r1', { wilayas: [16], communes: [{ w: 16, c: 'Bab Ezzouar' }], to: own, strict: true })] });
  const a = await order(16, 'Bab Ezzouar');
  assert.equal(Number((await row(a.id)).company_id), own);
  await call('orders.setConf', admin, { ids: [a.id], status: 'confirmed' });
  await db.query('UPDATE order_items SET picked_qty = qty WHERE order_id = $1', [a.id]);
  const karim = await as(EMAILS.depot);
  const list = (await call('depot.toAssign', karim, {})) as any;
  assert.ok(list.rows.some((o: any) => o.id === a.id), 'waits for a livreur');
  await db.query(`UPDATE orders SET assign_wait_since = now() - interval '30 hours' WHERE id = $1`, [a.id]);
  const p = ((await call('prefs.get', admin, {})) as any).prefs;
  await call('prefs.set', admin, { ...p, privateBackup: { on: true, hours: 24, companyId: zr } });
  const r = (await call('pilot.run', admin, {})) as any;
  assert.equal(r.moved, 1);
  const after = await row(a.id);
  assert.deepEqual([Number(after.company_id), after.pilot_by, after.follow_status], [zr, 'backup', 'prepared'], 'to ZR, in « En dispatch »');
  await call('prefs.set', admin, { ...p, privateBackup: { on: false, hours: 24, companyId: null } });
  await save({ mode: 'manual', rules: [] });
});
