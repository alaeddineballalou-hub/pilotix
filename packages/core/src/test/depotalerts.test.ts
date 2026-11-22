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

/** A prepared order no alert has used yet (packed now), going with a company of this kind (`code`: its courier code, if
 *  any). Own livreurs: its Pilotix label printed in « En dispatch » (`printed` false: not printed yet). */
async function take(kind: 'own' | 'zr', code: string | null = null, printed = true) {
  const o = (
    await db.query(
      `SELECT id FROM orders o WHERE follow_status IN ('prepared', 'to_prepare') AND conf_status = 'confirmed' AND tracking IS NULL
          AND NOT EXISTS (SELECT 1 FROM depot_alerts a WHERE a.order_id = o.id)
        ORDER BY (follow_status = 'prepared') DESC, id DESC LIMIT 1`,
    )
  )[0];
  assert.ok(o, 'a confirmed order still at the depot');
  const company = (await db.query(`SELECT id, name FROM delivery_companies WHERE kind = $1 ORDER BY id LIMIT 1`, [kind]))[0];
  const r = (
    await db.query(
      `UPDATE orders SET follow_status = 'prepared', company_id = $2, tracking = $3, label_code = CASE WHEN $4 THEN own_tracking END WHERE id = $1 RETURNING id, own_tracking`,
      [o.id, company.id, code, kind === 'own' && printed],
    )
  )[0];
  return { id: Number(r.id), ownTracking: r.own_tracking as string, company: company.name as string };
}

test('a change from outside the depot: old label, then the new label closes it; the depot’s own edits don’t alert', async () => {
  const admin = await as(EMAILS.admin);
  const karim = await as(EMAILS.depot);
  // the shop's own livreurs: the Pilotix label
  const t = await take('own');
  const o = { own_tracking: t.ownTracking };
  const id = t.id;
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
  const t = await take('own');
  const o = { code: t.ownTracking };
  const id = t.id;
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
  await call('push.subscribe', karim, { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: 'BKEY-1234567890', auth: 'AUTH-1234' });
  assert.equal(((await call('depot.alertMine', karim, {})) as any).mine, true);
  const o = (await db.query(`SELECT id FROM orders WHERE follow_status = 'prepared' AND tracking IS NULL ORDER BY id DESC LIMIT 1`))[0];
  await call('orders.update', admin, { id: Number(o.id), address: 'Rue des Frères, 12' });
  await db.query(`UPDATE profiles SET last_seen_at = NULL WHERE email = $1`, [EMAILS.depot]);
  const r: any = await call('depot.pushRun', admin, {});
  assert.ok(r.sent >= 1);
  assert.match(sent[0].payload.title, /MODIFIÉE/);
  assert.equal(sent[0].subs[0].endpoint, 'https://fcm.googleapis.com/fcm/send/abc');
  const again: any = await call('depot.pushRun', admin, {});
  assert.equal(again.sent, 0, 'not twice in the same minute');
  // in the app right now: the alarm rings there, no notification
  await db.query(`UPDATE depot_alerts SET pushed_at = NULL`);
  await db.query(`UPDATE profiles SET last_seen_at = now(), presence = 'online' WHERE email = $1`, [EMAILS.depot]);
  assert.equal(((await call('depot.pushRun', admin, {})) as any).sent, 0);
});

test('ZR refused the parcel (no label was ever printed): no « old label » step; sent to ZR, then only its ZR label closes it', async () => {
  const admin = await as(EMAILS.admin);
  const karim = await as(EMAILS.depot);
  const t = await take('zr');
  await call('orders.update', admin, { id: t.id, address: 'azefoune' });
  const a = (await mine(karim, t.id))[0];
  assert.ok(a);
  assert.equal(a.noOld, true, 'the parcel never had a label');
  assert.equal(a.oldCode, null);
  assert.equal(a.found, true, 'nothing to find by its label');
  assert.equal(a.api, true);
  assert.equal(a.send, true, 'no ZR code yet: it is sent to ZR first');
  assert.equal(a.newCode, null);
  assert.equal(a.companyName, t.company);
  await assert.rejects(call('depot.alertScan', karim, { id: a.id, code: t.ownTracking }), /Envoyer à/);
  // ZR gives its code (the red screen's « Envoyer à ZR »)
  await db.query('UPDATE orders SET tracking = $2 WHERE id = $1', [t.id, '15-MB6NUQH89N-ZR']);
  const b = (await mine(karim, t.id))[0];
  assert.equal(b.send, false);
  assert.equal(b.newCode, '15-MB6NUQH89N-ZR', 'the ZR label, never a Pilotix one');
  const pilotix = (await db.query('SELECT own_tracking FROM orders WHERE id = $1', [t.id]))[0].own_tracking;
  await assert.rejects(call('depot.alertScan', karim, { id: a.id, code: pilotix }), /pas l’étiquette/);
  assert.equal(((await call('depot.alertScan', karim, { id: a.id, code: '15-mb6nuqh89n-zr' })) as any).step, 'done');
  assert.equal((await mine(karim, t.id)).length, 0);
  const ev = await db.query(`SELECT note FROM order_events WHERE order_id = $1 AND kind = 'note' ORDER BY id DESC LIMIT 1`, [t.id]);
  assert.match(ev[0].note, /étiquette .+ collée/);
});

test('a parcel already carrying its ZR label: one scan of it is enough', async () => {
  const admin = await as(EMAILS.admin);
  const karim = await as(EMAILS.depot);
  const t = await take('zr', '16-AAAA1111-ZR');
  await call('orders.update', admin, { id: t.id, deliveryNote: 'Appeler avant de passer' });
  const a = (await mine(karim, t.id))[0];
  assert.equal(a.oldCode, '16-AAAA1111-ZR');
  assert.equal(a.noOld, false);
  assert.equal(a.send, false);
  assert.equal(a.newCode, null, 'the label on the parcel is already the right one');
  assert.equal(((await call('depot.alertScan', karim, { id: a.id, code: '16-AAAA1111-ZR' })) as any).step, 'done');
});

test('ZR made the parcel again (phone changed): the old ZR label, then the new ZR label', async () => {
  const admin = await as(EMAILS.admin);
  const karim = await as(EMAILS.depot);
  const t = await take('zr', '16-OLD22222-ZR');
  await call('orders.update', admin, { id: t.id, phone: '0661234599' });
  const now = (await db.query('SELECT tracking FROM orders WHERE id = $1', [t.id]))[0].tracking;
  const a = (await mine(karim, t.id))[0];
  assert.ok(a);
  assert.equal(a.oldCode, '16-OLD22222-ZR', 'the label still on the parcel');
  assert.ok(now && now !== '16-OLD22222-ZR', 'made again at once at ZR, with a new code');
  assert.equal(a.newCode, now, 'the new ZR label (before: one scan of the old one, and no new label asked)');
  assert.equal(((await call('depot.alertScan', karim, { id: a.id, code: '16-OLD22222-ZR' })) as any).step, 'found');
  await assert.rejects(call('depot.alertScan', karim, { id: a.id, code: '16-OLD22222-ZR' }), /encore l’ancienne/);
  assert.equal(((await call('depot.alertScan', karim, { id: a.id, code: now })) as any).step, 'done');
});

test('a cancelled parcel that never had a label: nothing to scan, « Colis retiré » closes it', async () => {
  const admin = await as(EMAILS.admin);
  const karim = await as(EMAILS.depot);
  const t = await take('zr');
  await call('orders.setConf', admin, { ids: [t.id], status: 'cancelled', reason: 'Client a annulé' });
  const a = (await mine(karim, t.id))[0];
  assert.ok(a);
  assert.equal(a.kind, 'cancel');
  assert.equal(a.noOld, true);
  assert.equal(a.oldCode, null);
  await assert.rejects(call('depot.alertScan', karim, { id: a.id, code: t.ownTracking }), /jamais eu d’étiquette/);
  assert.equal(((await call('depot.alertNoLabel', karim, { id: a.id })) as any).step, 'done');
  assert.equal((await mine(karim, t.id)).length, 0);
  // a parcel with a label is never closed without its scan
  const u = await take('own');
  await call('orders.setConf', admin, { ids: [u.id], status: 'cancelled', reason: 'Client a annulé' });
  const b = (await mine(karim, u.id))[0];
  await assert.rejects(call('depot.alertNoLabel', karim, { id: b.id }), /en scannant/);
  assert.equal(((await call('depot.alertScan', karim, { id: b.id, code: u.ownTracking })) as any).step, 'done');
});

test('own livreurs, a change before the Pilotix label was printed: no « old label » to scan, the new label closes it', async () => {
  const admin = await as(EMAILS.admin);
  const karim = await as(EMAILS.depot);
  const t = await take('own', null, false);
  await call('orders.update', admin, { id: t.id, address: 'Cité 500 logements, bâtiment 3' });
  const a = (await mine(karim, t.id))[0];
  assert.ok(a);
  assert.equal(a.noOld, true, 'never printed: nothing to find by its label');
  assert.equal(a.oldCode, null);
  assert.ok(a.newCode, 'its new Pilotix label');
  await assert.rejects(call('depot.alertScan', karim, { id: a.id, code: t.ownTracking }), /./);
  assert.equal(((await call('depot.alertScan', karim, { id: a.id, code: a.newCode })) as any).step, 'done');
  // the depot prints its label: a change later asks for that one
  assert.equal(((await call('depot.labelsPrinted', karim, { items: [{ id: t.id, code: a.newCode }] })) as any).recorded, 1);
  assert.equal(((await call('depot.labelsPrinted', karim, { items: [{ id: t.id, code: 'PXT99999999' }] })) as any).recorded, 0, 'not this order’s code: ignored');
  await call('orders.update', admin, { id: t.id, address: 'Cité 500 logements, bâtiment 4' });
  const b = (await mine(karim, t.id))[0];
  assert.equal(b.noOld, false);
  assert.equal(b.oldCode, a.newCode, 'the label printed on the parcel');
  // an order from before the record (label_known false): its label may be there, asked as before
  const u = await take('own', null, false);
  await db.query('UPDATE orders SET label_known = false WHERE id = $1', [u.id]);
  await call('orders.update', admin, { id: u.id, address: 'Rue 1' });
  const c = (await mine(karim, u.id))[0];
  assert.equal(c.noOld, false);
  assert.equal(c.oldCode, u.ownTracking);
});
