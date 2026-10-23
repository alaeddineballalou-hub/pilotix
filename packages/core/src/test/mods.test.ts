// Demandes de modification (ZR): a request keeps the order as it is until ZR accepts, then the order takes the new values.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(400));
});

async function zrParcel(skip: number[] = []) {
  const r = (
    await db.query(
      `SELECT o.id FROM orders o JOIN delivery_companies c ON c.id = o.company_id
       WHERE c.kind = 'zr' AND o.tracking IS NOT NULL AND o.follow_status IN ('shipped','out_for_delivery','alert','failed') AND NOT (o.id = ANY($1)) ORDER BY o.id LIMIT 1`,
      [skip],
    )
  )[0];
  assert.ok(r, 'a ZR parcel on the road in the demo data');
  return Number(r.id);
}

test('mods: new amount waits for ZR, then is applied', async () => {
  const ctx = await as(EMAILS.suivi);
  const oid = await zrParcel();
  const before: any = await call('orders.get', ctx, { id: oid });
  const info: any = await call('suivi.modInfo', ctx, { orderId: oid });
  assert.equal(info.api, true);
  const m: any = await call('suivi.modCreate', ctx, { orderId: oid, total: before.total - 300, note: 'remise client' });
  assert.equal(m.status, 'pending');
  assert.ok(m.extId);
  assert.deepEqual(m.kinds, ['price']);
  assert.equal((await call('orders.get', ctx, { id: oid }) as any).total, before.total, 'unchanged until ZR accepts');
  await assert.rejects(call('suivi.modCreate', ctx, { orderId: oid, total: 100 }), /attend déjà/);
  const s: any = await call('suivi.modSync', ctx, { orderId: oid });
  assert.equal(s.changed, 1);
  const after: any = await call('orders.get', ctx, { id: oid });
  assert.equal(after.total, before.total - 300);
  const list: any = await call('suivi.mods', ctx, { orderId: oid });
  assert.equal(list[0].status, 'approved');
});

test('mods: home → stop desk and wrong commune', async () => {
  const ctx = await as(EMAILS.suivi);
  const oid = await zrParcel();
  const o: any = await call('orders.get', ctx, { id: oid });
  const desk = (await db.query('SELECT id FROM stopdesks WHERE company_id = $1 LIMIT 1', [o.companyId]))[0];
  const toDesk: any = await call('suivi.modCreate', ctx, { orderId: oid, isStopdesk: !o.isStopdesk, stopdeskId: o.isStopdesk ? null : Number(desk.id), wilayaId: o.wilayaId, commune: o.commune || 'Bab Ezzouar' });
  assert.ok(toDesk.kinds.includes('type'));
  const c: any = await call('suivi.modCancel', ctx, { id: toDesk.id });
  assert.equal(c.status, 'cancelled');
  const com: any = await call('suivi.modCreate', ctx, { orderId: oid, isStopdesk: false, wilayaId: 16, commune: 'Bab Ezzouar', address: 'Cité 5 juillet' });
  assert.ok(com.kinds.includes('commune'));
  await call('suivi.modSync', ctx, {});
  const after: any = await call('orders.get', ctx, { id: oid });
  assert.equal(after.commune, 'Bab Ezzouar');
  assert.equal(after.isStopdesk, false);
  await assert.rejects(call('suivi.mods', await as(EMAILS.livreur), {}), /Accès refusé/);
});
