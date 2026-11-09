import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, type Ctx, type Db } from '../index';
import { runCourier } from '../couriers';
import { DEMO_ACCOUNTS } from '@pilotix/shared';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;
before(async () => { ({ db, as } = await setup(2400, true)); });

async function parcel() {
  const p = (await db.query(`SELECT o.id FROM orders o JOIN delivery_companies c ON c.id = o.company_id
    WHERE o.shipped_at IS NOT NULL AND o.tracking IS NOT NULL AND o.follow_status = 'shipped'
      AND c.kind <> 'own' ORDER BY o.id LIMIT 1`))[0];
  assert.ok(p, 'a tracked parcel in the demo');
  return Number(p.id);
}

test('demo data includes every demo account, a larger catalog, claims and completed swaps', async (t) => {
  for (const a of DEMO_ACCOUNTS) assert.ok((await as(a.email)).session.profile.id);
  const counts = (await db.query(`SELECT (SELECT count(*) FROM products)::int AS products,
    (SELECT count(*) FROM orders)::int AS orders, (SELECT count(*) FROM claims)::int AS claims,
    (SELECT count(*) FROM orders WHERE sub_status = 'annule_swappe')::int AS swaps`))[0];
  t.diagnostic(JSON.stringify(counts));
  assert.ok(Number(counts.products) >= 16);
  assert.ok(Number(counts.orders) >= 2400);
  assert.ok(Number(counts.claims) >= 20);
  assert.ok(Number(counts.swaps) > 0);
});

test('a fake API failure changes no order, event, or tracking value', async () => {
  const ctx = await as(EMAILS.suivi);
  const orderId = await parcel();
  const before = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  const events = await db.query('SELECT * FROM order_events WHERE order_id = $1 ORDER BY id', [orderId]);
  const r: any = await call('delivery.demoScenario', ctx, { orderId, status: 'error' });
  assert.equal(r.changed, 0);
  assert.match(r.error, /503/);
  assert.deepEqual(await db.query('SELECT * FROM orders WHERE id = $1', [orderId]), before);
  assert.deepEqual(await db.query('SELECT * FROM order_events WHERE order_id = $1 ORDER BY id', [orderId]), events);
});

test('fake tracking creates an alert and a claim, cancellation keeps its parcel available for swap', async () => {
  const ctx = await as(EMAILS.suivi);
  const orderId = await parcel();
  await call('delivery.demoScenario', ctx, { orderId, status: 'alert' });
  assert.equal((await call('orders.get', ctx, { id: orderId }) as any).followStatus, 'alert');
  const claim: any = await call('suivi.claimCreate', ctx, { orderId, reason: 'relivrer', details: 'Démo : client joint', message: 'Merci de relivrer', viaApi: true });
  assert.ok(claim.id);
  await call('suivi.act', ctx, { id: orderId, action: 'cancel', by: 'client', note: 'Démo : client annule' });
  const o: any = await call('orders.get', ctx, { id: orderId });
  assert.equal(o.followStatus, 'returning');
  const list: any = await call('suivi.list', ctx, { tab: 'swap', pageSize: 500 });
  assert.ok(list.rows.some((x: any) => x.id === orderId));
});

test('fake delivery uses normal tracking rules and refuses to change a finished parcel again', async () => {
  const ctx = await as(EMAILS.suivi);
  const orderId = await parcel();
  await call('delivery.demoScenario', ctx, { orderId, status: 'delivered' });
  assert.equal((await call('orders.get', ctx, { id: orderId }) as any).followStatus, 'delivered');
  await assert.rejects(call('delivery.demoScenario', ctx, { orderId, status: 'alert' }));
});

test('production contexts reject simulation before accessing orders or calling a courier', async () => {
  const demo = await as(EMAILS.admin);
  let touched = false;
  const dbGuard = { query: async () => { touched = true; throw new Error('must not read'); } } as unknown as Db;
  const shop = { id: 9, slug: 'real', primary: false, features: null, locked: false, demo: false, maxUsers: null, maxDrivers: null };
  const courier = async () => { touched = true; throw new Error('must not call'); };
  for (const ctx of [{ ...demo, db: dbGuard, shop }, { ...demo, db: dbGuard, server: { courier, meta: courier, hashPassword: async () => '' } }]) {
    await assert.rejects(call('delivery.demoScenario', ctx, { orderId: 1, status: 'alert' }), /démo/);
    assert.equal(touched, false);
  }
});

test('confirmation, marketer and driver cannot invoke courier scenarios', async () => {
  for (const email of [EMAILS.conf, EMAILS.marketer, EMAILS.livreur]) {
    await assert.rejects(call('delivery.demoScenario', await as(email), { orderId: 1, status: 'alert' }));
  }
});

test('real adapter entry refuses demo credentials even with server hooks', async () => {
  const ctx = await as(EMAILS.admin);
  const company = (await db.query("SELECT id FROM delivery_companies WHERE credentials->>'demo' = 'true' LIMIT 1"))[0];
  assert.ok(company);
  await assert.rejects(runCourier('test', { companyId: Number(company.id) }, ctx), /Identifiants démo/);
});
