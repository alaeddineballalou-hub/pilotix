// Suivi › En livraison (moved from the Dépôt) and the alerts of « Livraison privée »: what the livreur says on a parcel
// he could not deliver sends it to Suivi › Alertes when the Préférences say so (a suivi agent calls the customer first).
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;
let admin: Ctx, liv: Ctx;

before(async () => {
  ({ db, as } = await setup(40));
  admin = await as(EMAILS.admin);
  liv = await as(EMAILS.livreur);
});

/** a parcel of our own livreurs, in his hands (« En livraison ») */
async function onRoad(): Promise<number> {
  const own = Number((await db.query(`SELECT id FROM delivery_companies WHERE kind = 'own' LIMIT 1`))[0].id);
  const o = (await db.query(`SELECT id FROM orders WHERE conf_status = 'confirmed' AND NOT is_exchange ORDER BY id DESC LIMIT 1 OFFSET $1`, [n++]))[0];
  await db.query(
    `UPDATE orders SET company_id = $2, livreur_id = $3, follow_status = 'out_for_delivery', sub_status = NULL, shipped_at = now(), cashed = false WHERE id = $1`,
    [o.id, own, liv.session.profile.id],
  );
  return Number(o.id);
}
let n = 0;
const statusOf = async (id: number) => (await db.query('SELECT follow_status FROM orders WHERE id = $1', [id]))[0].follow_status;

test('the recommended choices: « ne répond pas », « absent », « refusé », « injoignable » go to Alertes', async () => {
  const p = ((await call('prefs.get', admin, {})) as any).prefs;
  assert.deepEqual(p.livreurAlerts, ['failed:no_answer', 'failed:absent', 'returning:refused', 'returning:unreachable']);
});

test('what the livreur says sends the parcel to Alertes, or not, as the Préférences say', async () => {
  const a = await onRoad();
  await call('orders.setFollow', liv, { ids: [a], status: 'failed', reason: 'Ne répond pas', reasonKey: 'no_answer' });
  assert.equal(await statusOf(a), 'alert', 'a suivi agent calls first');
  const b = await onRoad();
  await call('orders.setFollow', liv, { ids: [b], status: 'failed', reason: 'Reporté', reasonKey: 'postponed_by_client' });
  assert.equal(await statusOf(b), 'failed', 'not chosen: stays a failed attempt');
  const c = await onRoad();
  await call('orders.setFollow', liv, { ids: [c], status: 'returning', reason: 'Refusé', reasonKey: 'refused' });
  assert.equal(await statusOf(c), 'alert', 'a refusal is called before coming back');
  // the seller changes his mind
  const base = ((await call('prefs.get', admin, {})) as any).prefs;
  await call('prefs.set', admin, { ...base, livreurAlerts: ['failed:postponed_by_client'] });
  const d = await onRoad();
  await call('orders.setFollow', liv, { ids: [d], status: 'returning', reason: 'Refusé', reasonKey: 'refused' });
  assert.equal(await statusOf(d), 'returning');
  const e = await onRoad();
  await call('orders.setFollow', liv, { ids: [e], status: 'failed', reason: 'Reporté', reasonKey: 'postponed_by_client' });
  assert.equal(await statusOf(e), 'alert');
  await assert.rejects(call('prefs.set', admin, { ...base, livreurAlerts: ['alert:anything'] }));
  await call('prefs.set', admin, base);
});

test('Suivi › En livraison: the parcels on the road, without the treated alerts; counted', async () => {
  const a = await onRoad();
  const b = await onRoad();
  await db.query(`UPDATE orders SET sub_status = 'alert_traitee' WHERE id = $1`, [b]);
  const suivi = await as(EMAILS.suivi);
  const r = (await call('suivi.list', suivi, { tab: 'enlivraison', pageSize: 500 })) as any;
  const ids = r.rows.map((o: any) => o.id);
  assert.ok(ids.includes(a) && !ids.includes(b));
  assert.ok(r.rows.every((o: any) => ['out_for_delivery', 'failed'].includes(o.followStatus)));
  const c = (await call('suivi.counts', suivi, {})) as any;
  assert.ok(c.enlivraison >= 1);
});

test('each delivery company: its statuses that send a parcel to Alertes are ticked; changed, the others stay', async () => {
  const list = (await call('delivery.alertStatuses', admin, {})) as any[];
  const yal = list.find((c) => /yalidine/i.test(c.name));
  assert.ok(yal, 'Yalidine in the demo');
  assert.ok(yal.statuses.find((s: any) => s.status === 'En alerte')?.alert, 'its own « En alerte » is an alert');
  assert.ok(!yal.statuses.some((s: any) => s.status === 'Livré'), 'a status that ends the parcel is not offered');
  await call('delivery.saveAlertStatuses', admin, { companyId: yal.companyId, alert: ['Tentative échouée'] });
  const after = ((await call('delivery.alertStatuses', admin, {})) as any[]).find((c) => c.companyId === yal.companyId);
  assert.deepEqual(after.statuses.filter((s: any) => s.alert).map((s: any) => s.status), ['Tentative échouée']);
  const map = ((await call('delivery.statuses', admin, { companyId: yal.companyId })) as any[]).filter((r) => r.own !== undefined);
  assert.equal(map.find((r) => r.status === 'En alerte')?.own, 'out_for_delivery', 'unticked: stays on the road');
  assert.equal(map.find((r) => r.status === 'Tentative échouée')?.own, 'alert');
  await assert.rejects(call('delivery.alertStatuses', liv, {}));
});

test('« Alerte suivante »: the oldest alert, locked 15 minutes to the agent; his own parcels first; nobody else acts on it meanwhile', async () => {
  const suivi = await as(EMAILS.suivi);
  const me = suivi.session.profile.id;
  // two alerts nobody has: the older one comes first
  const a = await onRoad();
  const b = await onRoad();
  await db.query(`UPDATE orders SET follow_status = 'alert', follow_agent_id = NULL, locked_by = NULL, locked_until = NULL WHERE follow_status = 'alert'`);
  await db.query(`UPDATE orders SET follow_status = 'alert', follow_agent_id = NULL WHERE id = ANY($1)`, [[a, b]]);
  await db.query(`INSERT INTO order_events (order_id, user_id, kind, from_value, to_value, at) VALUES ($1, NULL, 'follow_status', 'out_for_delivery', 'alert', now() - interval '5 hours'), ($2, NULL, 'follow_status', 'out_for_delivery', 'alert', now() - interval '1 hour')`, [b, a]);
  await db.query(`UPDATE orders SET follow_status = 'out_for_delivery' WHERE follow_status = 'alert' AND NOT (id = ANY($1))`, [[a, b]]);
  const r1 = (await call('suivi.next', suivi, {})) as any;
  assert.equal(r1.id, b, 'the oldest alert first');
  assert.equal(r1.order.followStatus, 'alert');
  const lock = (await db.query('SELECT locked_by FROM orders WHERE id = $1', [b]))[0];
  assert.equal(lock.locked_by, me);
  // a second suivi agent: he gets the other alert, and cannot act on b while it is taken
  const confEmail = EMAILS.conf;
  await db.query(`UPDATE profiles SET roles = array_append(roles, 'suivi') WHERE email = $1 AND NOT ('suivi' = ANY(roles))`, [confEmail]);
  const two = await as(confEmail);
  const r2 = (await call('suivi.next', two, {})) as any;
  assert.equal(r2.id, a, 'never the same parcel');
  await assert.rejects(call('suivi.act', two, { id: b, action: 'cancel' }), /s’en occupe/);
  await call('suivi.release', two, { id: a });
  // « Alerte suivante » again with nothing done on b: b is released and skipped, a comes
  const r3 = (await call('suivi.next', suivi, { skip: [b], release: b })) as any;
  assert.equal(r3.id, a);
  assert.equal((await db.query('SELECT locked_by FROM orders WHERE id = $1', [b]))[0].locked_by, null, 'released');
  // once he acted on a parcel it stays his while he works: the other agent does not get it
  await call('suivi.release', suivi, { id: a });
  await db.query('UPDATE orders SET follow_agent_id = $2 WHERE id = $1', [b, me]);
  await db.query('UPDATE profiles SET last_seen_at = now() WHERE id = $1', [me]);
  const r4 = (await call('suivi.next', two, {})) as any;
  assert.equal(r4.id, a, 'his parcel stays his');
  await call('suivi.release', two, { id: a });
  // not seen for 8 hours (off today): his parcels go back to everyone
  await db.query(`UPDATE profiles SET last_seen_at = now() - interval '9 hours' WHERE id = $1`, [me]);
  const r5 = (await call('suivi.next', two, { skip: [a] })) as any;
  assert.equal(r5.id, b);
  await call('suivi.release', two, { id: b });
  // his own first
  const r6 = (await call('suivi.next', suivi, {})) as any;
  assert.equal(r6.id, b, 'his own parcel first');
  // nothing left
  const r7 = (await call('suivi.next', suivi, { skip: [a, b] })) as any;
  assert.equal(r7.id, null);
});

test('the clock of an alert: the first call within 2 working hours, then solved within 24; late alerts counted for the manager', async () => {
  const suivi = await as(EMAILS.suivi);
  const fresh = await onRoad();
  const old = await onRoad();
  await db.query(`UPDATE orders SET follow_status = 'alert', locked_by = NULL, locked_until = NULL WHERE id = ANY($1)`, [[fresh, old]]);
  await db.query(
    `INSERT INTO order_events (order_id, user_id, kind, from_value, to_value, at) VALUES ($1, NULL, 'follow_status', 'out_for_delivery', 'alert', now()), ($2, NULL, 'follow_status', 'out_for_delivery', 'alert', now() - interval '3 days')`,
    [fresh, old],
  );
  const before = (await call('suivi.counts', suivi, {})) as any;
  const list = (await call('suivi.list', suivi, { tab: 'alertes', pageSize: 500 })) as any;
  const cf = list.extra[fresh].clock;
  const co = list.extra[old].clock;
  assert.equal(cf.kind, 'call');
  assert.equal(cf.state, 'ok');
  assert.ok(cf.left > 100 && cf.left <= 120, 'two working hours');
  assert.equal(co.kind, 'call');
  assert.equal(co.state, 'late');
  assert.ok(before.lateCall >= 1);
  // a call is logged: the first call is done, the clock is now for solving it (24 working hours from the alert)
  await call('orders.logCall', suivi, { id: old });
  const after = (await call('suivi.list', suivi, { tab: 'alertes', pageSize: 500 })) as any;
  assert.equal(after.extra[old].clock.kind, 'solve');
  const c2 = (await call('suivi.counts', suivi, {})) as any;
  assert.equal(c2.lateCall, before.lateCall - 1);
  // the seller sets the times (Préférences)
  const base = ((await call('prefs.get', admin, {})) as any).prefs;
  assert.deepEqual(base.suiviClock, { firstHours: 2, solveHours: 24 });
  await call('prefs.set', admin, { ...base, suiviClock: { firstHours: 1, solveHours: 8 } });
  const l3 = (await call('suivi.list', suivi, { tab: 'alertes', pageSize: 500 })) as any;
  assert.ok(l3.extra[fresh].clock.left <= 60);
  await call('prefs.set', admin, base);
});

test('« Client annule » on an alert: after the seller\'s calls (far enough apart), or the customer himself, or « annulé trop tôt » with a reason', async () => {
  const suivi = await as(EMAILS.suivi);
  const mk = async () => {
    const id = await onRoad();
    await db.query(`UPDATE orders SET follow_status = 'alert', locked_by = NULL, locked_until = NULL WHERE id = $1`, [id]);
    await db.query(`INSERT INTO order_events (order_id, user_id, kind, from_value, to_value, at) VALUES ($1, NULL, 'follow_status', 'out_for_delivery', 'alert', now() - interval '1 day')`, [id]);
    return id;
  };
  const callAt = (id: number, ago: string) =>
    db.query(`INSERT INTO order_events (order_id, user_id, kind, at) VALUES ($1, $2, 'call', now() - $3::interval)`, [id, suivi.session.profile.id, ago]);
  // no call yet: refused, with how many are needed
  const a = await mk();
  await assert.rejects(call('suivi.act', suivi, { id: a, action: 'cancel' }), /3 appels \(0 faits\)/);
  // three calls but two only 10 minutes apart: 2 tries count
  await callAt(a, '5 hours');
  await callAt(a, '4 hours 50 minutes');
  await callAt(a, '2 hours');
  const tr = ((await call('suivi.list', suivi, { tab: 'alertes', pageSize: 500 })) as any).extra[a].tries;
  assert.deepEqual([tr.done, tr.need], [2, 3]);
  await assert.rejects(call('suivi.act', suivi, { id: a, action: 'cancel' }), /2 faits/);
  await callAt(a, '30 minutes');
  await call('suivi.act', suivi, { id: a, action: 'cancel' });
  assert.equal(await statusOf(a), 'returning');
  // the customer himself cancels: always allowed
  const b = await mk();
  await call('suivi.act', suivi, { id: b, action: 'cancel', by: 'client' });
  assert.equal(await statusOf(b), 'returning');
  // before the tries: a reason is needed, and it shows as « annulé trop tôt »
  const c = await mk();
  await assert.rejects(call('suivi.act', suivi, { id: c, action: 'cancel', by: 'early' }));
  await call('suivi.act', suivi, { id: c, action: 'cancel', by: 'early', note: 'Le client a bloqué le numéro' });
  const rc = (await db.query('SELECT follow_status, sub_status FROM orders WHERE id = $1', [c]))[0];
  assert.deepEqual([rc.follow_status, rc.sub_status], ['returning', 'annule_trop_tot']);
  // the seller changes the number
  const base = ((await call('prefs.get', admin, {})) as any).prefs;
  assert.deepEqual(base.suiviTries, { calls: 3, gapMinutes: 60 });
  await call('prefs.set', admin, { ...base, suiviTries: { calls: 1, gapMinutes: 0 } });
  const d = await mk();
  await callAt(d, '1 minute');
  await call('suivi.act', suivi, { id: d, action: 'cancel' });
  assert.equal(await statusOf(d), 'returning');
  await call('prefs.set', admin, base);
});

test('« Traiter »: Résolu (back on the road, the livreur asked to deliver again) or Perdu, always with a motif from Management', async () => {
  const suivi = await as(EMAILS.suivi);
  const mk = async () => {
    const id = await onRoad();
    await db.query(`UPDATE orders SET follow_status = 'alert', tracking = COALESCE(tracking, 'TRK' || id), locked_by = NULL, locked_until = NULL WHERE id = $1`, [id]);
    await db.query(`INSERT INTO order_events (order_id, user_id, kind, from_value, to_value, at) VALUES ($1, NULL, 'follow_status', 'out_for_delivery', 'alert', now() - interval '1 hour')`, [id]);
    await db.query(`DELETE FROM claims WHERE order_id = $1`, [id]);
    return id;
  };
  const m = (await call('suivi.motifs', suivi, {})) as any;
  assert.ok(m.resolved.some((x: any) => x.key === 'new_date') && m.lost.some((x: any) => x.key === 'refused' && x.client));
  // Résolu: back on the road with the motif, and a claim « relivrer » to our livreur
  const a = await mk();
  const r = (await call('suivi.resolve', suivi, { id: a, outcome: 'resolved', motif: 'new_date', date: '2026-11-02', note: 'après 14 h' })) as any;
  assert.equal(r.order.followStatus, 'out_for_delivery');
  assert.equal(r.order.subStatus, 'alert_traitee');
  assert.ok(r.claim, r.claimError ?? 'a claim');
  assert.equal(r.claim.reason, 'relivrer');
  assert.ok(r.claim.livreurId, 'to our livreur');
  const tl = (await call('suivi.list', suivi, { tab: 'traites', pageSize: 500 })) as any;
  assert.deepEqual(tl.extra[a].motif, { outcome: 'resolved', label: 'Nouvelle date de livraison' });
  // Perdu: the customer said it himself (no calls needed)
  const b = await mk();
  await call('suivi.resolve', suivi, { id: b, outcome: 'lost', motif: 'refused' });
  assert.equal(await statusOf(b), 'returning');
  // Perdu « injoignable » before the calls: refused, then « annulé trop tôt » with a reason
  const c = await mk();
  await assert.rejects(call('suivi.resolve', suivi, { id: c, outcome: 'lost', motif: 'unreachable' }), /appels/);
  await call('suivi.resolve', suivi, { id: c, outcome: 'lost', motif: 'unreachable', early: true, note: 'numéro coupé' });
  const rc = (await db.query('SELECT follow_status, sub_status FROM orders WHERE id = $1', [c]))[0];
  assert.deepEqual([rc.follow_status, rc.sub_status], ['returning', 'annule_trop_tot']);
  // the seller's motifs (Management): a motif switched off cannot be chosen
  const admin2 = await as(EMAILS.admin);
  await assert.rejects(call('suivi.motifsSet', suivi, m));
  await call('suivi.motifsSet', admin2, { ...m, lost: [...m.lost.map((x: any) => (x.key === 'price' ? { ...x, on: false } : x)), { key: 'damaged', fr: 'Colis abîmé', ar: '', on: true, client: true }] });
  const d = await mk();
  await assert.rejects(call('suivi.resolve', suivi, { id: d, outcome: 'lost', motif: 'price' }), /motif/);
  await call('suivi.resolve', suivi, { id: d, outcome: 'lost', motif: 'damaged' });
  assert.equal(await statusOf(d), 'returning');
  await call('suivi.motifsSet', admin2, m);
});
