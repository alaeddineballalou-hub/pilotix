// "Mot de passe oublié": one-time links, 30 minutes, newest only, 3 per hour, 2 changes a month (admins excepted),
// every session logged out. And who may create accounts / set passwords besides the administrator.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEMO_PASSWORD } from '@pilotix/shared';
import { call, createPasswordReset, login, resetPassword } from '../index';
import { EMAILS, setup } from './harness';

const link = (r: Awaited<ReturnType<typeof createPasswordReset>>) => {
  assert.ok(r && r.kind === 'link', `expected a link, got ${JSON.stringify(r)}`);
  return r;
};

test('password reset links', async () => {
  const { db } = await setup(5);
  const t0 = Date.UTC(2026, 9, 10, 9); // 10 October 2026

  // unknown e-mail: nothing to send (the server answers the same way)
  assert.equal(await createPasswordReset(db, 'nobody@example.com', t0), null);

  const a = link(await createPasswordReset(db, ' SAMIRA@demo.pilotix.dz ', t0));
  assert.equal(a.email, EMAILS.conf);
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  // only a hash is stored
  const stored = await db.query('SELECT token_hash FROM password_resets');
  assert.ok(stored.every((r: any) => r.token_hash !== a.token && /^[0-9a-f]{64}$/.test(r.token_hash)));

  // a newer link cancels the older one
  const b = link(await createPasswordReset(db, EMAILS.conf, t0 + 1000));
  await assert.rejects(resetPassword(db, a.token, 'nouveau-mot-1', t0 + 2000), /plus valable/);

  // too short, then fine; the link works once
  await assert.rejects(resetPassword(db, b.token, 'court', t0 + 2000), /8 caractères/);
  const tvBefore = Number((await db.query('SELECT token_version FROM profiles WHERE email=$1', [EMAILS.conf]))[0].token_version);
  assert.deepEqual(await resetPassword(db, b.token, 'nouveau-mot-1', t0 + 2000), { email: EMAILS.conf });
  await assert.rejects(resetPassword(db, b.token, 'nouveau-mot-2', t0 + 3000), /plus valable/);
  await assert.rejects(login(db, EMAILS.conf, DEMO_PASSWORD));
  assert.equal((await login(db, EMAILS.conf, 'nouveau-mot-1')).profile.email, EMAILS.conf);
  const tvAfter = Number((await db.query('SELECT token_version FROM profiles WHERE email=$1', [EMAILS.conf]))[0].token_version);
  assert.equal(tvAfter, tvBefore + 1);

  // 3 e-mails per hour at most
  link(await createPasswordReset(db, EMAILS.conf, t0 + 4000)); // the 3rd this hour
  assert.equal(await createPasswordReset(db, EMAILS.conf, t0 + 5000), null);

  // 2 changes a month: the 2nd works, then the e-mail says to ask the supervisor
  const c = link(await createPasswordReset(db, EMAILS.conf, t0 + 3_700_000));
  await resetPassword(db, c.token, 'nouveau-mot-3', t0 + 3_710_000);
  const lim = await createPasswordReset(db, EMAILS.conf, t0 + 7_400_000);
  assert.equal(lim?.kind, 'limit');
  assert.equal(lim?.email, EMAILS.conf);
  // next month: allowed again
  link(await createPasswordReset(db, EMAILS.conf, Date.UTC(2026, 10, 1, 8)));

  // administrators are not limited
  for (let k = 0; k < 3; k++) {
    const l = link(await createPasswordReset(db, EMAILS.admin, t0 + k * 3_700_000));
    await resetPassword(db, l.token, `admin-mot-${k}xx`, t0 + k * 3_700_000 + 1000);
  }

  // expired after 30 minutes
  const e = link(await createPasswordReset(db, EMAILS.suivi, t0));
  await assert.rejects(resetPassword(db, e.token, 'nouveau-mot-4', t0 + 31 * 60_000), /plus valable/);

  // a turned-off account gets nothing
  await db.query('UPDATE profiles SET active = false WHERE email = $1', [EMAILS.depot]);
  assert.equal(await createPasswordReset(db, EMAILS.depot, t0), null);

  // nonsense tokens
  await assert.rejects(resetPassword(db, 'x', 'nouveau-mot-5', t0), /plus valable/);
  await assert.rejects(resetPassword(db, 'A'.repeat(43), 'nouveau-mot-5', t0), /plus valable/);
});

test('team accounts: the administrator chooses who may create accounts and set passwords', async () => {
  const { db, as } = await setup(5);
  const admin = await as(EMAILS.admin);
  const manager = await as(EMAILS.manager);
  const id = async (email: string) => Number((await db.query('SELECT id FROM profiles WHERE email=$1', [email]))[0].id);
  const confId = await id(EMAILS.conf);

  // not allowed yet
  await assert.rejects(call('users.create', manager, { name: 'Nouvel Agent', email: 'nouveau@example.com', password: 'motdepasse1', roles: ['confirmation'] }), /refusé/);
  await assert.rejects(call('admin.users.resetPassword', manager, { id: confId }), /refusé/);

  // the administrator gives the right
  await call('users.update', admin, { id: await id(EMAILS.manager), canManageUsers: true });
  const m = await as(EMAILS.manager);
  assert.equal(m.session.canManageUsers, true);

  // creates an agent, sets an agent's password, sees the logins
  const created: any = await call('users.create', m, { name: 'Nouvel Agent', email: 'nouveau@example.com', password: 'motdepasse1', roles: ['confirmation'] });
  assert.equal(created.canManageUsers, false);
  const r: any = await call('admin.users.resetPassword', m, { id: confId });
  assert.equal((await login(db, EMAILS.conf, r.password)).profile.email, EMAILS.conf);
  const list = (await call('users.list', m, {})) as any[];
  assert.ok(list.find((u) => u.id === confId).email);

  // never: an administrator, another person with the right, himself, the admin role, or the right itself
  await assert.rejects(call('admin.users.resetPassword', m, { id: await id(EMAILS.admin) }), /administrateur/);
  await call('users.update', admin, { id: await id(EMAILS.manager2), canManageUsers: true });
  await assert.rejects(call('users.update', m, { id: await id(EMAILS.manager2), password: 'motdepasse2' }), /administrateur/);
  await assert.rejects(call('users.update', m, { id: m.session.profile.id, name: 'Moi Même' }), /Mon profil/);
  await assert.rejects(call('users.create', m, { name: 'Faux Admin', email: 'faux@example.com', password: 'motdepasse1', roles: ['admin'] }), /Administrateur/);
  await assert.rejects(call('users.update', m, { id: confId, roles: ['confirmation', 'admin'] }), /Administrateur/);
  await assert.rejects(call('users.update', m, { id: confId, canManageUsers: true }), /ce droit/);
  await assert.rejects(call('users.create', m, { name: 'Autre Chef', email: 'chef@example.com', password: 'motdepasse1', roles: ['agent_manager'], canManageUsers: true }), /ce droit/);

  // an administrator never carries the flag (they already have everything)
  const adm: any = await call('users.update', admin, { id: await id(EMAILS.vendeur), roles: ['admin'], canManageUsers: true });
  assert.equal(adm.canManageUsers, false);

  // the administrator takes the right back
  await call('users.update', admin, { id: await id(EMAILS.manager), canManageUsers: false });
  await assert.rejects(call('admin.users.resetPassword', await as(EMAILS.manager), { id: confId }), /refusé/);
});
