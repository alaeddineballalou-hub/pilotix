// (helpers copied from agencies.test.ts) Confirmation agencies: an agency signs up, Pilotix checks it, it finds a store by code (or the store finds it), the
// other side accepts; only the agency sets prices, only the store gives products and tasks; orders go by their first
// product; the agency's agents work inside the store on its orders only; numbers, bills, suspension, the end.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanCode } from '@pilotix/shared';
import { call, Ctx, login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, shopCtx, shopStatus, staffLogin, Tenancy } from '../index';
import { confirmSignup, loadShop, membershipsOf, passwordFromLink, startSignup, storeChoices } from '../platform';
import { computePayroll } from '../modules/admin';
import { rotateTimes } from '../modules/assign';

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


test('the agency own Affectation: its orders in a store go to its own agents (on line in its space), the store orders stay with the store', async () => {
  const { t, p } = await server();
  const shop = await store(t, p, 'Boutique Oran', 'karim@oran.dz');
  const ag = await agency(t, 'Agence Rapide', 'samir@agence.dz');
  const chief = await as(t, ag.id, 'samir@agence.dz', PW);
  await call('agency.prices', chief, { prices: PRICES });
  await p('p.agencies.verify', { id: ag.id, verified: true });
  const admin = await as(t, shop.id, 'karim@oran.dz', PW);
  const { id: linkId } = (await call('partners.request', admin, { agencyId: ag.id, tasks: ['confirmation'], products: [shop.products.VELO] })) as any;
  await call('agency.answer', chief, { id: linkId, accept: true });
  const nora: any = await call('users.create', chief, { phone: tph(), name: 'Nora', email: 'nora@agence.dz', password: PW, roles: ['confirmation'] });
  const lina: any = await call('users.create', chief, { phone: tph(), name: 'Lina', email: 'lina@agence.dz', password: PW, roles: ['confirmation'] });
  await call('agency.setAgents', chief, { id: linkId, people: [nora.id, lina.id] });
  const inStore = async (email: string) => Number((await shop.db.query('SELECT id FROM profiles WHERE email = $1', [email]))[0].id);
  const [noraS, linaS] = [await inStore('nora@agence.dz'), await inStore('lina@agence.dz')];

  // a store cannot use it; Manuel by default: nobody is given anything
  await assert.rejects(call('agency.assign.get', admin, {}), /agences de confirmation/);
  const g: any = await call('agency.assign.get', chief, {});
  assert.equal(g.cfg.conf.mode, 'manual');
  assert.deepEqual(g.conf.map((x: any) => x.name).sort(), ['Lina', 'Nora', 'Samir'].sort().filter((n) => g.conf.some((x: any) => x.name === n)));
  assert.deepEqual(g.shops.map((s: any) => s.name), ['Boutique Oran']);
  const o0 = await order(admin, shop.products.VELO, '0661000100');
  assert.equal(o0.agentId, null);
  assert.equal((await call('agency.assign.get', chief, {}) as any).waiting.conf, 1);

  // Nora on line in the agency's space (Lina not): Tour de rôle
  await t.shop((await loadShop(t, { id: ag.id }))!.schema).query(`UPDATE profiles SET last_seen_at = now(), presence = 'online' WHERE email = 'nora@agence.dz'`);
  await call('agency.assign.set', chief, { ...g.cfg, conf: { ...g.cfg.conf, mode: 'turn', max: 0 } });
  const r: any = await call('agency.assign.run', chief, {});
  assert.equal(r.conf.assigned, 1, 'the waiting agency order is given now');
  assert.equal(Number((await shop.db.query('SELECT agent_id FROM orders WHERE id = $1', [o0.id]))[0].agent_id), noraS);
  const o1 = await order(admin, shop.products.VELO, '0661000101');
  assert.equal(o1.agentId, noraS, 'a new agency order goes to its agent at once');
  // the store's own order is not the agency's business (the store is on Manuel)
  const o2 = await order(admin, shop.products.POUS, '0661000102');
  assert.equal(o2.agentId, null);
  // Lina out of the split, Nora too: it waits
  await call('agency.assign.set', chief, { ...g.cfg, conf: { ...g.cfg.conf, mode: 'turn', max: 0 }, agents: { [nora.id]: { out: true, weight: 1, channels: [], products: [], from: null, to: null, langs: [], senior: false, shops: [], woman: false } } });
  assert.equal((await order(admin, shop.products.VELO, '0661000103')).agentId, null);
  void linaS;
});

test('the agency own rotation: a late agency order goes to its chosen agent (her account in the store), the countdown from the agency settings', async () => {
  const { t, p } = await server();
  const shop = await store(t, p, 'Boutique Sétif', 'karim@setif.dz');
  const ag = await agency(t, 'Agence Tour', 'samir@tour.dz');
  const chief = await as(t, ag.id, 'samir@tour.dz', PW);
  await call('agency.prices', chief, { prices: PRICES });
  await p('p.agencies.verify', { id: ag.id, verified: true });
  const admin = await as(t, shop.id, 'karim@setif.dz', PW);
  const { id: linkId } = (await call('partners.request', admin, { agencyId: ag.id, tasks: ['confirmation'], products: [shop.products.VELO] })) as any;
  await call('agency.answer', chief, { id: linkId, accept: true });
  const nora: any = await call('users.create', chief, { phone: tph(), name: 'Nora', email: 'nora@tour.dz', password: PW, roles: ['confirmation'] });
  const lina: any = await call('users.create', chief, { phone: tph(), name: 'Lina', email: 'lina@tour.dz', password: PW, roles: ['confirmation'] });
  await call('agency.setAgents', chief, { id: linkId, people: [nora.id, lina.id] });
  const inStore = async (email: string) => Number((await shop.db.query('SELECT id FROM profiles WHERE email = $1', [email]))[0].id);
  const [noraS, linaS] = [await inStore('nora@tour.dz'), await inStore('lina@tour.dz')];
  const adb = t.shop((await loadShop(t, { id: ag.id }))!.schema);
  const agentOf = async (id: number) => Number((await shop.db.query('SELECT agent_id FROM orders WHERE id = $1', [id]))[0].agent_id);
  // the agent's time counts in the store's call hours: all day here, so the test does not depend on the hour it runs
  await shop.db.query(`INSERT INTO settings (key, value) VALUES ('calls', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ slots: [{ key: 'all', from: 0, to: 24 }], tries: 3, firstMinutes: 15, paceMinutes: 5, cancelAfterNoAnswer: 0 })]);

  // only Nora on line: she gets the order; the rotation of the agency: 20 minutes, always to Lina
  await adb.query(`UPDATE profiles SET last_seen_at = now(), presence = 'online' WHERE email = 'nora@tour.dz'`);
  const g: any = await call('agency.assign.get', chief, {});
  const rotation = { on: true, statuses: ['new'], minutes: 20, noCall: true, toLeadAfter: 0, setStatus: '', target: lina.id };
  await call('agency.assign.set', chief, { ...g.cfg, conf: { ...g.cfg.conf, mode: 'turn', max: 0, rotation } });
  const o = await order(admin, shop.products.VELO, '0661000200');
  assert.equal(o.agentId, noraS);
  const at = (await rotateTimes(admin, 'conf', [o.id])).get(o.id);
  assert.ok(at && Math.abs(at - (Date.now() + 20 * 60_000)) < 2 * 60_000, 'the agency settings: 20 minutes');

  // on time: it stays; late, Lina on line: to Lina (her account in the store)
  assert.equal(((await call('agency.assign.run', chief, {})) as any).conf.moved, 0);
  await adb.query(`UPDATE profiles SET last_seen_at = now(), presence = 'online' WHERE email = 'lina@tour.dz'`);
  await shop.db.query(`UPDATE orders SET assigned_at = now() - interval '21 minutes' WHERE id = $1`, [o.id]);
  assert.equal(((await call('agency.assign.run', chief, {})) as any).conf.moved, 1);
  assert.equal(await agentOf(o.id), linaS);
  const ev = await shop.db.query(`SELECT from_value, to_value, data FROM order_events WHERE order_id = $1 AND kind = 'rotate'`, [o.id]);
  assert.equal(ev.length, 1);
  assert.equal(Number(ev[0].from_value), noraS);

  // the store's own orders never move with the agency's rotation (the store is on Manuel)
  const own = await order(admin, shop.products.POUS, '0661000201');
  await shop.db.query(`UPDATE orders SET agent_id = $2, assigned_at = now() - interval '3 hours' WHERE id = $1`, [own.id, noraS]);
  await call('agency.assign.run', chief, {});
  assert.equal(await agentOf(own.id), noraS);
  assert.equal((await rotateTimes(admin, 'conf', [own.id])).has(own.id), false);
});
