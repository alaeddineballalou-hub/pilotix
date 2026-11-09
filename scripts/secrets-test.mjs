// End-to-end check of the saved secrets kept sealed (DATA_KEY): a second server on the demo database (port 3030) with
// its own DATA_KEY. A courier's webhook key and a secret setting written readable (as an older version did) are sealed
// at the start; the database then holds no readable copy, and the server still uses them (the courier's webhook is
// let in with the right key only). A secret typed in the app is sealed as it is saved.
//   DATABASE_URL=… REDIS_URL=… JWT_SECRET=… node scripts/secrets-test.mjs   (after npm run seed:demo)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'apps/server/package.json'));
const { Client } = require('pg');
const PORT = 3030;
const API = `http://localhost:${PORT}/api`;
const run = Date.now().toString(36).slice(-6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (m) => console.log(`   ✓ ${m}`);
// the main test server's key when it has one (both servers read the same database), else this run's own
const KEY = process.env.DATA_KEY || randomBytes(32).toString('base64');
const HOOK = `plain-hook-key-${run}`;
const SECRET = `plain-secret-${run}`;

// what an older version left readable in shop #1
const pg = new Client({ connectionString: process.env.DATABASE_URL });
await pg.connect();
const companyId = Number((await pg.query('SELECT id FROM public.delivery_companies ORDER BY id LIMIT 1')).rows[0].id);
await pg.query(`UPDATE public.delivery_companies SET credentials = COALESCE(credentials, '{}'::jsonb) || jsonb_build_object('webhook_key', $2::text) WHERE id = $1`, [companyId, HOOK]);
await pg.query(`INSERT INTO public.settings (key, value) VALUES ('secret_test_token', to_jsonb($1::text)) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [SECRET]);

const server = spawn(process.execPath, [join(ROOT, 'apps/server/dist/main.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_KEY: KEY },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
const raw = async () => ({
  cred: String((await pg.query('SELECT credentials::text AS t FROM public.delivery_companies WHERE id = $1', [companyId])).rows[0].t),
  set: String((await pg.query(`SELECT value::text AS t FROM public.settings WHERE key = 'secret_test_token'`)).rows[0].t),
});
const hook = (key) =>
  fetch(`${API}/hooks/courier/${companyId}?key=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tracking: `NOPE-${run}` }) });

try {
  console.log('\n■ Saved secrets kept sealed (DATA_KEY)');
  for (let i = 0; i < 60; i++) {
    if ((await fetch(`${API}/health`).catch(() => null))?.ok) break;
    await sleep(500);
  }
  // sealed at the start, in the background
  let r = await raw();
  for (let i = 0; i < 40 && (r.cred.includes(HOOK) || r.set.includes(SECRET)); i++) {
    await sleep(500);
    r = await raw();
  }
  assert.ok(!r.cred.includes(HOOK) && r.cred.includes('enc:v1:'), `the courier's key is still readable: ${r.cred.slice(0, 120)}`);
  assert.ok(!r.set.includes(SECRET) && r.set.startsWith('"enc:v1:'), `the secret setting is still readable: ${r.set.slice(0, 120)}`);
  ok('what was saved readable is sealed at the start: the database holds no readable copy');

  // the server still uses it: the courier's webhook is let in with its key only
  assert.equal((await hook('wrong-key')).status, 400);
  const good = await hook(HOOK);
  assert.ok(good.status < 300, `the right key is refused: ${good.status} ${(await good.text()).slice(0, 200)}`);
  ok('the server opens it when it reads it (the courier’s webhook: the right key in, a wrong one out)');

  // a secret typed in the app: sealed as it is saved
  const login = await (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@demo.pilotix.dz', password: 'demo-pilotix' }) })).json();
  const token = `EAAB${run}${'x'.repeat(30)}`;
  const saved = await fetch(`${API}/rpc/admin.meta.save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` },
    body: JSON.stringify({ adAccountId: '1234567890', token }),
  });
  assert.ok(saved.status < 300, `admin.meta.save → ${saved.status}`);
  const meta = String((await pg.query(`SELECT value::text AS t FROM public.settings WHERE key = 'secret_meta_token'`)).rows[0].t);
  assert.ok(!meta.includes(token) && meta.startsWith('"enc:v1:'), `the Meta token is readable: ${meta.slice(0, 80)}`);
  ok('a token typed in the app is sealed as it is saved');
  console.log('\nAll sealed secrets checks passed.');
} catch (e) {
  console.log(`   ✗ FAILED: ${e.message}`);
  console.log(log.split('\n').slice(-30).join('\n'));
  process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
  // the test's values gone (they were sealed with this run's key only)
  await pg.query(`DELETE FROM public.settings WHERE key IN ('secret_test_token', 'secret_meta_token')`);
  await pg.query(`UPDATE public.delivery_companies SET credentials = credentials - 'webhook_key' WHERE id = $1`, [companyId]);
  await pg.end();
}
