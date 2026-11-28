// Dépôt › Statistiques (the owner's design, 28 Nov 2026): one page for the whole depot — the orders sent, the median
// time from reaching the depot to leaving it, the late ones (over 48 h), the depot's errors (the same lines as
// « Erreurs de livraison ») ÷ the orders sent, what they cost, by type, by person; a tap opens the errors with the same
// filters. Only the depot's managers (Management › Alertes dépôt), the administrators and the seller see it.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, setSetting } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(300));
});

const P = { per: '30' } as const;
const H = 3_600_000;
const total = (xs: any[], k: string) => xs.reduce((n: number, x: any) => n + x[k], 0);

test('who sees it: the seller and the depot’s managers, never a plain depot agent', async () => {
  const karim = await as(EMAILS.depot);
  assert.deepEqual(await call('depot.statsOn', karim, {}), { on: false });
  await assert.rejects(call('depot.stats', karim, P), /Accès refusé/);
  await assert.rejects(call('depot.late', karim, P), /Accès refusé/);
  assert.deepEqual(await call('depot.statsOn', await as(EMAILS.vendeur), {}), { on: true });
  // Management › Alertes dépôt names him: he is one of the depot's managers
  await setSetting(db, 'depotAlerts', { to: [karim.session.profile.id] });
  const boss = await as(EMAILS.depot);
  assert.deepEqual(await call('depot.statsOn', boss, {}), { on: true });
  const s: any = await call('depot.stats', boss, P);
  assert.ok(s.sent >= 0);
  await setSetting(db, 'depotAlerts', { to: [] });
});

test('the lines add up to the cards, and the errors are « Erreurs de livraison »’s with the same filters', async () => {
  const seller = await as(EMAILS.vendeur);
  const karimId = (await as(EMAILS.depot)).session.profile.id;
  // a depot error found today on a parcel Karim prepared
  const [o] = await db.query(
    `SELECT o.id FROM orders o WHERE o.shipped_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM order_faults f WHERE f.order_id = o.id) ORDER BY o.id DESC LIMIT 1`,
  );
  await db.query(`INSERT INTO order_faults (order_id, moment, reason, team, person_id, cost, at) VALUES ($1, 'return', 'broken', 'depot', $2, 400, now())`, [o.id, karimId]);
  const s: any = await call('depot.stats', seller, P);
  assert.equal(total(s.people, 'prepared') + (s.none?.prepared ?? 0), s.sent, 'each order sent is someone’s, or « Sans nom »');
  assert.equal(total(s.people, 'errors') + (s.none?.errors ?? 0), s.errors);
  assert.equal(total(s.reasons, 'n'), s.errors);
  assert.ok(s.late <= s.sent && s.errors >= 1 && s.cost >= 400);
  // « Erreurs de livraison » with the same filters: the same lines
  const e: any = await call('faults.depot', seller, P);
  assert.equal(e.n, s.errors);
  assert.equal(e.cost, s.cost);
  const k: any = await call('faults.depot', seller, { ...P, agent: karimId });
  const ks = s.people.find((p: any) => p.id === karimId);
  assert.equal(k.n, ks.errors, 'a tap on Karim: his errors');
  const b: any = await call('faults.depot', seller, { ...P, reason: 'broken' });
  assert.equal(b.n, s.reasons.find((r: any) => r.reason === 'broken').n, 'a tap on « Arrivé cassé »: those errors');
  const none: any = await call('faults.depot', seller, { ...P, none: true });
  assert.equal(none.n, s.none?.errors ?? 0, 'a tap on « Sans nom »');
  assert.ok(e.agents.length > 0 && Array.isArray(e.products));
  // Karim alone: his orders and his errors
  const sk: any = await call('depot.stats', seller, { ...P, agent: karimId });
  assert.equal(sk.errors, ks.errors);
  assert.equal(sk.sent, ks.prepared);
  // a plain depot agent: his own errors only (« Mes erreurs »)
  const mine: any = await call('faults.depot', await as(EMAILS.depot), P);
  assert.equal(mine.scope, 'mine');
  assert.ok(mine.list.every((x: any) => x.mine));
  assert.equal(mine.agents, null);
  // the old way to ask (from / to) still works
  const old: any = await call('faults.depot', seller, { from: new Date(Date.now() - 30 * 24 * H).toISOString(), to: new Date(Date.now() + 24 * H).toISOString() });
  assert.ok(old.n >= 1);
});

test('« En retard »: over 48 h after reaching the depot, the slowest first; a wait for stock is not the depot’s', async () => {
  const seller = await as(EMAILS.vendeur);
  const now = Date.now();
  const [o] = await db.query(`SELECT id FROM orders WHERE NOT is_exchange AND shipped_at IS NOT NULL ORDER BY id LIMIT 1`);
  // confirmed 5 days ago, sent an hour ago
  await db.query(`UPDATE orders SET confirmed_at = $2, shipped_at = $3 WHERE id = $1`, [o.id, new Date(now - 5 * 24 * H).toISOString(), new Date(now - H).toISOString()]);
  await db.query(`DELETE FROM order_events WHERE order_id = $1 AND kind = 'conf_status' AND from_value = 'no_stock'`, [o.id]);
  let l: any = await call('depot.late', seller, P);
  const s: any = await call('depot.stats', seller, P);
  assert.equal(l.total, s.late);
  const row = l.rows.find((r: any) => r.orderId === Number(o.id));
  assert.ok(row && row.wait > 48 * H, 'five days: late');
  for (let k = 1; k < l.rows.length; k++) assert.ok(l.rows[k - 1].wait >= l.rows[k].wait, 'the slowest first');
  // it waited for stock until yesterday: the depot had it 23 hours
  await db.query(`INSERT INTO order_events (order_id, user_id, kind, from_value, to_value, at) VALUES ($1, NULL, 'conf_status', 'no_stock', 'confirmed', $2)`, [o.id, new Date(now - 24 * H).toISOString()]);
  l = await call('depot.late', seller, P);
  assert.ok(!l.rows.some((r: any) => r.orderId === Number(o.id)), 'a wait for stock is the supplier’s, not the depot’s');
});
