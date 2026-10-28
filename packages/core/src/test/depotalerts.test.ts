// Dépôt alerts: an order the depot still holds, changed or cancelled from outside the depot → a red alert for the
// depot until « C'est corrigé »; the depot's own edits don't alert; changes to the same order merge into one alert.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(250));
});

test('an edit from outside the depot alerts the depot; its own edits do not; « C’est corrigé » closes it', async () => {
  const admin = await as(EMAILS.admin);
  const karim = await as(EMAILS.depot);
  const o = (await db.query(`SELECT id, address, phone2 FROM orders WHERE follow_status = 'prepared' ORDER BY id LIMIT 1`))[0];
  assert.ok(o, 'a prepared order');
  const id = Number(o.id);
  await call('orders.update', karim, { id, address: 'Changée par le dépôt' });
  assert.equal(((await call('depot.alerts', karim, {})) as any[]).filter((a) => a.orderId === id).length, 0);
  await call('orders.update', admin, { id, address: 'Cité 200 logements, bloc B' });
  await call('orders.update', admin, { id, deliveryNote: 'Appeler avant' });
  const list = ((await call('depot.alerts', karim, {})) as any[]).filter((a) => a.orderId === id);
  assert.equal(list.length, 1, 'one alert per order');
  const a = list[0];
  assert.equal(a.kind, 'edit');
  const addr = a.changes.find((c: any) => c.field === 'address');
  assert.equal(addr.from, 'Changée par le dépôt');
  assert.equal(addr.to, 'Cité 200 logements, bloc B');
  assert.ok(a.changes.some((c: any) => c.field === 'note'));
  assert.ok(!a.changes.some((c: any) => c.field === 'place'), 'nothing else changed');
  await call('depot.alertDone', karim, { id: a.id });
  assert.equal(((await call('depot.alerts', karim, {})) as any[]).filter((x) => x.orderId === id).length, 0);
});

test('an order cancelled while the depot prepares it alerts « annulée »', async () => {
  const admin = await as(EMAILS.admin);
  const karim = await as(EMAILS.depot);
  const o = (await db.query(`SELECT id FROM orders WHERE follow_status = 'to_prepare' ORDER BY id LIMIT 1`))[0];
  const id = Number(o.id);
  await call('orders.setConf', admin, { ids: [id], status: 'cancelled', reason: 'Client a annulé' });
  const a = ((await call('depot.alerts', karim, {})) as any[]).find((x) => x.orderId === id);
  assert.ok(a);
  assert.equal(a.kind, 'cancel');
  await assert.rejects(call('depot.alerts', await as(EMAILS.conf), {}), /Accès refusé/);
});
