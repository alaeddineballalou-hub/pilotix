// « In progress » marks (action_locks): a double click, two people or the background job never do the same work twice
// (a parcel sent twice is billed twice). A mark is its run's own: renewed while the run works — a long send is never
// taken for a stuck one — and freed at the end only while still its own.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { Db, takeActionLocks, withActionLock } from '../index';
import { setup } from './harness';

let db: Db;
before(async () => {
  ({ db } = await setup(5));
});

const has = async (key: string) => !!(await db.query('SELECT 1 FROM action_locks WHERE key = $1', [key]))[0];

test('a second run is refused while the first works; the first frees only its own marks', async () => {
  const a = await takeActionLocks(db, ['send:1', 'send:2'], null);
  assert.deepEqual([...a.taken].sort(), ['send:1', 'send:2']);
  const b = await takeActionLocks(db, ['send:2', 'send:3'], null);
  assert.deepEqual([...b.taken], ['send:3'], 'send:2 is the first run\'s');
  await assert.rejects(withActionLock(db, 'send:1', null, 'Envoi déjà en cours', async () => 1), /Envoi déjà en cours/);
  // the first run looks stuck (its server stopped): a third run takes its mark over…
  await db.query(`UPDATE action_locks SET created_at = now() - interval '1 hour' WHERE key = 'send:1'`);
  const c = await takeActionLocks(db, ['send:1'], null);
  assert.deepEqual([...c.taken], ['send:1']);
  // …and the first run, ending late, does not free the third run's mark
  await a.release();
  assert.equal(await has('send:1'), true, 'still the third run\'s');
  assert.equal(await has('send:2'), false);
  await b.release();
  await c.release();
  assert.equal(await has('send:1'), false);
  assert.equal(await has('send:3'), false);
});

test('a long run keeps its mark: never taken for a stuck one while it works', async () => {
  // a 6-second limit, renewed every 5 seconds
  const got = await withActionLock(
    db,
    'send:long',
    null,
    'busy',
    async () => {
      await new Promise((r) => setTimeout(r, 7_000));
      // past the limit: a second run is still refused (the mark was renewed)
      const other = await takeActionLocks(db, ['send:long'], null, 6);
      assert.equal(other.taken.size, 0);
      return 'done';
    },
    6,
  );
  assert.equal(got, 'done');
  assert.equal(await has('send:long'), false, 'freed at the end');
});
