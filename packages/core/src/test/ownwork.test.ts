// A store's own confirmation agent opens only his own orders and the customers of those orders (given to him, handled
// or typed by him, the one « Commande suivante » gave him, the orders of his SAV tickets). The managers, the owner and
// the administrators see every order; the suivi and the depot keep their whole lists. An agency's agent never opens
// another customer of the store by mixing a customer id with the phone of one of the agency's customers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, Ctx, login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, shopCtx, shopStatus, staffLogin, Tenancy } from '../index';
import { confirmSignup, loadShop, passwordFromLink, startSignup } from '../platform';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const PW = 'Agent-Password-1';
let phoneN = 0;
const tph = () => `077${String(++phoneN).padStart(7, '0')}`;

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

/** A store with its owner, two confirmation agents, a manager and a suivi agent, and one product. */
async function store() {
  const { t } = await server();
  const mail: any = await startSignup(t, { name: 'Boss', email: 'boss@store.dz', phone: tph(), password: PW, storeName: 'Store Own Work', language: 'fr', terms: true }, null);
  const shopId = ((await confirmSignup(t, mail.token)) as any).shop.id as number;
  const boss = await as(t, shopId, 'boss@store.dz', PW);
  const pid = Number((await boss.db.query(`INSERT INTO products (name, sku, price) VALUES ('Lampe', 'LAMPE', 5000) RETURNING id`))[0].id);
  const person = async (name: string, email: string, roles: string[]) => {
    const u: any = await call('users.create', boss, { name, email, phone: tph(), password: PW, roles });
    return { id: Number(u.id), ctx: await as(t, shopId, email, PW) };
  };
  const A = await person('Agent A', 'a@store.dz', ['confirmation']);
  const B = await person('Agent B', 'b@store.dz', ['confirmation']);
  const M = await person('Manager', 'm@store.dz', ['agent_manager']);
  const S = await person('Suivi', 's@store.dz', ['suivi']);
  let n = 0;
  const order = async (agentId: number | null) => {
    const phone = `0662${String(++n).padStart(6, '0')}`;
    const o: any = await call('orders.create', boss, { customerName: `Client ${n}`, phone, wilayaId: 16, commune: 'Kouba', address: 'Rue', items: [{ productId: pid, variantId: null, qty: 1 }] });
    if (agentId) await boss.db.query('UPDATE orders SET agent_id = $1 WHERE id = $2', [agentId, o.id]);
    return { id: Number(o.id), phone, customerId: Number(o.customerId) };
  };
  return { t, shopId, boss, pid, A, B, M, S, order };
}

test('a store confirmation agent opens only his own orders and his own customers; managers and the suivi see all', async () => {
  const { A, B, M, S, order } = await store();
  const oA = await order(A.id);
  const oB = await order(B.id);
  const b = B.ctx;
  const mine = /donnée à un autre agent/;
  await assert.rejects(call('orders.get', b, { id: oA.id }), mine);
  await assert.rejects(call('orders.events', b, { id: oA.id }), mine);
  await assert.rejects(call('orders.note', b, { id: oA.id, note: 'hello' }), mine);
  await assert.rejects(call('orders.setConf', b, { ids: [oA.id], status: 'busy' }), mine);
  assert.equal(((await call('orders.get', b, { id: oB.id })) as any).id, oB.id);
  const list: any = await call('orders.list', b, {});
  assert.deepEqual(list.rows.map((r: any) => r.id), [oB.id]);
  const custs: any = await call('customers.list', b, {});
  assert.deepEqual(custs.rows.map((r: any) => r.phone), [oB.phone]);
  // the customers: by phone, by id, and an id mixed with the phone of one's own customer
  await assert.rejects(call('customers.history', b, { phone: oA.phone }), /pas un de vos clients/);
  await assert.rejects(call('customers.history', b, { id: oA.customerId }), /pas un de vos clients/);
  await assert.rejects(call('customers.history', b, { id: oA.customerId, phone: oB.phone }), /pas un de vos clients/);
  await assert.rejects(call('customers.setBlacklist', b, { id: oA.customerId, phone: oB.phone, on: true }), /pas un de vos clients/);
  const h: any = await call('customers.history', b, { phone: oB.phone });
  assert.equal(h.customer.phone, oB.phone);
  // the search of the SAV and of the claims finds his own orders only
  assert.deepEqual(((await call('sav.findOrder', b, { q: oA.phone })) as any[]).length, 0);
  assert.deepEqual(((await call('sav.findOrder', b, { q: oB.phone })) as any[]).map((o) => o.id), [oB.id]);
  // the manager and the suivi see every order
  assert.equal(((await call('orders.get', M.ctx, { id: oA.id })) as any).id, oA.id);
  assert.equal(((await call('orders.list', M.ctx, {})) as any).rows.length, 2);
  assert.equal(((await call('customers.list', M.ctx, {})) as any).rows.length, 2);
  assert.equal(((await call('orders.get', S.ctx, { id: oA.id })) as any).id, oA.id);
});

test('« Commande suivante », an order he typed and a SAV ticket given to him stay the agent\'s own; a free order only once his manager gives it', async () => {
  const { boss, pid, A, B, order } = await store();
  const oA = await order(A.id);
  const oB = await order(B.id);
  const free = await order(null);
  const later = await order(null);
  const b = B.ctx;
  const mine = /donnée à un autre agent/;
  // nobody's order: he never takes it himself — « Commande suivante » gives only his own, his manager gives the others
  await assert.rejects(call('orders.get', b, { id: free.id }), mine);
  await assert.rejects(call('confirmation.hold', b, { id: later.id }), mine);
  await assert.rejects(call('orders.assignAgent', b, { ids: [later.id], agentId: B.id }), /autre agent|manager/);
  const none: any = await call('orders.next', b, { skip: [oB.id] });
  assert.equal(none.id, null);
  await call('orders.assignAgent', boss, { ids: [free.id], agentId: B.id });
  const next: any = await call('orders.next', b, { skip: [oB.id] });
  assert.equal(next.id, free.id);
  assert.equal(((await call('orders.get', b, { id: free.id })) as any).id, free.id);
  assert.equal(((await call('confirmation.hold', b, { id: free.id })) as any).ok, true);
  await call('orders.setConf', b, { ids: [free.id], status: 'busy' });
  await call('confirmation.release', b, { id: free.id });
  // called once: his own now
  assert.equal(((await call('orders.get', b, { id: free.id })) as any).agentId, B.id);
  // still not the other free one
  await assert.rejects(call('orders.get', b, { id: later.id }), mine);
  // an order he types is his
  const typed: any = await call('orders.create', b, { customerName: 'Client tapé', phone: '0663000001', wilayaId: 16, commune: 'Kouba', address: 'Rue', items: [{ productId: pid, variantId: null, qty: 1 }] });
  assert.equal(((await call('orders.get', b, { id: typed.id })) as any).id, typed.id);
  // a SAV ticket on another agent's order, given to him by the owner: he opens the ticket and its order
  const tk: any = await call('sav.create', boss, { orderId: oA.id, type: 'other', details: 'Pièce cassée', assignedTo: B.id });
  const got: any = await call('sav.get', b, { id: tk.id ?? tk.ticket?.id });
  assert.equal(got.order.id, oA.id);
  const tickets: any = await call('sav.list', b, {});
  assert.ok(tickets.rows.some((r: any) => r.orderId === oA.id));
  // a ticket on another of A's orders stays A's
  const oA2 = await order(A.id);
  const tk2: any = await call('sav.create', boss, { orderId: oA2.id, type: 'other', details: 'Autre souci', assignedTo: A.id });
  await assert.rejects(call('sav.get', b, { id: tk2.id ?? tk2.ticket?.id }), /donné à un autre agent/);
});

test('an agency agent never opens another customer of the store with the phone of one of the agency\'s customers', async () => {
  const { t, p } = await server();
  const biz = (await p('p.plans.list')).find((x: any) => x.code === 'business');
  const sm: any = await p('p.shops.create', { name: 'Boutique Oran', ownerName: 'Karim', ownerEmail: 'karim@oran.dz', planId: biz.id, trialDays: 14 });
  await passwordFromLink(t, sm.mail.token, PW);
  const shop = (await loadShop(t, { id: sm.id }))!;
  const sdb = t.shop(shop.schema);
  await sdb.query(`INSERT INTO products (name, sku, price) VALUES ('Vélo', 'VELO', 9000), ('Poussette', 'POUS', 12000)`);
  const prod = Object.fromEntries((await sdb.query('SELECT id, sku FROM products')).map((r: any) => [r.sku, Number(r.id)]));
  const mail: any = await startSignup(t, { name: 'Samir', email: 'samir@agence.dz', phone: tph(), password: PW, storeName: 'Agence Rapide', language: 'fr', terms: true, kind: 'agency' }, null);
  const ag: any = ((await confirmSignup(t, mail.token)) as any).shop;
  await p('p.agencies.verify', { id: ag.id, verified: true });
  const admin = await as(t, shop.id, 'karim@oran.dz', PW);
  const chief = await as(t, ag.id, 'samir@agence.dz', PW);
  await call('agency.prices', chief, { prices: { perConfirmed: 0, perDelivered: 150, perUpsell: 50, monthly: 0, bonusRate: { min: 70, amount: 20 }, bonusVolume: { above: 0, amount: 0 } } });
  const { id: linkId } = (await call('partners.request', admin, { agencyId: ag.id, tasks: ['confirmation'], products: [prod.VELO] })) as any;
  await call('agency.answer', chief, { id: linkId, accept: true });
  await call('users.create', chief, { phone: tph(), name: 'Nora', email: 'nora@agence.dz', password: PW, roles: ['confirmation'] });
  const order = (pid: number, phone: string, name: string) => call('orders.create', admin, { customerName: name, phone, wilayaId: 31, commune: 'Oran', items: [{ productId: pid, variantId: null, qty: 1 }] }) as Promise<any>;
  const o1 = await order(prod.VELO, '0661000001', 'Agency Client');
  const o2 = await order(prod.POUS, '0661000002', 'Store Only Client');
  assert.equal(o1.confAgencyId, ag.id);
  assert.equal(o2.confAgencyId, null);
  const n: Ctx = { ...(await as(t, ag.id, 'nora@agence.dz', PW)), seller: shop.id };
  const notOurs = /pas un client de votre agence/;
  await assert.rejects(call('customers.history', n, { phone: '0661000002' }), notOurs);
  await assert.rejects(call('customers.history', n, { id: o2.customerId }), notOurs);
  await assert.rejects(call('customers.history', n, { id: o2.customerId, phone: '0661000001' }), notOurs);
  await assert.rejects(call('customers.setBlacklist', n, { id: o2.customerId, phone: '0661000001', on: true }), notOurs);
  const h: any = await call('customers.history', n, { phone: '0661000001' });
  assert.equal(h.customer.phone, '0661000001');
  assert.equal(((await sdb.query('SELECT blacklisted FROM customers WHERE id = $1', [o2.customerId]))[0] as any).blacklisted, false);
});
