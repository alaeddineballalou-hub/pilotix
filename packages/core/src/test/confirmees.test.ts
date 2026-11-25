// « Confirmées » lists the confirmed orders their delivery company does not have yet, with where each one is in the dépôt
// (the owner's ask, 25 Nov 2026): sans stock › en préparation › en dispatch › dispatchées (handed over, not taken yet). A
// parcel its company has (taken_at) leaves it: it is in Commandes › En livraison. The tab's number counts the same orders.
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

const NOT_TAKEN = `conf_status IN ('confirmed', 'no_stock') AND (follow_status IS NULL OR follow_status IN ('to_prepare', 'prepared') OR (follow_status = 'shipped' AND taken_at IS NULL))`;

test('Confirmées: the confirmed orders their company does not have yet, and its number counts the same', async () => {
  const admin = await as(EMAILS.admin);
  const ids = (await db.query(`SELECT id FROM sales WHERE conf_status = 'confirmed' ORDER BY id LIMIT 4`)).map((r) => Number(r.id));
  assert.equal(ids.length, 4);
  await db.query(`UPDATE orders SET follow_status = 'shipped', shipped_at = now(), taken_at = now() WHERE id = $1`, [ids[0]]);
  await db.query(`UPDATE orders SET follow_status = 'to_prepare', shipped_at = NULL, taken_at = NULL WHERE id = $1`, [ids[1]]);
  await db.query(`UPDATE orders SET follow_status = 'prepared', shipped_at = NULL, taken_at = NULL WHERE id = $1`, [ids[2]]);
  await db.query(`UPDATE orders SET follow_status = 'shipped', shipped_at = now(), taken_at = NULL WHERE id = $1`, [ids[3]]);
  const r: any = await call('confirmation.list', admin, { sub: 'confirmees', pageSize: 3000 });
  const got = r.rows.map((x: any) => Number(x.id));
  assert.ok(!got.includes(ids[0]), 'a parcel its company has left Confirmées');
  assert.ok(got.includes(ids[1]), 'a parcel to prepare is still in Confirmées');
  assert.ok(got.includes(ids[2]), 'a prepared parcel (en dispatch) is still in Confirmées');
  assert.ok(got.includes(ids[3]), 'a parcel handed over and not taken yet (dispatchée) is still in Confirmées');
  for (const x of r.rows) assert.ok(x.followStatus == null || ['to_prepare', 'prepared', 'shipped'].includes(x.followStatus), `${x.ref}: ${x.followStatus}`);
  const n = Number((await db.query(`SELECT count(*)::int AS n FROM sales WHERE ${NOT_TAKEN}`))[0].n);
  const c: any = await call('confirmation.counts', admin, {});
  assert.equal(c.confirmees, n);
  assert.equal(r.total, n);
});

test('Confirmées: one stage at a time, its number the same as the list', async () => {
  const admin = await as(EMAILS.admin);
  const c: any = await call('confirmation.counts', admin, {});
  const want: Record<string, string> = {
    nostock: `conf_status = 'no_stock' AND follow_status IS NULL`,
    preparer: `conf_status = 'confirmed' AND follow_status = 'to_prepare'`,
    prepares: `follow_status = 'prepared'`,
    dispatchees: `follow_status = 'shipped' AND taken_at IS NULL`,
  };
  for (const [stage, where] of Object.entries(want)) {
    const r: any = await call('confirmation.list', admin, { sub: 'confirmees', stage, pageSize: 3000 });
    const n = Number((await db.query(`SELECT count(*)::int AS n FROM sales WHERE ${NOT_TAKEN} AND ${where}`))[0].n);
    assert.equal(r.total, n, `${stage}: the list`);
    assert.equal(c.stages[stage], n, `${stage}: its number`);
  }
  assert.ok(c.stages.dispatchees >= 1, 'the dispatched parcel of the first test is counted');
  // a status and a stage that never meet: nothing (not every order)
  const none: any = await call('confirmation.list', admin, { sub: 'confirmees', stage: 'nostock', status: 'confirmed' });
  assert.equal(none.total, 0);
});
