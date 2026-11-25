// The agency's orders are the agency's, never one person's (the owner's rule, 25 Nov 2026). A new owner of the agency,
// Pilotix taking back its « Vérifier » and giving it again, or suspending and reactivating it: every order still to
// call stays with the agency and with its agent. Only the contract decides: when it ends, they go back to the store.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, Ctx, login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, shopCtx, shopStatus, staffLogin, Tenancy } from '../index';
import { attachProfile, confirmSignup, loadShop, passwordFromLink, startSignup } from '../platform';

let phoneN = 0;
const tph = () => `072${String(++phoneN).padStart(7, '0')}`;
const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const PW = 'Agence-Password-1';
const PRICES = { perConfirmed: 0, perDelivered: 150, perUpsell: 50, monthly: 0, bonusRate: { min: 70, amount: 20 }, bonusVolume: { above: 0, amount: 0 } };

async function server() {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  const pctx: PCtx = { t, staff, now: () => Date.now() };
  const p = <T = any>(name: string, input: unknown = {}) => platformCall(name, pctx, input) as Promise<T>;
  return { t, p };
}

async function as(t: Tenancy, shopId: number, email: string, password: string): Promise<Ctx> {
  const s = (await loadShop(t, { id: shopId }))!;
  const db = t.shop(s.schema);
  return { db, session: await login(db, email, password), now: () => Date.now(), emit: () => {}, shop: shopCtx(s, shopStatus(s, Date.now(), 3)), t };
}

test('a new owner, « Vérifier » taken back, a suspension: the agency keeps its orders, each with its agent', async () => {
  const { t, p } = await server();
  const biz = (await p('p.plans.list')).find((x: any) => x.code === 'business');
  const made = await p('p.shops.create', { name: 'Boutique Bébé', ownerName: 'Karim', ownerEmail: 'seller-keep@example.dz', planId: biz.id, trialDays: 14 });
  if (made.mail?.token) await passwordFromLink(t, made.mail.token, PW);
  const s = (await loadShop(t, { id: made.id }))!;
  const sdb = t.shop(s.schema);
  await sdb.query(`INSERT INTO products (name, sku, price) VALUES ('Pouf', 'POUF', 2300)`);
  const product = Number((await sdb.query('SELECT id FROM products LIMIT 1'))[0].id);

  const mail = await startSignup(t, { name: 'Hamza', email: 'old-chief@closer.dz', phone: tph(), password: PW, storeName: 'The Closer', language: 'fr', terms: true, kind: 'agency' }, null);
  const ag: any = await confirmSignup(t, (mail as any).token);
  const A = Number(ag.shop.id);
  await p('p.agencies.verify', { id: A, verified: true });
  const chief = await as(t, A, 'old-chief@closer.dz', PW);
  const seller = await as(t, s.id, 'seller-keep@example.dz', PW);
  await call('agency.prices', chief, { prices: PRICES });
  const link = (await call('partners.request', seller, { agencyId: A, tasks: ['confirmation', 'suivi'], products: null })) as { id: number };
  await call('agency.answer', chief, { id: link.id, accept: true });
  // a chef d'équipe (the next owner) and a confirmation agent
  const lead: any = await call('users.create', chief, { phone: tph(), name: 'Rayan', email: 'rayan@closer.dz', password: PW, roles: ['agent_manager', 'confirmation', 'suivi'] });
  await attachProfile(t, ag.shop.schema, lead.id);
  const agent: any = await call('users.create', chief, { phone: tph(), name: 'Belkis', email: 'belkis@closer.dz', password: PW, roles: ['confirmation'] });
  await attachProfile(t, ag.shop.schema, agent.id);

  const newOrder = async (phone: string) =>
    (await call('orders.create', seller, { customerName: 'Client', phone, wilayaId: 31, commune: 'Oran', items: [{ productId: product, variantId: null, qty: 1 }] })) as { id: number; confAgencyId: number | null };
  const o1 = await newOrder('0661000001');
  const o2 = await newOrder('0661000002');
  const free = await newOrder('0661000003');
  assert.deepEqual([o1.confAgencyId, o2.confAgencyId, free.confAgencyId], [A, A, A]);
  const belkisHere = Number((await sdb.query(`SELECT id FROM profiles WHERE email = 'belkis@closer.dz'`))[0].id);
  await call('orders.assignAgent', { ...chief, seller: s.id }, { ids: [o1.id, o2.id], agentId: belkisHere });
  // Belkis called o2: « Pas de réponse »
  await sdb.query(`UPDATE orders SET conf_status = 'no_answer', attempts = 1 WHERE id = $1`, [o2.id]);

  const held = async () =>
    (await sdb.query('SELECT id, conf_agency_id, agent_id FROM orders WHERE id = ANY($1) ORDER BY id', [[o1.id, o2.id, free.id]])).map((r: any) => [
      Number(r.id),
      r.conf_agency_id === null ? null : Number(r.conf_agency_id),
      r.agent_id === null ? null : Number(r.agent_id),
    ]);
  const asBefore = [
    [o1.id, A, belkisHere],
    [o2.id, A, belkisHere],
    [free.id, A, null],
  ];
  const active = async (email: string) => (await sdb.query('SELECT active FROM profiles WHERE email = $1', [email]))[0]?.active;

  // the agency moves to its chef d'équipe: nothing moves in the store
  await p('p.shops.setOwner', { id: A, email: 'rayan@closer.dz' });
  assert.deepEqual(await held(), asBefore, 'a new owner moves no order');
  assert.equal((await newOrder('0661000004')).confAgencyId, A);

  // Pilotix takes its « Vérifier » back: Belkis stops at once, her orders wait for her; new orders stay with the store
  await p('p.agencies.verify', { id: A, verified: false });
  assert.equal(await active('belkis@closer.dz'), false);
  assert.deepEqual(await held(), asBefore, 'a pause moves no order');
  assert.equal((await newOrder('0661000005')).confAgencyId, null);
  // and gives it again: Belkis is back with the same account, her orders are hers
  await p('p.agencies.verify', { id: A, verified: true });
  assert.equal(await active('belkis@closer.dz'), true);
  assert.equal(Number((await sdb.query(`SELECT id FROM profiles WHERE email = 'belkis@closer.dz'`))[0].id), belkisHere);
  assert.deepEqual(await held(), asBefore);
  assert.equal((await newOrder('0661000006')).confAgencyId, A);

  // suspended, then active again: the same
  await p('p.shops.setStatus', { id: A, status: 'suspended', reason: 'test' });
  assert.deepEqual(await held(), asBefore, 'a suspension moves no order');
  await p('p.shops.setStatus', { id: A, status: 'active' });
  assert.deepEqual(await held(), asBefore);

  // closed for good (archived): its orders still to call come back to the store's team
  await p('p.shops.setStatus', { id: A, status: 'archived', reason: 'test' });
  const back = [
    [o1.id, null, null],
    [o2.id, null, null],
    [free.id, null, null],
  ];
  assert.deepEqual(await held(), back);
  await p('p.shops.setStatus', { id: A, status: 'active' });
  assert.deepEqual(await held(), back, 'they stay with the store when it comes back');

  // and the contract: the store ends it, its orders still to call come back to the store's team
  const o3 = await newOrder('0661000007');
  assert.equal(o3.confAgencyId, A);
  await call('partners.end', seller, { id: link.id });
  assert.deepEqual((await sdb.query('SELECT conf_agency_id, agent_id FROM orders WHERE id = $1', [o3.id]))[0], { conf_agency_id: null, agent_id: null });
});
