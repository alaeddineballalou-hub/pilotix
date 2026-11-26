// Confirmation › « Bloquer jusqu'à l'appel »: in his work time (his shift, else the calling hours) a plain agent works
// only once his phone is ready — notifications on, a test ring that reached it (its worker answers), « je l'ai entendu »
// — at the start of each shift; a ring his phone does not answer blocks him again. A new order rings his phone (the
// newest first, « last in, first out », but the one on his screen or already called stays his until its result) at
// once, then every 2 minutes until « Appeler », never his computer; it waits while he works on another order, never
// outside his work time. Only the managers switch it and type the shifts.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { algiersHour, DEFAULT_CALL_SETTINGS, DEMO_PASSWORD } from '@pilotix/shared';
import { call, Ctx, Db, getSetting, hashPassword, setSetting } from '../index';
import { RING_AGAIN_MS } from '../modules/confblock';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
let samiraId = 0;
/** Samira's two new orders (the older one first: her phone shows the newer one first) */
let mine: number[] = [];

/** the shop calls its customers all day long (the tests run at any hour) */
const allDay = () => setSetting(db, 'calls', { ...DEFAULT_CALL_SETTINGS, slots: [{ key: 'morning', from: 0, to: 24 }] });
const PHONE = 'https://fcm.googleapis.com/fcm/send/conf-phone';
const PC = 'https://fcm.googleapis.com/fcm/send/conf-pc';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
/** a shift that starts two hours from now (Algiers): not his work time now */
const later = () => {
  const from = (Math.floor(algiersHour(Date.now())) + 2) % 24;
  return { from: `${String(from).padStart(2, '0')}:00`, to: from === 23 ? '23:59' : `${String(from + 1).padStart(2, '0')}:00` };
};

const sent: any[] = [];
const server = {
  publicUrl: 'https://pilotix.test',
  pushKeys: () => ({ publicKey: 'BPUBLIC', privateKey: 'PRIVATE' }),
  push: async (_k: any, subs: any[], payload: any) => {
    sent.push({ subs, payload });
    return subs.map((s) => ({ endpoint: s.endpoint, ok: true, gone: false }));
  },
} as any;

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
/** her phone's worker answers the last ring (sw.js posts its code to /push/ack/<code>) */
const answer = async () => {
  const code = String(sent[sent.length - 1].payload.ack).split('/').pop();
  return ((await call('push.ack', await as(EMAILS.admin), { code })) as any).ok as boolean;
};

test('off by default; only the managers switch it on or off and type the shifts', async () => {
  const samira = await as(EMAILS.conf);
  const yacine = await as(EMAILS.manager);
  assert.equal(((await call('confirmation.blockGet', samira, {})) as any).on, false, 'off in a new shop');
  assert.equal((await blocking(EMAILS.conf)).order, null, 'nothing blocks while it is off');
  assert.equal(((await call('confirmation.blockGet', samira, {})) as any).canSwitch, false);
  assert.equal(((await call('confirmation.blockGet', samira, {})) as any).agents, null, 'the agents list: the managers only');
  await assert.rejects(call('confirmation.blockSet', samira, { on: true }), /Seuls les managers/);
  await assert.rejects(call('confirmation.shiftSet', samira, { agentId: samiraId, from: '09:00', to: '15:00' }), /Seuls les managers/);
  const s: any = await call('confirmation.blockSet', yacine, { on: true });
  assert.equal(s.on, true);
  assert.equal(s.by, yacine.session.profile.name);
  assert.equal((await getSetting(db, 'confBlock')).on, true);
});

test('no phone: she cannot work; the newest order is hers to call; the one on her screen or called stays hers; a result moves on', async () => {
  const samira = await as(EMAILS.conf);
  const b = await blocking(EMAILS.conf);
  assert.equal(b.on, true);
  assert.equal(b.work, true, 'her work time (the calling hours: no shift typed)');
  assert.equal(b.gate, 'none', 'no phone ready: her computer and her phone are blocked');
  assert.equal(b.order?.id, mine[1], 'the newest first (last in, first out)');
  assert.equal(b.called, false);
  assert.equal(b.queue, 1, 'one more after it');
  // the older one is open on her screen (kept for her): it stays hers, the newer one waits behind it
  await db.query(`UPDATE orders SET locked_by = $1, locked_until = now() + interval '5 minutes' WHERE id = $2`, [samiraId, mine[0]]);
  assert.equal((await blocking(EMAILS.conf)).order?.id, mine[0], 'the order on her screen is not taken away');
  // she called it and left Pilotix for the call (no longer kept): still hers until its result is saved
  await call('orders.logCall', samira, { id: mine[0] });
  await db.query('UPDATE orders SET locked_by = NULL, locked_until = NULL WHERE id = $1', [mine[0]]);
  const c = await blocking(EMAILS.conf);
  assert.equal(c.order?.id, mine[0], 'the called order stays hers');
  assert.equal(c.called, true, 'the tap on « Appeler » is counted');
  // the result saved: the next one (the newest left) comes at once
  await call('confirmation.setTry', samira, { ids: [mine[0]], n: 1 });
  const next = await blocking(EMAILS.conf);
  assert.equal(next.order?.id, mine[1]);
  assert.equal(next.called, false, 'not called yet');
  assert.equal(next.queue, 0);
  // the managers and the administrators are never blocked
  for (const e of [EMAILS.manager, EMAILS.admin]) {
    const m = await blocking(e);
    assert.equal(m.order, null);
    assert.equal(m.gate, null);
  }
  // in the middle of another order (not a new one, open on her screen): the new one waits
  await db.query(`UPDATE orders SET locked_by = $1, locked_until = now() + interval '5 minutes' WHERE id = $2`, [samiraId, mine[0]]);
  const w = await blocking(EMAILS.conf);
  assert.equal(w.order, null);
  assert.equal(w.wait, true);
  await db.query('UPDATE orders SET locked_by = NULL, locked_until = NULL WHERE id = $1', [mine[0]]);
});

test('her phone: a test ring that reaches it, « je l’ai entendu », then she works — again each shift, and when it stops answering', async () => {
  const samira = await as(EMAILS.conf, server);
  const yacine = await as(EMAILS.manager);
  // notifications on on her computer only: not a phone
  await call('push.subscribe', samira, { endpoint: PC, p256dh: 'BKEY-1234567890', auth: 'AUTH-1234', ua: WINDOWS });
  assert.equal((await blocking(EMAILS.conf)).gate, 'none');
  await call('push.subscribe', samira, { endpoint: PHONE, p256dh: 'BKEY-0987654321', auth: 'AUTH-4321', ua: ANDROID });
  assert.equal((await blocking(EMAILS.conf)).gate, 'test', 'her phone: the test ring of this shift first');
  await assert.rejects(call('confirmation.phoneHeard', samira, { endpoint: PHONE }), /Faites d’abord sonner/);
  await assert.rejects(call('confirmation.phoneTest', samira, { endpoint: PC }), /Activez d’abord/, 'a computer cannot be the phone');
  assert.equal(((await call('confirmation.phoneTest', samira, { endpoint: PHONE })) as any).sent, 1);
  const t = sent[sent.length - 1];
  assert.deepEqual(t.subs.map((x: any) => x.endpoint), [PHONE], 'the phone only');
  assert.match(String(t.payload.ack), /^https:\/\/pilotix\.test\/api\/push\/ack\/[a-f0-9]{32}$/, 'the address its worker answers');
  assert.equal((await blocking(EMAILS.conf)).gate, 'test', 'not before the phone answers');
  assert.equal(await answer(), true);
  assert.equal((await blocking(EMAILS.conf)).gate, 'heard', 'it rang: now the agent says she heard it');
  await call('confirmation.phoneHeard', samira, { endpoint: PHONE });
  assert.equal((await blocking(EMAILS.conf)).gate, null, 'ready: she works');

  // a new shift (typed by a manager, begun before her check): the test ring again
  await call('confirmation.shiftSet', yacine, { agentId: samiraId, from: '00:00', to: '23:59' });
  await db.query(`UPDATE push_subs SET ack_at = now() - interval '25 hours', heard_at = now() - interval '25 hours' WHERE endpoint = $1`, [PHONE]);
  assert.equal((await blocking(EMAILS.conf)).gate, 'test', 'each shift starts with the test ring');
  await call('confirmation.phoneTest', samira, { endpoint: PHONE });
  await answer();
  await call('confirmation.phoneHeard', samira, { endpoint: PHONE });
  assert.equal((await blocking(EMAILS.conf)).gate, null);

  // a ring her phone does not answer for more than 3 minutes (off, no internet, notifications turned off): blocked again
  await db.query(`UPDATE push_subs SET ack_code = $2, asked_at = now() - interval '4 minutes' WHERE endpoint = $1`, [PHONE, 'a'.repeat(32)]);
  assert.equal((await blocking(EMAILS.conf)).gate, 'silent');
  assert.equal(((await call('push.ack', await as(EMAILS.admin), { code: 'a'.repeat(32) })) as any).ok, true);
  assert.equal((await blocking(EMAILS.conf)).gate, null, 'it answers again');

  // the managers see each agent's shift and phone
  const g: any = await call('confirmation.blockGet', yacine, {});
  const me = g.agents.find((a: any) => a.id === samiraId);
  assert.deepEqual(me.shift, { from: 0, to: 23 * 60 + 59 });
  assert.equal(me.phone, 'ok');
  await assert.rejects(call('confirmation.shiftSet', yacine, { agentId: samiraId, from: '15:00', to: '09:00' }), /après le début/);

  // outside her shift: nothing at all
  await call('confirmation.shiftSet', yacine, { agentId: samiraId, ...later() });
  const off = await blocking(EMAILS.conf);
  assert.equal(off.work, false);
  assert.equal(off.gate, null);
  assert.equal(off.order, null);
  await call('confirmation.shiftSet', yacine, { agentId: samiraId, from: null, to: null });
  assert.equal((await blocking(EMAILS.conf)).work, true, 'no shift: the calling hours again');
});

test('a new order rings her phone at once, then every 2 minutes until « Appeler » — never her computer, never outside her shift', async () => {
  const admin = await as(EMAILS.admin, server);
  const samira = await as(EMAILS.conf, server);
  const yacine = await as(EMAILS.manager);
  const run = async () => ((await call('confirmation.pushRun', admin, {})) as any).sent as number;
  // a third new order of hers, the newest: it rings first (one ring per agent: the order her phone shows)
  const third = Number((await db.query(`SELECT id FROM orders WHERE conf_status = 'new' AND agent_id IS NULL AND conf_agency_id IS NULL AND NOT is_exchange ORDER BY created_at DESC, id DESC LIMIT 1`))[0].id);
  await db.query('UPDATE orders SET agent_id = $2, assigned_at = now(), created_at = now(), locked_by = NULL, locked_until = NULL WHERE id = $1', [third, samiraId]);
  // she works in Pilotix on her computer right now: her phone rings all the same
  await db.query(`UPDATE profiles SET last_seen_at = now(), presence = 'online' WHERE id = $1`, [samiraId]);
  sent.length = 0;
  assert.equal(await run(), 1);
  assert.equal(sent.length, 1, 'one ring for her: the newest order, not the one behind it');
  assert.deepEqual(sent[0].subs.map((x: any) => x.endpoint), [PHONE], 'her phone, never her computer');
  assert.equal(sent[0].payload.tag, `conf-new-${third}`);
  assert.match(sent[0].payload.title, /Nouvelle commande/);
  assert.match(sent[0].payload.body, /\+1 après/, 'how many come after it');
  assert.equal(sent[0].payload.alarm, true);
  assert.equal(sent[0].payload.conf, true);
  assert.match(String(sent[0].payload.ack), /\/push\/ack\/[a-f0-9]{32}$/, 'each ring asks the phone to answer');
  assert.equal(await run(), 0, 'not again before 2 minutes');
  const back = async () => {
    const rings = await getSetting(db, 'confRings');
    for (const k of Object.keys(rings)) rings[k] = { ...rings[k], at: rings[k].at - RING_AGAIN_MS - 1000 };
    await setSetting(db, 'confRings', rings);
  };
  for (let i = 0; i < 8; i++) {
    await back();
    assert.equal(await run(), 1);
  }
  assert.match(sent[sent.length - 1].payload.title, /attend toujours/);
  assert.equal(sent.length, 9, 'no limit while it waits for her call');
  // busy with another order (not a new one, open on her screen, kept for her): it waits
  await db.query(`UPDATE orders SET locked_by = $1, locked_until = now() + interval '5 minutes' WHERE id = $2`, [samiraId, mine[0]]);
  await back();
  assert.equal(await run(), 0, 'not while she works on another order');
  await db.query('UPDATE orders SET locked_by = NULL, locked_until = NULL WHERE id = $1', [mine[0]]);
  // outside her shift: nothing rings
  await call('confirmation.shiftSet', yacine, { agentId: samiraId, ...later() });
  await back();
  assert.equal(await run(), 0, 'not outside her shift');
  await call('confirmation.shiftSet', yacine, { agentId: samiraId, from: null, to: null });
  // she tapped « Appeler »: the phone stops ringing (the result is what lets her go)
  await call('orders.logCall', samira, { id: third });
  await back();
  assert.equal(await run(), 0, 'called: no more ringing');
  await call('confirmation.setTry', samira, { ids: [third], n: 1 });
  assert.equal(await run(), 1, 'the result saved: the next one rings at once');
  assert.equal(sent[sent.length - 1].payload.tag, `conf-new-${mine[1]}`);
  // switched off: nothing waits to ring any more
  await call('confirmation.blockSet', yacine, { on: false });
  assert.deepEqual(await getSetting(db, 'confRings'), {});
  assert.equal(await run(), 0);
  assert.equal((await blocking(EMAILS.conf)).order, null);
});

test('a community manager is never blocked: she confirms the orders she makes from her chats, her computer stays open', async () => {
  const yacine = await as(EMAILS.manager);
  await call('confirmation.blockSet', yacine, { on: true });
  const hash = await hashPassword(DEMO_PASSWORD);
  const lina = Number((await db.query(`INSERT INTO profiles (name, email, phone, password_hash, roles) VALUES ('Lina', 'lina.block@demo.pilotix.dz', '0661999101', $1, '{cm}') RETURNING id`, [hash]))[0].id);
  const id = Number((await db.query(`SELECT id FROM orders WHERE conf_status = 'new' AND agent_id IS NULL AND conf_agency_id IS NULL AND NOT is_exchange ORDER BY id LIMIT 1`))[0].id);
  await db.query('UPDATE orders SET agent_id = $2, assigned_at = now(), locked_by = NULL, locked_until = NULL WHERE id = $1', [id, lina]);
  const b = await blocking('lina.block@demo.pilotix.dz');
  assert.equal(b.on, false, 'no phone gate for her');
  assert.equal(b.gate, null);
  assert.equal(b.order, null, 'nothing rings for an order she made herself');
  // her role includes Confirmation: she sees her own orders there
  assert.ok((await as('lina.block@demo.pilotix.dz')).session.roles.includes('confirmation'));
  await call('confirmation.blockSet', yacine, { on: false });
});
