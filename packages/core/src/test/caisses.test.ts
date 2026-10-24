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

test('the owner creates his own caisses, uses them, renames them and removes them (money moved first)', async () => {
  const admin = await as(EMAILS.admin);
  const c: any = await call('caisse.create', admin, { name: 'Coffre', kind: 'cash' });
  assert.match(c.key, /^c\d+$/);
  await assert.rejects(call('caisse.create', admin, { name: 'coffre' }), /existe déjà/);
  const list: any = await call('caisse.list', admin, {});
  assert.ok(list.some((x: any) => x.key === c.key && x.name === 'Coffre'));
  await call('caisse.add', admin, { caisse: c.key, kind: 'income', amount: 5000, note: 'fond de caisse' });
  assert.equal(await bal(admin, c.key), 5000);
  await call('caisse.rename', admin, { key: c.key, name: 'Coffre dépôt' });
  const ov: any = await call('caisse.overview', admin, {});
  assert.ok(ov.caisses.some((x: any) => x.key === c.key && x.name === 'Coffre dépôt' && x.balance === 5000));
  await assert.rejects(call('caisse.remove', admin, { key: c.key }), /choisissez où mettre/);
  const main0 = await bal(admin, 'main');
  const r: any = await call('caisse.remove', admin, { key: c.key, moveTo: 'main' });
  assert.equal(r.moved, 5000);
  assert.equal(await bal(admin, 'main'), main0 + 5000);
  await assert.rejects(call('caisse.add', admin, { caisse: c.key, kind: 'income', amount: 10 }), /supprimée/);
  const set: any = await call('caisse.settings', admin, {});
  assert.ok(!set.caisses.some((x: any) => x.key === c.key));
  // employees cannot manage caisses
  await assert.rejects(call('caisse.create', await as(EMAILS.depot), { name: 'X caisse' }), /Accès refusé/);
});

test('a shop that does not use a bank removes it, and can put it back', async () => {
  const admin = await as(EMAILS.admin);
  const left = await bal(admin, 'bank');
  await call('caisse.remove', admin, { key: 'bank', moveTo: left ? 'main' : undefined });
  const list: any = await call('caisse.list', admin, {});
  assert.ok(!list.some((x: any) => x.key === 'bank'));
  const ov: any = await call('caisse.overview', admin, {});
  assert.equal(ov.bank, null);
  await assert.rejects(call('caisse.add', admin, { caisse: 'bank', kind: 'income', amount: 10 }), /supprimée/);
  await call('caisse.restoreBank', admin, {});
  assert.ok(((await call('caisse.list', admin, {})) as any).some((x: any) => x.key === 'bank'));
});
