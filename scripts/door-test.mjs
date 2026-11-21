// The backup door (« porte de secours »): its keeper (apps/web/public/sw.js) and its door page, checked without a browser
// (the worker runs in a sandbox with a pretend network, the door page's own script with a pretend page; time runs 100
// times faster), and, with a server (API=…), its tickets (apps/server api.ts › auth/door).
//   node scripts/door-test.mjs                                    the keeper and the door page
//   API=http://localhost:3000/api node scripts/door-test.mjs      the same, then the server (the demo shop, seed:demo)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SW = readFileSync(new URL('../apps/web/public/sw.js', import.meta.url), 'utf8');
const fast = (fn, ms = 0, ...a) => setTimeout(fn, Math.max(0, ms / 100), ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A worker on pilotix.online, with a network that answers as `net(request)` says. */
function worker(net) {
  const handlers = {};
  const store = new Map();
  const caches = {
    open: async () => ({
      match: async (k) => (store.has(k) ? new Response(store.get(k)) : undefined),
      put: async (k, r) => void store.set(k, await r.text()),
    }),
  };
  const self = {
    location: new URL('https://pilotix.online/sw.js'),
    registration: { scope: 'https://pilotix.online/', showNotification: async () => {} },
    clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} },
    crypto: globalThis.crypto,
    skipWaiting: () => {},
    addEventListener: (type, fn) => (handlers[type] = fn),
  };
  const ctx = vm.createContext({ self, caches, fetch: (req) => net(req), Response, Request, URL, Promise, JSON, Date, Array, Uint8Array, setTimeout: fast, clearTimeout });
  vm.runInContext(SW, ctx);
  /** a navigation: what the worker answered (undefined: it let the browser do it) */
  const open = async (url, init = {}) => {
    let answer;
    const waits = [];
    handlers.fetch({ request: { url, mode: init.mode ?? 'navigate', method: init.method ?? 'GET' }, respondWith: (p) => (answer = p), waitUntil: (p) => waits.push(p) });
    return answer === undefined ? undefined : await answer;
  };
  const tell = async (data) => {
    const waits = [];
    handlers.message({ data, waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  };
  return { open, tell };
}
const page = (status = 200) => new Response('<html>Pilotix</html>', { status, headers: { 'Content-Type': 'text/html' } });
const isDoor = async (r) => r && (await r.clone().text()).includes('id="t"') && /nonce-/.test(r.headers.get('Content-Security-Policy') || '');
const CONF = { type: 'px-door', on: true, main: 'pilotix.online', direct: 'direct.pilotix.online' };
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('nothing told yet: every page comes from the network, as before', async () => {
  const w = worker(() => new Promise((r) => fast(() => r(page()), 20_000)));
  const r = await w.open('https://pilotix.online/maison/commandes');
  assert.equal(await r.text(), '<html>Pilotix</html>');
});
test('on, the main road answers: its page', async () => {
  const w = worker(async () => page());
  await w.tell(CONF);
  const r = await w.open('https://pilotix.online/maison/commandes');
  assert.equal(await r.text(), '<html>Pilotix</html>');
});
test('on, 5 s of silence: the door page', async () => {
  const w = worker(() => new Promise((r) => fast(() => r(page()), 20_000)));
  await w.tell(CONF);
  assert.ok(await isDoor(await w.open('https://pilotix.online/maison/commandes')));
});
test('on, the road fails at once: the door page', async () => {
  const w = worker(async () => {
    throw new TypeError('Failed to fetch');
  });
  await w.tell(CONF);
  assert.ok(await isDoor(await w.open('https://pilotix.online/')));
});
test('on, Cloudflare cannot reach the server (522): the door page; a 404 or 500 of the server: its page', async () => {
  const w = worker(async (req) => page(req.url.endsWith('/a') ? 522 : req.url.endsWith('/b') ? 404 : 500));
  await w.tell(CONF);
  assert.ok(await isDoor(await w.open('https://pilotix.online/a')));
  assert.equal((await w.open('https://pilotix.online/b')).status, 404);
  assert.equal((await w.open('https://pilotix.online/c')).status, 500);
});
test('off (control room): every page from the network, however slow', async () => {
  const w = worker(() => new Promise((r) => fast(() => r(page()), 8_000)));
  await w.tell({ ...CONF, on: false });
  assert.equal(await (await w.open('https://pilotix.online/')).text(), '<html>Pilotix</html>');
});
test('the server’s own addresses, other names and other methods are never touched', async () => {
  const w = worker(async () => page());
  await w.tell(CONF);
  for (const u of ['https://pilotix.online/api/oauth/meta/callback?code=x', 'https://pilotix.online/live', 'https://pilotix.online/mcp', 'https://pilotix.online/.well-known/oauth-authorization-server', 'https://pilotix.online/llms.txt'])
    assert.equal(await w.open(u), undefined, u);
  assert.equal(await w.open('https://pilotix.online/', { method: 'POST' }), undefined);
  assert.equal(await w.open('https://pilotix.online/', { mode: 'cors' }), undefined);
  // another address (www, sent to the main name by the server; a shop's domain): not this worker's, the browser goes on
  assert.equal(await w.open('https://www.pilotix.online/'), undefined);
  assert.equal(await w.open('https://babyjoydz.net/x'), undefined);
});
test('« the main road answers again »: the next pages wait for it as long as it takes', async () => {
  const w = worker(() => new Promise((r) => fast(() => r(page()), 8_000)));
  await w.tell(CONF);
  await w.tell({ type: 'px-door-bypass' });
  assert.equal(await (await w.open('https://pilotix.online/')).text(), '<html>Pilotix</html>');
});
test('a wrong message is ignored (no door on someone else’s address)', async () => {
  const w = worker(() => new Promise((r) => fast(() => r(page()), 8_000)));
  for (const bad of [{ ...CONF, direct: 'evil.example/x' }, { ...CONF, main: '' }, { ...CONF, on: 'yes' }, { type: 'px-door' }]) await w.tell(bad);
  assert.equal(await (await w.open('https://pilotix.online/')).text(), '<html>Pilotix</html>');
});
test('the door page: its own strict rules, one script with the same nonce, the addresses written safely', async () => {
  const w = worker(async () => {
    throw new TypeError('x');
  });
  await w.tell(CONF);
  const r = await w.open('https://pilotix.online/');
  const csp = r.headers.get('Content-Security-Policy');
  const nonce = /'nonce-([0-9a-f]{32})'/.exec(csp)[1];
  const html = await r.text();
  assert.equal((html.match(/<script/g) || []).length, 1);
  assert.ok(html.includes(`<script nonce="${nonce}">`));
  assert.ok(!html.includes('__CONF__') && !html.includes('__NONCE__'));
  assert.ok(html.includes('"main":"pilotix.online","direct":"direct.pilotix.online","why":"sw"'));
  assert.match(csp, /default-src 'none'/);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
});

// ---------------------------------------------------------------- the door page's own script
async function doorPage() {
  const w = worker(async () => {
    throw new TypeError('x');
  });
  await w.tell(CONF);
  const html = await (await w.open('https://pilotix.online/maison/commandes?x=1')).text();
  return /<script nonce="[0-9a-f]+">([\s\S]*?)<\/script>/.exec(html)[1];
}
/** Runs the door page's script: `roads` says which address answers, `ticket` what the backup door gives. */
async function runDoor(script, { roads, token = 'TOKEN', ticket = 'T1', lang = 'fr', reloaded = 0 }) {
  const els = {};
  const el = (id) => (els[id] ??= { id, textContent: '', hidden: false, listeners: {}, addEventListener(t, f) { this.listeners[t] = f; } });
  const seen = { replaced: null, reloaded: false, posted: [], asked: [] };
  const session = new Map(reloaded ? [['px.door.reload', String(reloaded)]] : []);
  const fetchFn = async (url, init = {}) => {
    seen.asked.push(url);
    const u = new URL(url);
    if (u.pathname === '/api/health') {
      if (roads[u.hostname]) return new Response('{"ok":true}', { status: 200 });
      throw new TypeError('Failed to fetch');
    }
    if (u.pathname === '/api/auth/door/ticket') {
      assert.equal(init.headers.Authorization, `Bearer ${token}`);
      return ticket ? new Response(JSON.stringify({ ticket }), { status: 200 }) : new Response('{}', { status: 401 });
    }
    throw new Error('unexpected ' + url);
  };
  const ctx = vm.createContext({
    document: { getElementById: el, documentElement: {} },
    localStorage: { getItem: (k) => (k === 'px.token' ? token : k === 'px.lang' ? lang : null) },
    sessionStorage: { getItem: (k) => session.get(k) ?? null, setItem: (k, v) => session.set(k, v) },
    navigator: { language: 'fr-FR', serviceWorker: { controller: { postMessage: (m) => seen.posted.push(m) } } },
    location: { pathname: '/maison/commandes', search: '?x=1', replace: (u) => (seen.replaced = u), reload: () => (seen.reloaded = true) },
    window: { addEventListener: () => {} },
    fetch: fetchFn,
    AbortController,
    Promise,
    Date,
    Number,
    String,
    JSON,
    encodeURIComponent,
    setTimeout: fast,
    clearTimeout,
  });
  vm.runInContext(script, ctx);
  await wait(200);
  return { seen, els };
}

test('door page: the main road cut, the backup door answers → the same page there, with a ticket, never the token', async () => {
  const { seen } = await runDoor(await doorPage(), { roads: { 'direct.pilotix.online': true } });
  assert.equal(seen.replaced, 'https://direct.pilotix.online/maison/commandes?x=1#porte=T1&par=sw');
  assert.ok(!seen.replaced.includes('TOKEN'));
});
test('door page: not logged in → the backup door without a ticket (its login page)', async () => {
  const { seen } = await runDoor(await doorPage(), { roads: { 'direct.pilotix.online': true }, token: null });
  assert.equal(seen.replaced, 'https://direct.pilotix.online/maison/commandes?x=1#porte=&par=sw');
  assert.ok(!seen.asked.some((u) => u.includes('/auth/door/ticket')));
});
test('door page: the ticket refused (old session) → the backup door anyway, to log in there', async () => {
  const { seen } = await runDoor(await doorPage(), { roads: { 'direct.pilotix.online': true }, ticket: null });
  assert.equal(seen.replaced, 'https://direct.pilotix.online/maison/commandes?x=1#porte=&par=sw');
});
test('door page: the main road was only slow → this page again, waited for (once a minute at most)', async () => {
  const script = await doorPage();
  const a = await runDoor(script, { roads: { 'pilotix.online': true, 'direct.pilotix.online': true } });
  assert.equal(a.seen.reloaded, true);
  assert.equal(JSON.stringify(a.seen.posted), '[{"type":"px-door-bypass"}]');
  assert.equal(a.seen.replaced, null);
  // reloaded a moment ago and still no page: the backup door instead of a loop
  const b = await runDoor(script, { roads: { 'pilotix.online': true, 'direct.pilotix.online': true }, reloaded: Date.now() - 5_000 });
  assert.equal(b.seen.reloaded, false);
  assert.equal(b.seen.replaced, 'https://direct.pilotix.online/maison/commandes?x=1#porte=T1&par=sw');
});
test('door page: nothing answers → says so in the person’s language, a button, and tries again by itself', async () => {
  const { seen, els } = await runDoor(await doorPage(), { roads: {}, lang: 'ar' });
  assert.equal(seen.replaced, null);
  assert.equal(els.r.hidden, false);
  assert.match(els.s.textContent, /Pilotix لا يستجيب/);
  assert.equal(els.t.textContent, 'الباب الاحتياطي');
});

// ---------------------------------------------------------------- the server's tickets
const API = process.env.API || '';
if (API) {
  const http = async (path, { body, token } = {}) => {
    const r = await fetch(API + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try {
      data = await r.json();
    } catch {
      /* no body */
    }
    return { status: r.status, data };
  };
  const EMAIL = 'samira@demo.pilotix.dz';
  const login = async () => {
    const r = await http('/auth/login', { body: { email: EMAIL, password: 'demo-pilotix' } });
    assert.ok(r.status < 300 && r.data?.token, `login: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    return r.data.token;
  };
  test('server: the switch is public, and on unless the control room turns it off', async () => {
    const r = await http('/door');
    assert.equal(r.status, 200);
    assert.equal(r.data.on, true);
  });
  test('server: a ticket opens the same person in the same store, at the other address, once', async () => {
    const token = await login();
    const t = await http('/auth/door/ticket', { body: {}, token });
    assert.ok(t.status < 300, `ticket: ${t.status}`);
    const ticket = t.data.ticket;
    assert.equal(typeof ticket, 'string');
    assert.ok(!ticket.includes(token));
    const e = await http('/auth/door', { body: { ticket } });
    assert.ok(e.status < 300, `door: ${e.status} ${JSON.stringify(e.data).slice(0, 200)}`);
    assert.equal(e.data.session.profile.email, EMAIL);
    assert.notEqual(e.data.token, token);
    const me = await http('/rpc/me.get', { body: {}, token: e.data.token });
    assert.ok(me.status < 300, `the new session works: ${me.status}`);
    // once
    assert.equal((await http('/auth/door', { body: { ticket } })).status, 401);
  });
  test('server: no ticket without a session; a broken ticket, or a session’s own token, opens nothing', async () => {
    assert.equal((await http('/auth/door/ticket', { body: {} })).status, 401);
    const token = await login();
    for (const bad of ['', 'x', 'a.b.c', token]) assert.equal((await http('/auth/door', { body: { ticket: bad } })).status, 401, String(bad).slice(0, 12));
    assert.equal((await http('/auth/door', { body: {} })).status, 401);
  });
  test('server: the ticket of a session ended since (« Se déconnecter ») opens nothing', async () => {
    const token = await login();
    const ticket = (await http('/auth/door/ticket', { body: {}, token })).data.ticket;
    await http('/auth/logout', { body: {}, token });
    assert.equal((await http('/auth/door', { body: { ticket } })).status, 401);
  });
  test('server: a move through the backup door is told to Doctor', async () => {
    const token = await login();
    const r = await http('/client-report', { body: { items: [{ kind: 'door', page: 'accueil', message: 'Porte de secours ouverte (test)', device: 'computer' }] }, token });
    assert.ok(r.status < 300, `report: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  });
}

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.log(`not ok - ${name}\n  ${(e && e.stack) || e}`);
  }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
