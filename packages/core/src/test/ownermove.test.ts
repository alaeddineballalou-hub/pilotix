// « Changer le propriétaire » (control room › Agences, Marketers, Boutiques): the shop moves to another e-mail. The
// owner before loses every access at once (here, and in the stores a partner works for); the new one gets the account
// (nothing sent: Google), the administrator's place and the shop; the team's passwords still open it; a store keeps
// its plan, and the old seller's other boutique takes the plan when the one that held it leaves.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, Ctx, login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, shopCtx, shopStatus, staffLogin, Tenancy } from '../index';
import { accountByEmail, attachProfile, confirmSignup, loadShop, membershipsOf, passwordFromLink, passwordOpens, startSignup } from '../platform';

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

async function store(t: Tenancy, p: (n: string, i?: unknown) => Promise<any>, name: string, email: string) {
  const biz = (await p('p.plans.list')).find((x: any) => x.code === 'business');
  const made = await p('p.shops.create', { name, ownerName: 'Karim', ownerEmail: email, planId: biz.id, trialDays: 14 });
  if (made.mail?.token) await passwordFromLink(t, made.mail.token, PW);
  const s = (await loadShop(t, { id: made.id }))!;
  const db = t.shop(s.schema);
  await db.query(`INSERT INTO products (name, sku, price) VALUES ('Vélo', 'VELO', 9000)`);
  return { id: s.id, schema: s.schema, db, product: Number((await db.query('SELECT id FROM products LIMIT 1'))[0].id) };
}

async function agency(t: Tenancy, name: string, email: string) {
  const mail = await startSignup(t, { name: 'Rayan', email, phone: tph(), password: PW, storeName: name, language: 'fr', terms: true, kind: 'agency' }, null);
  const made: any = await confirmSignup(t, (mail as any).token);
  return { id: made.shop.id as number, schema: made.shop.schema as string };
}

const person = async (t: Tenancy, schema: string, email: string) =>
  (await t.shop(schema).query('SELECT id, name, roles, active, token_version, agency_id FROM profiles WHERE lower(email) = $1', [email]))[0];

test('an agency moves to a new e-mail: the old chief is out at once, here and in the stores; its team goes on', async () => {
  const { t, p } = await server();
  const shop = await store(t, p, 'Boutique Cliente', 'seller-move@example.dz');
  const ag = await agency(t, 'The Closer', 'old-chief@example.dz');
  await p('p.agencies.verify', { id: ag.id, verified: true });
  const chief = await as(t, ag.id, 'old-chief@example.dz', PW);
  const seller = await as(t, shop.id, 'seller-move@example.dz', PW);
  await call('agency.prices', chief, { prices: PRICES });
  const link = (await call('partners.request', seller, { agencyId: ag.id, tasks: ['confirmation'], products: null })) as { id: number };
  await call('agency.answer', chief, { id: link.id, accept: true });
  // an agent the old chief added (his password was chosen by the chief, as the server does after users.create)
  const agent: any = await call('users.create', chief, { phone: tph(), name: 'Agent Closer', email: 'agent-closer@example.dz', password: PW, roles: ['confirmation'] });
  await attachProfile(t, ag.schema, agent.id);
  assert.equal((await person(t, shop.schema, 'old-chief@example.dz'))?.active, true, 'the chief works in the store');
  const tvBefore = Number((await person(t, ag.schema, 'old-chief@example.dz')).token_version);

  // refused: the same e-mail, an e-mail that cannot have an account, an e-mail that already has its agency
  await assert.rejects(p('p.shops.setOwner', { id: ag.id, email: 'OLD-chief@example.dz' }), /déjà l’e-mail du propriétaire/);
  await assert.rejects(p('p.shops.setOwner', { id: ag.id, email: 'x@pilotix.invalid' }), /E-mail invalide/);
  await agency(t, 'Autre agence', 'other-chief@example.dz');
  await assert.rejects(p('p.shops.setOwner', { id: ag.id, email: 'other-chief@example.dz' }), /déjà son agence/);
  const primary = (await loadShop(t, { primary: true }))!;
  await assert.rejects(p('p.shops.setOwner', { id: primary.id, email: 'new@example.dz' }), /propre boutique/);

  const r: any = await p('p.shops.setOwner', { id: ag.id, email: ' TSWISEDZ@example.dz ', name: 'Nouveau chef', phone: '0550000000' });
  assert.deepEqual([r.from, r.to, r.name, r.created, r.promoted, r.passwordDropped], ['old-chief@example.dz', 'tswisedz@example.dz', 'Nouveau chef', true, false, false]);
  // the agency is the new e-mail's: an account with no password (nothing sent: « Continuer avec Google »)
  const acc = (await accountByEmail(t, 'tswisedz@example.dz'))!;
  assert.equal(acc.hasPassword, false);
  const a = (await loadShop(t, { id: ag.id }))!;
  assert.deepEqual([a.ownerAccountId, a.ownerEmail, a.ownerName, a.ownerPhone], [acc.id, 'tswisedz@example.dz', 'Nouveau chef', '0550000000']);
  const chiefNow = await person(t, ag.schema, 'tswisedz@example.dz');
  assert.deepEqual([chiefNow.roles, chiefNow.active], [['admin'], true]);
  assert.deepEqual((await membershipsOf(t, 'tswisedz@example.dz')).map((m) => m.shopId).sort(), [ag.id, shop.id].sort());
  // the old chief: closed here (his sessions end) and in the store; nowhere to go
  const old = await person(t, ag.schema, 'old-chief@example.dz');
  assert.equal(old.active, false);
  assert.equal(Number(old.token_version), tvBefore + 1);
  assert.equal((await person(t, shop.schema, 'old-chief@example.dz')).active, false);
  assert.deepEqual(await membershipsOf(t, 'old-chief@example.dz'), []);
  await assert.rejects(as(t, ag.id, 'old-chief@example.dz', PW), /désactivé/);
  // the new chief works in the store for the agency
  const inStore = await person(t, shop.schema, 'tswisedz@example.dz');
  assert.deepEqual([Number(inStore.agency_id), inStore.active], [ag.id, true]);
  // the agent's password (the old chief chose it) still opens the agency
  const agentAcc = (await accountByEmail(t, 'agent-closer@example.dz'))!;
  assert.equal(agentAcc.passwordBy, 'admin');
  assert.equal(await passwordOpens(t, agentAcc, ag.id), true);
  // the control room's journal
  const log = (await t.platform.query(`SELECT details FROM platform.audit WHERE action = 'shop.owner' AND shop_id = $1`, [ag.id]))[0];
  assert.equal((typeof log.details === 'string' ? JSON.parse(log.details) : log.details).to, 'tswisedz@example.dz');

  // the agent becomes the owner: his place becomes the administrator's, and the password the old chief chose goes
  const r2: any = await p('p.shops.setOwner', { id: ag.id, email: 'agent-closer@example.dz' });
  assert.deepEqual([r2.created, r2.promoted, r2.passwordDropped, r2.name], [false, true, true, 'Agent Closer']);
  const promoted = await person(t, ag.schema, 'agent-closer@example.dz');
  assert.deepEqual([[...promoted.roles].sort(), promoted.active, Number(promoted.id)], [['admin', 'confirmation'], true, agent.id]);
  assert.equal((await accountByEmail(t, 'agent-closer@example.dz'))!.hasPassword, false);
  assert.equal((await person(t, ag.schema, 'tswisedz@example.dz')).active, false);
});

test('a store moves to a new e-mail: it keeps its plan; the old seller keeps his other boutique, which takes the plan', async () => {
  const { t, p } = await server();
  const first = await store(t, p, 'Boutique Une', 'seller-two@example.dz');
  const biz = (await p('p.plans.list')).find((x: any) => x.code === 'business');
  // the same seller's second boutique follows the first one's plan
  const made = await p('p.shops.create', { name: 'Boutique Deux', ownerName: 'Karim', ownerEmail: 'seller-two@example.dz', planId: biz.id, trialDays: 3 });
  const trialEnd = '2027-03-31T23:00:00.000Z';
  await p('p.shops.update', { id: first.id, trialEndsAt: trialEnd });
  assert.equal((await loadShop(t, { id: made.id }))!.mainShopId, first.id);
  // an order the seller took himself, still to call: it goes back to the team
  const seller = await as(t, first.id, 'seller-two@example.dz', PW);
  const o: any = await call('orders.create', seller, { customerName: 'Client', phone: '0661000001', wilayaId: 31, commune: 'Oran', items: [{ productId: first.product, variantId: null, qty: 1 }] });
  await first.db.query('UPDATE orders SET agent_id = $2 WHERE id = $1', [o.id, seller.session.profile.id]);

  // the first boutique (it holds the plan) goes to a buyer
  const r: any = await p('p.shops.setOwner', { id: first.id, email: 'buyer@example.dz', name: 'Acheteur' });
  assert.equal(r.created, true);
  const one = (await loadShop(t, { id: first.id }))!;
  const two = (await loadShop(t, { id: made.id }))!;
  assert.deepEqual([one.ownerEmail, one.mainShopId, one.planId, one.trialEndsAt], ['buyer@example.dz', null, biz.id, trialEnd]);
  // the seller's other boutique holds his plan now, with the same period
  assert.deepEqual([two.mainShopId, two.planId, two.trialEndsAt], [null, biz.id, trialEnd]);
  assert.deepEqual((await membershipsOf(t, 'seller-two@example.dz')).map((m) => m.shopId), [made.id]);
  assert.equal((await person(t, first.schema, 'seller-two@example.dz')).active, false);
  assert.deepEqual((await person(t, first.schema, 'buyer@example.dz')).roles, ['admin']);
  assert.equal((await first.db.query('SELECT agent_id FROM orders WHERE id = $1', [o.id]))[0].agent_id, null);
  // a buyer who has a boutique already: refused (two subscriptions would mix)
  await assert.rejects(p('p.shops.setOwner', { id: made.id, email: 'buyer@example.dz' }), /déjà ses boutiques/);
});

test('a boutique that follows its seller’s plan keeps the plan and the period it had when it moves', async () => {
  const { t, p } = await server();
  const first = await store(t, p, 'Boutique Mère', 'seller-three@example.dz');
  const biz = (await p('p.plans.list')).find((x: any) => x.code === 'business');
  const made = await p('p.shops.create', { name: 'Boutique Fille', ownerName: 'Karim', ownerEmail: 'seller-three@example.dz', planId: biz.id, trialDays: 1 });
  const trialEnd = '2027-04-30T23:00:00.000Z';
  await p('p.shops.update', { id: first.id, trialEndsAt: trialEnd });
  await p('p.shops.setOwner', { id: made.id, email: 'new-seller@example.dz' });
  const two = (await loadShop(t, { id: made.id }))!;
  assert.deepEqual([two.ownerEmail, two.mainShopId, two.planId, two.trialEndsAt], ['new-seller@example.dz', null, biz.id, trialEnd]);
  // the seller's first boutique is unchanged
  const one = (await loadShop(t, { id: first.id }))!;
  assert.deepEqual([one.ownerEmail, one.trialEndsAt], ['seller-three@example.dz', trialEnd]);
});
