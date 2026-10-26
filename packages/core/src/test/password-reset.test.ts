// "Mot de passe oublié": one-time links, 30 minutes, newest only, 3 per hour, every session logged out.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEMO_PASSWORD } from '@pilotix/shared';
import { createPasswordReset, login, resetPassword } from '../index';
import { EMAILS, setup } from './harness';

test('password reset links', async () => {
  const { db } = await setup(5);
  const t0 = Date.now();

  // unknown e-mail: nothing to send (the server answers the same way)
  assert.equal(await createPasswordReset(db, 'nobody@example.com', t0), null);

  const a = await createPasswordReset(db, ' SAMIRA@demo.pilotix.dz ', t0);
  assert.ok(a);
  assert.equal(a!.email, EMAILS.conf);
  assert.match(a!.token, /^[A-Za-z0-9_-]{43}$/);
  // only a hash is stored
  const stored = await db.query('SELECT token_hash FROM password_resets');
  assert.ok(stored.every((r: any) => r.token_hash !== a!.token && /^[0-9a-f]{64}$/.test(r.token_hash)));

  // a newer link cancels the older one
  const b = await createPasswordReset(db, EMAILS.conf, t0 + 1000);
  await assert.rejects(resetPassword(db, a!.token, 'nouveau-mot-1', t0 + 2000), /plus valable/);

  // too short, then fine; the link works once
  await assert.rejects(resetPassword(db, b!.token, 'court', t0 + 2000), /8 caractères/);
  const tvBefore = Number((await db.query('SELECT token_version FROM profiles WHERE email=$1', [EMAILS.conf]))[0].token_version);
  assert.deepEqual(await resetPassword(db, b!.token, 'nouveau-mot-1', t0 + 2000), { email: EMAILS.conf });
  await assert.rejects(resetPassword(db, b!.token, 'nouveau-mot-2', t0 + 3000), /plus valable/);
  await assert.rejects(login(db, EMAILS.conf, DEMO_PASSWORD));
  assert.equal((await login(db, EMAILS.conf, 'nouveau-mot-1')).profile.email, EMAILS.conf);
  const tvAfter = Number((await db.query('SELECT token_version FROM profiles WHERE email=$1', [EMAILS.conf]))[0].token_version);
  assert.equal(tvAfter, tvBefore + 1);

  // 3 links per hour at most
  assert.ok(await createPasswordReset(db, EMAILS.conf, t0 + 4000)); // the 3rd this hour
  assert.equal(await createPasswordReset(db, EMAILS.conf, t0 + 5000), null);
  assert.ok(await createPasswordReset(db, EMAILS.conf, t0 + 3_700_000));

  // expired after 30 minutes
  const c = await createPasswordReset(db, EMAILS.suivi, t0);
  await assert.rejects(resetPassword(db, c!.token, 'nouveau-mot-3', t0 + 31 * 60_000), /plus valable/);

  // a turned-off account gets no link
  await db.query('UPDATE profiles SET active = false WHERE email = $1', [EMAILS.depot]);
  assert.equal(await createPasswordReset(db, EMAILS.depot, t0), null);

  // nonsense tokens
  await assert.rejects(resetPassword(db, 'x', 'nouveau-mot-4', t0), /plus valable/);
  await assert.rejects(resetPassword(db, 'A'.repeat(43), 'nouveau-mot-4', t0), /plus valable/);
});
