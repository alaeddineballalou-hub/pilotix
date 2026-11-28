// A client coming back to a shop's pages (28 Nov 2026, Meta's « manual advanced matching »). The page that took an order
// leaves a mark for its shop (when, and the shop's pixel ids: never a name or a number); on a later visit it asks the
// shop about its device. Only an order an agent confirmed gives that shop's own pixel the client's scrambled details —
// never a fake, blocked, waiting or old one, never another device's — and nothing changes for anyone else.
import { renderGroup, renderLanding, sha256Hex, zeroBits } from '@pilotix/shared';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import vm from 'node:vm';
import { call, Ctx, Db } from '../index';
import { LANDING_POW_BITS, makeChallenge, returningClient } from '../modules/landing';
import { EMAILS, setup } from './harness';

// ---------------------------------------------------------------- the server: who is a confirmed client coming back

let db: Db;
let admin: Ctx;
let conf: Ctx;
let productId: number;
let variantId: number;
const SLUG = 'returning-test';
const UA = 'Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const DAY = 86_400_000;

before(async () => {
  const s = await setup(120);
  db = s.db;
  admin = await s.as(EMAILS.admin);
  conf = await s.as(EMAILS.conf);
  const p = (await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id WHERE p.sku = 'PX-POU' AND v.title <> '' ORDER BY v.id LIMIT 1`))[0];
  productId = Number(p.id);
  variantId = Number(p.vid);
  await call('landing.save', await s.as(EMAILS.marketer), { productId, slug: SLUG, title: 'Returning', price: 9950, pixelId: '555566667777999' });
});

const solve = (ch: string) => {
  for (let n = 0; ; n++) if (zeroBits(sha256Hex(`${ch}:${n}`)) >= LANDING_POW_BITS) return String(n);
};
let seq = 0;
const NAMES = ['Benali', 'Haddad', 'Mansouri', 'Belkacem', 'Saidi', 'Bouzid', 'Cherif', 'Djebbar'];
/** a person's form from their own browser (its device code `did`) */
async function form(did: string, over: Record<string, unknown> = {}) {
  const n = ++seq;
  const ch = await makeChallenge(db, SLUG, Date.now() - 25_000);
  const phone = `0668${String(n).padStart(3, '0')}${String(n).padStart(3, '0')}`;
  return { slug: SLUG, name: `Amina ${NAMES[n % NAMES.length]}`, phone, wilaya: 16, commune: 'Hydra', variant: variantId, qty: 1, hp: '', ch, pw: solve(ch), t: 25_000, ki: 40, wd: false, fp: `fp${did}`, did, vid: `v${did}${n}`, meta: { ip: `10.7.0.${n}`, ua: UA }, ...over };
}
const orderOf = async (phone: string) => (await db.query(`SELECT * FROM orders WHERE phone = $1 ORDER BY id DESC`, [phone]))[0];
async function confirm(id: unknown) {
  await db.query('UPDATE orders SET agent_id = $2 WHERE id = $1', [id, conf.session.profile.id]);
  await call('orders.setConf', conf, { ids: [Number(id)], status: 'confirmed' });
}
const me = (did: string) => call('landing.me', admin, { slug: SLUG, did }) as Promise<{ ok: true; am?: Record<string, string> }>;

test('server: a confirmed order of this device gives its scrambled details — Meta’s format, one string per key', async () => {
  const did = 'a1b2c3d4e5f60001';
  const f = await form(did);
  await call('landing.submit', admin, f);
  const o = await orderOf(f.phone);
  assert.ok(o, 'a clean order');
  // waiting for its call: the plain answer
  assert.deepEqual(await me(did), { ok: true });
  await confirm(o.id);
  const r = await me(did);
  assert.ok(r.am, 'confirmed: the details');
  assert.equal(r.am.ph, sha256Hex(`213${f.phone.slice(1)}`));
  assert.equal(r.am.country, sha256Hex('dz'));
  assert.equal(r.am.fn, sha256Hex('amina'));
  assert.equal(r.am.st, sha256Hex('16'));
  assert.equal(r.am.ct, sha256Hex('hydra'));
  assert.ok(/^[0-9a-f]{64}$/.test(r.am.external_id), 'the client’s id, scrambled');
  for (const v of Object.values(r.am)) assert.match(v, /^[0-9a-f]{64}$/, 'never a readable name or number');
  // another device: nothing; a device code that is no code: nothing
  assert.deepEqual(await me('ffffffffffff0001'), { ok: true });
  assert.deepEqual(await me('not-a-device'), { ok: true });
});

test('server: never a fake, a marked device, a newer order still waiting, a blocked submit, or an order over 90 days old', async () => {
  // confirmed, then an agent marks it « Fausse »
  const fakeDid = 'a1b2c3d4e5f60002';
  const f1 = await form(fakeDid);
  await call('landing.submit', admin, f1);
  const o1 = await orderOf(f1.phone);
  await confirm(o1.id);
  assert.ok((await me(fakeDid)).am);
  await call('orders.setConf', conf, { ids: [Number(o1.id)], status: 'fake', reason: 'N’a pas commandé' });
  assert.deepEqual(await me(fakeDid), { ok: true }, 'a fake: nothing');

  // confirmed, but the device carries a fraud mark (« Concurrent » on another of its orders)
  const markedDid = 'a1b2c3d4e5f60003';
  const f2 = await form(markedDid);
  await call('landing.submit', admin, f2);
  const o2 = await orderOf(f2.phone);
  await confirm(o2.id);
  await db.query(`INSERT INTO fraud_marks (kind, value, reason, device) VALUES ('device', $1, 'competitor', $1)`, [`d:${markedDid}`]);
  assert.deepEqual(await me(markedDid), { ok: true }, 'a marked device: nothing');

  // confirmed, then the same device sends a new order still waiting for its call: the last order decides
  const twiceDid = 'a1b2c3d4e5f60004';
  const f3 = await form(twiceDid);
  await call('landing.submit', admin, f3);
  await confirm((await orderOf(f3.phone)).id);
  assert.ok((await me(twiceDid)).am);
  await call('landing.submit', admin, await form(twiceDid));
  assert.deepEqual(await me(twiceDid), { ok: true }, 'its newest order is not confirmed yet: nothing');

  // a blocked submit (a robot's): no order at all
  const botDid = 'a1b2c3d4e5f60005';
  await call('landing.submit', admin, { ...(await form(botDid)), hp: 'spam', pw: '', meta: { ip: '1.2.3.4', ua: 'curl/8.0' } });
  assert.deepEqual(await me(botDid), { ok: true });

  // confirmed, but more than 90 days ago
  const oldDid = 'a1b2c3d4e5f60006';
  const f4 = await form(oldDid);
  await call('landing.submit', admin, f4);
  await confirm((await orderOf(f4.phone)).id);
  assert.ok(await returningClient(db, oldDid, Date.now()));
  assert.equal(await returningClient(db, oldDid, Date.now() + 91 * DAY), null, '91 days later: nothing');
});

test('server: the page’s address to ask is given in live mode only, and never to a team browser', async () => {
  const base = { slug: SLUG, post: '/api/lp/returning-test/order', geo: '/api/lp/geo/', seen: '/api/lp/returning-test/seen', me: '/api/lp/returning-test/me' };
  const cfgOf = (html: string) => JSON.parse(/window\.__LP=([\s\S]*?)<\/script>/.exec(html)![1]);
  const live = (await call('landing.html', admin, { ...base, mode: 'live' })) as { html: string };
  assert.equal(cfgOf(live.html).me, '/api/lp/returning-test/me');
  const team = (await call('landing.html', admin, { ...base, mode: 'live', team: true })) as { html: string };
  assert.equal(cfgOf(team.html).me, '');
  const preview = (await call('landing.html', admin, { ...base, mode: 'preview' })) as { html: string };
  assert.equal(cfgOf(preview.html).me, '');
});

// ---------------------------------------------------------------- the page: its pixels start with the details or not

type Fn = (...a: unknown[]) => void;
const PIX = '123456789012';
const ME = '/api/lp/bureaux-pliable/me';
const KEY = 'pxo:babyjoy.test/api/lp/';
const VIEW: any = {
  slug: 'bureaux-pliable', title: 'مكتب', color: '#0f766e', price: 4950, oldPrice: null, description: '', descImages: {}, variantLabel: 'اللون',
  variants: [{ id: 1, title: 'Gris', price: null, available: 5 }], soldOut: false, images: [], fees: {}, shopName: 'Baby Joy', pixelId: PIX,
  tiktokId: '', whatsapp: null, productId: 26,
};
const page = (me = ME) =>
  renderLanding(VIEW, { mode: 'live', post: '/api/lp/bureaux-pliable/order', geo: '/api/lp/geo/', lead: '/api/lp/bureaux-pliable/lead', seen: '/api/lp/bureaux-pliable/seen', me, viewId: 'abc123def456gh', challenge: 'k1.r2.0123456789abcdef0123456789abcdef', bits: 10 });
const group = () =>
  renderGroup(
    { slug: 'tous', title: 'Tous', subtitle: '', color: '#0f766e', theme: 'grid', items: [], bestSlug: null, shopName: 'Baby Joy', shopLogo: null, pixelId: PIX, tiktokId: '' } as any,
    { mode: 'live', viewId: 'grp123', seen: '/api/lp/tous/seen', me: '/api/lp/tous/me' },
  );

/** the page in a small fake browser: what its storage holds; what it asked the server, and Meta's pixel calls */
function open(html: string, local: Record<string, string> = {}) {
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).pop()!;
  const cfg = /window\.(__L[PG])=([\s\S]*?)<\/script>/.exec(html)!;
  const timers: { ms: number; fn: Fn }[] = [];
  const asked: { url: string; body: any; x: any }[] = [];
  const store = new Map(Object.entries(local));
  class XHR {
    url = '';
    responseText = '';
    status = 0;
    timeout = 0;
    onload: Fn | null = null;
    onerror: Fn | null = null;
    ontimeout: Fn | null = null;
    open(_m: string, u: string) {
      this.url = u;
    }
    setRequestHeader() {}
    send(b: string) {
      asked.push({ url: this.url, body: b ? JSON.parse(b) : null, x: this });
    }
  }
  const doc = {
    visibilityState: 'visible',
    prerendering: false,
    cookie: '',
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
    head: { appendChild() {} },
    documentElement: { scrollHeight: 100, clientHeight: 100 },
  };
  const ctx: any = {
    document: doc,
    navigator: { sendBeacon: () => true, userAgent: 'test' },
    location: { href: 'https://babyjoy.test/bureaux-pliable', search: '', host: 'babyjoy.test' },
    sessionStorage: { getItem: () => null, setItem() {} },
    localStorage: { getItem: (k: string) => (store.has(k) ? store.get(k) : null), setItem: (k: string, v: string) => store.set(k, String(v)) },
    screen: {},
    Intl,
    XMLHttpRequest: XHR,
    setTimeout: (fn: Fn, ms: number) => timers.push({ ms, fn }),
    clearTimeout() {},
  };
  ctx[cfg[1]] = JSON.parse(cfg[2]);
  vm.createContext(ctx);
  ctx.window = vm.runInContext('this', ctx);
  ctx.addEventListener = () => {};
  vm.runInContext(script, ctx);
  return {
    asked,
    /** Meta's pixel calls, in order (as arrays) */
    calls: () => JSON.parse(JSON.stringify(Array.from(ctx.fbq?.queue ?? [], (a: ArrayLike<unknown>) => Array.from(a)))),
    answer: (i: number, json: unknown) => {
      const x = asked[i].x;
      x.status = 200;
      x.responseText = JSON.stringify(json);
      x.onload?.();
    },
    after: (ms: number) => timers.filter((t) => t.ms === ms).forEach((t) => t.fn()),
  };
}
const mark = (px = [PIX], t = Date.now()) => JSON.stringify({ t, px });
const AM = { ph: 'a'.repeat(64), fn: 'b'.repeat(64), country: 'c'.repeat(64) };
const PLAIN = [['set', 'autoConfig', false, PIX], ['init', PIX]];

test('page: a visitor without a mark — the pixel starts at once, as before, and the page asks nothing', () => {
  const b = open(page(), { pxd: 'a1b2c3d4e5f60001' });
  assert.equal(b.asked.length, 0);
  assert.deepEqual(b.calls().slice(0, 2), PLAIN);
  assert.deepEqual(b.calls().slice(2).map((c: any[]) => c[1]), ['PageView', 'ViewContent']);
});

test('page: a client coming back — the page asks the shop, the pixel waits, then starts with his details', () => {
  const b = open(page(), { pxd: 'a1b2c3d4e5f60001', [KEY]: mark() });
  assert.deepEqual(b.asked.map((a) => [a.url, a.body]), [[ME, { did: 'a1b2c3d4e5f60001' }]]);
  assert.deepEqual(b.calls(), [], 'nothing leaves before the answer');
  b.answer(0, { ok: true, am: AM });
  assert.deepEqual(b.calls().slice(0, 2), [['set', 'autoConfig', false, PIX], ['init', PIX, AM]]);
  assert.deepEqual(b.calls().slice(2).map((c: any[]) => c[1]), ['PageView', 'ViewContent']);
});

test('page: the plain answer, or none within 1.5 s — the pixel starts as before, once', () => {
  const plain = open(page(), { pxd: 'a1b2c3d4e5f60001', [KEY]: mark() });
  plain.answer(0, { ok: true });
  assert.deepEqual(plain.calls().slice(0, 2), PLAIN);

  const slow = open(page(), { pxd: 'a1b2c3d4e5f60001', [KEY]: mark() });
  slow.after(1500);
  assert.deepEqual(slow.calls().slice(0, 2), PLAIN);
  slow.answer(0, { ok: true, am: AM });
  assert.equal(slow.calls().filter((c: any[]) => c[0] === 'init').length, 1, 'a late answer starts nothing twice');
});

test('page: the mark of another shop, of other pixels, over 90 days old, or no device code — the page asks nothing', () => {
  const cases: Record<string, string>[] = [
    { pxd: 'a1b2c3d4e5f60001', 'pxo:other-shop.test/api/lp/': mark() },
    { pxd: 'a1b2c3d4e5f60001', [KEY]: mark(['999999999999']) },
    { pxd: 'a1b2c3d4e5f60001', [KEY]: mark([PIX], Date.now() - 91 * DAY) },
    { [KEY]: mark() },
  ];
  for (const local of cases) {
    const b = open(page(), local);
    assert.equal(b.asked.length, 0, JSON.stringify(local));
    assert.deepEqual(b.calls().slice(0, 2), PLAIN);
  }
  // no address to ask (the preview, a team browser): as before
  const none = open(page(''), { pxd: 'a1b2c3d4e5f60001', [KEY]: mark() });
  assert.equal(none.asked.length, 0);
  assert.deepEqual(none.calls().slice(0, 2), PLAIN);
});

test('page: the group page knows the same client (the same shop’s mark)', () => {
  const b = open(group(), { pxd: 'a1b2c3d4e5f60001', [KEY]: mark() });
  assert.deepEqual(b.asked.map((a) => a.url), ['/api/lp/tous/me']);
  b.answer(0, { ok: true, am: AM });
  assert.deepEqual(b.calls(), [['set', 'autoConfig', false, PIX], ['init', PIX, AM], ['track', 'PageView', {}, { eventID: 'pv-grp123' }]]);
});

test('page: a sent order leaves the shop’s mark — its time and pixel ids, never a name or a number', () => {
  const html = page();
  assert.ok(html.includes('done=1;if(px&&C.me)pmark();'));
  assert.ok(html.includes("var pmark=function(){try{localStorage.setItem(MK,JSON.stringify({t:Date.now(),px:PS}))}catch(e){}};"));
});
