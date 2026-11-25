// The Pilotix Android app's phones (Firebase, step 7 of mobile/PROGRESS.md): the website saves each one as « fcm:<token> »
// next to the browsers' devices; the server tells them through server.fcm (never Web Push), forgets the ones Firebase says
// are gone, and « Bloquer jusqu'à l'appel » rings them too — its ring carries `ring` and the phone's one-time answer
// address. A server with only Firebase (no browser keys) still reaches them.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, setSetting } from '../index';
import { appEndpoint, fcmGone, fcmMessage, pushOnly } from '../modules/push';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;

const TOKEN = `dR8xQ2${'A'.repeat(120)}:APA91b${'x'.repeat(30)}`;
const APP = `fcm:${TOKEN}`;
const WEB = 'https://fcm.googleapis.com/fcm/send/app-test-browser';
/** the app's WebView: Android, « wv » and the app's own word */
const APP_UA = 'Mozilla/5.0 (Linux; Android 14; SM-A546B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36 PilotixApp';

const web: { subs: { endpoint: string }[]; payload: any }[] = [];
const app: { tokens: string[]; payload: any }[] = [];
const gone = new Set<string>();
const both = {
  publicUrl: 'https://pilotix.test',
  pushKeys: () => ({ publicKey: 'BPUBLIC', privateKey: 'PRIVATE' }),
  push: async (_k: unknown, subs: { endpoint: string }[], payload: any) => {
    web.push({ subs, payload });
    return subs.map((s) => ({ endpoint: s.endpoint, ok: true, gone: false }));
  },
  fcm: async (tokens: string[], payload: any) => {
    app.push({ tokens, payload });
    return tokens.map((token) => ({ token, ok: !gone.has(token), gone: gone.has(token) }));
  },
} as any;
/** a server that has the Firebase key only */
const firebaseOnly = { publicUrl: both.publicUrl, fcm: both.fcm } as any;

const rowOf = async (endpoint: string) => (await db.query('SELECT profile_id, p256dh, auth, ua, ack_code, ack_at FROM push_subs WHERE endpoint = $1', [endpoint]))[0] as any;

before(async () => {
  ({ db, as } = await setup(120));
});

test('an app phone is saved with its token, in place of a browser; a broken token or another address is refused', async () => {
  const me = await as(EMAILS.conf, both);
  assert.equal(appEndpoint(APP), true);
  assert.equal(appEndpoint('fcm:short'), false, 'too short for a Firebase token');
  assert.equal(appEndpoint(`fcm:${'a'.repeat(30)}/x`), false, 'only the letters a token has');
  assert.equal(appEndpoint(WEB), false);
  assert.deepEqual(await call('push.subscribe', me, { endpoint: APP, ua: APP_UA }), { ok: true });
  const r = await rowOf(APP);
  assert.equal(Number(r.profile_id), me.session.profile.id);
  assert.equal(r.p256dh, 'pilotix-app', 'no browser keys: the table keeps a placeholder');
  assert.equal(r.ua, APP_UA);
  await assert.rejects(call('push.subscribe', me, { endpoint: 'fcm:short', ua: APP_UA }));
  await assert.rejects(call('push.subscribe', me, { endpoint: 'https://evil.example/push', p256dh: 'k'.repeat(20), auth: 'a'.repeat(10) }), /refusée/);
  // a browser's device is saved as before
  assert.deepEqual(await call('push.subscribe', me, { endpoint: WEB, p256dh: 'BKEY'.repeat(5), auth: 'AUTH1234', ua: 'Mozilla/5.0 (Windows NT 10.0)' }), { ok: true });
});

test('a notification goes to the browser by Web Push and to the app phone by Firebase, once each', async () => {
  const me = await as(EMAILS.conf, both);
  web.length = 0;
  app.length = 0;
  const n = await pushOnly(me, [me.session.profile.id], { title: 'Nouvelle commande', body: 'PX1 · Alger', tag: 'order-1', alarm: true, order: 1 });
  assert.equal(n, 2, 'both devices');
  assert.deepEqual(web.flatMap((x) => x.subs.map((s) => s.endpoint)), [WEB], 'Web Push: the browser only');
  assert.deepEqual(app.flatMap((x) => x.tokens), [TOKEN], 'Firebase: the token, without « fcm: »');
  assert.equal(app[0].payload.title, 'Nouvelle commande');
  assert.equal(app[0].payload.alarm, true);
  // the phones only (« Bloquer jusqu'à l'appel »): the app phone, not the computer
  web.length = 0;
  app.length = 0;
  assert.equal(await pushOnly(me, [me.session.profile.id], { title: 'x', tag: 'p' }, { phones: true }), 1);
  assert.equal(web.length, 0);
  assert.deepEqual(app.flatMap((x) => x.tokens), [TOKEN]);
});

test('a server with only the Firebase key still tells the app phone (and its test), never the browsers', async () => {
  const me = await as(EMAILS.conf, firebaseOnly);
  web.length = 0;
  app.length = 0;
  assert.equal(await pushOnly(me, [me.session.profile.id], { title: 'x', tag: 'f' }), 1);
  assert.equal(web.length, 0);
  assert.deepEqual(((await call('push.test', me, { endpoint: APP })) as any).sent, true);
  assert.deepEqual(((await call('push.test', me, { endpoint: WEB })) as any).sent, false, 'no browser keys here');
});

test('« Bloquer jusqu’à l’appel »: the test ring reaches the app phone with `ring` and its one-time answer address', async () => {
  const samira = await as(EMAILS.conf, both);
  const yacine = await as(EMAILS.manager, both);
  await call('confirmation.blockSet', yacine, { on: true });
  app.length = 0;
  const r: any = await call('confirmation.phoneTest', samira, { endpoint: APP });
  assert.equal(r.sent, 1);
  const p = app[app.length - 1].payload;
  assert.equal(p.ring, true, 'the app rings its loud ring');
  assert.equal(p.alarm, true);
  assert.match(String(p.ack), /^https:\/\/pilotix\.test\/api\/push\/ack\/[a-f0-9]{32}$/);
  // the app posts it back when the message arrives: the phone counts as ringing
  const code = String(p.ack).split('/').pop();
  assert.equal(((await call('push.ack', await as(EMAILS.admin), { code })) as any).ok, true);
  assert.ok((await rowOf(APP)).ack_at, 'heard back from the phone');
  await setSetting(db, 'confBlock', { on: false, by: null, at: null });
});

test('an app phone Firebase says is gone is forgotten; the browser stays', async () => {
  const me = await as(EMAILS.conf, both);
  gone.add(TOKEN);
  await pushOnly(me, [me.session.profile.id], { title: 'x', tag: 'g' });
  assert.equal(await rowOf(APP), undefined, 'forgotten');
  assert.ok(await rowOf(WEB), 'the browser is still there');
  gone.clear();
});

test('the Firebase message: data only, every value as text, high priority; « gone » only for a token Firebase no longer knows', () => {
  const m = fcmMessage('tok', { title: 'A', body: '', alarm: true, conf: false, ring: true, order: 12, url: '#/x', workspace: 'baby-joy', nothing: null });
  assert.deepEqual(m, { message: { token: 'tok', data: { title: 'A', alarm: '1', ring: '1', order: '12', url: '#/x', workspace: 'baby-joy' }, android: { priority: 'HIGH', ttl: '120s' } } });
  assert.equal(fcmGone(404, null), true);
  assert.equal(fcmGone(404, { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }), true);
  assert.equal(fcmGone(403, { error: { status: 'PERMISSION_DENIED', details: [{ errorCode: 'SENDER_ID_MISMATCH' }] } }), false, "a key from another project: the phones stay");
  assert.equal(fcmGone(400, { error: { status: 'INVALID_ARGUMENT', message: 'The registration token is not a valid FCM registration token' } }), true);
  assert.equal(fcmGone(400, { error: { status: 'INVALID_ARGUMENT', message: 'Invalid JSON payload received.' } }), false, 'the message, not the phone');
  assert.equal(fcmGone(401, { error: { status: 'UNAUTHENTICATED' } }), false, "the server's key: the phone stays");
  assert.equal(fcmGone(429, { error: { status: 'RESOURCE_EXHAUSTED' } }), false);
  assert.equal(fcmGone(503, { error: { status: 'UNAVAILABLE' } }), false);
});
