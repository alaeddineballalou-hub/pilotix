// Affectation › rotation (piece B): an order its agent did not act on in time goes to another agent — never back to
// someone who had it, to a supervisor after N moves (then it stays with him), to a chosen agent or by the split; an
// order open on someone's screen waits; the countdown on the order; the same for the Suivi alerts.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { DEFAULT_CALL_SETTINGS } from '@pilotix/shared';
import { rotateTimes } from '../modules/assign';
import { setSetting } from '../settings';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (e: string) => Promise<Ctx>;
let admin: Ctx;
let X: { productId: number; variantId: number };
let agents: number[] = [];
let lead = 0;
let base: any;

before(async () => {
  ({ db, as } = await setup(40));
  admin = await as(EMAILS.admin);
  const r = (await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id AND v.active WHERE p.active AND NOT p.is_service ORDER BY p.id, v.id LIMIT 1`))[0];
  X = { productId: Number(r.id), variantId: Number(r.vid) };
  agents = (await db.query(`SELECT id FROM profiles WHERE active AND 'confirmation' = ANY(roles) AND NOT ('agent_manager' = ANY(roles)) AND agency_id IS NULL ORDER BY id`)).map((x: any) => Number(x.id));
  lead = (await as(EMAILS.manager)).session.profile.id;
  await db.query(`UPDATE profiles SET roles = array_append(roles, 'agent_manager') WHERE id = $1 AND NOT ('agent_manager' = ANY(roles))`, [lead]);
  base = ((await call('assign.get', admin, {})) as any).cfg;
  // nothing from the demo waits or moves: only this test's orders
  await db.query(`UPDATE orders SET agent_id = (SELECT min(id) FROM profiles WHERE 'confirmation' = ANY(roles)) WHERE agent_id IS NULL`);
  await db.query(`UPDATE orders SET conf_status = 'confirmed' WHERE conf_status = ANY('{new,no_answer,busy,to_check,callback,postponed}'::text[])`);
  // the agent's time counts in the call hours: all day here, so the tests do not depend on the hour they run
  await setSetting(db, 'calls', { ...DEFAULT_CALL_SETTINGS, slots: [{ key: 'all', from: 0, to: 24 }] });
});

let n = 0;
const order = async () =>
  (await call('orders.create', admin, { customerName: `Client Rot ${++n}`, phone: `0671${String(200000 + n).slice(-6)}`, wilayaId: 16, commune: 'Kouba', address: 'Rue 1', items: [{ ...X, qty: 1 }] })) as any;
const online = (who: number[]) => db.query(`UPDATE profiles SET last_seen_at = now(), presence = 'online' WHERE id = ANY($1)`, [who]);
const offline = (who: number[]) => db.query(`UPDATE profiles SET last_seen_at = now() - interval '2 hours' WHERE id = ANY($1)`, [who]);
const rot = (r: object) => ({ on: true, statuses: ['new', 'no_answer', 'busy'], minutes: 30, noCall: true, toLeadAfter: 2, setStatus: '', target: null, ...r });
const save = (r: object, conf: object = {}) => call('assign.set', admin, { ...base, conf: { ...base.conf, mode: 'load', max: 0, sameClient: false, ...conf, rotation: rot(r) } });
const agentOf = async (id: number) => Number((await db.query('SELECT agent_id FROM orders WHERE id = $1', [id]))[0].agent_id);
/** as if he got it `min` minutes ago */
const late = (id: number, min = 31) => db.query(`UPDATE orders SET assigned_at = now() - make_interval(mins => $2) WHERE id = $1`, [id, min]);
const moves = async (id: number) => db.query(`SELECT from_value, to_value, note, data FROM order_events WHERE order_id = $1 AND kind = 'rotate' ORDER BY id`, [id]);

test('Confirmation: on time nothing moves; late it goes to another agent, never back, then to the supervisor and stays', async () => {
  assert.ok(agents.length >= 3, 'three confirmation agents in the demo');
  await offline([...agents, lead]);
  await online(agents.slice(0, 3));
  await save({});
  const o = await order();
  const first = await agentOf(o.id);
  assert.ok(agents.includes(first), 'given at once');

  // the countdown: when it will move
  const at = (await rotateTimes(admin, 'conf', [o.id])).get(o.id);
  assert.ok(at && Math.abs(at - (Date.now() + 30 * 60_000)) < 2 * 60_000, 'moves in 30 minutes');

  await call('assign.run', admin, {});
  assert.equal(await agentOf(o.id), first, 'on time: it stays');

  // late, but open on someone's screen: it waits
  await late(o.id);
  await db.query(`UPDATE orders SET locked_by = $2, locked_until = now() + interval '10 minutes' WHERE id = $1`, [o.id, first]);
  await call('assign.run', admin, {});
  assert.equal(await agentOf(o.id), first, 'locked: it waits');
  await db.query(`UPDATE orders SET locked_by = NULL, locked_until = NULL WHERE id = $1`, [o.id]);

  // late: to another agent, written in the history, his clock starts again
  const r1 = (await call('assign.run', admin, {})) as any;
  assert.equal(r1.conf.moved, 1);
  const second = await agentOf(o.id);
  assert.ok(second !== first && agents.includes(second));
  const m1 = await moves(o.id);
  assert.equal(m1.length, 1);
  assert.equal(Number(m1[0].from_value), first);
  assert.equal(Number(m1[0].to_value), second);
  assert.match(m1[0].note, /Rotation \(confirmation\) · 30 min sans action/);
  assert.equal(m1[0].data.area, 'conf');
  const at2 = (await rotateTimes(admin, 'conf', [o.id])).get(o.id);
  assert.ok(at2 && at2 > Date.now() + 25 * 60_000, 'the new agent has his 30 minutes');

  // he called: « seulement s'il n'a rien fait » keeps it with him (and no countdown)
  await late(o.id);
  await db.query(`INSERT INTO order_events (order_id, user_id, kind, at, note) VALUES ($1, $2, 'call', now() - interval '5 minutes', 'appel')`, [o.id, second]);
  await call('assign.run', admin, {});
  assert.equal(await agentOf(o.id), second, 'he acted: it stays');
  assert.equal((await rotateTimes(admin, 'conf', [o.id])).has(o.id), false);

  // the rule off: it moves even after his call — never back to the first one
  await save({ noCall: false });
  await call('assign.run', admin, {});
  const third = await agentOf(o.id);
  assert.ok(third !== first && third !== second && agents.includes(third), 'a third agent');

  // two moves done: the supervisor (on line) gets it…
  await save({ noCall: false });
  await online([lead]);
  await late(o.id);
  await call('assign.run', admin, {});
  assert.equal(await agentOf(o.id), lead, 'to the supervisor after 2 moves');
  const m3 = await moves(o.id);
  assert.equal(m3.length, 3);
  assert.equal(m3[2].data.lead, true);
  assert.match(m3[2].note, /superviseur/);
  // …and it stays with him
  await late(o.id, 120);
  await call('assign.run', admin, {});
  assert.equal(await agentOf(o.id), lead, 'with the supervisor it stays');
  assert.equal((await rotateTimes(admin, 'conf', [o.id])).has(o.id), false, 'no countdown with the supervisor');
  await offline([lead]);
});

test('Confirmation: nobody else to take it, it stays; to the chosen agent; the status after the move', async () => {
  const [a, b, c] = agents;
  await offline([...agents, lead]);
  await online([a]);
  await save({});
  const o = await order();
  assert.equal(await agentOf(o.id), a);
  await late(o.id);
  await call('assign.run', admin, {});
  assert.equal(await agentOf(o.id), a, 'nobody else on line: it stays');

  // to the chosen agent (on line), with the status chosen
  await online([a, b, c]);
  await save({ target: c, setStatus: 'no_answer' });
  await call('assign.run', admin, {});
  assert.equal(await agentOf(o.id), c);
  const row = (await db.query('SELECT conf_status FROM orders WHERE id = $1', [o.id]))[0];
  assert.equal(row.conf_status, 'no_answer');
  const ev = await db.query(`SELECT from_value, to_value FROM order_events WHERE order_id = $1 AND kind = 'conf_status' AND note = 'Rotation'`, [o.id]);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].to_value, 'no_answer');
  await save({ on: false });
});

test('the settings: only « à traiter » statuses; an old screen without the rotation keeps the saved one', async () => {
  await call('assign.set', admin, { ...base, conf: { ...base.conf, rotation: rot({ statuses: ['confirmed', 'new', 'cancelled'], setStatus: 'confirmed' }) } });
  let cfg = ((await call('assign.get', admin, {})) as any).cfg;
  assert.deepEqual(cfg.conf.rotation.statuses, ['new']);
  assert.equal(cfg.conf.rotation.setStatus, '');
  // a screen that does not know the rotation: it is kept
  const { rotation: _r, ...old } = cfg.conf;
  await call('assign.set', admin, { ...cfg, conf: old });
  cfg = ((await call('assign.get', admin, {})) as any).cfg;
  assert.equal(cfg.conf.rotation.on, true);
  await call('assign.set', admin, { ...cfg, conf: { ...cfg.conf, rotation: { ...cfg.conf.rotation, on: false } } });
});

test('Suivi: an alert nobody acted on goes to another Suivi agent; a treated alert stays', async () => {
  const s1 = (await as(EMAILS.suivi)).session.profile.id;
  const s2 = agents[0];
  await db.query(`UPDATE profiles SET roles = array_append(roles, 'suivi') WHERE id = $1 AND NOT ('suivi' = ANY(roles))`, [s2]);
  await offline([...agents, lead, s1]);
  await online([s1, s2]);
  // only this test's parcels in alert
  await db.query(`UPDATE orders SET follow_status = 'out_for_delivery' WHERE follow_status = 'alert'`);
  const ps = (await db.query(`SELECT id FROM orders WHERE shipped_at IS NOT NULL AND follow_status = 'out_for_delivery' ORDER BY id DESC LIMIT 2`)).map((x: any) => Number(x.id));
  assert.equal(ps.length, 2);
  for (const id of ps) {
    await db.query(`UPDATE orders SET follow_status = 'alert', sub_status = NULL, follow_agent_id = $2 WHERE id = $1`, [id, s1]);
    await db.query(`INSERT INTO order_events (order_id, user_id, kind, at, from_value, to_value) VALUES ($1, NULL, 'follow_status', now() - interval '3 hours', 'out_for_delivery', 'alert')`, [id]);
    await db.query(`INSERT INTO order_events (order_id, user_id, kind, at, to_value, note) VALUES ($1, NULL, 'assign', now() - interval '3 hours', $2, 'test')`, [id, String(s1)]);
  }
  // the second one was treated already
  await db.query(`UPDATE orders SET sub_status = 'alert_traitee' WHERE id = $1`, [ps[1]]);
  const who = async (id: number) => Number((await db.query('SELECT follow_agent_id FROM orders WHERE id = $1', [id]))[0].follow_agent_id);
  await call('assign.set', admin, { ...base, follow: { ...base.follow, mode: 'load', max: 0, sameClient: false, rotation: rot({ statuses: [], minutes: 120, toLeadAfter: 0 }) } });
  const t0 = (await rotateTimes(admin, 'follow', ps)).get(ps[0]);
  assert.ok(t0 && t0 < Date.now(), 'its time is up');
  const r = (await call('assign.run', admin, {})) as any;
  assert.equal(r.follow.moved, 1);
  assert.equal(await who(ps[0]), s2, 'to the other Suivi agent');
  assert.equal(await who(ps[1]), s1, 'a treated alert stays');
  const m = await moves(ps[0]);
  assert.equal(m.length, 1);
  assert.equal(m[0].data.area, 'follow');
  assert.match(m[0].note, /Rotation \(suivi\) · 120 min/);
  // the new agent has his own 120 minutes
  const t1 = (await rotateTimes(admin, 'follow', [ps[0]])).get(ps[0]);
  assert.ok(t1 && t1 > Date.now() + 110 * 60_000);
  await call('assign.set', admin, base);
});

test('the night does not count: an order given at 20:50 is due the next morning, not at 21:20', async () => {
  await setSetting(db, 'calls', DEFAULT_CALL_SETTINGS);
  try {
    await offline([...agents, lead]);
    await online(agents.slice(0, 2));
    await save({});
    const o = await order();
    // given at 20:50 Algiers (19:50 UTC) yesterday; the shop calls 9:00 → 21:00
    const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await db.query('UPDATE orders SET assigned_at = $2::timestamptz WHERE id = $1', [o.id, `${day}T19:50:00Z`]);
    const at = (await rotateTimes(admin, 'conf', [o.id])).get(o.id)!;
    // 10 minutes before 21:00, 20 more from 9:00 the next morning: 9:20 Algiers (8:20 UTC)
    const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    assert.equal(new Date(at).toISOString(), `${next}T08:20:00.000Z`);
    // at 7:00 that morning nothing moves
    const early = { ...admin, now: () => Date.parse(`${next}T06:00:00Z`) };
    const r: any = await call('assign.run', early, {});
    assert.equal(r.conf.moved, 0);
    await save({ on: false });
  } finally {
    await setSetting(db, 'calls', { ...DEFAULT_CALL_SETTINGS, slots: [{ key: 'all', from: 0, to: 24 }] });
  }
});

test('the call slot an order was tried in: one try per slot, as the « prochain appel » shown', async () => {
  const { nextDue, slotStartOf, DEFAULT_CALL_SETTINGS: s } = await import('@pilotix/shared');
  // Algiers = UTC+1: 9-12, 12-16, 16-21 → 08:00, 11:00, 15:00 UTC
  const at = (h: string) => Date.parse(`2026-11-03T${h}:00.000Z`);
  assert.equal(slotStartOf(at('10:30'), s), at('08:00'));
  assert.equal(slotStartOf(at('11:00'), s), at('11:00'));
  assert.equal(slotStartOf(at('21:00'), s), at('15:00'), 'at night: the evening slot');
  assert.equal(slotStartOf(Date.parse('2026-11-04T06:00:00.000Z'), s), at('15:00'), 'before the morning: still yesterday evening');
  // the same answer as nextDue for a « pas de réponse »: due once a new slot started after the call
  for (const call of ['07:30', '08:10', '10:59', '11:00', '14:00', '19:59', '21:30']) {
    for (const now of ['08:00', '09:00', '11:00', '12:00', '15:00', '16:30', '21:00', '23:00']) {
      const lastCallAt = new Date(at(call)).toISOString();
      if (at(now) < at(call)) continue;
      const due = nextDue({ createdAt: lastCallAt, attempts: 1, nextCallAt: null, done: false, lastCallAt }, s, at(now)).kind === 'now';
      assert.equal(at(call) < slotStartOf(at(now), s), due, `called ${call}, now ${now}`);
    }
  }
});
