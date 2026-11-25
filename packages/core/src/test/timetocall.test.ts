// « C'est l'heure d'appeler » (owner's rule, 25 Nov 2026: « follow the chrono: when it's green it's time to call »): an
// unanswered order (Occupé, Pas de réponse) gets its next try at the start of the next call slot of the seller's calling
// hours, as its chrono shows; then its own agent is told once — one line for all his orders whose try came. A callback
// (À rappeler, Reportée) is told at its time. An agency's agent hears both in his agency, by the agency's rule
// (Réglages › Notifications, one notification at a time like the seller's page); the timing stays the seller's.
// (helpers copied from agencyassign.test.ts)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { algiersDayStart } from '@pilotix/shared';
import { call, Ctx, login, migrate, migrateAll, num, PCtx, pgliteTenancy, platformCall, seedBase, setSetting, shopCtx, shopStatus, staffLogin, Tenancy } from '../index';
import { confirmSignup, loadShop, passwordFromLink, startSignup } from '../platform';
import { inboxRun } from '../modules/inbox';
import { EMAILS, setup } from './harness';

const H = 3_600_000;
const SLOTS = [
  { key: 'morning', from: 9, to: 12 },
  { key: 'midday', from: 12, to: 16 },
  { key: 'evening', from: 16, to: 21 },
];
const CALLS = { slots: SLOTS, tries: 3, firstMinutes: 15, paceMinutes: 5, cancelAfterNoAnswer: 0 };
/** today in Algiers at this hour (a simulated clock: the test does not depend on when it runs) */
const today = (hours: number) => algiersDayStart(Date.now()) + hours * H;
const at = (ctx: Ctx, t: number): Ctx => ({ ...ctx, now: () => t });
const iso = (t: number) => new Date(t).toISOString();

test('the seller’s own agent: one line at the start of the slot for all his unanswered orders, once; the next slot again', async () => {
  const { db, as } = await setup(60);
  const admin = await as(EMAILS.admin);
  const samira = await as(EMAILS.conf);
  const S = samira.session.profile.id;
  await setSetting(db, 'calls', CALLS);
  // only the orders of this test wait for a try
  await db.query(`UPDATE orders SET agent_id = NULL WHERE conf_status IN ('busy', 'no_answer')`);
  const two = (await db.query(`SELECT id, ref, customer_name FROM orders WHERE conf_status = 'new' ORDER BY id LIMIT 2`)).map((r: any) => ({ id: num(r.id), ref: String(r.ref), name: String(r.customer_name ?? '').trim() }));
  await db.query(`UPDATE orders SET conf_status = 'busy', attempts = 1, next_call_at = NULL, last_call_at = $2, agent_id = $3 WHERE id = $1`, [two[0].id, iso(today(10)), S]);
  await db.query(`UPDATE orders SET conf_status = 'no_answer', attempts = 1, next_call_at = NULL, last_call_at = $2, agent_id = $3 WHERE id = $1`, [two[1].id, iso(today(10.5)), S]);
  const lines = async () => ((await call('inbox.list', samira, {})) as any).items.filter((x: any) => x.kind === 'callback');

  // 11:30: still the morning slot where she called them: grey chrono, nothing
  assert.equal((await inboxRun(at(admin, today(11.5)))).due, 0);
  assert.equal((await lines()).length, 0);
  // 12:05: the midday slot opened, the chrono is green: one line for both
  assert.equal((await inboxRun(at(admin, today(12) + 5 * 60_000))).due, 1);
  const l1 = await lines();
  assert.equal(l1.length, 1);
  assert.equal(l1[0].title, '📞 2 commandes à appeler maintenant');
  assert.equal(l1[0].n, 2);
  assert.match(l1[0].body, new RegExp(`${two[0].ref}, ${two[1].ref}`));
  assert.equal(l1[0].important, true);
  // told once in the slot
  assert.equal((await inboxRun(at(admin, today(12) + 6 * 60_000))).due, 0);
  assert.equal((await lines()).length, 1);
  // 16:05: not called since: the evening slot tells her again; one of them only
  await db.query(`UPDATE orders SET conf_status = 'confirmed' WHERE id = $1`, [two[1].id]);
  assert.equal((await inboxRun(at(admin, today(16) + 5 * 60_000))).due, 1);
  const l2 = await lines();
  assert.equal(l2.length, 2);
  assert.equal(l2[0].title, `📞 Rappeler ${two[0].name || two[0].ref} maintenant`);
  assert.equal(l2[0].body, `${two[0].ref} · appel n° 2`);
  assert.equal(l2[0].orderId, two[0].id);
  // a server back 40 minutes into a slot stays quiet (the start is past)
  await setSetting(db, 'dueRings', { slot: 0, calls: {} });
  assert.equal((await inboxRun(at(admin, today(16) + 40 * 60_000))).due, 0);
  // called in this slot: its next try is the next slot, not now
  await db.query(`UPDATE orders SET attempts = 2, last_call_at = $2 WHERE id = $1`, [two[0].id, iso(today(16) + 10 * 60_000)]);
  await setSetting(db, 'dueRings', { slot: 0, calls: {} });
  assert.equal((await inboxRun(at(admin, today(16) + 15 * 60_000))).due, 0);
  // the seller turned « C'est l'heure d'appeler » off: nothing
  await db.query(`UPDATE orders SET attempts = 1, last_call_at = $2 WHERE id = $1`, [two[0].id, iso(today(10))]);
  await call('notify.set', admin, { rules: { callback: { on: false, who: ['agent'], people: [], phone: 'always' } } });
  await setSetting(db, 'dueRings', { slot: 0, calls: {} });
  assert.equal((await inboxRun(at(admin, today(12) + 5 * 60_000))).due, 0);
  // never at midnight: a slot from 00:00 (the whole day) has no start to ring at
  await call('notify.set', admin, { rules: { callback: { on: true, who: ['agent'], people: [], phone: 'always' } } });
  await setSetting(db, 'calls', { ...CALLS, slots: [{ key: 'all', from: 0, to: 24 }] });
  await setSetting(db, 'dueRings', { slot: 0, calls: {} });
  assert.equal((await inboxRun(at(admin, today(0) + 5 * 60_000))).due, 0);
});

// ---------------------------------------------------------------- an agency's agent
let phoneN = 0;
const tph = () => `072${String(++phoneN).padStart(7, '0')}`;
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
  return { id: s.id, schema: s.schema, db, products: ids as Record<'VELO' | 'POUS', number> };
}
async function agency(t: Tenancy, name: string, email: string) {
  const mail = await startSignup(t, { name: 'Samir', email, phone: tph(), password: PW, storeName: name, language: 'fr', terms: true, kind: 'agency' }, null);
  const made: any = await confirmSignup(t, (mail as any).token);
  return { id: made.shop.id as number, schema: made.shop.schema as string };
}
const PRICES = { perConfirmed: 0, perDelivered: 150, perUpsell: 50, monthly: 0, bonusRate: { min: 70, amount: 20 }, bonusVolume: { above: 0, amount: 0 } };

test('an agency’s agent: the seller’s chrono rings him in his agency, by the agency’s rule; one notification at a time on its page', async () => {
  const { t, p } = await server();
  const shop = await store(t, p, 'Boutique Blida', 'karim@blida.dz');
  const ag = await agency(t, 'Agence Appel', 'samir@appel.dz');
  const chief = await as(t, ag.id, 'samir@appel.dz', PW);
  await call('agency.prices', chief, { prices: PRICES });
  await p('p.agencies.verify', { id: ag.id, verified: true });
  const admin = await as(t, shop.id, 'karim@blida.dz', PW);
  const { id: linkId } = (await call('partners.request', admin, { agencyId: ag.id, tasks: ['confirmation'], products: [shop.products.VELO] })) as any;
  await call('agency.answer', chief, { id: linkId, accept: true });
  const nora: any = await call('users.create', chief, { phone: tph(), name: 'Nora', email: 'nora@appel.dz', password: PW, roles: ['confirmation'] });
  await call('agency.setAgents', chief, { id: linkId, people: [nora.id] });
  const noraS = Number((await shop.db.query('SELECT id FROM profiles WHERE email = $1', ['nora@appel.dz']))[0].id);
  const noraAg = await as(t, ag.id, 'nora@appel.dz', PW);
  const lines = async () => ((await call('inbox.list', noraAg, {})) as any).items.filter((x: any) => x.kind === 'callback');
  // the timing is the seller's: his calling hours
  await setSetting(shop.db, 'calls', CALLS);
  const o: any = await call('orders.create', admin, { customerName: 'Client', phone: '0661000300', wilayaId: 31, commune: 'Oran', items: [{ productId: shop.products.VELO, variantId: null, qty: 1 }] });
  await shop.db.query(`UPDATE orders SET conf_status = 'busy', attempts = 1, next_call_at = NULL, last_call_at = $2, agent_id = $3 WHERE id = $1`, [o.id, iso(today(10)), noraS]);

  // the page: each notification on its own, « C'est l'heure d'appeler » to the order's agent by default
  const g: any = await call('agency.notify.get', chief, {});
  const due = g.kinds.find((k: any) => k.kind === 'due');
  assert.deepEqual(due.rule, { on: true, roles: ['confirmation'], people: [], phone: 'always' });
  assert.deepEqual(due.can, ['confirmation', 'agent_manager', 'admin']);
  assert.deepEqual(g.kinds.find((k: any) => k.kind === 'delivered').rule.roles, ['confirmation', 'suivi']);
  assert.equal(g.kinds.some((k: any) => k.kind === 'follow'), false, 'a service the agency does not have: not shown');
  await assert.rejects(call('agency.notify.get', admin, {}));
  await assert.rejects(call('agency.notify.set', noraAg, { rules: {} }));

  // 12:05 at the seller's: Nora's chrono is green — she hears it in her agency, once
  await inboxRun(at(admin, today(12) + 5 * 60_000));
  const l1 = await lines();
  assert.equal(l1.length, 1);
  assert.equal(l1[0].title, 'C’est l’heure d’appeler');
  assert.match(l1[0].body, new RegExp(o.ref));
  await inboxRun(at(admin, today(12) + 6 * 60_000));
  assert.equal((await lines()).length, 1);

  // a callback she set: at its time, once
  const cb = today(14);
  await shop.db.query(`UPDATE orders SET conf_status = 'callback', next_call_at = $2 WHERE id = $1`, [o.id, iso(cb)]);
  await inboxRun(at(admin, cb + 60_000));
  await inboxRun(at(admin, cb + 2 * 60_000));
  const l2 = await lines();
  assert.equal(l2.length, 2);
  assert.match(l2[0].body, /14:00/);

  // the agency turns it off: nothing any more
  await call('agency.notify.set', chief, { rules: { due: { on: false, roles: ['confirmation'], people: [], phone: 'work' } } });
  assert.equal(((await call('agency.notify.get', chief, {})) as any).kinds.find((k: any) => k.kind === 'due').rule.on, false);
  const cb2 = today(15);
  await shop.db.query(`UPDATE orders SET next_call_at = $2 WHERE id = $1`, [o.id, iso(cb2)]);
  await inboxRun(at(admin, cb2 + 60_000));
  assert.equal((await lines()).length, 2);
  // a role this notification cannot go to is refused
  await assert.rejects(call('agency.notify.set', chief, { rules: { order: { on: true, roles: ['suivi'], people: [], phone: 'work' } } }), /incompatible/);
  // a service the agency does not have cannot be turned on
  await assert.rejects(call('agency.notify.set', chief, { rules: { alert: { on: true, roles: ['suivi'], people: [], phone: 'work' } } }), /pas confié/);

  // the older page's save of a group wins over the one-by-one page's kinds of that group
  await call('agency.notify.set', chief, { rules: { order: { on: false, roles: ['confirmation'], people: [], phone: 'never' } } });
  assert.equal(((await call('agency.notify.get', chief, {})) as any).kinds.find((k: any) => k.kind === 'order').rule.on, false);
  await call('agency.notifications.set', chief, { rules: { order: ['confirmation'] } });
  assert.deepEqual(((await call('agency.notify.get', chief, {})) as any).kinds.find((k: any) => k.kind === 'order').rule, { on: true, roles: ['confirmation'], people: [], phone: 'always' });
});
