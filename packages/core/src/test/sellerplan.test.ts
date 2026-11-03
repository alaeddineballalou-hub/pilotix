// One plan per seller: a plan says how many boutiques its seller may have; the seller's first boutique holds the plan
// and the payments, their other boutiques follow it (plan, period, lock, limits); the people of all their boutiques take
// the plan's places together (each e-mail once), their orders are added up; a payment, a trial asked on another
// boutique go to the first one; when the first one closes, the next one takes the plan and the period on.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, Ctx, login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, shopCtx, shopStatus, staffLogin, Tenancy } from '../index';
import { accountByEmail, addStore, deleteStoreByOwner, loadShop, passwordFromLink, platformSettings, shopInfoExtra, takeDueReminders } from '../platform';

const OWNER = { email: 'owner@platform.dz', password: 'Owner-Password-1' };
const PW = 'Boutique-Password-1';
const KARIM = 'karim@shops.dz';

async function as(t: Tenancy, shopId: number, email: string): Promise<Ctx> {
  const s = (await loadShop(t, { id: shopId }))!;
  const db = t.shop(s.schema);
  return { db, session: await login(db, email, PW), now: () => Date.now(), emit: () => {}, shop: shopCtx(s, shopStatus(s, Date.now(), 3)), t };
}

test('one plan per seller: boutiques per plan, one payment, places and orders counted together', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  const pctx: PCtx = { t, staff, now: () => Date.now() };
  const p = (name: string, input: unknown = {}) => platformCall(name, pctx, input) as Promise<any>;

  // the plans made at the start have their number of boutiques
  const plans = await p('p.plans.list');
  assert.deepEqual(Object.fromEntries(plans.map((x: any) => [x.code, x.maxStores])), { interne: 100, essentiel: 1, pro: 3, business: 10 });
  // a small plan: 2 boutiques, 4 people, 1 livreur, 5 orders a month
  const { id: planId } = await p('p.plans.save', { name: 'Duo', priceMonth: 5000, features: ['*'], maxUsers: 4, maxDrivers: 1, maxOrdersMonth: 5, maxStores: 2, public: true, active: true });

  // Karim's first boutique, on that plan
  const made = await p('p.shops.create', { name: 'Bébé Shop', ownerName: 'Karim', ownerEmail: KARIM, planId, trialDays: 14 });
  if (made.mail?.token) await passwordFromLink(t, made.mail.token, PW);
  await t.platform.query('UPDATE platform.accounts SET email_verified_at = now() WHERE email = $1', [KARIM]);
  const A = (await loadShop(t, { id: made.id }))!;
  assert.equal(A.mainShopId, null);
  const karim = (await accountByEmail(t, KARIM))!;

  // his second boutique follows the first one: its plan and its trial, no new trial
  const B0 = await addStore(t, karim, { name: 'Maison Shop' });
  const B = (await loadShop(t, { id: B0.id }))!;
  assert.equal(B.mainShopId, A.id);
  assert.equal(B.mainShopName, 'Bébé Shop');
  assert.equal(B.planId, planId);
  assert.equal(B.trialEndsAt, A.trialEndsAt);
  // a third one: over the plan's 2 boutiques
  await assert.rejects(addStore(t, karim, { name: 'Sport Shop' }), /2 boutiques.*maximum de votre formule/);
  const set = await platformSettings(t);
  const infoB = await shopInfoExtra(t, B, KARIM, set);
  assert.deepEqual([infoB.ownStores, infoB.maxStores, infoB.canAddStore], [2, 2, false]);

  // a payment asked on the second boutique is the seller's: recorded on the first one, both are paid
  const pay = await p('p.payments.add', { shopId: B.id, amount: 5000, method: 'cash', months: 1 });
  assert.deepEqual(pay.main, { id: A.id, name: 'Bébé Shop' });
  const A1 = (await loadShop(t, { id: A.id }))!;
  const B1 = (await loadShop(t, { id: B.id }))!;
  assert.ok(A1.paidUntil && A1.paidUntil === pay.paidUntil);
  assert.equal(B1.paidUntil, A1.paidUntil);
  assert.equal(Number((await t.platform.query('SELECT count(*)::int AS n FROM platform.payments WHERE shop_id = $1', [A.id]))[0].n), 1);
  // the plan and the dates are changed on the first boutique only
  await assert.rejects(p('p.shops.update', { id: B.id, planId }), /suit l’abonnement de « Bébé Shop »/);
  // more trial asked on the second: the first one's
  const tr = await p('p.shops.extendTrial', { id: B.id, days: 5 });
  assert.equal((await loadShop(t, { id: A.id }))!.trialEndsAt, tr.trialEndsAt);

  // places: Karim in both boutiques is one; Samira in both is one; Hana and Lamine (livreur) make 4; a 5th is refused
  const inA = await as(t, A.id, KARIM);
  const inB = await as(t, B.id, KARIM);
  const person = (name: string, email: string, phone: string, roles = ['confirmation']) => ({ name, email, phone, password: 'Person-Password-1', roles, language: 'fr' });
  await call('users.create', inA, person('Samira', 'samira@shops.dz', '0661000001'));
  await call('users.create', inB, person('Samira', 'samira@shops.dz', '0661000001'));
  await call('users.create', inB, person('Hana', 'hana@shops.dz', '0661000002'));
  await call('users.create', inA, person('Lamine', 'lamine@shops.dz', '0661000004', ['livreur']));
  await assert.rejects(call('users.create', inA, person('Lina', 'lina@shops.dz', '0661000003')), /4 comptes actifs pour toutes vos boutiques/);
  // livreurs: one for the seller (Samira made livreur in the second boutique is refused)
  const samiraB = Number((await inB.db.query(`SELECT id FROM profiles WHERE email = 'samira@shops.dz'`))[0].id);
  await assert.rejects(call('users.update', inB, { id: samiraB, roles: ['confirmation', 'livreur'] }), /1 livreur actif pour toutes vos boutiques/);
  // the seller's numbers: the orders of both boutiques count
  const pid = async (c: Ctx) => Number((await c.db.query(`INSERT INTO products (name, sku, price) VALUES ('Article', 'ART-${c.shop!.id}', 5000) RETURNING id`))[0].id);
  const pA = await pid(inA);
  const pB = await pid(inB);
  const order = (c: Ctx, product: number, phone: string) => call('orders.create', c, { customerName: 'Client', phone, wilayaId: 16, commune: 'Kouba', address: 'Rue 1', items: [{ productId: product, variantId: null, qty: 1 }] });
  await order(inA, pA, '0770000001');
  await order(inA, pA, '0770000002');
  await order(inB, pB, '0770000003');
  assert.equal((await shopInfoExtra(t, (await loadShop(t, { id: A.id }))!, KARIM, set)).ordersMonth, 3);
  assert.equal((await shopInfoExtra(t, (await loadShop(t, { id: B.id }))!, KARIM, set)).ordersMonth, 3);
  // the control room: the first boutique carries the seller's numbers; the other one is never « over » by itself
  const rows = await p('p.shops.list');
  const rowA = rows.find((r: any) => r.id === A.id);
  const rowB = rows.find((r: any) => r.id === B.id);
  assert.equal(rowA.usage.ordersMonth, 3);
  assert.equal(rowA.usage.users, 4);
  assert.equal(rowA.usage.drivers, 1);
  assert.deepEqual(rowB.main, { id: A.id, name: 'Bébé Shop' });
  assert.equal(rowB.limits.over.users, false);
  const detail = await p('p.shops.get', { id: B.id });
  assert.deepEqual(detail.sellerShops.map((x: any) => [x.name, x.main, x.current]), [
    ['Bébé Shop', true, false],
    ['Maison Shop', false, true],
  ]);
  // the dashboard counts a seller once
  const dash = await p('p.dashboard');
  assert.equal(dash.counts.linked, 1);
  assert.equal(dash.counts.total, 1);
  // the plans: one seller on « Duo »
  assert.equal((await p('p.plans.list')).find((x: any) => x.id === planId).shops, 1);

  // the first boutique suspended: the seller's other one is locked too; back on, both work
  await p('p.shops.setStatus', { id: A.id, status: 'suspended', reason: 'Impayé' });
  const Bs = (await loadShop(t, { id: B.id }))!;
  assert.equal(shopStatus(Bs, Date.now(), 3).locked, true);
  await p('p.shops.setStatus', { id: A.id, status: 'active' });
  assert.equal(shopStatus((await loadShop(t, { id: B.id }))!, Date.now(), 3).locked, false);

  // reminders: the seller's first boutique only
  await t.platform.query(`UPDATE platform.shops SET paid_until = now() + interval '2 days' WHERE id = $1`, [A.id]);
  const due = await takeDueReminders(t);
  assert.deepEqual(due.filter((r) => r.shopId === A.id || r.shopId === B.id).map((r) => r.shopId), [A.id]);

  // the first boutique deleted by its owner: the second one holds the plan and the period now
  const paidUntil = (await loadShop(t, { id: A.id }))!.paidUntil;
  await deleteStoreByOwner(t, karim, A.id, PW, 'Bébé Shop');
  const B2 = (await loadShop(t, { id: B.id }))!;
  assert.equal(B2.mainShopId, null);
  assert.equal(B2.planId, planId);
  assert.equal(B2.paidUntil, paidUntil);
  assert.equal(shopStatus(B2, Date.now(), 3).locked, false);
});
