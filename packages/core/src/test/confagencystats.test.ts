// Confirmation › Statistiques of a confirmation agency (owner's choice, 28 Nov 2026: « always when we build statistics we
// build them for all views »): its chief and its chefs d'équipe see the agency's numbers — one seller, or « Tous les
// vendeurs » with each agent once (his id in the agency, the same in every store) and each seller side by side; a plain
// agent never sees them, nor a store's own agent; the store's owner keeps one line for the agency (its agents private).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, Ctx, login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, shopCtx, shopStatus, staffLogin, Tenancy } from '../index';
import { confirmSignup, loadShop, passwordFromLink, startSignup } from '../platform';
import { createOrder } from '../modules/orders';

let phoneN = 0;
const tph = () => `073${String(++phoneN).padStart(7, '0')}`;
const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const PW = 'Agence-Password-1';
const PRICES = { perConfirmed: 0, perDelivered: 150, perUpsell: 50, monthly: 0, bonusRate: { min: 70, amount: 20 }, bonusVolume: { above: 0, amount: 0 } };

async function server() {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  const t = pgliteTenancy(pg as any);
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

async function store(t: Tenancy, p: (n: string, i?: unknown) => Promise<any>, name: string, email: string) {
  const biz = (await p('p.plans.list')).find((x: any) => x.code === 'business');
  const made = await p('p.shops.create', { name, ownerName: 'Karim', ownerEmail: email, planId: biz.id, trialDays: 14 });
  await passwordFromLink(t, made.mail.token, PW);
  const s = (await loadShop(t, { id: made.id }))!;
  const db = t.shop(s.schema);
  await db.query(`INSERT INTO products (name, sku, price) VALUES ('Vélo', 'VELO', 9000), ('Poussette', 'POUS', 12000)`);
  const ids = (await db.query('SELECT id, sku FROM products ORDER BY id')).reduce((m: Record<string, number>, r: any) => ({ ...m, [r.sku]: Number(r.id) }), {});
  // one variant each, in stock: a confirmed order stays « Confirmée » (not « Sans stock »)
  const wh = Number((await db.query('SELECT id FROM warehouses WHERE active ORDER BY is_default DESC, id LIMIT 1'))[0].id);
  const variants: Record<number, number> = {};
  for (const [sku, pid] of Object.entries(ids)) {
    const v = Number((await db.query(`INSERT INTO product_variants (product_id, title, sku) VALUES ($1, 'Unique', $2) RETURNING id`, [pid, `${sku}-U`]))[0].id);
    await db.query('INSERT INTO stock (variant_id, warehouse_id, qty) VALUES ($1, $2, 100)', [v, wh]);
    variants[pid as number] = v;
  }
  return { id: s.id, db, email, products: ids as Record<'VELO' | 'POUS', number>, variants };
}

async function agency(t: Tenancy, name: string, email: string) {
  const mail = await startSignup(t, { name: 'Samir', email, phone: tph(), password: PW, storeName: name, language: 'fr', terms: true, kind: 'agency' }, null);
  const made: any = await confirmSignup(t, (mail as any).token);
  return { id: made.shop.id as number, schema: made.shop.schema as string };
}

const order = (ctx: Ctx, s: { products: Record<'VELO' | 'POUS', number>; variants: Record<number, number> }, sku: 'VELO' | 'POUS', phone: string) =>
  createOrder(ctx, { customerName: 'Client', phone, wilayaId: 31, commune: 'Oran', address: '', isStopdesk: false, channel: 'landing', items: [{ productId: s.products[sku], variantId: s.variants[s.products[sku]], qty: 1 }], discount: 0, confirm: false, isExchange: false } as any, ctx.db, { came: 'form' }) as Promise<any>;

test('an agency’s chief and chefs d’équipe: Nouvelles, En cours and Confirmées stats, one seller or every seller', async () => {
  const { t, p } = await server();
  const oran = await store(t, p, 'Boutique Oran', 'karim@oran.dz');
  const alger = await store(t, p, 'Boutique Alger', 'lyes@alger.dz');
  const ag = await agency(t, 'The Closer', 'samir@closer.dz');
  await p('p.agencies.verify', { id: ag.id, verified: true });
  const chief = await as(t, ag.id, 'samir@closer.dz', PW);
  await call('agency.prices', chief, { prices: PRICES });
  for (const s of [oran, alger]) {
    const admin = await as(t, s.id, s.email, PW);
    const { id: linkId } = (await call('partners.request', admin, { agencyId: ag.id, tasks: ['confirmation'], products: null })) as any;
    await call('agency.answer', chief, { id: linkId, accept: true });
  }
  await call('users.create', chief, { phone: tph(), name: 'Hakim', email: 'hakim@closer.dz', password: PW, roles: ['agent_manager'] });
  const noraAg: any = await call('users.create', chief, { phone: tph(), name: 'Nora', email: 'nora@closer.dz', password: PW, roles: ['confirmation'] });
  const raniaAg: any = await call('users.create', chief, { phone: tph(), name: 'Rania', email: 'rania@closer.dz', password: PW, roles: ['confirmation'] });
  const oranAdmin = await as(t, oran.id, oran.email, PW);
  const algerAdmin = await as(t, alger.id, alger.email, PW);
  await call('users.create', oranAdmin, { phone: tph(), name: 'Samia', email: 'samia@oran.dz', password: PW, roles: ['confirmation'] });
  const here = async (s: { db: any }, email: string) => Number((await s.db.query('SELECT id FROM profiles WHERE email = $1', [email]))[0].id);

  // 2 orders in Oran, 1 in Alger: all the agency's (landing pages); Nora has o1 and o3, Rania o2
  const o1 = await order(oranAdmin, oran, 'VELO', '0661000101');
  const o2 = await order(oranAdmin, oran, 'POUS', '0661000102');
  const o3 = await order(algerAdmin, alger, 'VELO', '0661000103');
  assert.deepEqual([o1.confAgencyId, o2.confAgencyId, o3.confAgencyId], [ag.id, ag.id, ag.id]);
  const inOran = (c: Ctx): Ctx => ({ ...c, seller: oran.id });
  const inAlger = (c: Ctx): Ctx => ({ ...c, seller: alger.id });
  const every = (c: Ctx): Ctx => ({ ...c, seller: 'all' });
  await call('orders.assignAgent', inOran(chief), { ids: [o1.id], agentId: await here(oran, 'nora@closer.dz') });
  await call('orders.assignAgent', inOran(chief), { ids: [o2.id], agentId: await here(oran, 'rania@closer.dz') });
  await call('orders.assignAgent', inAlger(chief), { ids: [o3.id], agentId: await here(alger, 'nora@closer.dz') });
  // the first calls: Nora confirms o1 and o3; Rania gets no answer on o2 (it goes to En cours)
  const nora = await as(t, ag.id, 'nora@closer.dz', PW);
  const rania = await as(t, ag.id, 'rania@closer.dz', PW);
  await call('orders.setConf', inOran(nora), { ids: [o1.id], status: 'confirmed' });
  await call('orders.setConf', inAlger(nora), { ids: [o3.id], status: 'confirmed' });
  await call('orders.setConf', inOran(rania), { ids: [o2.id], status: 'no_answer' });

  // ---- Nouvelles, one seller: the agency's numbers there, each agent by his id in the agency
  const nvOran: any = await call('confirmation.nouvelles', inOran(chief), {});
  assert.equal(nvOran.agency, true);
  assert.equal(nvOran.director, false);
  assert.equal(nvOran.today.received, 2);
  assert.equal(nvOran.today.called, 2);
  assert.equal(nvOran.today.converted, 1);
  assert.deepEqual(nvOran.agents.map((a: any) => [a.name, a.id, a.called]).sort(), [['Nora', noraAg.id, 1], ['Rania', raniaAg.id, 1]]);
  assert.deepEqual(nvOran.perAgent && [nvOran.perAgent.orders, nvOran.perAgent.agents], [2, 2]);
  assert.equal(nvOran.sellers, null, 'one seller: no « Par vendeur »');
  // a chef d'équipe sees the same (the agency is one team)
  const hakim = await as(t, ag.id, 'hakim@closer.dz', PW);
  const nvHakim: any = await call('confirmation.nouvelles', inOran(hakim), {});
  assert.deepEqual(nvHakim.agents.map((a: any) => a.id).sort(), nvOran.agents.map((a: any) => a.id).sort());

  // ---- Nouvelles, every seller: added up, Nora once (her two calls), each seller side by side, the median again
  const nv: any = await call('confirmation.nouvelles', every(chief), {});
  assert.equal(nv.today.received, 3);
  assert.equal(nv.today.called, 3);
  assert.equal(nv.today.converted, 2);
  assert.equal(typeof nv.today.median, 'number');
  assert.equal(nv.today.ds, undefined, 'the minutes stay on the server');
  const noraLine = nv.agents.find((a: any) => a.id === noraAg.id);
  assert.deepEqual([noraLine?.name, noraLine?.called, noraLine?.converted], ['Nora', 2, 2]);
  assert.equal(nv.agents.length, 2);
  assert.deepEqual(nv.sellers.map((s: any) => [s.name, s.id, s.received, s.called]).sort(), [['Boutique Alger', alger.id, 1, 1], ['Boutique Oran', oran.id, 2, 2]]);
  assert.deepEqual([nv.allSellers.received, nv.allSellers.called, nv.allSellers.agents], [3, 3, 2], 'Nora counts once over the two sellers');
  assert.deepEqual([nv.perAgent.orders, nv.perAgent.agents], [3, 2]);

  // ---- En cours: o2 waits for its next call (Oran)
  const ec: any = await call('confirmation.enCours', every(chief), {});
  assert.equal(ec.live.inProgress, 1);
  assert.deepEqual(ec.sellers.map((s: any) => [s.name, s.inProgress]).sort(), [['Boutique Alger', 0], ['Boutique Oran', 1]]);
  assert.equal(ec.allSellers.inProgress, 1);
  const ecOran: any = await call('confirmation.enCours', inOran(chief), {});
  assert.equal(ecOran.live.inProgress, 1);
  assert.equal(ecOran.agency, true);

  // ---- Confirmées: per agent (each once), per seller, per product (named with its seller), one agent
  const KF = { per: '30', basis: 'created' } as const;
  const cf: any = await call('confirmation.confirmees', every(chief), { ...KF });
  assert.equal(cf.bySeller, true);
  assert.deepEqual([cf.sum.leads, cf.sum.confirmed], [3, 2]);
  assert.deepEqual(cf.table.filter((r: any) => r.kind !== 'none').map((r: any) => [r.name, r.leads, r.confirmed]).sort(), [['Nora', 2, 2], ['Rania', 1, 0]]);
  assert.deepEqual(cf.agents.map((a: any) => a.id).sort(), [noraAg.id, raniaAg.id].sort());
  assert.deepEqual([cf.perAgent.leads, cf.perAgent.agents], [3, 2]);
  const bySeller: any = await call('confirmation.confirmees', every(chief), { ...KF, by: 'seller' });
  assert.equal(bySeller.by, 'seller');
  assert.deepEqual(bySeller.table.map((r: any) => [r.name, r.id, r.leads]).sort(), [['Boutique Alger', alger.id, 1], ['Boutique Oran', oran.id, 2]]);
  const byProduct: any = await call('confirmation.confirmees', every(chief), { ...KF, by: 'product' });
  assert.deepEqual(byProduct.table.map((r: any) => r.name).sort(), ['Poussette · Boutique Oran', 'Vélo · Boutique Alger', 'Vélo · Boutique Oran']);
  assert.deepEqual(byProduct.products, [], 'a product is one seller’s: its filter needs one seller');
  const onlyNora: any = await call('confirmation.confirmees', every(chief), { ...KF, agent: noraAg.id });
  assert.deepEqual([onlyNora.sum.leads, onlyNora.sum.confirmed, onlyNora.by], [2, 2, 'product']);
  const cfOran: any = await call('confirmation.confirmees', inOran(chief), { ...KF, agent: noraAg.id });
  assert.deepEqual([cfOran.sum.leads, cfOran.bySeller], [1, false]);

  // ---- never a plain agent of the agency, never the store's own agent
  for (const name of ['confirmation.nouvelles', 'confirmation.enCours', 'confirmation.confirmees'] as const) {
    await assert.rejects(call(name, inOran(nora), name === 'confirmation.confirmees' ? KF : {}), /chef de l’agence et à ses chefs d’équipe/);
    await assert.rejects(call(name, every(nora), name === 'confirmation.confirmees' ? KF : {}), /chef de l’agence et à ses chefs d’équipe/);
    await assert.rejects(call(name, await as(t, oran.id, 'samia@oran.dz', PW), name === 'confirmation.confirmees' ? KF : {}), /Accès refusé/);
  }

  // ---- the store's owner keeps one line for the agency: its agents stay private
  const owner: any = await call('confirmation.nouvelles', oranAdmin, {});
  assert.equal(owner.director, true);
  assert.equal(owner.agency, false);
  const line = owner.teams.find((r: any) => r.kind === 'agency');
  assert.deepEqual([line?.name, line?.agents, line?.received], ['The Closer', null, 2]);
  assert.deepEqual(owner.agents, [], 'no agent of the agency on the owner’s side');
});
