// A confirmation agency gives its orders by hand (« Attribuer »): its chief (administrator) and its chefs d'équipe see
// every order of the agency in a seller's store — the free ones too — and give them to the agency's own confirmation
// agents (the products each one works on); a plain agent sees and works only the orders given to him. Never the
// store's team, never by a plain agent, whatever the store's « Rôles ».
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, Ctx, login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, shopCtx, shopStatus, staffLogin, Tenancy } from '../index';
import { confirmSignup, loadShop, passwordFromLink, startSignup } from '../platform';

let phoneN = 0;
const tph = () => `072${String(++phoneN).padStart(7, '0')}`;
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

async function agency(t: Tenancy, name: string, email: string) {
  const mail = await startSignup(t, { name: 'Samir', email, phone: tph(), password: PW, storeName: name, language: 'fr', terms: true, kind: 'agency' }, null);
  const made: any = await confirmSignup(t, (mail as any).token);
  return { id: made.shop.id as number, schema: made.shop.schema as string };
}

const order = (ctx: Ctx, productId: number, phone: string) =>
  call('orders.create', ctx, { customerName: 'Client', phone, wilayaId: 31, commune: 'Oran', items: [{ productId, variantId: null, qty: 1 }] }) as Promise<any>;
const ids = (out: any) => out.rows.map((o: any) => o.id);

test('an agency: its chief and chefs d’équipe give its orders to its agents; a plain agent sees only his own', async () => {
  const { t, p } = await server();
  const shop = await store(t, p, 'Boutique Oran', 'karim@oran.dz');
  const ag = await agency(t, 'The Closer', 'samir@closer.dz');
  await p('p.agencies.verify', { id: ag.id, verified: true });
  const chief = await as(t, ag.id, 'samir@closer.dz', PW);
  await call('agency.prices', chief, { prices: PRICES });
  const admin = await as(t, shop.id, 'karim@oran.dz', PW);
  const { id: linkId } = (await call('partners.request', admin, { agencyId: ag.id, tasks: ['confirmation'], products: null })) as any;
  await call('agency.answer', chief, { id: linkId, accept: true });

  // the agency's team: a chef d'équipe, two agents (Rania on the Poussette only); the store has its own agent too
  const hakimAg: any = await call('users.create', chief, { phone: tph(), name: 'Hakim', email: 'hakim@closer.dz', password: PW, roles: ['agent_manager'] });
  await call('users.create', chief, { phone: tph(), name: 'Nora', email: 'nora@closer.dz', password: PW, roles: ['confirmation'] });
  await call('users.create', chief, { phone: tph(), name: 'Rania', email: 'rania@closer.dz', password: PW, roles: ['confirmation'], sellers: [{ store: shop.id, products: [shop.products.POUS] }] });
  await call('users.create', admin, { phone: tph(), name: 'Samia', email: 'samia@oran.dz', password: PW, roles: ['confirmation'] });
  const here = async (email: string) => Number((await shop.db.query('SELECT id FROM profiles WHERE email = $1', [email]))[0].id);
  const [nora, rania, samia] = [await here('nora@closer.dz'), await here('rania@closer.dz'), await here('samia@oran.dz')];

  const o1 = await order(admin, shop.products.VELO, '0661000001');
  const o2 = await order(admin, shop.products.VELO, '0661000002');
  const o3 = await order(admin, shop.products.POUS, '0661000003');
  assert.deepEqual([o1.confAgencyId, o2.confAgencyId, o3.confAgencyId], [ag.id, ag.id, ag.id]);

  // from the agency's space, the seller chosen at the top
  const at = (c: Ctx): Ctx => ({ ...c, seller: shop.id });
  const hakim = at(await as(t, ag.id, 'hakim@closer.dz', PW));
  const noraC = at(await as(t, ag.id, 'nora@closer.dz', PW));
  const raniaC = at(await as(t, ag.id, 'rania@closer.dz', PW));

  // the chef d'équipe sees every order of the agency, the free ones too; his list of agents is the agency's only
  assert.deepEqual(ids(await call('confirmation.list', hakim, { sub: 'nouvelles' })).sort(), [o1.id, o2.id, o3.id].sort());
  const meta: any = await call('confirmation.meta', hakim, {});
  assert.deepEqual(meta.agents.map((a: any) => a.name), ['Hakim', 'Nora', 'Rania', 'Samir']);
  assert.equal(meta.manager, true);

  // a plain agent: nothing given yet → nothing to see, « Commande suivante » gives nothing, a free order stays closed
  assert.deepEqual(ids(await call('confirmation.list', noraC, { sub: 'nouvelles' })), []);
  assert.equal(((await call('confirmation.counts', noraC, {})) as any).nouvelles, 0);
  assert.equal(((await call('orders.next', noraC, {})) as any).id, null);
  await assert.rejects(call('orders.get', noraC, { id: o2.id }), /ne vous est pas donnée/);
  await assert.rejects(call('orders.setConf', noraC, { ids: [o2.id], status: 'confirmed' }), /ne vous est pas donnée/);
  // and she gives nothing, not even to herself
  await assert.rejects(call('orders.assignAgent', noraC, { ids: [o2.id], agentId: nora }), /chef de l’agence ou un chef d’équipe/);
  assert.deepEqual((await call('confirmation.meta', noraC, {}) as any).manager, false);

  // « Attribuer »: the chef d'équipe gives o1 to Nora — whatever the store's « Rôles » say for agencies
  await call('orders.assignAgent', hakim, { ids: [o1.id], agentId: nora });
  assert.deepEqual(ids(await call('confirmation.list', noraC, { sub: 'nouvelles' })), [o1.id]);
  assert.equal(((await call('orders.next', noraC, {})) as any).id, o1.id);
  await call('confirmation.release', noraC, { id: o1.id });
  assert.equal((await call('orders.get', noraC, { id: o1.id }) as any).agentId, nora);
  // Rania works on the Poussette only: the Vélo never goes to her, the Poussette does
  await assert.rejects(call('orders.assignAgent', hakim, { ids: [o2.id], agentId: rania }), /Rania ne travaille pas sur le produit/);
  await call('orders.assignAgent', hakim, { ids: [o3.id], agentId: rania });
  assert.deepEqual(ids(await call('confirmation.list', raniaC, { sub: 'nouvelles' })), [o3.id]);
  // never the store's own team, never someone unknown
  await assert.rejects(call('orders.assignAgent', hakim, { ids: [o2.id], agentId: samia }), /pas un agent de confirmation de votre agence/);
  await assert.rejects(call('orders.assignAgent', hakim, { ids: [o2.id], agentId: 999999 }), /pas un agent de confirmation de votre agence/);
  // never an order the agency does not have
  const own = await order(admin, shop.products.VELO, '0661000009');
  await shop.db.query('UPDATE orders SET conf_agency_id = NULL WHERE id = $1', [own.id]);
  await assert.rejects(call('orders.assignAgent', hakim, { ids: [own.id], agentId: nora }), /pas confiée à votre agence/);

  // the chief of the agency (its administrator) gives too: o1 moves from Nora to Hakim
  const chiefC = at(chief);
  const hakimHere = await here('hakim@closer.dz');
  await call('orders.assignAgent', chiefC, { ids: [o1.id], agentId: hakimHere });
  assert.deepEqual(ids(await call('confirmation.list', noraC, { sub: 'nouvelles' })), []);
  // and takes an order back: nobody's again, Rania no longer sees it
  await call('orders.assignAgent', chiefC, { ids: [o3.id], agentId: null });
  assert.deepEqual(ids(await call('confirmation.list', raniaC, { sub: 'nouvelles' })), []);
  // a chef d'équipe may take a free order himself with « Commande suivante », like a store's manager
  const free = ((await call('orders.next', hakim, { skip: [o1.id] })) as any).id;
  assert.ok([o2.id, o3.id].includes(free));
  await call('confirmation.release', hakim, { id: free });

  // « Tous les vendeurs »: the agency's confirmation agents, with their account in each seller's store
  const people: any[] = (await call('agency.givePeople', at(chief), {})) as any[];
  assert.deepEqual(people.map((x) => [x.name, x.at[shop.id]]), [['Hakim', hakimHere], ['Nora', nora], ['Rania', rania], ['Samir', await here('samir@closer.dz')]]);
  await assert.rejects(call('agency.givePeople', await as(t, ag.id, 'nora@closer.dz', PW), {}), /Accès refusé|refusé|forbidden/i);
  // an order of « Tous les vendeurs » is given inside its own store (the seller of its row)
  await call('orders.assignAgent', { ...(await as(t, ag.id, 'hakim@closer.dz', PW)), seller: shop.id }, { ids: [o2.id], agentId: nora });
  assert.deepEqual(ids(await call('confirmation.list', { ...noraC, seller: 'all' }, { sub: 'nouvelles' })), [o2.id]);

  // Hakim is no longer a chef d'équipe in the agency: at once he gives nothing and sees only his own orders
  await call('users.update', chief, { id: hakimAg.id, roles: ['confirmation'] });
  const hakim2 = at(await as(t, ag.id, 'hakim@closer.dz', PW));
  await assert.rejects(call('orders.assignAgent', hakim2, { ids: [o2.id], agentId: hakimHere }), /chef de l’agence ou un chef d’équipe/);
  assert.deepEqual(ids(await call('confirmation.list', hakim2, { sub: 'nouvelles' })), [o1.id]);
});

test('an order one of the agency’s agents has open: its chief and its chefs d’équipe still change it (24 Nov 2026)', async () => {
  // the owner's rule: whoever is above an agent may do anything the agent does, on the agent's orders too; the 🔒 card
  // tells them « … est sur cette commande en ce moment. Vous pouvez quand même la changer. » (web: useMayOverrideHold)
  const { t, p } = await server();
  const shop = await store(t, p, 'Boutique Sétif', 'karim@setif.dz');
  const ag = await agency(t, 'The Closer', 'samir@closer.dz');
  await p('p.agencies.verify', { id: ag.id, verified: true });
  const chief = await as(t, ag.id, 'samir@closer.dz', PW);
  await call('agency.prices', chief, { prices: PRICES });
  const admin = await as(t, shop.id, 'karim@setif.dz', PW);
  const { id: linkId } = (await call('partners.request', admin, { agencyId: ag.id, tasks: ['confirmation'], products: null })) as any;
  await call('agency.answer', chief, { id: linkId, accept: true });
  await call('users.create', chief, { phone: tph(), name: 'Hakim', email: 'hakim@closer.dz', password: PW, roles: ['agent_manager'] });
  await call('users.create', chief, { phone: tph(), name: 'Moh', email: 'moh@closer.dz', password: PW, roles: ['confirmation'] });
  await call('users.create', chief, { phone: tph(), name: 'Nora', email: 'nora@closer.dz', password: PW, roles: ['confirmation'] });
  const moh = Number((await shop.db.query('SELECT id FROM profiles WHERE email = $1', ['moh@closer.dz']))[0].id);
  const at = (c: Ctx): Ctx => ({ ...c, seller: shop.id });
  const hakim = at(await as(t, ag.id, 'hakim@closer.dz', PW));
  const mohC = at(await as(t, ag.id, 'moh@closer.dz', PW));
  const noraC = at(await as(t, ag.id, 'nora@closer.dz', PW));
  const status = async (id: number) => {
    const r = (await shop.db.query('SELECT conf_status, attempts FROM orders WHERE id = $1', [id]))[0];
    return `${r.conf_status} · ${Number(r.attempts)}`;
  };

  const o1 = await order(admin, shop.products.VELO, '0661000201');
  const o2 = await order(admin, shop.products.VELO, '0661000202');
  await call('orders.assignAgent', hakim, { ids: [o1.id, o2.id], agentId: moh });

  // Moh presses « Commande suivante »: the order is his for 10 minutes; the chef d'équipe's list says « 🔒 Moh », and he
  // still changes it
  const first = Number(((await call('orders.next', mohC, {})) as any).id);
  const [mine, other] = first === o1.id ? [o1, o2] : [o2, o1];
  const row = (await call('confirmation.list', hakim, { sub: 'nouvelles' }) as any).rows.find((r: any) => r.id === mine.id);
  assert.equal(row?.lockedBy?.name, 'Moh');
  await call('orders.setConf', hakim, { ids: [mine.id], status: 'no_answer' });
  assert.equal(await status(mine.id), 'no_answer · 1');

  // Moh takes the next one: the chief of the agency (its administrator) changes it too
  assert.equal(Number(((await call('orders.next', mohC, { skip: [mine.id] })) as any).id), other.id);
  const row2 = (await call('confirmation.list', at(chief), { sub: 'nouvelles' }) as any).rows.find((r: any) => r.id === other.id);
  assert.equal(row2?.lockedBy?.name, 'Moh');
  await call('orders.setConf', at(chief), { ids: [other.id], status: 'no_answer' });
  assert.equal(await status(other.id), 'no_answer · 1');

  // a plain agent never touches another agent's order: it is not given to her
  await assert.rejects(call('orders.setConf', noraC, { ids: [other.id], status: 'no_answer' }), /ne vous est pas donnée/);
  assert.equal(await status(other.id), 'no_answer · 1', 'no call counted');
});
