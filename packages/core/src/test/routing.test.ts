// Who works an order (owner's rule, 26 Nov 2026, routing.ts): the person who typed it keeps it; one that came by itself
// goes by its channel — a landing page's to the boutique's confirmation agency (every product), a chat Dellal answered to
// the person in charge of that chat, the others to the store's own team. Suivi follows the side that confirms. The
// seller gives orders to his agency from « Assigner un agent » and takes them back; he never sees its agents. One agency
// per task in a boutique.
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
  return { id: s.id, db, products: ids as Record<'VELO' | 'POUS', number> };
}

async function agency(t: Tenancy, p: (n: string, i?: unknown) => Promise<any>, name: string, email: string) {
  const mail = await startSignup(t, { name: 'Samir', email, phone: tph(), password: PW, storeName: name, language: 'fr', terms: true, kind: 'agency' }, null);
  const made: any = await confirmSignup(t, (mail as any).token);
  await p('p.agencies.verify', { id: made.shop.id, verified: true });
  const chief = await as(t, made.shop.id, email, PW);
  await call('agency.prices', chief, { prices: PRICES });
  return { id: made.shop.id as number, chief };
}

const input = (productId: number, phone: string, extra: Record<string, unknown> = {}) => ({
  customerName: 'Client',
  phone,
  wilayaId: 31,
  commune: 'Oran',
  address: '',
  isStopdesk: false,
  channel: 'facebook',
  items: [{ productId, variantId: null, qty: 1 }],
  discount: 0,
  confirm: false,
  isExchange: false,
  ...extra,
});
const typed = (ctx: Ctx, productId: number, phone: string, extra: Record<string, unknown> = {}) => call('orders.create', ctx, input(productId, phone, extra)) as Promise<any>;
const side = async (db: Ctx['db'], id: number) => {
  const r = (await db.query('SELECT conf_agency_id, agent_id, follow_agency_id FROM orders WHERE id = $1', [id]))[0];
  return { conf: r.conf_agency_id == null ? null : Number(r.conf_agency_id), agent: r.agent_id == null ? null : Number(r.agent_id), follow: r.follow_agency_id == null ? null : Number(r.follow_agency_id) };
};

test('the person who types an order keeps it; a landing page’s goes to the agency (any product); the others stay with the store', async () => {
  const { t, p } = await server();
  const shop = await store(t, p, 'Boutique Oran', 'karim@oran.dz');
  const ag = await agency(t, p, 'The Closer', 'samir@closer.dz');
  const admin = await as(t, shop.id, 'karim@oran.dz', PW);
  const { id: linkId } = (await call('partners.request', admin, { agencyId: ag.id, tasks: ['confirmation', 'suivi'], products: [shop.products.VELO] })) as any;
  await call('agency.answer', ag.chief, { id: linkId, accept: true });
  await call('users.create', admin, { phone: tph(), name: 'Samia', email: 'samia@oran.dz', password: PW, roles: ['confirmation'] });
  await call('users.create', admin, { phone: tph(), name: 'Lina', email: 'lina@oran.dz', password: PW, roles: ['cm'] });
  const here = async (email: string) => Number((await shop.db.query('SELECT id FROM profiles WHERE email = $1', [email]))[0].id);
  const [samiaId, linaId, adminId] = [await here('samia@oran.dz'), await here('lina@oran.dz'), await here('karim@oran.dz')];
  const samia = await as(t, shop.id, 'samia@oran.dz', PW);
  const lina = await as(t, shop.id, 'lina@oran.dz', PW);
  // the agency works on every product: the store's choice of products is no longer kept for an agency
  const link = (await call('partners.home', admin, {}) as any).links.find((l: any) => l.id === linkId);
  assert.equal(link.products, null);

  // typed by a person: his, on the store's side — even a product the agency used to get
  const bySamia = await typed(samia, shop.products.VELO, '0661100001');
  assert.deepEqual(await side(shop.db, bySamia.id), { conf: null, agent: samiaId, follow: null });
  const byAdmin = await typed(admin, shop.products.VELO, '0661100002');
  assert.deepEqual(await side(shop.db, byAdmin.id), { conf: null, agent: adminId, follow: null });
  // the Community manager keeps hers too: she confirms it herself
  const byLina = await typed(lina, shop.products.POUS, '0661100003', { channel: 'instagram' });
  assert.deepEqual(await side(shop.db, byLina.id), { conf: null, agent: linaId, follow: null });

  // a landing page's order: the agency, whatever its product, followed by the agency (it does the suivi too)
  for (const [pid, ph] of [[shop.products.VELO, '0661100004'], [shop.products.POUS, '0661100005']] as const) {
    const o = await createOrder(admin, input(pid, ph, { channel: 'landing' }) as any, admin.db, { came: 'form' });
    assert.deepEqual(await side(shop.db, o.id), { conf: ag.id, agent: null, follow: ag.id });
  }
  // a number left on a landing page that Pilotix turned into an order: the agency too
  const left = await createOrder(admin, input(shop.products.POUS, '0661100006', { channel: 'landing' }) as any, admin.db, { came: 'abandoned', abandoned: true, silent: true });
  assert.equal((await side(shop.db, left.id)).conf, ag.id);

  // the other channels that come by themselves: the store's own team, nobody's yet
  for (const [came, ph] of [['meta_form', '0661100007'], ['site', '0661100008'], ['sheet', '0661100009']] as const) {
    const o = await createOrder(admin, input(shop.products.VELO, ph) as any, admin.db, { came });
    assert.deepEqual(await side(shop.db, o.id), { conf: null, agent: null, follow: null }, came);
  }

  // a chat Dellal answered: the person in charge of that chat; nobody in charge → the store's team
  const conv = Number((await shop.db.query(`INSERT INTO conversations (channel, external_id, customer_name, mode, assigned_to) VALUES ('messenger', 'psid-r-1', 'Imène', 'human', $1) RETURNING id`, [linaId]))[0].id);
  const chat = await createOrder(admin, input(shop.products.VELO, '0661100010') as any, admin.db, { came: 'chat', conversationId: conv });
  assert.deepEqual(await side(shop.db, chat.id), { conf: null, agent: linaId, follow: null });
  const alone = Number((await shop.db.query(`INSERT INTO conversations (channel, external_id, customer_name) VALUES ('instagram', 'ig-r-1', 'Sara') RETURNING id`))[0].id);
  const aiOnly = await createOrder(admin, input(shop.products.VELO, '0661100011') as any, admin.db, { came: 'chat_auto', conversationId: alone, silent: true });
  assert.deepEqual(await side(shop.db, aiOnly.id), { conf: null, agent: null, follow: null });

  // the Community manager works her own order in Confirmation, never one she was not given
  assert.ok(((await call('confirmation.list', lina, { sub: 'nouvelles' })) as any).rows.some((o: any) => o.id === byLina.id));
  await call('orders.setConf', lina, { ids: [byLina.id], status: 'no_answer' });
  assert.equal((await shop.db.query('SELECT attempts FROM orders WHERE id = $1', [byLina.id]))[0].attempts > 0, true);
  await assert.rejects(call('orders.setConf', lina, { ids: [bySamia.id], status: 'no_answer' }), (e: any) => e.code === 'forbidden');
  // never « Confirmer » while typing it: from Confirmation, after her call
  await assert.rejects(typed(lina, shop.products.VELO, '0661100012', { channel: 'facebook', confirm: true }), /après votre appel/);
});

test('the seller gives orders to his agency and takes them back; he never sees nor picks its agents', async () => {
  const { t, p } = await server();
  const shop = await store(t, p, 'Boutique Oran', 'karim@oran.dz');
  const ag = await agency(t, p, 'The Closer', 'samir@closer.dz');
  const admin = await as(t, shop.id, 'karim@oran.dz', PW);
  const { id: linkId } = (await call('partners.request', admin, { agencyId: ag.id, tasks: ['confirmation', 'suivi'], products: null })) as any;
  await call('agency.answer', ag.chief, { id: linkId, accept: true });
  await call('users.create', ag.chief, { phone: tph(), name: 'Nora', email: 'nora@closer.dz', password: PW, roles: ['confirmation'] });
  await call('users.create', admin, { phone: tph(), name: 'Samia', email: 'samia@oran.dz', password: PW, roles: ['confirmation'] });
  await call('users.create', admin, { phone: tph(), name: 'Lina', email: 'lina@oran.dz', password: PW, roles: ['cm'] });
  const here = async (email: string) => Number((await shop.db.query('SELECT id FROM profiles WHERE email = $1', [email]))[0].id);
  const [nora, samia] = [await here('nora@closer.dz'), await here('samia@oran.dz')];

  // « Assigner un agent »: his own people (his Community manager too), and the agency as one line — never its agents
  const meta: any = await call('confirmation.meta', admin, {});
  assert.ok(meta.agents.some((a: any) => a.name === 'Samia') && meta.agents.some((a: any) => a.name === 'Lina'));
  assert.ok(!meta.agents.some((a: any) => a.id === nora), 'the agency’s agents are not his to pick');
  assert.deepEqual(meta.agencies, [{ id: ag.id, name: 'The Closer' }]);
  assert.deepEqual((await call('orders.agencyNames', admin, {})) as any, [{ id: ag.id, name: 'The Closer' }]);
  // his own agent sees no agency line (only the seller gives orders to the agency)
  assert.deepEqual(((await call('confirmation.meta', await as(t, shop.id, 'samia@oran.dz', PW), {})) as any).agencies, []);

  const o1 = await typed(admin, shop.products.VELO, '0661200001');
  const o2 = await typed(admin, shop.products.POUS, '0661200002');
  assert.equal((await call('orders.giveAgency', admin, { ids: [o1.id, o2.id], agencyId: ag.id }) as any).given, 2);
  assert.deepEqual(await side(shop.db, o1.id), { conf: ag.id, agent: null, follow: ag.id });
  // the agency's chief gives it to its agent; the seller never does
  await call('orders.assignAgent', { ...ag.chief, seller: shop.id } as Ctx, { ids: [o1.id], agentId: nora });
  await assert.rejects(call('orders.assignAgent', admin, { ids: [o2.id], agentId: nora }), /réservée à l’équipe/);
  // « Désassigner » leaves the agency's orders with it
  await call('orders.assignAgent', admin, { ids: [o1.id], agentId: null });
  assert.deepEqual(await side(shop.db, o1.id), { conf: ag.id, agent: nora, follow: ag.id });
  // taken back: given to one of his own people, the suivi comes back with it
  await call('orders.assignAgent', admin, { ids: [o1.id], agentId: samia });
  assert.deepEqual(await side(shop.db, o1.id), { conf: null, agent: samia, follow: null });
  // and given again
  await call('orders.giveAgency', admin, { ids: [o1.id], agencyId: ag.id });
  assert.deepEqual(await side(shop.db, o1.id), { conf: ag.id, agent: null, follow: ag.id });

  // only an order still to confirm moves; never to an agency that does not confirm for him
  await shop.db.query(`UPDATE orders SET conf_status = 'confirmed' WHERE id = $1`, [o2.id]);
  await assert.rejects(call('orders.assignAgent', admin, { ids: [o2.id], agentId: samia }), /déjà traitée par l’agence/);
  const o3 = await typed(admin, shop.products.VELO, '0661200003');
  await shop.db.query(`UPDATE orders SET conf_status = 'confirmed' WHERE id = $1`, [o3.id]);
  await assert.rejects(call('orders.giveAgency', admin, { ids: [o3.id], agencyId: ag.id }), /plus à confirmer/);
  await assert.rejects(call('orders.giveAgency', admin, { ids: [o3.id], agencyId: 999999 }), /ne fait pas la confirmation/);
  // only the seller gives orders to the agency
  await assert.rejects(call('orders.giveAgency', await as(t, shop.id, 'samia@oran.dz', PW), { ids: [o3.id], agencyId: ag.id }), (e: any) => e.code === 'forbidden');
});

test('one agency per task in a boutique; an agency doing only the suivi follows the landing pages’ orders', async () => {
  const { t, p } = await server();
  const shop = await store(t, p, 'Boutique Oran', 'karim@oran.dz');
  const a1 = await agency(t, p, 'The Closer', 'samir@closer.dz');
  const a2 = await agency(t, p, 'Call Pro', 'nabil@callpro.dz');
  const admin = await as(t, shop.id, 'karim@oran.dz', PW);
  const { id: l1 } = (await call('partners.request', admin, { agencyId: a1.id, tasks: ['confirmation'], products: null })) as any;
  await call('agency.answer', a1.chief, { id: l1, accept: true });
  await assert.rejects(call('partners.request', admin, { agencyId: a2.id, tasks: ['confirmation', 'suivi'], products: null }), /The Closer fait déjà la confirmation de cette boutique/);
  const { id: l2 } = (await call('partners.request', admin, { agencyId: a2.id, tasks: ['suivi'], products: null })) as any;
  await call('agency.answer', a2.chief, { id: l2, accept: true });

  // a landing page's order: confirmed by The Closer, followed by Call Pro (it does the suivi without the confirmation)
  const fromPage = await createOrder(admin, input(shop.products.VELO, '0661300001', { channel: 'landing' }) as any, admin.db, { came: 'form' });
  assert.deepEqual(await side(shop.db, fromPage.id), { conf: a1.id, agent: null, follow: a2.id });
  // an order a person typed: the store's, its suivi too (each side follows its own)
  const typedOne = await typed(admin, shop.products.VELO, '0661300002');
  const s2 = await side(shop.db, typedOne.id);
  assert.deepEqual([s2.conf, s2.follow], [null, null]);
});
