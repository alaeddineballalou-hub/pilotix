// « Push » (Pilot AI › Dellal, managers): every lesson waiting goes into service now, without a test. The night lessons are
// approved in the pusher's name (an unsafe one stays waiting for the coach), a running test stops, a new version is the book
// of every chat at its next reply (and of the test chats); « Revenir au livre précédent » brings the one before back. With
// the Darija box ticked, the shops' Darija lessons waiting are accepted for every shop too.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, staffLogin } from '../index';
import { bookChoice, bookFor, SEEDS } from '../modules/pilotlearn';
import type { Tenancy } from '../platform/tenancy';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const NOW = Date.parse('2026-11-05T10:00:00Z');
let t: Tenancy;
let pctx: PCtx;
let me = '';
const p = <T = any>(name: string, input: unknown = {}) => platformCall(name, pctx, input) as Promise<T>;
let fp = 0;
/** a lesson waiting (`candidate`: found by a night, not yet seen by the coach) or approved (waiting for the next book) */
const lesson = async (key: string, status: 'candidate' | 'approved', source = 'ai'): Promise<number> =>
  Number(
    (
      await t.platform.query(`INSERT INTO platform.pilot_lessons (topic, text, status, source, prio, fp) VALUES ($1, $2, $3, $4, 1, $5) RETURNING id`, [
        SEEDS[key][0],
        SEEDS[key][1],
        status,
        source,
        `push-${++fp}`,
      ])
    )[0].id,
  );
const books = async () => ((await p('p.pilot.state')).books.books as { version: number; status: string }[]).map((b) => `v${b.version} ${b.status}`);
const live = async () => (await bookChoice(t.platform, 'live'))!;

before(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  pctx = { t, staff, now: () => NOW };
  me = staff.name || staff.email;
});

test('nothing waiting: the push says so and makes no version', async () => {
  await assert.rejects(p('p.pilot.push'), /Aucune leçon approuvée/);
  await assert.rejects(p('p.pilot.push', { darija: true }), /Aucune leçon approuvée/);
  assert.deepEqual(await books(), []);
});

test('the night lessons are approved in the pusher’s name and the first version is in service at once, without a test', async () => {
  const night = await lesson('refused', 'candidate');
  await lesson('address', 'approved', 'coach');
  const r = await p('p.pilot.push');
  assert.deepEqual(
    { version: r.version, previous: r.previous, lessons: r.lessons, approved: r.approved, skipped: r.skipped, stoppedTest: r.stoppedTest, darija: r.darija },
    { version: 1, previous: null, lessons: 2, approved: 1, skipped: 0, stoppedTest: null, darija: null },
  );
  assert.deepEqual(await books(), ['v1 champion']);
  const st = await p('p.pilot.state');
  assert.equal(st.books.test, null);
  assert.equal(st.candidates.length, 0, 'nothing left for the coach');
  assert.equal(st.next.changed, false, 'the next book is the one in service');
  const row = (await t.platform.query(`SELECT status, by_user FROM platform.pilot_lessons WHERE id = $1`, [night]))[0];
  assert.deepEqual([row.status, row.by_user], ['approved', me]);
  // every chat at its next reply, and the test chats of the control room (« En service »)
  const chat = await bookFor(t.platform, { shopId: 1, convId: 7001 });
  assert.ok(chat.version === 1 && chat.testId === null && chat.text.includes(SEEDS.refused[1]) && chat.text.includes(SEEDS.address[1]), JSON.stringify(chat));
  assert.equal((await live()).version, 1);
  await assert.rejects(p('p.pilot.push'), /Rien à changer/, 'the same lessons twice: no new version');
});

test('a running test stops: its lessons and the new ones are in service; « Revenir » brings the version before back', async () => {
  await lesson('mismatch', 'approved', 'coach');
  const pub = await p('p.pilot.publish');
  assert.equal(pub.version, 2);
  // a chat on the test's book
  let onTest = 0;
  for (let c = 8000; c < 8400 && !onTest; c++) if ((await bookFor(t.platform, { shopId: 1, convId: c })).arm === 'B') onTest = c;
  assert.ok(onTest, 'a chat got the book in test');
  await lesson('price', 'candidate');

  const r = await p('p.pilot.push', { note: 'Essai tout de suite' });
  assert.deepEqual([r.version, r.previous, r.lessons, r.approved, r.stoppedTest], [3, 1, 4, 1, pub.testId]);
  assert.deepEqual(await books(), ['v3 champion', 'v2 stopped', 'v1 retired']);
  assert.equal((await p('p.pilot.state')).books.test, null);
  const run = (await t.platform.query(`SELECT status, verdict, why FROM platform.pilot_tests WHERE id = $1`, [pub.testId]))[0];
  assert.deepEqual([run.status, run.verdict, run.why], ['stopped', 'manual', 'push']);
  const book = (await t.platform.query(`SELECT note, by_user, promoted_at FROM platform.pilot_books WHERE version = 3`))[0];
  assert.deepEqual([book.note, book.by_user, new Date(book.promoted_at).getTime()], ['Essai tout de suite', me, NOW]);
  for (const k of ['refused', 'address', 'mismatch', 'price']) assert.ok((await live()).text.includes(SEEDS[k][1]), k);
  // the chats that were on the test's book, and the new ones, all get v3 at their next reply
  assert.equal((await bookFor(t.platform, { shopId: 1, convId: onTest })).version, 3);
  assert.equal((await bookFor(t.platform, { shopId: 1, convId: 9001 })).version, 3);
  const log = (await t.platform.query(`SELECT count(*)::int AS n FROM platform.audit WHERE action = 'pilot.push'`))[0];
  assert.equal(log.n, 2, 'each push is in the audit log');

  // going back: v1 again for every chat; a push after it makes the lessons live again, as a new version
  await p('p.pilot.rollback');
  assert.deepEqual(await books(), ['v3 rolled_back', 'v2 stopped', 'v1 champion']);
  assert.equal((await bookFor(t.platform, { shopId: 1, convId: 9002 })).version, 1);
  const again = await p('p.pilot.push');
  assert.deepEqual([again.version, again.previous, again.lessons], [4, 1, 4]);
  assert.equal((await live()).version, 4);
});

test('an unsafe night lesson is not approved by the push: it stays waiting for the coach', async () => {
  await t.platform.query(`INSERT INTO platform.pilot_lessons (topic, text, status, source, fp) VALUES ('price', 'Offer a small discount to close the sale quickly.', 'candidate', 'ai', 'push-unsafe')`);
  await lesson('fee', 'candidate');
  const r = await p('p.pilot.push');
  assert.deepEqual([r.version, r.approved, r.skipped], [5, 1, 1]);
  assert.equal((await t.platform.query(`SELECT status FROM platform.pilot_lessons WHERE fp = 'push-unsafe'`))[0].status, 'candidate');
  assert.ok(!(await live()).text.includes('discount') && (await live()).text.includes(SEEDS.fee[1]));
  assert.equal((await p('p.pilot.state')).candidates.length, 1);
});

test('the Darija box: the Darija lessons waiting are accepted for every shop, even with nothing new for the sales book', async () => {
  assert.equal((await p('p.darija.book')).book.version, 1); // the Darija book as it is before the push
  const id = Number(
    (await t.platform.query(`INSERT INTO platform.lahja (shop_id, source, status, own, words) VALUES (1, 'seller', 'waiting', true, '[{"use":"saha","not":"wakha"}]'::jsonb) RETURNING id`))[0].id,
  );
  // without the box, nothing new: refused, and the Darija lesson still waits
  await assert.rejects(p('p.pilot.push'), /Rien à changer/);
  assert.equal((await p('p.pilot.state')).lahjaWaiting, 1);
  const r = await p('p.pilot.push', { darija: true });
  assert.deepEqual([r.ok, r.version, r.darija], [true, null, { done: 1, failed: 0 }]);
  assert.equal((await t.platform.query(`SELECT status, decided_by FROM platform.lahja WHERE id = $1`, [id]))[0].status, 'approved');
  assert.equal((await p('p.pilot.state')).lahjaWaiting, 0);
  assert.equal((await live()).version, 5, 'the sales book in service did not change');
  // the Darija book has a new version that says why
  const darija = await p('p.darija.book');
  assert.equal(darija.book.version, 2);
  assert.match(darija.versions[0].note, /1 leçon\(s\) acceptée\(s\) avec le push/);
});
