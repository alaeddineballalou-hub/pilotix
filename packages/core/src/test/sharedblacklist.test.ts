// « Liste noire partagée »: a number one of the seller's boutiques blacklists by hand is blacklisted in all their
// boutiques (a line on the open orders there), never in another seller's; taken off the list, it leaves the others only
// where it came from this boutique; the automatic list stays each boutique's own; « Partager toute la liste » sends the
// numbers blocked before.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, Ctx, login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, shopCtx, shopStatus, staffLogin, Tenancy } from '../index';
import { loadShop, passwordFromLink } from '../platform';

const OWNER = { email: 'owner@platform.dz', password: 'Owner-Password-1' };
const PW = 'Boutique-Password-1';
const KARIM = 'karim@shops.dz';
const NADIA = 'nadia@other.dz';

async function as(t: Tenancy, shopId: number, email: string): Promise<Ctx> {
  const s = (await loadShop(t, { id: shopId }))!;
  const db = t.shop(s.schema);
  return { db, session: await login(db, email, PW), now: () => Date.now(), emit: () => {}, shop: shopCtx(s, shopStatus(s, Date.now(), 3)), t };
}

test('a number blacklisted by hand in one boutique is blacklisted in all the boutiques of its owner', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  const pctx: PCtx = { t, staff, now: () => Date.now() };
  const p = (name: string, input: unknown = {}) => platformCall(name, pctx, input) as Promise<any>;
  const biz = (await p('p.plans.list')).find((x: any) => x.code === 'business');

  // Karim's two boutiques, and Nadia's (another seller)
  const shops: { id: number; db: any; product: number }[] = [];
  for (const [name, email] of [['Bébé Shop', KARIM], ['Maison Shop', KARIM], ['Sport Nadia', NADIA]]) {
    const made = await p('p.shops.create', { name, ownerName: name, ownerEmail: email, planId: biz.id, trialDays: 14 });
    if (made.mail?.token) await passwordFromLink(t, made.mail.token, PW);
    const s = (await loadShop(t, { id: made.id }))!;
    const db = t.shop(s.schema);
    const pid = Number((await db.query(`INSERT INTO products (name, sku, price) VALUES ('Article', 'ART-1', 5000) RETURNING id`))[0].id);
    shops.push({ id: s.id, db, product: pid });
  }
  const [A, B, C] = shops;
  const inA = await as(t, A.id, KARIM);
  const inB = await as(t, B.id, KARIM);
  const inC = await as(t, C.id, NADIA);
  const order = (c: Ctx, pid: number, phone: string) => call('orders.create', c, { customerName: 'Rachid', phone, wilayaId: 16, commune: 'Kouba', address: 'Rue 1', items: [{ productId: pid, variantId: null, qty: 1 }] }) as Promise<any>;
  const X = '0770000011';
  const Y = '0770000022';
  const Z = '0770000033';
  const oA = await order(inA, A.product, X);
  const oB = await order(inB, B.product, X);
  await order(inC, C.product, X);
  const cust = async (db: any, phone: string) => {
    const c = (await db.query('SELECT blacklisted, blacklist_reason, blacklist_auto, blacklist_shop FROM customers WHERE phone = $1', [phone]))[0];
    return c && { on: c.blacklisted, reason: c.blacklist_reason, auto: c.blacklist_auto, shop: c.blacklist_shop === null ? null : Number(c.blacklist_shop) };
  };
  const notes = async (db: any, orderId: number) => (await db.query(`SELECT note FROM order_events WHERE order_id = $1 AND kind = 'note' ORDER BY id`, [orderId])).map((r: any) => r.note);

  // blocked in Bébé Shop: Maison Shop too (a line on its open order), never Nadia's boutique
  const r: any = await call('customers.setBlacklist', inA, { phone: X, on: true, reason: 'Fausse commande' });
  assert.deepEqual(r.shared, ['Maison Shop']);
  assert.deepEqual(await cust(B.db, X), { on: true, reason: 'Fausse commande · Bébé Shop', auto: false, shop: A.id });
  assert.ok((await notes(B.db, oB.id)).includes('Client mis en liste noire dans Bébé Shop : Fausse commande'));
  assert.equal((await cust(C.db, X)).on, false);
  assert.deepEqual(await cust(A.db, X), { on: true, reason: 'Fausse commande', auto: false, shop: null });
  // a new order of that number in Maison Shop arrives « À vérifier »
  const again: any = await order(inB, B.product, X);
  assert.equal((await call('orders.get', inB, { id: again.id }) as any).confStatus, 'to_check');

  // a number that never ordered in Maison Shop: a customer is made there, on the list
  await A.db.query(`INSERT INTO customers (phone, name, wilaya_id) VALUES ($1, 'Yacine', 31)`, [Y]);
  await call('customers.setBlacklist', inA, { phone: Y, on: true });
  assert.deepEqual(await cust(B.db, Y), { on: true, reason: 'Liste noire de Bébé Shop', auto: false, shop: A.id });

  // Maison Shop's own decision stays its own: not replaced, not taken off by Bébé Shop
  await B.db.query(`INSERT INTO customers (phone, name) VALUES ($1, 'Zaki')`, [Z]);
  await A.db.query(`INSERT INTO customers (phone, name) VALUES ($1, 'Zaki')`, [Z]);
  await call('customers.setBlacklist', inB, { phone: Z, on: true, reason: 'Insultes' });
  assert.equal((await cust(A.db, Z)).shop, B.id);
  await call('customers.setBlacklist', inA, { phone: Z, on: true, reason: 'Faux numéro' });
  assert.deepEqual(await cust(B.db, Z), { on: true, reason: 'Insultes', auto: false, shop: null });
  await call('customers.setBlacklist', inA, { phone: Z, on: false });
  assert.equal((await cust(B.db, Z)).on, true);
  assert.equal((await cust(A.db, Z)).on, false);

  // taken off in Bébé Shop: off in Maison Shop (it came from there), a line on the open order
  const off: any = await call('customers.setBlacklist', inA, { phone: X, on: false });
  assert.deepEqual(off.shared, ['Maison Shop']);
  assert.deepEqual(await cust(B.db, X), { on: false, reason: null, auto: false, shop: null });
  assert.ok((await notes(B.db, oB.id)).includes('Client retiré de la liste noire dans Bébé Shop'));
  // taken off in Maison Shop (a copy from Bébé Shop): Bébé Shop's own decision stays
  await call('customers.setBlacklist', inB, { phone: Y, on: false });
  assert.equal((await cust(B.db, Y)).on, false);
  assert.equal((await cust(A.db, Y)).on, true);

  // « Bloquer le client » from an order: shared too
  const blk: any = await call('confirmation.block', inA, { ids: [oA.id], reason: 'Commande pour rire' });
  assert.deepEqual(blk.shared, ['Maison Shop']);
  assert.deepEqual(await cust(B.db, X), { on: true, reason: 'Commande pour rire · Bébé Shop', auto: false, shop: A.id });

  // the automatic list (parcels refused) stays each boutique's own; « Partager toute la liste »: the numbers blocked before
  const W = '0770000044';
  const V = '0770000055';
  await A.db.query(`INSERT INTO customers (phone, name, blacklisted, blacklist_reason) VALUES ($1, 'Walid', true, 'Ancien blocage')`, [W]);
  await A.db.query(`INSERT INTO customers (phone, name, blacklisted, blacklist_auto, blacklist_reason) VALUES ($1, 'Victor', true, true, 'Colis refusés')`, [V]);
  const info: any = await call('customers.shareInfo', inA, {});
  assert.deepEqual(info.shops, ['Maison Shop']);
  assert.equal(info.own, 3); // X (blocked from the order), Y, W — not Z (taken off), not V (automatic)
  const all: any = await call('customers.shareAll', inA, {});
  assert.equal(all.numbers, 3);
  assert.deepEqual(all.shops, ['Maison Shop']);
  assert.deepEqual(await cust(B.db, W), { on: true, reason: 'Ancien blocage · Bébé Shop', auto: false, shop: A.id });
  assert.equal(await cust(B.db, V), undefined);
  // Nadia's boutique: nothing of Karim's list
  assert.equal(Number((await C.db.query('SELECT count(*)::int AS n FROM customers WHERE blacklisted'))[0].n), 0);
  // Nadia shares with nobody (one boutique)
  assert.deepEqual(((await call('customers.shareInfo', inC, {})) as any).shops, []);
});
