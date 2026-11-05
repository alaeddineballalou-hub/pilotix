// The control room's authenticator app (platform/totp.ts): RFC 6238's own test values, then add / log in / remove.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base32, hotp, migrate, migrateAll, pgliteTenancy, seedBase, staffLogin, staffTotpOn, totpCheck, totpConfirm, totpOff, totpStart, totpStep, unbase32 } from '../index';

const OWNER = { email: 'owner@pilotix.dz', password: 'Owner-Password-1', name: 'Amine' };
// RFC 6238 appendix B: the SHA-1 secret is the ASCII text 12345678901234567890
const RFC = base32(new TextEncoder().encode('12345678901234567890'));

test('codes as RFC 6238 makes them; base32 both ways', async () => {
  assert.equal(RFC, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual([...unbase32('gezd gnbv-gy3t qojq')], [...new TextEncoder().encode('1234567890')]);
  // the 8-digit values of the RFC, their last 6 digits
  for (const [sec, want] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037']] as const)
    assert.equal(await hotp(unbase32(RFC), Math.floor(sec / 30)), want, String(sec));
  // 30 seconds either side is accepted (a phone's clock a little off), not more
  const at = 1111111111_000;
  assert.equal(await totpStep(RFC, '050471', at), Math.floor(1111111111 / 30));
  assert.equal(await totpStep(RFC, '050471', at + 30_000), Math.floor(1111111111 / 30));
  assert.equal(await totpStep(RFC, '050471', at + 90_000), null);
  assert.equal(await totpStep(RFC, '12345', at), null);
});

test('added with its first code, asked at login, a code serves once, removed with a code', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), OWNER);
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  assert.equal(await staffTotpOn(t, staff.id), false);
  const { secret, uri } = await totpStart(t, staff.id);
  assert.match(uri, /^otpauth:\/\/totp\/Pilotix%3Aowner%40pilotix\.dz\?secret=[A-Z2-7]{32}&issuer=Pilotix/);
  const now = Date.now();
  const codeAt = async (ms: number) => hotp(unbase32(secret), Math.floor(ms / 30_000));
  // not on until a code made from the secret is typed
  await assert.rejects(totpConfirm(t, staff.id, '000000', now), /Code incorrect/);
  assert.equal(await staffTotpOn(t, staff.id), false);
  await totpConfirm(t, staff.id, await codeAt(now), now);
  assert.equal(await staffTotpOn(t, staff.id), true);
  await assert.rejects(totpStart(t, staff.id), /déjà active/);
  // a login: the code of the next step works once; the one used to turn it on, and any earlier one, never again
  assert.equal(await totpCheck(t, staff.id, await codeAt(now), now), false);
  const next = now + 30_000;
  assert.equal(await totpCheck(t, staff.id, await codeAt(next), next), true);
  assert.equal(await totpCheck(t, staff.id, await codeAt(next), next), false);
  // removed only with a code it shows
  await assert.rejects(totpOff(t, staff.id, '000000', next + 30_000), /Code incorrect/);
  await totpOff(t, staff.id, await codeAt(next + 30_000), next + 30_000);
  assert.equal(await staffTotpOn(t, staff.id), false);
  assert.equal((await t.platform.query('SELECT totp_secret FROM platform.staff WHERE id = $1', [staff.id]))[0].totp_secret, null);
});
