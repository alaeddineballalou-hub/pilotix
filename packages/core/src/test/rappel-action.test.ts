// « Rappel » and « Occupé » are actions, not statuses (the owner's rule, 25 Nov 2026 evening): an order still to call
// shows only its try, « Tentative 0N ». « Rappel »: the time the agent picks is its next call, the try stays (a
// « Nouvelle » becomes « Tentative 01 »), nothing goes to the customer, and the 10-minute sweep never cancels it before
// that call. « Occupé » on a call back whose time came: a normal try again (the next slot), the try stays. En cours says
// what happens next (« Rappel 18:00 », « Occupé »). The orders from before are moved once (migrations/138).
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { DEFAULT_CALL_SETTINGS, slotStartOf } from '@pilotix/shared';
import { call, Ctx, Db } from '../index';
import m138 from '../migrations/138_rappel_action';
import { inboxRun } from '../modules/inbox';
import { dueNowSql } from '../modules/orders';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;
let admin: Ctx;
let X: { productId: number; variantId: number };

before(async () => {
  ({ db, as } = await setup(40));
  admin = await as(EMAILS.admin);
  const r = (await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id AND v.active WHERE p.active AND NOT p.is_service ORDER BY p.id, v.id LIMIT 1`))[0];
  X = { productId: Number(r.id), variantId: Number(r.vid) };
});

const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p))[0];
const calls = (extra: Record<string, unknown>) =>
  db.query(`INSERT INTO settings (key, value) VALUES ('calls', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ ...DEFAULT_CALL_SETTINGS, ...extra })]);
let n = 0;
/** new orders waiting for their first call, given to nobody */
const freeNew = async (k: number) => {
  const ids: number[] = [];
  for (let i = 0; i < k; i++) {
    const o = (await call('orders.create', admin, { customerName: `Client Rappel ${++n}`, phone: `0674${String(500000 + n).slice(-6)}`, wilayaId: 16, commune: 'Kouba', address: 'Rue 1', items: [{ ...X, qty: 1 }] })) as any;
    await db.query(`UPDATE orders SET conf_status = 'new', attempts = 0, last_call_at = NULL, next_call_at = NULL, agent_id = NULL WHERE id = $1`, [o.id]);
    ids.push(Number(o.id));
  }
  return ids;
};
const row = (id: number) => one('SELECT conf_status, attempts, last_call_at, next_call_at FROM orders WHERE id = $1', [id]);
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const refOf = async (id: number) => String((await one('SELECT ref FROM orders WHERE id = $1', [id])).ref);
/** « Commande suivante » would give it at that moment (the rule of the queue) */
const dueAt = async (id: number, t: number) =>
  !!(await one(`SELECT 1 AS ok FROM orders WHERE id = $1 AND ${dueNowSql(2)}`, [id, new Date(slotStartOf(t, DEFAULT_CALL_SETTINGS)).toISOString()]));
/** the « no answer » messages of an order still to be sent */
const waitingMsgs = async (id: number) =>
  Number((await one(`SELECT count(*)::int AS n FROM notifications WHERE order_id = $1 AND kind = 'no_answer' AND status IN ('queued', 'manual', 'failed')`, [id])).n);

test('« Rappel »: the try stays (a « Nouvelle » becomes « Tentative 01 »), its time is the next call, never a message', async () => {
  await calls({});
  const g: any = await call('notify.settings.get', admin, {});
  // the automatic « no answer » message after 1 call: never for a « Rappel » (the customer answered)
  await call('notify.settings.save', admin, { ...g.settings, cases: { ...g.settings.cases, no_answer: true }, noAnswerAfter: 1 });
  const [a, b] = await freeNew(2);
  const when = new Date(Date.now() + 2 * 3_600_000).toISOString();
  await call('orders.setConf', admin, { ids: [a], status: 'callback', nextCallAt: when });
  const ra = await row(a);
  assert.deepEqual([ra.conf_status, Number(ra.attempts), iso(ra.next_call_at)], ['no_answer', 1, when], 'a « Nouvelle »: « Tentative 01 » at its time');
  assert.ok(ra.last_call_at, 'the call is written');
  assert.equal(await waitingMsgs(a), 0, 'no message');
  // « Tentative 02 », then « Rappel »: still « Tentative 02 », and a « no answer » message still waiting is not sent
  await call('orders.setConf', admin, { ids: [b], status: 'no_answer' });
  await call('orders.setConf', admin, { ids: [b], status: 'no_answer' });
  await call('orders.setConf', admin, { ids: [b], status: 'callback', nextCallAt: when });
  const rb = await row(b);
  assert.deepEqual([rb.conf_status, Number(rb.attempts), iso(rb.next_call_at)], ['no_answer', 2, when]);
  assert.equal(await waitingMsgs(b), 0, 'the waiting « no answer » message is not sent');
  await call('notify.settings.save', admin, g.settings);
  // the history says « À rappeler · <time> · Tentative 02 »
  const ev = ((await call('orders.events', admin, { id: b })) as any[]).filter((e) => e.kind === 'conf_status' && e.callbackTry);
  assert.deepEqual(ev.map((e) => e.callbackTry), [{ at: when, n: 2 }]);
  // in the queue: not before its time, at its time (the queue reads the database's clock: the time is moved)
  assert.equal(await dueAt(b, Date.now()), false, 'not before its time');
  await db.query('UPDATE orders SET next_call_at = $2 WHERE id = $1', [b, new Date(Date.now() - 60_000).toISOString()]);
  assert.equal(await dueAt(b, Date.now()), true, 'its time came: to call now');
  // En cours: its status is its try; the list says what comes next (its time) and its passed steps « À rappeler »
  const list: any = await call('confirmation.list', admin, { sub: 'attente', q: await refOf(a) });
  const r = list.rows.find((x: any) => x.id === a);
  assert.deepEqual([r.confStatus, r.attempts, r.nextCallAt, r.lastBusy], ['no_answer', 1, when, false]);
  assert.deepEqual(r.passed, ['callback']);
});

test('« Occupé » on a call back whose time came: a normal try again (next slot), the try stays; « Occupé » on the line', async () => {
  await calls({});
  const [id] = await freeNew(1);
  await call('orders.setConf', admin, { ids: [id], status: 'callback', nextCallAt: new Date(Date.now() + 3_600_000).toISOString() });
  // its time came
  await db.query('UPDATE orders SET next_call_at = $2 WHERE id = $1', [id, new Date(Date.now() - 5 * 60_000).toISOString()]);
  await call('orders.setConf', admin, { ids: [id], status: 'busy' });
  const o = await row(id);
  assert.deepEqual([o.conf_status, Number(o.attempts), o.next_call_at], ['no_answer', 1, null], 'its try stays, the call back is done');
  assert.equal(await dueAt(id, Date.now()), false, 'not again in this slot');
  const list: any = await call('confirmation.list', admin, { sub: 'attente', q: await refOf(id) });
  assert.equal(list.rows.find((x: any) => x.id === id)?.lastBusy, true, 'its line says « Occupé »');
  // a « Pas de réponse » after: a normal try, the line does not say « Occupé » any more
  await call('orders.setConf', admin, { ids: [id], status: 'no_answer' });
  const list2: any = await call('confirmation.list', admin, { sub: 'attente', q: await refOf(id) });
  const r2 = list2.rows.find((x: any) => x.id === id);
  assert.deepEqual([r2.attempts, r2.lastBusy], [2, false]);
});

test('the 10-minute sweep never cancels an order waiting for its call back', async () => {
  await calls({ cancelAfterNoAnswer: 2, messageAtTry: 2 });
  const [id, plain] = await freeNew(2);
  await call('orders.setConf', admin, { ids: [id, plain], status: 'no_answer' });
  // both reach the shop's limit (2 tries) from before the rule; one waits for its call back
  await db.query('UPDATE orders SET attempts = 2 WHERE id = ANY($1)', [[id, plain]]);
  await call('orders.setConf', admin, { ids: [id], status: 'callback', nextCallAt: new Date(Date.now() + 3_600_000).toISOString() });
  const job: any = await call('confirmation.noAnswerSweep', admin, {});
  assert.ok(job.refs.includes(await refOf(plain)), 'the other one is cancelled (the limit)');
  assert.ok(!job.refs.includes(await refOf(id)), 'not the call back');
  assert.equal((await row(id)).conf_status, 'no_answer');
  // even once its time passed: it waits for that call
  await db.query('UPDATE orders SET next_call_at = $2 WHERE id = $1', [id, new Date(Date.now() - 3_600_000).toISOString()]);
  await call('confirmation.noAnswerSweep', admin, {});
  assert.equal((await row(id)).conf_status, 'no_answer');
  await calls({});
});

test('the agent is told when the call back time comes (the bell)', async () => {
  await calls({});
  const samira = await as(EMAILS.conf);
  const [id] = await freeNew(1);
  await db.query('UPDATE orders SET agent_id = $2 WHERE id = $1', [id, samira.session.profile.id]);
  await call('orders.setConf', admin, { ids: [id], status: 'callback', nextCallAt: new Date(Date.now() + 3_600_000).toISOString() });
  await db.query('UPDATE orders SET next_call_at = $2 WHERE id = $1', [id, new Date(Date.now() - 60_000).toISOString()]);
  assert.ok((await inboxRun(admin)).calls >= 1);
  const name = String((await one('SELECT customer_name FROM orders WHERE id = $1', [id])).customer_name).trim();
  const mine: any = await call('inbox.list', samira, {});
  assert.ok(mine.items.some((i: any) => i.kind === 'callback' && String(i.title).includes(name)), JSON.stringify(mine.items.slice(0, 3)));
});

test('« ↶ Annuler » a « Rappel » on a tried order: as it was, no call to take back', async () => {
  await calls({});
  const [id] = await freeNew(1);
  await call('orders.setConf', admin, { ids: [id], status: 'no_answer' });
  await call('orders.setConf', admin, { ids: [id], status: 'callback', nextCallAt: new Date(Date.now() + 3_600_000).toISOString() });
  const lc: any = await call('orders.lastChange', admin, { id });
  assert.ok(!lc.effects.some((e: any) => e.k === 'call'), 'it counted no call');
  await call('orders.undo', admin, { id, eventId: lc.eventId });
  const o = await row(id);
  assert.deepEqual([o.conf_status, Number(o.attempts), o.next_call_at], ['no_answer', 1, null]);
});

test('the orders from before (« Occupé », « À rappeler »): « Tentative » once, the call back keeps its time', async () => {
  const [busy, cb, cb0] = await freeNew(3);
  const t = new Date(Date.now() + 5 * 3_600_000).toISOString();
  await db.query(`UPDATE orders SET conf_status = 'busy', attempts = 2 WHERE id = $1`, [busy]);
  await db.query(`UPDATE orders SET conf_status = 'callback', attempts = 3, next_call_at = $2 WHERE id = $1`, [cb, t]);
  await db.query(`UPDATE orders SET conf_status = 'callback', attempts = 0, next_call_at = $2 WHERE id = $1`, [cb0, t]);
  for (const q of m138.split(';').map((s) => s.trim()).filter(Boolean)) await db.query(q);
  const [a, b, c] = [await row(busy), await row(cb), await row(cb0)];
  assert.deepEqual([a.conf_status, Number(a.attempts), a.next_call_at], ['no_answer', 2, null]);
  assert.deepEqual([b.conf_status, Number(b.attempts), iso(b.next_call_at)], ['no_answer', 3, t]);
  assert.deepEqual([c.conf_status, Number(c.attempts), iso(c.next_call_at)], ['no_answer', 1, t]);
  assert.equal(Number((await one(`SELECT count(*)::int AS n FROM orders WHERE conf_status IN ('busy', 'callback')`)).n), 0);
});
