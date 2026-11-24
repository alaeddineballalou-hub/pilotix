// « Mes appareils » (modules/push.ts): its two platform tables have their own step (p045). Written into p003 on
// 23 Nov 2026, they never reached the servers that had run p003 long before: « Mes appareils », every notification of a
// store and the depot's scanner on a parcel in red alert answered « Erreur du serveur » (24 Nov 2026).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pgliteTenancy } from '../index';
import { migratePlatform } from '../platform/schema';

test('a server that ran p003 before « Mes appareils » was written there gets its two tables on its next start', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  await migratePlatform(t);
  const has = async () =>
    (
      await t.platform.query<{ d: boolean; s: boolean }>(
        `SELECT to_regclass('platform.notification_devices') IS NOT NULL AS d, to_regclass('platform.notification_device_subscriptions') IS NOT NULL AS s`,
      )
    )[0];
  assert.deepEqual({ ...(await has()) }, { d: true, s: true }, 'a new server has them');
  // the live server: p003 (and every step up to p044) ran before the tables existed
  await t.exec(
    'public',
    `DROP TABLE platform.notification_device_subscriptions; DROP TABLE platform.notification_devices;
     DELETE FROM platform.migrations WHERE name = 'p045_notification_devices';`,
  );
  assert.deepEqual({ ...(await has()) }, { d: false, s: false });
  assert.deepEqual(await migratePlatform(t), ['p045_notification_devices'], 'only the new step runs');
  assert.deepEqual({ ...(await has()) }, { d: true, s: true }, 'the next start makes them');
  assert.deepEqual(await migratePlatform(t), [], 'and only once');
});
