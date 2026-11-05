// End-to-end check of the landing pages' own address (go.<domain> in production): a second server, on the same demo
// database, whose site is http://localhost:3010 (PUBLIC_URL, pilotix.online) and whose pages live at
// http://127.0.0.1:3010 (LANDING_URL, go.pilotix.online). Checks: the server turns the pages' address on once it
// answers there, a page served there calls that address, the old addresses at the site move there (what followed them
// kept), the links the app shows and the lists for AI assistants use it, and its certificate is allowed.
//   DATABASE_URL=… REDIS_URL=… JWT_SECRET=… node scripts/landing-host-test.mjs   (after npm run seed:demo)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3010;
const SITE = `http://localhost:${PORT}`;
// another name of this machine (PAGES_URL: a name of /etc/hosts, to check the road of LANDING_CHECK_VIA too)
const PAGES = process.env.PAGES_URL || `http://127.0.0.1:${PORT}`;
const run = Date.now().toString(36).slice(-6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (m) => console.log(`   ✓ ${m}`);

const server = spawn(process.execPath, [join(ROOT, 'apps/server/dist/main.js')], {
  env: { ...process.env, PORT: String(PORT), PUBLIC_URL: SITE, LANDING_URL: PAGES, CORS_ORIGINS: SITE },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));

async function json(url, init) {
  const r = await fetch(url, init);
  const text = await r.text();
  try {
    return { status: r.status, data: JSON.parse(text) };
  } catch {
    return { status: r.status, data: text };
  }
}
async function rpc(token, name, input = {}) {
  const r = await json(`${SITE}/api/rpc/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  if (r.status >= 300) throw new Error(`${name} → ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data;
}
const moved = async (url) => {
  const r = await fetch(url, { redirect: 'manual' });
  return { status: r.status, to: r.headers.get('location'), cache: r.headers.get('cache-control') };
};

try {
  console.log('\n■ The landing pages at their own address');
  for (let i = 0; i < 60; i++) {
    if ((await fetch(`${SITE}/api/health`).catch(() => null))?.ok) break;
    await sleep(500);
  }
  const login = await json(`${SITE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.pilotix.dz', password: 'demo-pilotix' }),
  });
  assert.ok(login.status < 300 && login.data?.token, JSON.stringify(login.data).slice(0, 200));
  const T = login.data.token;

  // the server asks the pages' address who answers there, soon after it starts
  assert.deepEqual((await json(`${PAGES}/api/landing-ready`)).data, { landing: true });
  assert.deepEqual((await json(`${SITE}/api/landing-ready`)).data, { landing: false });
  let st;
  for (let i = 0; i < 40; i++) {
    st = await rpc(T, 'landing.store');
    if (st.pagesUrl === PAGES) break;
    await sleep(500);
  }
  assert.equal(st.pagesUrl, PAGES, 'the pages’ address never turned on');
  ok('the pages’ own address answers, the server turns it on (the app’s links use it)');
  assert.equal((await rpc(T, 'landing.settings.get')).pagesUrl, PAGES);

  // a page of shop #1
  const product = (await rpc(T, 'catalog.products', {}))[0];
  const slug = `adresse-${run}`;
  await rpc(T, 'landing.save', { productId: product.id, slug, title: 'Page adresse', color: '#0f766e', price: 4500, description: 'Une page de test' });
  const store = st.store;

  // served at its own address: it calls that address, and names it as its own
  const page = await fetch(`${PAGES}/api/s/${store}/${slug}?fbclid=abc`);
  const html = await page.text();
  assert.equal(page.status, 200, html.slice(0, 200));
  assert.ok(html.includes(`${PAGES}/api/lp/${slug}/order`), 'the page posts its orders to the pages’ address');
  assert.ok(!html.includes(`${SITE}/api/`), 'the page calls the app’s site');
  assert.ok(html.includes(`${PAGES}/${store}/${slug}`), 'the page names its own address');
  ok('a page at its own address calls only that address');

  // the old addresses at the app's site move there, with what followed them (the ad's click id)
  let m = await moved(`${SITE}/api/s/${store}/${slug}?fbclid=abc&utm_source=facebook`);
  assert.equal(m.status, 301);
  assert.equal(m.to, `${PAGES}/${store}/${slug}?fbclid=abc&utm_source=facebook`);
  assert.match(String(m.cache), /no-store/);
  m = await moved(`${SITE}/api/lp/${slug}?ttclid=x1`);
  assert.equal(m.status, 301);
  assert.equal(m.to, `${PAGES}/${store}/${slug}?ttclid=x1`);
  ok('the old links (in ads already) move to the pages’ address, their click ids kept');

  // the first address of a page still opens it at the pages' address (no redirect there)
  assert.equal((await fetch(`${PAGES}/api/lp/${slug}`, { redirect: 'manual' })).status, 200);
  // a page that does not exist: nothing moves, nothing is said
  assert.equal((await fetch(`${PAGES}/api/s/${store}/nexiste-pas-${run}`)).status, 404);
  ok('at the pages’ address: the first addresses open, unknown pages are 404');

  // the lists for AI assistants link the pages at their address
  const llms = await (await fetch(`${SITE}/api/llms.txt`)).text();
  assert.ok(llms.includes(`${PAGES}/${store}/${slug}`), llms.slice(0, 300));
  ok('llms.txt links the pages at their address');

  // the pages' address may get its certificate; other names do not
  assert.equal((await fetch(`${SITE}/api/domain-check?domain=${new URL(PAGES).hostname}`)).status, 200);
  assert.equal((await fetch(`${SITE}/api/domain-check?domain=go.example.org`)).status, 404);
  ok('only the pages’ address (and the shops’ ready domains) may get a certificate');

  const made = (await rpc(T, 'landing.list')).find((p) => p.slug === slug);
  if (made) await rpc(T, 'landing.remove', { id: made.id });
  console.log('\nAll landing address checks passed.');
} catch (e) {
  console.log(`   ✗ FAILED: ${e.message}`);
  console.log(log.split('\n').slice(-30).join('\n'));
  process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
}
