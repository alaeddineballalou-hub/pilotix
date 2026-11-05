// Saved secrets kept sealed (secretbox.ts, platform/sealing.ts). A stand-in sealer here (the server's is AES-256-GCM
// with DATA_KEY: apps/server/src/secretbox.ts, checked end to end by scripts/secrets-test.mjs).
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  call,
  login,
  migrate,
  migrateAll,
  pgliteTenancy,
  sealDeep,
  sealPlatformSetting,
  sealSetting,
  sealStoredSecrets,
  sealString,
  seedBase,
  useSecretSealer,
} from '../index';

const OWNER = { email: 'owner@pilotix.dz', password: 'Owner-Password-1', name: 'Amine' };
const fake = (s: string) => `enc:v1:${Buffer.from(s).toString('base64url')}`;
after(() => useSecretSealer(null));

test('without a sealer (the demo in the browser) nothing changes', () => {
  useSecretSealer(null);
  assert.equal(sealString('tok'), 'tok');
  assert.deepEqual(sealDeep({ a: 'x', n: 1 }), { a: 'x', n: 1 });
  assert.equal(sealSetting('secret_meta_token', 'tok'), 'tok');
});

test('with one: secret settings sealed whole, couriers’ keys every text, the control room’s secret fields only', () => {
  useSecretSealer(fake);
  assert.equal(sealString('tok'), fake('tok'));
  assert.equal(sealString(fake('tok')), fake('tok'), 'never sealed twice');
  assert.equal(sealString(''), '', 'an empty value stays empty');
  assert.equal(sealSetting('secret_meta_token', 'tok'), fake('tok'));
  assert.deepEqual(sealSetting('secret_notify_sms', { key: 'k', on: true }), { key: fake('k'), on: true });
  assert.deepEqual(sealSetting('shop', { name: 'Ma boutique' }), { name: 'Ma boutique' }, 'an ordinary setting stays readable');
  assert.deepEqual(sealDeep({ api_id: '12', api_token: 'abc', demo: true, list: ['x'] }), { api_id: fake('12'), api_token: fake('abc'), demo: true, list: [fake('x')] });
  assert.deepEqual(sealPlatformSetting('whatsapp_otp', { on: true, phoneId: '123', token: 'T' }), { on: true, phoneId: '123', token: fake('T') });
  assert.deepEqual(sealPlatformSetting('cloudflare_turnstile', { accountId: 'acc', token: 'T' }), { accountId: 'acc', token: fake('T') });
  assert.deepEqual(sealPlatformSetting('pilot_key', { key: 'sk-ant' }), { key: fake('sk-ant') });
  assert.deepEqual(sealPlatformSetting('signup', { open: true }), { open: true });
});

test('what was saved readable is sealed at the start, once, everywhere; a new secret is sealed as it is saved', async () => {
  useSecretSealer(null);
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  const db = t.shop('public');
  await migrate(db, (sql) => t.exec('public', sql));
  await seedBase(db, OWNER);
  await migrateAll(t);
  // an older version's readable secrets
  await db.query(`INSERT INTO settings (key, value) VALUES ('secret_meta_token', '"EAAB-old"'), ('shop_note', '"not a secret"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const cid = Number((await db.query(`INSERT INTO delivery_companies (name, kind, credentials) VALUES ('Yalidine', 'yalidine', '{"api_id":"111","api_token":"tok"}') RETURNING id`))[0].id);
  await t.platform.query(`INSERT INTO platform.settings (key, value) VALUES ('whatsapp_otp', '{"on":true,"phoneId":"55","token":"WA"}'), ('signup', '{"open":true}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  assert.equal(await sealStoredSecrets(t), null, 'no sealer: nothing to do');

  useSecretSealer(fake);
  const first = (await sealStoredSecrets(t))!;
  assert.equal(first.sealed, 3);
  const raw = async (sql: string, p: unknown[] = []) => String((await (sql.includes('platform.') ? t.platform : db).query(sql, p))[0].v);
  assert.equal(await raw(`SELECT value::text AS v FROM settings WHERE key = 'secret_meta_token'`), JSON.stringify(fake('EAAB-old')));
  assert.equal(await raw(`SELECT value::text AS v FROM settings WHERE key = 'shop_note'`), '"not a secret"');
  assert.deepEqual(JSON.parse(await raw(`SELECT credentials::text AS v FROM delivery_companies WHERE id = $1`, [cid])), { api_id: fake('111'), api_token: fake('tok') });
  assert.deepEqual(JSON.parse(await raw(`SELECT value::text AS v FROM platform.settings WHERE key = 'whatsapp_otp'`)), { on: true, phoneId: '55', token: fake('WA') });
  assert.equal(await raw(`SELECT value::text AS v FROM platform.settings WHERE key = 'signup'`), '{"open": true}');
  assert.equal((await sealStoredSecrets(t))!.sealed, 0, 'never sealed twice');

  // typed in the app: sealed as it is saved
  const admin = { db, session: await login(db, OWNER.email, OWNER.password), now: () => Date.now(), emit: () => {} };
  await call('admin.meta.save', admin as any, { adAccountId: '1234567890', token: 'EAAB-new-token-typed-0123456789' });
  assert.equal(await raw(`SELECT value::text AS v FROM settings WHERE key = 'secret_meta_token'`), JSON.stringify(fake('EAAB-new-token-typed-0123456789')));
});
