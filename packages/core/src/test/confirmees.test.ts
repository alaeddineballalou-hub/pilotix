// « Confirmées » lists only the confirmed orders the courier does not have yet: a parcel handed to its courier leaves it
// (it is in Suivi › En livraison), and the tab's number counts the same orders.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;

before(async () => {
  const s = await setup(60);
  db = s.db;
  as = s.as;
});

test('Confirmées: the confirmed orders not with the courier yet, and its number counts the same', async () => {
  const admin = await as(EMAILS.admin);
  const ids = (await db.query(`SELECT id FROM sales WHERE conf_status = 'confirmed' ORDER BY id LIMIT 3`)).map((r) => Number(r.id));
  assert.equal(ids.length, 3);
  await db.query(`UPDATE orders SET follow_status = 'shipped', shipped_at = now() WHERE id = $1`, [ids[0]]);
  await db.query(`UPDATE orders SET follow_status = 'to_prepare', shipped_at = NULL WHERE id = $1`, [ids[1]]);
  await db.query(`UPDATE orders SET follow_status = 'prepared', shipped_at = NULL WHERE id = $1`, [ids[2]]);
  const r: any = await call('confirmation.list', admin, { sub: 'confirmees', pageSize: 3000 });
  const got = r.rows.map((x: any) => Number(x.id));
  assert.ok(!got.includes(ids[0]), 'a parcel handed to its courier left Confirmées');
  assert.ok(got.includes(ids[1]), 'a parcel to prepare is still in Confirmées');
  assert.ok(got.includes(ids[2]), 'a prepared parcel (en dispatch) is still in Confirmées');
  for (const x of r.rows) assert.ok(x.followStatus == null || ['to_prepare', 'prepared'].includes(x.followStatus), `${x.ref}: ${x.followStatus}`);
  const n = Number((await db.query(`SELECT count(*)::int AS n FROM sales WHERE conf_status IN ('confirmed', 'no_stock') AND (follow_status IS NULL OR follow_status IN ('to_prepare', 'prepared'))`))[0].n);
  const c: any = await call('confirmation.counts', admin, {});
  assert.equal(c.confirmees, n);
  assert.equal(r.total, n);
});
