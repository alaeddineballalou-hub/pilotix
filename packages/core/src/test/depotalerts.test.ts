// Dépôt alerts: an order the depot still holds, changed or cancelled from outside the depot → a red alert for the depot
// manager (or whoever is chosen) until it is scanned: cancelled = its label once; changed = the old label, then the new one.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(250));
});

const mine = async (ctx: Ctx, orderId: number) => ((await call('depot.alerts', ctx, {})) as any[]).filter((a) => a.orderId === orderId);

test('a change from outside the depot: old label, then the new label closes it; the depot’s own edits don’t alert', async () => {
  const admin = await as(EMAILS.admin);
  const karim = await as(EMAILS.depot);
  const o = (await db.query(`SELECT id, own_tracking FROM orders WHERE follow_status = 'prepared' AND tracking IS NULL ORDER BY id LIMIT 1`))[0];
  assert.ok(o, 'a prepared order without a courier code');
  const id = Number(o.id);
  await call('orders.update', karim, { id, address: 'Changée par le dépôt' });
  assert.equal((await mine(karim, id)).length, 0);
  await call('orders.update', admin, { id, address: 'Cité 200 logements, bloc B' });
  await call('orders.update', admin, { id, deliveryNote: 'Appeler avant' });
  const list = await mine(karim, id);
  assert.equal(list.length, 1, 'one alert per order');
  const a = list[0];
  assert.equal(a.kind, 'edit');
  assert.equal(a.oldCode, o.own_tracking, 'the code on the parcel');
  assert.ok(a.newCode && a.newCode !== o.own_tracking, 'a new label code');
  const now = (await db.query('SELECT own_tracking FROM orders WHERE id = $1', [id]))[0].own_tracking;
  assert.equal(now, a.newCode);
  assert.equal(a.changes.find((c: any) => c.field === 'address').to, 'Cité 200 logements, bloc B');
  assert.ok(a.changes.some((c: any) => c.field === 'note'));
  await assert.rejects(call('depot.alertScan', karim, { id: a.id, code: a.newCode }), /ancienne étiquette/);
  await assert.rejects(call('depot.alertScan', karim, { id: a.id, code: 'PXT00000000' }), /pas ce colis/);
  assert.equal(((await call('depot.alertScan', karim, { id: a.id, code: a.oldCode.toLowerCase() })) as any).step, 'found');
  await assert.rejects(call('depot.alertScan', karim, { id: a.id, code: a.oldCode }), /encore l’ancienne/);
  assert.equal(((await call('depot.alertScan', karim, { id: a.id, code: a.newCode })) as any).step, 'done');
  assert.equal((await mine(karim, id)).length, 0);
});

test('an order « à préparer » (not picked yet) just changes: no alert', async () => {
  const admin = await as(EMAILS.admin);
  const karim = await as(EMAILS.depot);
  const o = (await db.query(`SELECT id FROM orders WHERE follow_status = 'to_prepare' ORDER BY id LIMIT 2`));
  await call('orders.update', admin, { id: Number(o[0].id), address: 'Nouvelle adresse' });
  await call('orders.setConf', admin, { ids: [Number(o[1].id)], status: 'cancelled', reason: 'Client a annulé' });
  assert.equal((await mine(karim, Number(o[0].id))).length, 0);
  assert.equal((await mine(karim, Number(o[1].id))).length, 0);
});

test('a cancelled order: one scan of its label; only the chosen people get the alerts', async () => {
  const admin = await as(EMAILS.admin);
  const karim = await as(EMAILS.depot);
  const o = (await db.query(`SELECT id, COALESCE(tracking, own_tracking) AS code FROM orders WHERE follow_status = 'prepared' ORDER BY id DESC LIMIT 1`))[0];
  const id = Number(o.id);
  await call('orders.setConf', admin, { ids: [id], status: 'cancelled', reason: 'Client a annulé' });
  const a = (await mine(karim, id))[0];
  assert.ok(a);
  assert.equal(a.kind, 'cancel');
  assert.equal(a.newCode, null);
  // the owner gives the alerts to someone else: Karim no longer sees them
  const me = Number((await db.query(`SELECT id FROM profiles WHERE email = $1`, [EMAILS.admin]))[0].id);
  await call('depot.alertConfigSet', admin, { to: [me] });
  assert.equal((await mine(karim, id)).length, 0);
  await call('depot.alertConfigSet', admin, { to: [] });
  assert.equal(((await call('depot.alertScan', karim, { id: a.id, code: o.code })) as any).step, 'done');
  await assert.rejects(call('depot.alerts', await as(EMAILS.conf), {}), /Accès refusé/);
});

test('an open alert rings on the phones of the people away from the app, not more than once a minute', async () => {
  const sent: any[] = [];
  const server = {
    pushKeys: () => ({ publicKey: 'BPUBLIC', privateKey: 'PRIVATE' }),
    push: async (_k: any, subs: any[], payload: any) => {
      sent.push({ subs, payload });
      return subs.map((s) => ({ endpoint: s.endpoint, ok: true, gone: false }));
    },
  } as any;
  const admin = await (as as any)(EMAILS.admin, server);
  const karim = await (as as any)(EMAILS.depot, server);
  assert.equal(((await call('push.key', karim, {})) as any).key, 'BPUBLIC');
  await call('push.subscribe', karim, { endpoint: 'https://push.example.com/abc', p256dh: 'BKEY-1234567890', auth: 'AUTH-1234' });
  assert.equal(((await call('depot.alertMine', karim, {})) as any).mine, true);
  const o = (await db.query(`SELECT id FROM orders WHERE follow_status = 'prepared' AND tracking IS NULL ORDER BY id DESC LIMIT 1`))[0];
  await call('orders.update', admin, { id: Number(o.id), address: 'Rue des Frères, 12' });
  await db.query(`UPDATE profiles SET last_seen_at = NULL WHERE email = $1`, [EMAILS.depot]);
  const r: any = await call('depot.pushRun', admin, {});
  assert.ok(r.sent >= 1);
  assert.match(sent[0].payload.title, /MODIFIÉE/);
  assert.equal(sent[0].subs[0].endpoint, 'https://push.example.com/abc');
  const again: any = await call('depot.pushRun', admin, {});
  assert.equal(again.sent, 0, 'not twice in the same minute');
  // in the app right now: the alarm rings there, no notification
  await db.query(`UPDATE depot_alerts SET pushed_at = NULL`);
  await db.query(`UPDATE profiles SET last_seen_at = now(), presence = 'online' WHERE email = $1`, [EMAILS.depot]);
  assert.equal(((await call('depot.pushRun', admin, {})) as any).sent, 0);
});
