// End-to-end check of the control room's authenticator app (packages/core/src/platform/totp.ts) on the running demo
// server, with the test mailbox (scripts/smtp-sink.cjs): a staff member adds the app (its first code), the login then
// asks the app's code instead of the e-mailed one (once each; a wrong one refused; a remembered device let in), and the
// app removed with a code brings the e-mailed code back.
//   API=http://localhost:3000/api MAILS_DIR=/tmp/mails DATABASE_URL=… node scripts/totp-test.mjs
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeIn, mailCount, mailTo } from './mailbox.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'apps/server/package.json'));
const { Client } = require('pg');
const bcrypt = require(createRequire(join(ROOT, 'packages/core/package.json')).resolve('bcryptjs'));
const API = process.env.API || 'http://localhost:3000/api';
const run = Date.now().toString(36).slice(-6);
const ok = (m) => console.log(`   ✓ ${m}`);
const STAFF = { email: `totp-${run}@pilotix.test`, password: 'Totp-Password-1' };

async function post(path, body, token) {
  const r = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const unbase32 = (s) => {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of s.replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};
/** The app's code for a step (RFC 6238), as the phone would show it. */
const codeAt = (secret, step) => {
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  msg.writeUInt32BE(step >>> 0, 4);
  const h = createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000).padStart(6, '0');
};
const stepNow = () => Math.floor(Date.now() / 30_000);

const pg = new Client({ connectionString: process.env.DATABASE_URL });
await pg.connect();
await pg.query(`INSERT INTO platform.staff (name, email, password_hash, role) VALUES ('Totp Test', $1, $2, 'support')`, [STAFF.email, await bcrypt.hash(STAFF.password, 10)]);
try {
  console.log('\n■ The control room’s authenticator app');
  // logged in with the e-mailed code
  const n0 = mailCount();
  const r1 = await post('/platform/auth/login', STAFF);
  assert.equal(r1.data?.step, 'code', JSON.stringify(r1.data));
  const r2 = await post('/platform/auth/code', { ticket: r1.data.ticket, code: codeIn(await mailTo(STAFF.email, n0)), remember: true });
  const P = r2.data.token;
  const device = r2.data.device;
  assert.ok(P && device);
  // the app added: its secret, then its first code
  const s = (await post('/platform/rpc/p.me.totp.start', {}, P)).data;
  assert.match(s.uri, /^otpauth:\/\/totp\//);
  assert.equal((await post('/platform/rpc/p.me.totp.confirm', { code: '000000' }, P)).status, 400);
  const first = stepNow();
  assert.equal((await post('/platform/rpc/p.me.totp.confirm', { code: codeAt(s.secret, first) }, P)).status, 201);
  assert.equal((await post('/platform/rpc/p.me.totp', {}, P)).data.on, true);
  ok('added: its QR code’s secret, then the first code it shows');
  // the login now asks the app's code: no e-mail
  const n1 = mailCount();
  const r3 = await post('/platform/auth/login', STAFF);
  assert.equal(r3.data?.step, 'totp', JSON.stringify(r3.data));
  assert.equal(mailCount(), n1, 'no code e-mailed');
  assert.equal((await post('/platform/auth/totp', { ticket: r3.data.ticket, code: codeAt(s.secret, first) })).status, 401, 'the code that turned it on serves no more');
  const next = codeAt(s.secret, first + 1);
  const r4 = await post('/platform/auth/totp', { ticket: r3.data.ticket, code: next });
  assert.ok(r4.data?.token, JSON.stringify(r4.data));
  assert.equal((await post('/platform/auth/totp', { ticket: r3.data.ticket, code: next })).status, 401, 'each code once');
  ok('the login asks the app’s code instead of an e-mail; each code serves once');
  assert.ok((await post('/platform/auth/login', { ...STAFF, device })).data?.token, 'a remembered device is let in');
  ok('a device remembered 30 days is let in');
  // removed with a code: the e-mailed code is back (a later code than the last one used: its 30 seconds must come)
  while (stepNow() < first + 1) await new Promise((r) => setTimeout(r, 1000));
  assert.equal((await post('/platform/rpc/p.me.totp.off', { code: '000000' }, r4.data.token)).status, 400);
  assert.equal((await post('/platform/rpc/p.me.totp.off', { code: codeAt(s.secret, first + 2) }, r4.data.token)).status, 201);
  assert.equal((await post('/platform/auth/login', STAFF)).data?.step, 'code');
  ok('removed only with a code it shows; the e-mailed code is asked again');
  console.log('\nAll authenticator app checks passed.');
} catch (e) {
  console.log(`   ✗ FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  await pg.query('DELETE FROM platform.staff WHERE email = $1', [STAFF.email]).catch(() => null);
  await pg.end();
}
