// The « Lancer un test d'attaque » button: runs real attacks through the real scoring, reports what passes, and leaves
// NOTHING behind (no order, no submit, no mark — the whole run is rolled back).
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let marketer: Ctx;

before(async () => {
  const s = await setup(40);
  db = s.db;
  marketer = await s.as(EMAILS.marketer);
});

const counts = async () => ({
  orders: Number((await db.query(`SELECT count(*)::int AS n FROM orders`))[0].n),
  submits: Number((await db.query(`SELECT count(*)::int AS n FROM landing_submits`))[0].n),
  marks: Number((await db.query(`SELECT count(*)::int AS n FROM fraud_marks`))[0].n),
  metaEvents: Number((await db.query(`SELECT count(*)::int AS n FROM meta_events`))[0].n),
  customers: Number((await db.query(`SELECT count(*)::int AS n FROM customers`))[0].n),
});

test('attack test: real attacks through the real scoring; real customers not blocked; nothing is saved', async () => {
  const before = await counts();
  const rep: any = await call('landing.attackTest', marketer, { turnstile: 'off' });
  // real customers are the control group: none blocked
  assert.equal(rep.real.blocked, 0, 'real customers blocked');
  assert.ok(rep.real.sent >= 50);
  // the obvious robots are fully stopped
  const robot = rep.rows.find((r: any) => r.name.includes('Script simple'));
  assert.equal(robot.passed, 0);
  // the smart team is blocked once the agents have marked it (fingerprint follows the device)
  const after = rep.rows.find((r: any) => r.name.includes('après'));
  assert.ok(after.blocked >= after.sent - 1, 'smart team after marking');
  assert.ok(rep.total.blocked + rep.total.review > 0);
  // NOTHING persisted: the whole run was rolled back
  assert.deepEqual(await counts(), before, 'the test left rows behind');

  // with Cloudflare simulated ON, the « smart robot » is caught (fails the invisible check), unlike without
  const off = (await call('landing.attackTest', marketer, { turnstile: 'off' })) as any;
  const on = (await call('landing.attackTest', marketer, { turnstile: 'on' })) as any;
  const smart = (rep2: any) => rep2.rows.find((r: any) => r.name.includes('Robot intelligent'));
  assert.equal(on.turnstileOn, true);
  assert.ok(smart(on).blocked + smart(on).review > smart(off).blocked + smart(off).review, 'Cloudflare should catch more robots');
  assert.deepEqual(await counts(), before, 'still nothing saved');
});
