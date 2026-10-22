// My profile: update name / phone / picture, referrals and invitations, admin rules, delete my account.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEMO_PASSWORD } from '@pilotix/shared';
import { call } from '../index';
import { EMAILS, setup } from './harness';

test('profile, referrals, rules and account deletion', async () => {
  const { db, as } = await setup(30);
  const conf = await as(EMAILS.conf);
  await call('me.update', conf, { name: 'Samira B.', phone: '0555 11 22 33', avatar: 'data:image/png;base64,AAAA' });
  const me: any = await call('me.get', conf, {});
  assert.equal(me.profile.name, 'Samira B.');
  assert.equal(me.profile.avatar, 'data:image/png;base64,AAAA');
  await assert.rejects(call('me.update', conf, { name: 'X Y', avatar: 'javascript:alert(1)' }), /Image invalide/);

  const r: any = await call('me.referrals', conf, {});
  assert.match(r.code, /^[0-9A-F]{6}$/);
  assert.equal(r.totals.invited, r.friends.length);
  await call('me.invite', conf, { name: 'Ami Test', email: 'ami@example.com' });
  await assert.rejects(call('me.invite', conf, { name: 'Ami Test', email: 'AMI@example.com' }), /déjà invité/);
  await assert.rejects(call('me.invite', conf, { name: 'Admin', email: EMAILS.admin }), /utilise déjà/);
  assert.equal(((await call('me.referrals', conf, {})) as any).totals.invited, r.totals.invited + 1);

  const admin = await as(EMAILS.admin);
  await assert.rejects(call('referral.rules', conf, { cash: 1, months: 1 }));
  await call('referral.rules', admin, { cash: 3000, months: 2 });
  assert.deepEqual(((await call('me.referrals', conf, {})) as any).rules, { cash: 3000, months: 2 });

  await assert.rejects(call('me.delete', conf, { password: 'wrong' }), /incorrect/);
  const id = conf.session.profile.id;
  await call('me.delete', conf, { password: DEMO_PASSWORD });
  assert.equal((await db.query('SELECT 1 FROM profiles WHERE id=$1', [id])).length, 0);
  assert.equal(Number((await db.query('SELECT count(*)::int AS n FROM orders WHERE agent_id=$1', [id]))[0].n), 0);
});
