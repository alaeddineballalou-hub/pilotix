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
