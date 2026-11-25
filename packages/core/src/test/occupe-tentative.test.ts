// « Occupé » in Confirmation (the owner's rule, 25 Nov 2026): a « Nouvelle » or « À vérifier » order becomes
// « Tentative 01 » — one call counted, so the next call waits for the next slot — with no message to the customer and
// no cancel (not even by the 10-minute sweep). An order already tried keeps its try number. « ↶ Annuler » puts it back.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { DEFAULT_CALL_SETTINGS, slotStartOf } from '@pilotix/shared';
import { call, Ctx, Db } from '../index';
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
/** new orders waiting for their first call (« Nouvelle », no call yet) */
const freeNew = async (k: number) => {
  const ids: number[] = [];
  for (let i = 0; i < k; i++) {
    const o = (await call('orders.create', admin, { customerName: `Client Occupé ${++n}`, phone: `0673${String(400000 + n).slice(-6)}`, wilayaId: 16, commune: 'Kouba', address: 'Rue 1', items: [{ ...X, qty: 1 }] })) as any;
    await db.query(`UPDATE orders SET conf_status = 'new', attempts = 0, last_call_at = NULL, next_call_at = NULL, agent_id = NULL WHERE id = $1`, [o.id]);
    ids.push(Number(o.id));
  }
  return ids;
};
const row = (id: number) => one('SELECT conf_status, attempts, last_call_at, next_call_at FROM orders WHERE id = $1', [id]);
/** what the agents' statistics count as calls (stats.ts) */
const callLines = async (id: number) =>
  Number((await one(`SELECT count(*)::int AS n FROM order_events WHERE order_id = $1 AND (kind = 'conf_status' OR (kind = 'call' AND to_value = 'busy'))`, [id])).n);
/** today in Algiers at this hour (UTC+1) */
const at = (h: number) => {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h - 1, 0, 0);
};
/** « Commande suivante » would give it now (the rule of the queue) */
const dueAt = async (id: number, t: number) =>
  !!(await one(`SELECT 1 AS ok FROM orders WHERE id = $1 AND ${dueNowSql(2)}`, [id, new Date(slotStartOf(t, DEFAULT_CALL_SETTINGS)).toISOString()]));

test('« Occupé » on a « Nouvelle » order: « Tentative 01 », one call, the next call in the next slot', async () => {
  await calls({});
  const [id] = await freeNew(1);
  assert.equal(await dueAt(id, at(10)), true, 'a new order is to call at once');
  const morning = { ...admin, now: () => at(10) };
  const r: any = await call('orders.setConf', morning, { ids: [id], status: 'busy' });
  assert.deepEqual(r.changed, [id]);
  assert.deepEqual(r.busyTried, [id]);
  const o = await row(id);
  assert.equal(o.conf_status, 'no_answer');
  assert.equal(Number(o.attempts), 1);
  assert.equal(new Date(o.last_call_at).getTime(), at(10));
  assert.equal(o.next_call_at, null);
  assert.equal(await callLines(id), 1, 'one call, not two');
  // the same slot (9 h – 12 h): not given again; the next slot (from 12 h): given
  assert.equal(await dueAt(id, at(11)), false);
  assert.equal(await dueAt(id, at(13)), true);
  // the history says « Occupé · Tentative 01 »
  const ev = ((await call('orders.events', admin, { id })) as any[]).filter((e) => e.kind === 'conf_status');
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].fromValue, ev[0].toValue, ev[0].busyTry], ['new', 'no_answer', 1]);
  // in « En cours », its history cell shows « Occupé »
  const ref = (await one('SELECT ref FROM orders WHERE id = $1', [id])).ref;
  const list: any = await call('confirmation.list', admin, { sub: 'attente', q: ref });
  assert.deepEqual(list.rows.find((x: any) => x.id === id)?.passed, ['busy']);
});

test('« Occupé » again, or on an order already tried: its try number stays', async () => {
  await calls({});
  const [a, b] = await freeNew(2);
  await call('orders.setConf', admin, { ids: [a], status: 'busy' });
  const again: any = await call('orders.setConf', admin, { ids: [a], status: 'busy' });
  assert.deepEqual(again.busyTried, []);
  assert.deepEqual([(await row(a)).conf_status, Number((await row(a)).attempts)], ['no_answer', 1]);
  assert.equal(await callLines(a), 2, 'each « Occupé » is a call');
  await call('orders.setConf', admin, { ids: [b], status: 'no_answer' });
  await call('orders.setConf', admin, { ids: [b], status: 'no_answer' });
  await call('orders.setConf', admin, { ids: [b], status: 'busy' });
  assert.deepEqual([(await row(b)).conf_status, Number((await row(b)).attempts)], ['no_answer', 2], '« Tentative 02 » stays « Tentative 02 »');
  assert.equal((await one(`SELECT to_value FROM order_events WHERE order_id = $1 ORDER BY id DESC LIMIT 1`, [b])).to_value, 'busy');
  // « à rappeler »: it stays « à rappeler », at its time
  const [c] = await freeNew(1);
  const when = new Date(Date.now() + 3 * 3_600_000).toISOString();
  await call('orders.setConf', admin, { ids: [c], status: 'callback', nextCallAt: when });
  await call('orders.setConf', admin, { ids: [c], status: 'busy' });
  const cb = await row(c);
  assert.deepEqual([cb.conf_status, Number(cb.attempts), new Date(cb.next_call_at).toISOString()], ['callback', 0, when]);
});

test('« Occupé » on an « À vérifier » order: « Tentative 01 » too', async () => {
  await calls({});
  const [id] = await freeNew(1);
  await db.query(`UPDATE orders SET conf_status = 'to_check' WHERE id = $1`, [id]);
  const r: any = await call('orders.setConf', admin, { ids: [id], status: 'busy' });
  assert.deepEqual(r.busyTried, [id]);
  assert.deepEqual([(await row(id)).conf_status, Number((await row(id)).attempts)], ['no_answer', 1]);
});

test('no message to the customer and no cancel from an « Occupé », even when the shop asks them at try 1', async () => {
  await calls({ messageAtTry: 1, cancelAfterNoAnswer: 1 });
  const [id, plain] = await freeNew(2);
  // a « Pas de réponse » there asks the cancel message first
  await assert.rejects(call('orders.setConf', admin, { ids: [plain], status: 'no_answer' }), /message d’annulation/);
  // « Occupé »: nothing asked, nothing sent, not cancelled (even with the automatic « no answer » message after 1 call)
  const g: any = await call('notify.settings.get', admin, {});
  await call('notify.settings.save', admin, { ...g.settings, cases: { ...g.settings.cases, no_answer: true }, noAnswerAfter: 1 });
  const messages = async () => Number((await one(`SELECT count(*)::int AS n FROM notifications WHERE order_id = $1`, [id])).n);
  const before = await messages();
  const r: any = await call('orders.setConf', admin, { ids: [id], status: 'busy' });
  assert.deepEqual(r.autoCancelled, []);
  assert.deepEqual([(await row(id)).conf_status, Number((await row(id)).attempts)], ['no_answer', 1]);
  assert.equal(await messages(), before, 'no message');
  await call('notify.settings.save', admin, g.settings);
  // the 10-minute sweep (orders at the limit or above) leaves it
  const job: any = await call('confirmation.noAnswerSweep', admin, {});
  assert.ok(!job.refs.includes((await one('SELECT ref FROM orders WHERE id = $1', [id])).ref));
  assert.equal((await row(id)).conf_status, 'no_answer');
  // its next « Pas de réponse » counts as usual: the cancel message, at the 2nd call
  await assert.rejects(call('orders.setConf', admin, { ids: [id], status: 'no_answer' }), /message d’annulation/);
  await calls({});
});

test('« ↶ Annuler » an « Occupé » on a « Nouvelle » order: « Nouvelle » again, the call not counted', async () => {
  await calls({});
  const [id] = await freeNew(1);
  await call('orders.setConf', admin, { ids: [id], status: 'busy' });
  const lc: any = await call('orders.lastChange', admin, { id });
  assert.equal(lc.from, 'new');
  assert.ok(lc.effects.some((e: any) => e.k === 'call'), 'it says the call is not counted any more');
  await call('orders.undo', admin, { id, eventId: lc.eventId });
  assert.deepEqual([(await row(id)).conf_status, Number((await row(id)).attempts)], ['new', 0]);
  assert.equal(Number((await one(`SELECT count(*)::int AS n FROM order_events WHERE order_id = $1 AND kind = 'conf_status'`, [id])).n), 0);
});
