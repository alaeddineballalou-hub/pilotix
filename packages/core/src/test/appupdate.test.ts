// The phone app updating itself: its version card read from GitHub, what a phone should show, and the control room's
// « Mise à jour obligatoire ».
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APP_RELEASE_URL, appUpdateNeed, parseAppCard } from '@pilotix/shared';
import { migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, staffLogin } from '../index';
import { forgetLatestApp, keepLatestApp, latestApp } from '../platform/appUpdate';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const card = { build: 21, sha: 'abc1234', date: '2026-11-09T10:00:00Z', size: 4_200_000, fixedKey: true };

test('the version card: read safely, the app always from Pilotix’s download page', () => {
  const c = parseAppCard({ ...card, url: 'https://evil.example/app.apk' });
  assert.equal(c?.build, 21);
  assert.equal(c?.fixedKey, true);
  assert.equal(c?.url, `${APP_RELEASE_URL}/pilotix-test.apk`, 'the card never chooses where the app comes from');
  assert.equal(parseAppCard({ ...card, fixedKey: 'yes' })?.fixedKey, false, 'only a true « true » is the fixed key');
  for (const bad of [null, {}, { build: 0 }, { build: -3 }, { build: 2.5 }, { build: 'x' }, 'card']) assert.equal(parseAppCard(bad), null);
});

test('what a phone shows: nothing, an offer, or a required update', () => {
  const latest = parseAppCard(card)!;
  assert.equal(appUpdateNeed(21, { latest, minBuild: 0 }), 'none', 'already the latest');
  assert.equal(appUpdateNeed(25, { latest, minBuild: 0 }), 'none', 'newer than the card (a test build)');
  assert.equal(appUpdateNeed(18, { latest, minBuild: 0 }), 'offer');
  assert.equal(appUpdateNeed(18, { latest, minBuild: 21 }), 'required');
  assert.equal(appUpdateNeed(21, { latest, minBuild: 21 }), 'none', 'required and done');
  assert.equal(appUpdateNeed(18, { latest, minBuild: 30 }), 'offer', 'a required build GitHub has not made yet: offered, not forced');
  assert.equal(appUpdateNeed(0, { latest, minBuild: 0 }), 'offer', 'an app made before the updater (build 0)');
  assert.equal(appUpdateNeed(18, { latest: { ...latest, fixedKey: false }, minBuild: 21 }), 'none', 'without the fixed key it could not replace the app');
  assert.equal(appUpdateNeed(18, { latest: null, minBuild: 21 }), 'none', 'GitHub out of reach');
  assert.equal(appUpdateNeed(18, null), 'none');
});

test('the card from GitHub: read once and kept 5 minutes; GitHub out of reach is no new app', async () => {
  forgetLatestApp();
  let reads = 0;
  const ok = (async (url: string) => {
    reads++;
    assert.equal(url, `${APP_RELEASE_URL}/app-version.json`);
    return new Response(JSON.stringify(card), { status: 200 });
  }) as typeof fetch;
  const t0 = Date.parse('2026-11-09T10:00:00Z');
  assert.equal((await latestApp(t0, ok))?.build, 21);
  assert.equal((await latestApp(t0 + 4 * 60_000, ok))?.build, 21);
  assert.equal(reads, 1, 'kept');
  const down = (async () => {
    throw new Error('offline');
  }) as typeof fetch;
  assert.equal(await latestApp(t0 + 6 * 60_000, down), null);
  assert.equal(await latestApp(t0 + 6.5 * 60_000, ok), null, 'a failure is kept a minute');
  assert.equal((await latestApp(t0 + 7.5 * 60_000, ok))?.build, 21);
  const missing = (async () => new Response('Not Found', { status: 404 })) as typeof fetch;
  forgetLatestApp();
  assert.equal(await latestApp(t0, missing), null, 'no card yet (apps made before the updater)');
  forgetLatestApp();
});

test('control room: « Mise à jour obligatoire » from the latest build, and back to none (the owner only)', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  const owner: PCtx = { t, staff, now: () => Date.now() };
  const p = (name: string, input: unknown = {}, as: PCtx = owner) => platformCall(name, as, input) as Promise<any>;
  keepLatestApp(parseAppCard(card));
  let s = await p('p.app.get');
  assert.equal(s.latest.build, 21);
  assert.equal(s.minBuild, 0);
  s = await p('p.app.require', { build: 21 });
  assert.equal(s.minBuild, 21);
  assert.equal((await p('p.app.get')).minBuild, 21);
  assert.equal((await p('p.settings.get')).app.minBuild, 21, 'kept with the platform settings (the server tells the phones)');
  // saving the other settings keeps it
  await p('p.settings.save', { notice: { text: 'Bonjour', tone: 'info', until: null } });
  assert.equal((await p('p.app.get')).minBuild, 21);
  // a manager can see it, not change it
  await p('p.staff.save', { name: 'Yanis', email: 'yanis@pilotix.dz', role: 'manager', active: true, password: 'Yanis-Password-1' });
  const manager: PCtx = { t, staff: (await staffLogin(t, 'yanis@pilotix.dz', 'Yanis-Password-1')).staff, now: () => Date.now() };
  assert.equal((await p('p.app.get', {}, manager)).minBuild, 21);
  await assert.rejects(p('p.app.require', { build: 0 }, manager), /Réservé/);
  assert.equal((await p('p.app.require', { build: 0 })).minBuild, 0);
  forgetLatestApp();
});
