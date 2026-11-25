// Confirmation: the counters over Nouvelles and En cours (the owner's design, 25 Nov 2026) — each one is a filter, the
// numbers count the whole list, and Nouvelles' « En retard » says what the banner « Appels en retard » says.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { bucketOf, type DueInfo } from '../modules/confirmation';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(300));
});

const MIN = 60_000;
const due = (kind: DueInfo['kind'], deadline: DueInfo['deadline']): DueInfo => ({ kind, at: deadline?.t ?? null, start: 0, deadline });

test('the rules: Nouvelles by its first-call clock, En cours by what comes next', () => {
  const now = Date.UTC(2026, 10, 25, 10);
  const nv = (d: DueInfo | undefined) => bucketOf('nouvelles', { confStatus: 'new' }, d, now);
  assert.equal(nv(due('first_late', { t: now - 5 * MIN, m: 'first' })), 'late');
  assert.equal(nv(due('first_due', { t: now + 10 * MIN, m: 'first' })), 'soon');
  assert.equal(nv(due('first_due', { t: now + 30 * MIN, m: 'first' })), 'soon');
  assert.equal(nv(due('first_due', { t: now + 31 * MIN, m: 'first' })), 'ontime');
  // the night: its clock starts at the next slot
  assert.equal(nv(due('first_next', { t: now + 9 * 60 * MIN, m: 'first' })), 'ontime');
  assert.equal(nv(due('later', { t: now + 5 * MIN, m: 'start', e: now + 35 * MIN })), 'ontime');
  assert.equal(nv(undefined), 'ontime');
  const ec = (status: string, d: DueInfo | undefined) => bucketOf('attente', { confStatus: status }, d, now);
  assert.equal(ec('postponed', due('later', { t: now + 60 * MIN, m: 'start' })), 'postponed');
  assert.equal(ec('postponed', due('now', { t: now - MIN, m: 'first' })), 'postponed');
  assert.equal(ec('callback', due('later', { t: now + 60 * MIN, m: 'start' })), 'later');
  assert.equal(ec('to_check', due('first_next', { t: now + 60 * MIN, m: 'first' })), 'later');
  assert.equal(ec('no_answer', due('now', { t: now + 60 * MIN, m: 'slot' })), 'now');
  assert.equal(ec('no_answer', due('missed', { t: now - 60 * MIN, m: 'slot' })), 'now');
  assert.equal(ec('busy', undefined), 'now');
});

/** The same moment for every call of one test (an order's clock can pass its deadline between two calls). */
const at = async (email: string, now: number): Promise<Ctx> => ({ ...(await as(email)), now: () => now });

for (const who of ['conf', 'admin'] as const) {
  test(`counters count the whole list and each one filters it (${who})`, async () => {
    const ctx = await at(EMAILS[who], Date.now());
    for (const sub of ['nouvelles', 'attente'] as const) {
      const all: any = await call('confirmation.list', ctx, { sub, pageSize: 5 });
      const keys = sub === 'nouvelles' ? ['late', 'soon', 'ontime'] : ['now', 'later', 'postponed'];
      assert.deepEqual(Object.keys(all.buckets).sort(), [...keys].sort(), `${sub}: its three counters`);
      const sum = keys.reduce((t, k) => t + all.buckets[k], 0);
      assert.equal(sum, all.total, `${sub}: the counters add up to the list (not only the page)`);
      assert.equal(typeof all.tries, 'number');
      for (const k of keys) {
        const one: any = await call('confirmation.list', ctx, { sub, bucket: k, pageSize: 3000 });
        assert.equal(one.total, all.buckets[k], `${sub} › ${k}: the filter shows what its counter says`);
        assert.equal(one.rows.length, all.buckets[k]);
        // the numbers stay the whole list's while one is on
        assert.deepEqual(one.buckets, all.buckets);
        if (k === 'postponed') for (const r of one.rows) assert.equal(r.confStatus, 'postponed');
        if (k === 'late') for (const r of one.rows) assert.ok(r.deadline && r.deadline.t < ctx.now(), 'late: its chrono is past');
      }
    }
    // Confirmées and the rest: no counters from the list (Confirmées counts the dépôt's stages)
    const cf: any = await call('confirmation.list', ctx, { sub: 'confirmees', pageSize: 5 });
    assert.equal(cf.buckets, null);
  });
}

test('the counters follow the search and the managers\' switch', async () => {
  const ctx = await at(EMAILS.admin, Date.now());
  const free: any = await call('confirmation.list', ctx, { sub: 'nouvelles', assigned: 'free', pageSize: 3000 });
  const sum = ['late', 'soon', 'ontime'].reduce((t, k) => t + free.buckets[k], 0);
  assert.equal(sum, free.total);
  assert.ok(free.rows.every((r: any) => !r.agentId));
  const one = free.rows[0] ?? (await call('confirmation.list', ctx, { sub: 'nouvelles', pageSize: 1 }) as any).rows[0];
  const q: any = await call('confirmation.list', ctx, { sub: 'nouvelles', q: one.ref, pageSize: 50 });
  assert.equal(['late', 'soon', 'ontime'].reduce((t, k) => t + q.buckets[k], 0), q.total);
  assert.equal(q.total, 1);
});

test('the banner « Appels en retard » and Nouvelles\' « En retard » say the same number', async () => {
  // an agent with late new orders of his own (the seed's clock is now: make two of his new orders late)
  const agent = await as(EMAILS.conf);
  const me = agent.session.profile.id;
  const mine = await db.query(`SELECT id FROM orders WHERE conf_status = 'new' AND agent_id = $1 ORDER BY id LIMIT 2`, [me]);
  if (mine.length < 2) {
    const free = await db.query(`SELECT id FROM orders WHERE conf_status = 'new' ORDER BY id LIMIT 2`);
    await db.query(`UPDATE orders SET agent_id = $1 WHERE id = ANY($2)`, [me, free.map((r: any) => r.id)]);
    mine.splice(0, mine.length, ...free);
  }
  await db.query(`UPDATE orders SET created_at = now() - interval '2 days', assigned_at = now() - interval '2 days', next_call_at = NULL, attempts = 0 WHERE id = ANY($1)`, [mine.map((r: any) => r.id)]);
  // and one « À vérifier » never called: a try of En cours, not a new order of the banner
  const check = (await db.query(`SELECT id FROM orders WHERE conf_status = 'to_check' ORDER BY id LIMIT 1`))[0];
  if (check) await db.query(`UPDATE orders SET agent_id = $1, attempts = 0, next_call_at = NULL, created_at = now() - interval '2 days', assigned_at = now() - interval '2 days' WHERE id = $2`, [me, check.id]);
  const ctx = await at(EMAILS.conf, Date.now());
  const b: any = await call('confirmation.banner', ctx, {});
  const nv: any = await call('confirmation.list', ctx, { sub: 'nouvelles', pageSize: 5 });
  assert.ok(nv.buckets.late >= 2, 'the two late new orders');
  assert.equal(b.firstLate, nv.buckets.late, 'the banner and the counter agree');
  assert.ok(b.fresh >= b.firstLate);
});
