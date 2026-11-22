// Confirmation › « Bloquer jusqu'à l'appel »: a new order given to a plain agent blocks his screen (the oldest first)
// until he has called and saved a result; it waits while he works on another order, never at night; only the
// managers switch it; away from Pilotix his devices get a notification, then a reminder every 5 minutes (6 at most).
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { DEFAULT_CALL_SETTINGS } from '@pilotix/shared';
import { call, Ctx, Db, getSetting, setSetting } from '../index';
import { RING_AGAIN_MS, RINGS_MAX } from '../modules/confblock';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
let samiraId = 0;
/** Samira's two new orders (the older one first) */
let mine: number[] = [];

/** the shop calls its customers all day long (the tests run at any hour) */
const allDay = () => setSetting(db, 'calls', { ...DEFAULT_CALL_SETTINGS, slots: [{ key: 'morning', from: 0, to: 24 }] });

before(async () => {
  ({ db, as } = await setup(250));
  samiraId = (await as(EMAILS.conf)).session.profile.id;
  // only the two orders of this test are her new ones, and she has no other order open (the demo opens one for her)
  await db.query(`UPDATE orders SET agent_id = NULL WHERE agent_id = $1 AND conf_status = 'new'`, [samiraId]);
  await db.query('UPDATE orders SET locked_by = NULL, locked_until = NULL WHERE locked_by = $1', [samiraId]);
  const two = (await db.query(`SELECT id FROM orders WHERE conf_status = 'new' AND agent_id IS NULL AND conf_agency_id IS NULL AND NOT is_exchange ORDER BY created_at, id LIMIT 2`)).map((r: any) => Number(r.id));
  assert.equal(two.length, 2, 'two new orders nobody has');
  for (const id of two) await db.query('UPDATE orders SET agent_id = $2, assigned_at = now(), locked_by = NULL, locked_until = NULL WHERE id = $1', [id, samiraId]);
  mine = two;
  await allDay();
});

const blocking = async (email: string) => (await call('confirmation.blocking', await as(email), {})) as any;

test('off by default; only the managers switch it on or off', async () => {
  const samira = await as(EMAILS.conf);
  const yacine = await as(EMAILS.manager);
  assert.equal(((await call('confirmation.blockGet', samira, {})) as any).on, false, 'off in a new shop');
  assert.equal((await blocking(EMAILS.conf)).order, null, 'nothing blocks while it is off');
  assert.equal(((await call('confirmation.blockGet', samira, {})) as any).canSwitch, false);
  await assert.rejects(call('confirmation.blockSet', samira, { on: true }), /Seuls les managers/);
  const g: any = await call('confirmation.blockGet', yacine, {});
  assert.equal(g.canSwitch, true);
  const s: any = await call('confirmation.blockSet', yacine, { on: true });
  assert.equal(s.on, true);
  assert.equal(s.by, yacine.session.profile.name);
  assert.equal((await getSetting(db, 'confBlock')).on, true);
});

test('the oldest new order blocks the agent; « Appeler » is counted; a result moves on to the next; never the managers', async () => {
  const samira = await as(EMAILS.conf);
  const b = await blocking(EMAILS.conf);
  assert.equal(b.on, true);
  assert.equal(b.order?.id, mine[0], 'the oldest first');
  assert.equal(b.called, false);
  assert.equal(b.queue, 1, 'one more after it');
  await call('orders.logCall', samira, { id: mine[0] });
  assert.equal((await blocking(EMAILS.conf)).called, true, 'the tap on « Appeler » is counted');
  // the result (no answer) lets her go: the next one comes
  await call('confirmation.setTry', samira, { ids: [mine[0]], n: 1 });
  const next = await blocking(EMAILS.conf);
  assert.equal(next.order?.id, mine[1]);
  assert.equal(next.called, false, 'a new order: not called yet');
  assert.equal(next.queue, 0);
  // the managers and the administrators are never blocked
  assert.equal((await blocking(EMAILS.manager)).order, null);
  assert.equal((await blocking(EMAILS.admin)).order, null);
});

test('it waits while the agent works on another order, and never at night', async () => {
  // another of her orders open on her screen (kept for her)
  await db.query(`UPDATE orders SET locked_by = $1, locked_until = now() + interval '5 minutes' WHERE id = $2`, [samiraId, mine[0]]);
  const w = await blocking(EMAILS.conf);
  assert.equal(w.order, null);
  assert.equal(w.wait, true);
  await db.query('UPDATE orders SET locked_by = NULL, locked_until = NULL WHERE id = $1', [mine[0]]);
  assert.equal((await blocking(EMAILS.conf)).order?.id, mine[1]);
  // calling hours closed: one slot two hours from now (Algiers time)
  const from = (new Date(Date.now() + 3_600_000).getUTCHours() + 2) % 24;
  await setSetting(db, 'calls', { ...DEFAULT_CALL_SETTINGS, slots: [{ key: 'morning', from, to: from + 1 }] });
  assert.equal((await blocking(EMAILS.conf)).order, null, 'never outside the calling hours');
  await allDay();
});

test('away from Pilotix: a notification at once, then every 5 minutes, 6 at most; none while in Pilotix', async () => {
  const sent: any[] = [];
  const server = {
    pushKeys: () => ({ publicKey: 'BPUBLIC', privateKey: 'PRIVATE' }),
    push: async (_k: any, subs: any[], payload: any) => {
      sent.push({ subs, payload });
      return subs.map((s) => ({ endpoint: s.endpoint, ok: true, gone: false }));
    },
  } as any;
  const admin = await as(EMAILS.admin, server);
  const samira = await as(EMAILS.conf, server);
  await call('push.subscribe', samira, { endpoint: 'https://fcm.googleapis.com/fcm/send/conf-1', p256dh: 'BKEY-1234567890', auth: 'AUTH-1234' });
  // in Pilotix right now: it rings there, no notification
  await db.query(`UPDATE profiles SET last_seen_at = now(), presence = 'online' WHERE id = $1`, [samiraId]);
  assert.equal(((await call('confirmation.pushRun', admin, {})) as any).sent, 0);
  // away
  await db.query(`UPDATE profiles SET last_seen_at = NULL WHERE id = $1`, [samiraId]);
  const r: any = await call('confirmation.pushRun', admin, {});
  assert.ok(r.sent >= 1);
  const mineSent = sent.filter((x) => x.subs.some((s: any) => s.endpoint.endsWith('conf-1')));
  assert.match(mineSent[0].payload.title, /Nouvelle commande/);
  assert.equal(mineSent[0].payload.alarm, true);
  const n = sent.length;
  await call('confirmation.pushRun', admin, {});
  assert.equal(sent.length, n, 'not again before 5 minutes');
  // 5 minutes later: a reminder, until 6 in all
  const back = async () => {
    const rings = await getSetting(db, 'confRings');
    for (const k of Object.keys(rings)) rings[k] = { ...rings[k], at: rings[k].at - RING_AGAIN_MS - 1000 };
    await setSetting(db, 'confRings', rings);
  };
  for (let i = 1; i < RINGS_MAX + 2; i++) {
    await back();
    await call('confirmation.pushRun', admin, {});
  }
  const forOrder = sent.filter((x) => x.payload.tag === `conf-new-${mine[1]}`);
  assert.equal(forOrder.length, RINGS_MAX, '6 at most');
  assert.match(forOrder[1].payload.title, /attend toujours/);
  // switched off: nothing waits to ring any more
  await call('confirmation.blockSet', await as(EMAILS.manager), { on: false });
  assert.deepEqual(await getSetting(db, 'confRings'), {});
  assert.equal(((await call('confirmation.pushRun', admin, {})) as any).sent, 0);
  assert.equal((await blocking(EMAILS.conf)).order, null);
});
