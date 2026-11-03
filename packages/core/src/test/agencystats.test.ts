// Agency Dashboard and Analyse & statistiques. (helpers copied from agencies.test.ts) Confirmation agencies: an agency signs up, Pilotix checks it, it finds a store by code (or the store finds it), the
// other side accepts; only the agency sets prices, only the store gives products and tasks; orders go by their first
// product; the agency's agents work inside the store on its orders only; numbers, bills, suspension, the end.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanCode } from '@pilotix/shared';
import { call, Ctx, login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, shopCtx, shopStatus, staffLogin, Tenancy } from '../index';
import { confirmSignup, loadShop, membershipsOf, passwordFromLink, startSignup, storeChoices } from '../platform';
import { computePayroll } from '../modules/admin';

/** a new team member's phone (required, one per person) */
let phoneN = 0;
const tph = () => `071${String(++phoneN).padStart(7, '0')}`;

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const PW = 'Agence-Password-1';

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

/** A logged-in person of a shop, as the server builds it (its shop's rules, the whole server's data). */
async function as(t: Tenancy, shopId: number, email: string, password: string): Promise<Ctx> {
  const s = (await loadShop(t, { id: shopId }))!;
  const db = t.shop(s.schema);
  return { db, session: await login(db, email, password), now: () => Date.now(), emit: () => {}, shop: shopCtx(s, shopStatus(s, Date.now(), 3)), t };
}

/** A store made from the control room, with two products. */
async function store(t: Tenancy, p: (n: string, i?: unknown) => Promise<any>, name: string, email: string) {
  const biz = (await p('p.plans.list')).find((x: any) => x.code === 'business');
  const made = await p('p.shops.create', { name, ownerName: 'Karim', ownerEmail: email, planId: biz.id, trialDays: 14 });
  await passwordFromLink(t, made.mail.token, PW);
  const s = (await loadShop(t, { id: made.id }))!;
  const db = t.shop(s.schema);
  await db.query(`INSERT INTO products (name, sku, price) VALUES ('Vélo', 'VELO', 9000), ('Poussette', 'POUS', 12000), ('Casque', 'CASQ', 3000)`);
  const ids = (await db.query('SELECT id, sku FROM products ORDER BY id')).reduce((m: Record<string, number>, r: any) => ({ ...m, [r.sku]: Number(r.id) }), {});
  return { id: s.id, schema: s.schema, db, code: s.publicCode!, products: ids as Record<'VELO' | 'POUS' | 'CASQ', number> };
}

/** An agency made by its owner (« Créer mon agence »: e-mail confirmed). */
async function agency(t: Tenancy, name: string, email: string) {
  const mail = await startSignup(t, { name: 'Samir', email, phone: tph(), password: PW, storeName: name, language: 'fr', terms: true, kind: 'agency' }, null);
  assert.equal(mail?.kind, 'confirm');
  const made: any = await confirmSignup(t, (mail as any).token);
  return { id: made.shop.id as number, schema: made.shop.schema as string, code: made.shop.publicCode as string };
}

const PRICES = { perConfirmed: 0, perDelivered: 150, perUpsell: 50, monthly: 0, bonusRate: { min: 70, amount: 20 }, bonusVolume: { above: 0, amount: 0 } };
const order = (ctx: Ctx, productId: number, phone: string) =>
  call('orders.create', ctx, { customerName: 'Client', phone, wilayaId: 31, commune: 'Oran', items: [{ productId, variantId: null, qty: 1 }] }) as Promise<any>;



test('agency Dashboard and Analyse: its orders only, the team for the chief, an agent his own row and rank', async () => {
  const { t, p } = await server();
  const shop = await store(t, p, 'Boutique Oran', 'karim@oran.dz');
  const ag = await agency(t, 'Agence Rapide', 'samir@agence.dz');
  const chief = await as(t, ag.id, 'samir@agence.dz', PW);
  await call('agency.prices', chief, { prices: PRICES });
  await p('p.agencies.verify', { id: ag.id, verified: true });
  const admin = await as(t, shop.id, 'karim@oran.dz', PW);
  const { id: linkId } = (await call('partners.request', admin, { agencyId: ag.id, tasks: ['confirmation', 'suivi'], products: [shop.products.VELO] })) as any;
  await call('agency.answer', chief, { id: linkId, accept: true });
  const nora: any = await call('users.create', chief, { phone: tph(), name: 'Nora', email: 'nora@agence.dz', password: PW, roles: ['confirmation'] });
  const lina: any = await call('users.create', chief, { phone: tph(), name: 'Lina', email: 'lina@agence.dz', password: PW, roles: ['confirmation'] });
  await call('agency.setAgents', chief, { id: linkId, people: [nora.id, lina.id] });
  const inStore = async (email: string) => Number((await shop.db.query('SELECT id FROM profiles WHERE email = $1', [email]))[0].id);
  const [noraS, linaS] = [await inStore('nora@agence.dz'), await inStore('lina@agence.dz')];

  // three orders for the agency (Vélo), one the store keeps (Poussette)
  const o1 = await order(admin, shop.products.VELO, '0661000201');
  const o2 = await order(admin, shop.products.VELO, '0661000202');
  const o3 = await order(admin, shop.products.VELO, '0661000203');
  await order(admin, shop.products.POUS, '0661000204');
  // Nora confirmed o1 (delivered since, with an upsell); Lina cancelled o2; o3 waits for someone
  await shop.db.query(`UPDATE orders SET agent_id = $2, conf_status = 'confirmed', confirmed_at = now(), follow_status = 'delivered', delivered_at = now(), has_upsell = true, total = 12000 WHERE id = $1`, [o1.id, noraS]);
  await shop.db.query(`UPDATE orders SET agent_id = $2, conf_status = 'cancelled' WHERE id = $1`, [o2.id, linaS]);
  await shop.db.query(`INSERT INTO order_events (order_id, user_id, kind, from_value, to_value) VALUES ($1, $2, 'conf_status', 'new', 'confirmed'), ($3, $4, 'conf_status', 'new', 'no_answer'), ($3, $4, 'conf_status', 'no_answer', 'cancelled')`, [o1.id, noraS, o2.id, linaS]);
  const today = { from: new Date(Date.now() - 6 * 3_600_000).toISOString(), to: new Date(Date.now() + 3_600_000).toISOString() };

  // the chief: the team, its orders only (the store's Poussette is not counted)
  const d: any = await call('agency.dash', chief, today);
  assert.equal(d.lead, true);
  assert.deepEqual([d.team.received, d.team.confirmed, d.team.cancelled, d.team.pending, d.team.delivered, d.team.upsells], [3, 1, 1, 1, 1, 1]);
  assert.equal(d.team.confRate, 0.5);
  assert.equal(d.team.revenue, 12000);
  assert.deepEqual([d.now.toCall, d.now.unassigned], [1, 1]);
  const row = (n: string) => d.agents.find((a: any) => a.name === n);
  assert.deepEqual([row('Nora').received, row('Nora').confirmed, row('Nora').calls, row('Nora').delivered], [1, 1, 1, 1]);
  assert.deepEqual([row('Lina').cancelled, row('Lina').calls, row('Lina').confRate], [1, 2, 0]);

  // Nora: her own orders and her own row only, with her rank (first of two on the confirmation rate)
  const noraCtx = await as(t, ag.id, 'nora@agence.dz', PW);
  const m: any = await call('agency.dash', noraCtx, today);
  assert.equal(m.lead, false);
  assert.deepEqual(m.agents.map((a: any) => a.name), ['Nora']);
  assert.deepEqual([m.team.received, m.team.confirmed, m.team.cancelled], [1, 1, 0]);
  assert.deepEqual(m.rank, { rank: 1, of: 2 });
  assert.equal(m.now.toCall, 0);
  // Analyse is for the chief and the agent managers
  await assert.rejects(call('agency.analytics', noraCtx, today), /Accès refusé|refus/i);
  // a store cannot ask
  await assert.rejects(call('agency.dash', admin, today), /agences de confirmation/);

  // the chief's Analyse: per seller, product (its name), wilaya and agent
  const a: any = await call('agency.analytics', chief, today);
  assert.deepEqual(a.sellers.map((s: any) => [s.name, s.received, s.delivered]), [['Boutique Oran', 3, 1]]);
  assert.deepEqual(a.products.map((x: any) => [x.name, x.received]), [['Vélo', 3]]);
  assert.equal(a.wilayas[0].name, '31 · Oran');
  assert.deepEqual(a.agents.map((x: any) => x.name).sort(), ['Lina', 'Nora']);
  // the seller chosen at the top of the page: another store → nothing
  const other: any = await call('agency.analytics', { ...chief, seller: shop.id + 999 }, today);
  assert.equal(other.team.received, 0);
  assert.equal((await call('agency.analytics', { ...chief, seller: shop.id }, today) as any).team.received, 3);
});
