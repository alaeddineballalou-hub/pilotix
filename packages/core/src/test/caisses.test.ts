// Caisses: money received goes into the caisse of whoever received it; expenses, entries and transfers move balances;
// an employee only uses his own caisse and can only hand it to the main caisse.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(250));
});

const bal = async (ctx: Ctx, caisse: string) => ((await call('caisse.view', ctx, { caisse })) as any).balance as number;

test('money received from a company goes into the chosen caisse; cancelling takes it back out', async () => {
  const admin = await as(EMAILS.admin);
  const karim = (await db.query(`SELECT id FROM profiles WHERE email = $1`, [EMAILS.depot]))[0];
  const key = `u${karim.id}`;
  const before = await bal(admin, key);
  const due: any = await call('cash.due', admin, {});
  const g = due.groups.find((x: any) => !x.livreurId);
  const one = g.orders[0];
  const r: any = await call('cash.receive', admin, { ids: [one.id], into: key });
  assert.equal(await bal(admin, key), before + one.net);
  await call('cash.cancel', admin, { handoverId: r.handovers[0] });
  assert.equal(await bal(admin, key), before);
  const ov: any = await call('caisse.overview', admin, {});
  assert.ok(ov.companies.length > 0);
  assert.ok(ov.employees.some((e: any) => e.key === key));
});

test('expenses, entries and transfers move the balances; a transfer cannot exceed the balance', async () => {
  const admin = await as(EMAILS.admin);
  const m0 = await bal(admin, 'main');
  await call('caisse.add', admin, { caisse: 'main', kind: 'income', amount: 10_000, note: 'Fond de caisse' });
  await call('caisse.add', admin, { caisse: 'main', kind: 'expense', amount: 2_500, category: 'packing', note: 'Cartons' });
  assert.equal(await bal(admin, 'main'), m0 + 7_500);
  await assert.rejects(call('caisse.add', admin, { caisse: 'main', kind: 'expense', amount: 100 }), /catégorie/);
  const b0 = await bal(admin, 'bank');
  await call('caisse.transfer', admin, { from: 'main', to: 'bank', amount: 5_000 });
  assert.equal(await bal(admin, 'bank'), b0 + 5_000);
  assert.equal(await bal(admin, 'main'), m0 + 2_500);
  await assert.rejects(call('caisse.transfer', admin, { from: 'bank', to: 'main', amount: b0 + 999_999_999 }), /insuffisant/);
  const v: any = await call('caisse.view', admin, { caisse: 'main' });
  const t = v.moves.find((m: any) => m.kind === 'transfer');
  assert.match(t.label, /Banque/);
  await call('caisse.cancel', admin, { id: t.moveId });
  assert.equal(await bal(admin, 'bank'), b0);
});

test('an employee uses only his caisse and hands it only to the main caisse', async () => {
  const karim = await as(EMAILS.depot);
  const me: any = await call('caisse.mine', karim, {});
  await call('caisse.add', karim, { caisse: me.key, kind: 'income', amount: 3_000, note: 'Client payé au dépôt' });
  await call('caisse.add', karim, { caisse: me.key, kind: 'expense', amount: 1_000, category: 'fuel' });
  assert.equal(((await call('caisse.mine', karim, {})) as any).balance, me.balance + 2_000);
  await assert.rejects(call('caisse.add', karim, { caisse: 'main', kind: 'expense', amount: 10, category: 'other' }), /votre caisse/);
  await assert.rejects(call('caisse.transfer', karim, { from: me.key, to: 'bank', amount: 100 }), /caisse principale/);
  await call('caisse.transfer', karim, { from: me.key, to: 'main', amount: 2_000 });
  assert.equal(((await call('caisse.mine', karim, {})) as any).balance, me.balance);
  await assert.rejects(call('caisse.overview', karim, {}), /Accès refusé/);
});
