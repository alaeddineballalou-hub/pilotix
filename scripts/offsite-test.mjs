// End-to-end check of the off-site copy's settings (apps/server/src/offsite.ts) on the running demo server: the
// encryption is the one `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000` reads back; the owner saves the bucket,
// the two keys and the passphrase (refused when too short), the keys and passphrase are never shown again and are
// kept sealed in the database; « Tester » says what Backblaze answered.
//   API=http://localhost:3000/api MAILS_DIR=/tmp/mails DATABASE_URL=… node scripts/offsite-test.mjs   (after npm run build)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeIn, mailCount, mailTo } from './mailbox.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'apps/server/package.json'));
const { Client } = require('pg');
const bcrypt = require(createRequire(join(ROOT, 'packages/core/package.json')).resolve('bcryptjs'));
const { encryptFile } = require(join(ROOT, 'apps/server/dist/offsite.js'));
const API = process.env.API || 'http://localhost:3000/api';
const run = Date.now().toString(36).slice(-6);
const ok = (m) => console.log(`   ✓ ${m}`);
const STAFF = { email: `offsite-${run}@pilotix.test`, password: 'Offsite-Password-1' };
const PASS = 'a passphrase kept on paper 2026';
const KEY = 'K005abcdefghijklmnopqrstuvwxyz0123';

async function post(path, body, token) {
  const r = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null) };
}

const pg = new Client({ connectionString: process.env.DATABASE_URL });
await pg.connect();
await pg.query(`INSERT INTO platform.staff (name, email, password_hash, role) VALUES ('Offsite Test', $1, $2, 'owner')`, [STAFF.email, await bcrypt.hash(STAFF.password, 10)]);
try {
  console.log('\n■ The off-site copy (Backblaze B2)');
  // the encryption: openssl reads it back
  const dir = mkdtempSync(join(tmpdir(), 'offsite-'));
  const plain = Buffer.from(`-- a dump ${run}\n`.repeat(5000));
  writeFileSync(join(dir, 'd.sql.gz'), plain);
  await encryptFile(join(dir, 'd.sql.gz'), join(dir, 'd.sql.gz.enc'), PASS);
  const back = spawnSync('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-in', join(dir, 'd.sql.gz.enc'), '-pass', `pass:${PASS}`]);
  assert.equal(back.status, 0, String(back.stderr));
  assert.ok(Buffer.compare(back.stdout, plain) === 0, 'openssl gives the same bytes back');
  assert.ok(!readFileSync(join(dir, 'd.sql.gz.enc')).includes(Buffer.from(`a dump ${run}`)), 'nothing readable in the copy');
  ok('encrypted as openssl reads back (-aes-256-cbc -pbkdf2 -iter 200000)');

  const n0 = mailCount();
  const r1 = await post('/platform/auth/login', STAFF);
  const P = (await post('/platform/auth/code', { ticket: r1.data.ticket, code: codeIn(await mailTo(STAFF.email, n0)) })).data.token;
  assert.ok(P);
  assert.equal((await post('/platform/backup/status', {}, P)).data.configured, false);
  assert.equal((await post('/platform/backup/save', { bucket: 'pilotix-backups', keyId: '005a1b2c3d4e5f60000000001', key: KEY, passphrase: 'too short' }, P)).status, 400);
  const s = (await post('/platform/backup/save', { bucket: 'pilotix-backups', keyId: '005a1b2c3d4e5f60000000001', key: KEY, passphrase: PASS }, P)).data;
  assert.deepEqual([s.configured, s.bucket, s.keyId, s.keySet, s.passphraseSet], [true, 'pilotix-backups', '…000001', true, true]);
  assert.ok(!JSON.stringify(s).includes(KEY) && !JSON.stringify(s).includes(PASS), 'the key and the passphrase are never shown again');
  // a save without them keeps them
  assert.equal((await post('/platform/backup/save', { bucket: 'pilotix-backups' }, P)).data.keySet, true);
  ok('saved by the owner; the passphrase must be long; the key and passphrase never come back');
  const raw = String((await pg.query(`SELECT value::text AS t FROM platform.settings WHERE key = 'backup_offsite'`)).rows[0].t);
  if (process.env.DATA_KEY) {
    assert.ok(!raw.includes(KEY) && !raw.includes(PASS) && raw.includes('enc:v1:'), raw.slice(0, 200));
    ok('kept sealed in the database (DATA_KEY)');
  }
  // « Tester » with made-up keys: Backblaze (or the network) says no, and that is what the page shows
  const tst = await post('/platform/backup/test', {}, P);
  assert.equal(tst.status, 400);
  assert.ok(String(tst.data?.message ?? '').length > 0);
  assert.ok((await post('/platform/backup/status', {}, P)).data.lastError, 'the error is kept for the page');
  ok(`« Tester » says what went wrong (${String(tst.data.message).slice(0, 60)})`);
  assert.equal((await post('/platform/backup/save', { bucket: '', clear: true }, P)).data.configured, false);
  console.log('\nAll off-site copy checks passed.');
} catch (e) {
  console.log(`   ✗ FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  await pg.query(`DELETE FROM platform.settings WHERE key = 'backup_offsite'`).catch(() => null);
  await pg.query('DELETE FROM platform.staff WHERE email = $1', [STAFF.email]).catch(() => null);
  await pg.end();
}
