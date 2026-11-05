// End-to-end check of Cloudflare's robot check after a few wrong passwords (apps/server/src/robot.ts): a second server
// on the demo database (port 3040, its own Redis database, so its counters start at zero), with Cloudflare's test keys
// (a site key whose secret always passes). 3 wrong passwords, then the right one is asked the robot check; with its
// token the login goes on. Run after the other end-to-end tests (it leaves no setting behind).
//   DATABASE_URL=… REDIS_URL=… JWT_SECRET=… node scripts/robot-test.mjs   (after npm run seed:demo)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'apps/server/package.json'));
const { Client } = require('pg');
const PORT = 3040;
const API = `http://localhost:${PORT}/api`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (m) => console.log(`   ✓ ${m}`);
// Cloudflare's published test keys: this secret answers « success » for any token
const SITE = '1x00000000000000000000AA';
const SECRET = '1x0000000000000000000000000000000AA';

const pg = new Client({ connectionString: process.env.DATABASE_URL });
await pg.connect();
await pg.query(`INSERT INTO platform.settings (key, value) VALUES ('cloudflare_turnstile', '{"accountId":"test","token":"test"}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
await pg.query(`INSERT INTO platform.turnstile_widgets (sitekey, secret, name, domains) VALUES ($1, $2, 'Test', ARRAY['localhost']) ON CONFLICT (sitekey) DO UPDATE SET domains = EXCLUDED.domains`, [SITE, SECRET]);
const redis = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
redis.pathname = '/5';
const server = spawn(process.execPath, [join(ROOT, 'apps/server/dist/main.js')], {
  env: { ...process.env, PORT: String(PORT), REDIS_URL: redis.toString() },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
const login = async (password, turnstile) => {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'karim@demo.pilotix.dz', password, ...(turnstile ? { turnstile } : {}) }),
  });
  return { status: r.status, data: await r.json().catch(() => null) };
};

try {
  console.log('\n■ Cloudflare’s robot check after a few wrong passwords');
  for (let i = 0; i < 60; i++) {
    if ((await fetch(`${API}/health`).catch(() => null))?.ok) break;
    await sleep(500);
  }
  for (let i = 0; i < 3; i++) assert.equal((await login(`wrong-${i}`)).status, 401);
  const asked = await login('demo-pilotix');
  assert.equal(asked.status, 403, JSON.stringify(asked.data));
  assert.equal(asked.data?.challenge, SITE);
  ok('after 3 wrong passwords, even the right one is asked the robot check (the site key comes with the answer)');
  const bad = await login('demo-pilotix', '');
  assert.equal(bad.status, 403);
  const done = await login('demo-pilotix', 'XXXX.DUMMY.TOKEN.XXXX');
  assert.ok(done.status < 300 && (done.data?.token || done.data?.pick || done.data?.phone), JSON.stringify(done.data).slice(0, 200));
  ok('with the check’s token, the login goes on');
  console.log('\nAll robot check tests passed.');
} catch (e) {
  console.log(`   ✗ FAILED: ${e.message}`);
  console.log(log.split('\n').slice(-30).join('\n'));
  process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
  await pg.query(`DELETE FROM platform.turnstile_widgets WHERE sitekey = $1`, [SITE]);
  await pg.query(`DELETE FROM platform.settings WHERE key = 'cloudflare_turnstile'`);
  await pg.end();
}
