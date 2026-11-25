// Safe statuses: « Annuler après N appels sans réponse » reaches any N; an order at the depot sent back to be called
// again leaves the depot (and is never dispatched); a stop-desk order needs its bureau before « Confirmer ».
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { DEFAULT_CALL_SETTINGS } from '@pilotix/shared';
import { call, Ctx, Db, reactivateCancelledOrder } from '../index';
import { attackOf, cancelReason } from '../modules/confirmation';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(200));
});

const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p))[0];
const freeNew = async () => Number((await one(`SELECT id FROM orders WHERE conf_status = 'new' AND agent_id IS NULL AND follow_status IS NULL ORDER BY id DESC LIMIT 1`)).id);

test('« Annuler après 5 appels »: the 5th unanswered call cancels the order, and says so', async () => {
  const admin = await as(EMAILS.admin);
  await db.query(`INSERT INTO settings (key, value) VALUES ('calls', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ ...DEFAULT_CALL_SETTINGS, cancelAfterNoAnswer: 5 })]);
  const id = await freeNew();
  for (let k = 1; k <= 4; k++) {
    if (k === 3) {
      await call('orders.setConf', admin, { ids: [id], status: 'busy' });
      const current = await one('SELECT conf_status, attempts FROM orders WHERE id = $1', [id]);
      assert.equal(current.conf_status, 'no_answer');
      assert.equal(Number(current.attempts), 2);
      assert.equal((await one("SELECT to_value FROM order_events WHERE order_id = $1 AND kind = 'call' ORDER BY id DESC LIMIT 1", [id])).to_value, 'busy');
      await assert.rejects(call('confirmation.setTry', admin, { ids: [id], n: 3, note: 'Message écrit seulement' }), /confirmez l’envoi/);
    }
    const r: any = await call('confirmation.setTry', admin, { ids: [id], n: k === 1 ? 30 : k, note: k === 3 ? 'Message laissé au client' : null, messageSentVia: k === 3 ? 'whatsapp' : null });
    assert.deepEqual(r.autoCancelled, []);
    assert.equal(Number((await one('SELECT attempts FROM orders WHERE id = $1', [id])).attempts), k, 'the count goes on past 3');
  }
  // « Tentative 01 » by mistake on the 5th call: it still counts as the 5th
  await assert.rejects(call('confirmation.setTry', admin, { ids: [id], n: 1 }), /message d’annulation/);
  const link = await call('orders.reorderLink', admin, { id }) as { token: string; path: string };
  assert.equal(await reactivateCancelledOrder(db, id, link.token), false);
  const r: any = await call('confirmation.setTry', admin, { ids: [id], n: 1, messageSentVia: 'whatsapp', reorderToken: link.token, note: `Votre commande a été annulée. https://pilotix.online${link.path}` });
  assert.equal(r.autoCancelled.length, 1);
  assert.equal(r.autoCancelled[0].attempts, 5);
  assert.equal((await one('SELECT conf_status FROM orders WHERE id = $1', [id])).conf_status, 'cancelled');
  const final = await one("SELECT note FROM order_events WHERE order_id = $1 AND kind = 'conf_status' ORDER BY id DESC LIMIT 1", [id]);
  assert.match(final.note, /^Pas de réponse/);
  assert.equal(attackOf('cancelled', final.note), 'noAnswer');
  assert.equal((await one("SELECT from_value FROM order_events WHERE order_id = $1 AND kind = 'chat' AND note = 'Message laissé au client'", [id])).from_value, 'manual_whatsapp');
  // the plain « Pas de réponse » counts the same way
  const id2 = await freeNew();
  for (let k = 1; k <= 4; k++) await call('orders.setConf', admin, { ids: [id2], status: 'no_answer', note: k === 3 ? 'Message laissé' : null, messageSentVia: k === 3 ? 'sms' : null });
  const second = await call('orders.reorderLink', admin, { id: id2 }) as { token: string; path: string };
  const r2: any = await call('orders.setConf', admin, { ids: [id2], status: 'no_answer', messageSentVia: 'sms', reorderToken: second.token, note: `https://pilotix.online${second.path}` });
  assert.equal(r2.autoCancelled[0]?.id, id2);
  assert.equal(await reactivateCancelledOrder(db, id2, link.token), false);
  assert.equal(await reactivateCancelledOrder(db, id, link.token), true);
  assert.equal(await reactivateCancelledOrder(db, id, link.token), false);
  const reopened = await one('SELECT conf_status, attempts, next_call_at FROM orders WHERE id = $1', [id]);
  assert.deepEqual([reopened.conf_status, Number(reopened.attempts), reopened.next_call_at], ['new', 0, null]);
  assert.equal(cancelReason('Panier abandonné — Retour du client'), 'abandoned_cart');
  await db.query(`DELETE FROM settings WHERE key = 'calls'`);
});

test('an order at the depot sent back to « À rappeler » leaves the depot and is never dispatched', async () => {
  const admin = await as(EMAILS.admin);
  const o = await one(`SELECT id, ref FROM orders WHERE conf_status = 'confirmed' AND follow_status = 'to_prepare' AND NOT is_exchange AND NOT is_stopdesk ORDER BY id LIMIT 1`);
  const id = Number(o.id);
  const next = new Date(Date.now() + 3_600_000).toISOString();
  await call('orders.setConf', admin, { ids: [id], status: 'callback', nextCallAt: next });
  const cur = await one('SELECT conf_status, follow_status FROM orders WHERE id = $1', [id]);
  // (« Rappel » is an action since 25 Nov 2026: the order is a « Tentative » with its time)
  assert.deepEqual([cur.conf_status, cur.follow_status], ['no_answer', null], 'out of the depot');
  // confirmed again: back to « À préparer »
  await call('orders.setConf', admin, { ids: [id], status: 'confirmed' });
  assert.equal((await one('SELECT follow_status FROM orders WHERE id = $1', [id])).follow_status, 'to_prepare');
  // even if a row says « to_prepare » with a status that is not confirmed, dispatch leaves it
  await db.query(`UPDATE orders SET conf_status = 'no_answer' WHERE id = $1`, [id]);
  const res: any = await call('depot.dispatch', admin, { ids: [id] }).catch((e: any) => ({ error: e.message }));
  assert.notEqual((await one('SELECT follow_status FROM orders WHERE id = $1', [id])).follow_status, 'prepared', JSON.stringify(res));
});

test('a stop-desk order needs its bureau before « Confirmer » when the wilaya has bureaus', async () => {
  const admin = await as(EMAILS.admin);
  const d = await one(`SELECT s.wilaya_id, s.company_id FROM stopdesks s JOIN delivery_companies c ON c.id = s.company_id AND c.active LIMIT 1`);
  assert.ok(d, 'the demo has bureaus');
  const id = await freeNew();
  await db.query(`UPDATE orders SET is_stopdesk = true, stopdesk_id = NULL, wilaya_id = $2, company_id = $3 WHERE id = $1`, [id, d.wilaya_id, d.company_id]);
  await assert.rejects(call('orders.setConf', admin, { ids: [id], status: 'confirmed' }), /bureau/);
  assert.equal((await one('SELECT conf_status FROM orders WHERE id = $1', [id])).conf_status, 'new');
});
