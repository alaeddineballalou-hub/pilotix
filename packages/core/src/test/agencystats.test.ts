// Agency Dashboard and Analyse & statistiques. (helpers copied from agencies.test.ts) Confirmation agencies: an agency signs up, Pilotix checks it, it finds a store by code (or the store finds it), the
// other side accepts; only the agency sets prices, only the store gives products and tasks; orders go by their first
// product; the agency's agents work inside the store on its orders only; numbers, bills, suspension, the end.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanCode, DEFAULT_MANAGEMENT_PLAN } from '@pilotix/shared';
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
  // the team's ladder: her own name only, the others' numbers without names
  assert.equal(m.ladder.by, 'conf');
  assert.deepEqual(m.ladder.rows.map((x: any) => [x.pos, x.me, x.name]), [[1, true, 'Nora'], [2, false, null]]);
  // each line's numbers are the rate's own: confirmed out of confirmed + cancelled
  for (const x of m.ladder.rows) if (x.b > 0) assert.equal(x.rate, x.a / x.b);
  assert.ok(!JSON.stringify(m).includes('Lina'), 'no other agent named anywhere');
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
  // the money (the chief): what each seller owes for each month of the period, as Facturation
  assert.ok(a.earnings);
  assert.deepEqual(a.earnings.sellers.map((x: any) => x.name), ['Boutique Oran']);
  assert.ok(a.earnings.months.includes(a.earnings.current));
  const bill: any = await call('agency.billing', chief, { month: a.earnings.current });
  assert.equal(a.earnings.sellers[0].months[a.earnings.current].total, bill.rows[0].bill.total, 'the same amount as Facturation');
  // the seller chosen at the top of the page: another store → nothing
  const other: any = await call('agency.analytics', { ...chief, seller: shop.id + 999 }, today);
  assert.equal(other.team.received, 0);
  assert.equal((await call('agency.analytics', { ...chief, seller: shop.id }, today) as any).team.received, 3);
});

/** An agent pay plan: a fixed amount per delivered order (and a monthly salary). */
const payPlan = (task: 'confirmation' | 'suivi', rate: number, monthly = 0) => ({ ...structuredClone(DEFAULT_MANAGEMENT_PLAN), agentTask: task, method: 'fixed' as const, trigger: 'delivered' as const, rate, monthly });

test('agency Dashboard: the chief\'s money (billed to the sellers − the agents\' pay = profit), each seller, each user his own numbers', async () => {
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
  const ali: any = await call('users.create', chief, { phone: tph(), name: 'Ali', email: 'ali@agence.dz', password: PW, roles: ['suivi'] });
  await call('users.create', chief, { phone: tph(), name: 'Riad', email: 'riad@agence.dz', password: PW, roles: ['agent_manager'] });
  await call('agency.setAgents', chief, { id: linkId, people: [nora.id, ali.id] });
  // their pay: Nora 100 DA per delivered order she confirmed; Ali 40 DA per delivered parcel he followed + 20 000 DA a month
  const conf: any = await call('management.planSave', chief, { name: 'Conf 100', kind: 'agent', configuration: payPlan('confirmation', 100) });
  const suivi: any = await call('management.planSave', chief, { name: 'Suivi 40', kind: 'agent', configuration: payPlan('suivi', 40, 20000) });
  await call('pay.assign', chief, { personId: nora.id, task: 'confirmation', planId: conf.id });
  await call('pay.assign', chief, { personId: ali.id, task: 'suivi', planId: suivi.id });
  // given before this month (so this month's salary counts)
  await chief.db.query(`UPDATE pay_plan_terms SET effective_at = now() - interval '40 days'`);
  const inStore = async (email: string) => Number((await shop.db.query('SELECT id FROM profiles WHERE email = $1', [email]))[0].id);
  const [noraS, aliS] = [await inStore('nora@agence.dz'), await inStore('ali@agence.dz')];

  // Nora confirmed three orders: two delivered (Ali followed them, one with an upsell), one cancelled
  const os = [await order(admin, shop.products.VELO, '0661000301'), await order(admin, shop.products.VELO, '0661000302'), await order(admin, shop.products.VELO, '0661000303')];
  for (const [i, o] of os.slice(0, 2).entries())
    await shop.db.query(
      `UPDATE orders SET agent_id = $2, follow_agent_id = $3, conf_agency_id = $4, follow_agency_id = $4, conf_status = 'confirmed', confirmed_at = now(), follow_status = 'delivered', delivered_at = now(), has_upsell = $5, total = 9000 WHERE id = $1`,
      [o.id, noraS, aliS, ag.id, i === 0],
    );
  await shop.db.query(`UPDATE orders SET agent_id = $2, conf_status = 'cancelled' WHERE id = $1`, [os[2].id, noraS]);
  const today = { from: new Date(Date.now() - 6 * 3_600_000).toISOString(), to: new Date(Date.now() + 3_600_000).toISOString() };

  // the leads: each seller's numbers over the period
  const d: any = await call('agency.dash', chief, today);
  assert.deepEqual(d.bySeller.map((s: any) => [s.name, s.received, s.confirmed, s.delivered, s.upsells, s.upsellRate]), [['Boutique Oran', 3, 2, 2, 1, 0.5]]);
  assert.equal(d.prevMe, null);
  const riad = await as(t, ag.id, 'riad@agence.dz', PW);
  assert.equal(((await call('agency.dash', riad, today)) as any).bySeller.length, 1, 'an agent manager sees the sellers too');

  // the chief's money of the month: the bill (as Facturation) − the agents' pay (as Paie) = the profit
  // this month, in Algiers
  const month = new Date(Date.now() + 3_600_000).toISOString().slice(0, 7);
  const bill: any = await call('agency.billing', chief, { month });
  const billed = bill.rows[0].bill.total;
  assert.ok(billed > 0);
  const m: any = await call('agency.money', chief, { month });
  assert.equal(m.earned, billed, 'the same amount as Facturation');
  assert.deepEqual([m.commissions, m.salaries, m.cost], [280, 20000, 20280], 'Nora 2 × 100, Ali 2 × 40 + his salary');
  assert.equal(m.profit, billed - 20280);
  assert.equal(m.margin, (billed - 20280) / billed);
  assert.deepEqual(m.sellers.map((s: any) => [s.name, s.earned, s.cost, s.profit]), [['Boutique Oran', billed, 280, billed - 280]]);
  assert.deepEqual(m.agents.map((a: any) => [a.name, a.orders, a.commissions, a.salary, a.total]), [['Ali', 2, 80, 20000, 20080], ['Nora', 2, 200, 0, 200]]);
  // the seller chosen at the top of the page: his part only (the salaries belong to no seller); another seller: nothing
  const own: any = await call('agency.money', { ...chief, seller: shop.id }, { month });
  assert.deepEqual([own.earned, own.commissions, own.salaries, own.cost], [billed, 280, null, 280]);
  const none: any = await call('agency.money', { ...chief, seller: shop.id + 999 }, { month });
  assert.deepEqual([none.earned, none.cost, none.sellers.length], [0, 0, 0]);
  // the chief only; never a month to come
  const noraCtx = await as(t, ag.id, 'nora@agence.dz', PW);
  await assert.rejects(call('agency.money', noraCtx, { month }), /Accès refusé|refus/i);
  await assert.rejects(call('agency.money', riad, { month }), /Accès refusé|refus/i);
  const next = `${Number(month.slice(0, 4)) + 1}-01`;
  await assert.rejects(call('agency.money', chief, { month: next }), /pas encore commencé/);

  // each agent: his own job's numbers, and his own of the period before (to compare)
  const nd: any = await call('agency.dash', noraCtx, today);
  assert.deepEqual([nd.agents[0].received, nd.agents[0].confirmed, nd.agents[0].cancelled, nd.agents[0].upsells], [3, 2, 1, 1]);
  assert.equal(nd.prevMe.received, 0);
  assert.deepEqual(nd.bySeller, []);
  const ad: any = await call('agency.dash', await as(t, ag.id, 'ali@agence.dz', PW), today);
  assert.deepEqual([ad.agents[0].followDelivered, ad.agents[0].followReturned, ad.agents[0].followRate], [2, 0, 1]);
  assert.equal(ad.ladder.by, 'follow');
});

test('agency Co-Pilot: the agency\'s orders in its sellers\' stores, each person his part (the chief, a manager, his own orders or parcels)', async () => {
  const { t, p } = await server();
  const shop = await store(t, p, 'Boutique Blida', 'karim@blida.dz');
  const ag = await agency(t, 'Agence Nord', 'samir@nord.dz');
  const chief = await as(t, ag.id, 'samir@nord.dz', PW);
  await call('agency.prices', chief, { prices: PRICES });
  await p('p.agencies.verify', { id: ag.id, verified: true });
  const admin = await as(t, shop.id, 'karim@blida.dz', PW);
  const { id: linkId } = (await call('partners.request', admin, { agencyId: ag.id, tasks: ['confirmation', 'suivi'], products: [shop.products.VELO] })) as any;
  await call('agency.answer', chief, { id: linkId, accept: true });
  const nora: any = await call('users.create', chief, { phone: tph(), name: 'Nora', email: 'nora@nord.dz', password: PW, roles: ['confirmation'] });
  const ali: any = await call('users.create', chief, { phone: tph(), name: 'Ali', email: 'ali@nord.dz', password: PW, roles: ['suivi'] });
  await call('users.create', chief, { phone: tph(), name: 'Riad', email: 'riad@nord.dz', password: PW, roles: ['agent_manager'] });
  await call('agency.setAgents', chief, { id: linkId, people: [nora.id, ali.id] });
  const inStore = async (email: string) => Number((await shop.db.query('SELECT id FROM profiles WHERE email = $1', [email]))[0].id);
  const [noraS, aliS] = [await inStore('nora@nord.dz'), await inStore('ali@nord.dz')];

  // the agency's orders: three not called for 3 hours (two given to Nora, one to nobody), a callback of Nora's 2 hours
  // late, a parcel of Ali's with no news for 5 days, an alert of his; and an order the store keeps (not the agency's)
  const os = [];
  for (let i = 0; i < 6; i++) os.push(await order(admin, shop.products.VELO, `066100040${i}`));
  const own = await order(admin, shop.products.POUS, '0661000499');
  const set = (id: number, sql: string, params: unknown[] = []) => shop.db.query(`UPDATE orders SET ${sql} WHERE id = $1`, [id, ...params]);
  for (const [i, who] of [noraS, noraS, null].entries()) await set(os[i].id, `conf_status = 'new', attempts = 0, created_at = now() - interval '3 hours', agent_id = $2, conf_agency_id = $3`, [who, ag.id]);
  await set(os[3].id, `conf_status = 'callback', next_call_at = now() - interval '2 hours', agent_id = $2, conf_agency_id = $3`, [noraS, ag.id]);
  await set(os[4].id, `conf_status = 'confirmed', follow_status = 'shipped', shipped_at = now() - interval '10 days', ext_status_at = now() - interval '5 days', follow_agent_id = $2, follow_agency_id = $3`, [aliS, ag.id]);
  await set(os[5].id, `conf_status = 'confirmed', follow_status = 'alert', sub_status = NULL, shipped_at = now() - interval '1 day', follow_agent_id = $2, follow_agency_id = $3`, [aliS, ag.id]);
  await set(own.id, `conf_status = 'new', attempts = 0, created_at = now() - interval '3 hours', conf_agency_id = NULL, follow_agency_id = NULL`);

  const doc = async (ctx: Ctx) => {
    const r: any = await call('stats.doctor', ctx, {});
    return { r, of: (id: string) => r.items.find((x: any) => x.id === id) };
  };
  // the chief: the whole agency (the store's own order is not his), with the order given to nobody and the agents' pay
  const c = await doc(chief);
  assert.deepEqual(c.r.scope, { whole: true, mine: false, agency: true });
  assert.equal(c.of('notCalled').params.count, 3);
  assert.equal(c.of('lateCallbacks').params.count, 1);
  assert.equal(c.of('agUnassigned').params.count, 1);
  assert.equal(c.of('stuckParcels').params.count, 1);
  assert.equal(c.of('openAlerts').params.count, 1);
  assert.deepEqual(c.of('agPayNoPlan').list.map((x: any) => x.label).sort(), ['Ali', 'Nora'], 'no pay plan yet');
  assert.ok(c.r.score < 100);
  // an agent manager: the team's calls and parcels, not the pay nor the assignment
  const m = await doc(await as(t, ag.id, 'riad@nord.dz', PW));
  assert.deepEqual(m.r.scope, { whole: false, mine: false, agency: true });
  assert.equal(m.of('notCalled').params.count, 3);
  assert.equal(m.of('openAlerts').params.count, 1);
  assert.equal(m.of('agUnassigned'), undefined);
  assert.equal(m.of('agPayNoPlan'), undefined);
  // Nora: her own orders only (no parcels: she does not follow any)
  const n = await doc(await as(t, ag.id, 'nora@nord.dz', PW));
  assert.deepEqual(n.r.scope, { whole: false, mine: true, agency: true });
  assert.equal(n.of('notCalled').params.count, 2);
  assert.equal(n.of('lateCallbacks').params.count, 1);
  assert.equal(n.of('meVsTeam').level, 'info', 'not enough calls yet to compare');
  assert.equal(n.of('stuckParcels'), undefined);
  // Ali: his own parcels only
  const a = await doc(await as(t, ag.id, 'ali@nord.dz', PW));
  assert.deepEqual(a.r.scope, { whole: false, mine: true, agency: true });
  assert.equal(a.of('stuckParcels').params.count, 1);
  assert.equal(a.of('openAlerts').params.count, 1);
  assert.equal(a.of('notCalled'), undefined);
  // another seller chosen at the top of the page: nothing of this store
  assert.equal((await doc({ ...chief, seller: shop.id + 999 })).of('notCalled').level, 'ok');
  // the store's own Co-Pilot is still the store's: its order the agency does not have counts there
  const own2: any = await call('stats.doctor', admin, {});
  assert.equal(own2.scope.agency, undefined);
  assert.equal(own2.items.find((x: any) => x.id === 'notCalled').params.count, 4, 'the store sees all its orders not called');
});
