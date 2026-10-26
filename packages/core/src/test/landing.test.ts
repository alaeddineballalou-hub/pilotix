// Landing pages: one public page per product; orders from it pass, go to review, or are blocked as fake without the
// customer knowing (same answer), and a blocked one can be restored as a real order.
import { sha256Hex, zeroBits } from '@pilotix/shared';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { scoreOrder, nameSignals, phoneSignals, FraudFacts } from '../modules/fraud';
import { LANDING_POW_BITS, makeChallenge } from '../modules/landing';
import { EMAILS, setup } from './harness';

let db: Db;
let admin: Ctx;
let as: (email: string) => Promise<Ctx>;
let productId: number;
let variantId: number;
const SLUG = 'poussette-test';
const UA = 'Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';

before(async () => {
  const s = await setup(200);
  db = s.db;
  as = s.as;
  admin = await s.as(EMAILS.admin);
  const p = (await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id WHERE p.sku = 'PX-POU' AND v.title <> '' ORDER BY v.id LIMIT 1`))[0];
  productId = Number(p.id);
  variantId = Number(p.vid);
  await call('landing.save', await s.as(EMAILS.marketer), { productId, slug: SLUG, title: 'عربة أطفال', color: '#db2777', price: 9950, description: '- خفيفة\n- قابلة للطي' });
});

const solve = (ch: string) => {
  for (let n = 0; ; n++) if (zeroBits(sha256Hex(`${ch}:${n}`)) >= LANDING_POW_BITS) return String(n);
};

/** what the page sends, as a person would: the page served 25 s earlier, the challenge solved, typed by hand */
async function human(over: Record<string, unknown> = {}, phone = `0661${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`) {
  const t0 = Date.now() - 25_000;
  const ch = await makeChallenge(db, SLUG, t0);
  return { slug: SLUG, name: 'Amina Benali', phone, wilaya: 16, commune: 'Hydra', variant: variantId, qty: 1, hp: '', ch, pw: solve(ch), t: 25_000, ki: 40, wd: false, fp: 'abc', did: `d${Math.random()}`, meta: { ip: `10.0.0.${Math.floor(Math.random() * 250)}`, ua: UA }, ...over };
}

test('the page is one small HTML file with the form, the colour and the description', async () => {
  const r: any = await call('landing.html', admin, { slug: SLUG, mode: 'live', post: '/api/lp/x/order', geo: '/api/lp/geo/', imgBase: '/api/lp/img/' });
  assert.match(r.html, /^<!doctype html><html lang="ar" dir="rtl">/);
  assert.ok(r.html.includes('--c:#db2777'));
  assert.ok(r.html.includes('9950.00 دج'));
  assert.ok(r.html.includes('<li>خفيفة</li>'));
  assert.ok(r.html.includes('اطلب الآن'));
  assert.ok(Buffer.byteLength(r.html) < 30_000, `page is ${Buffer.byteLength(r.html)} bytes`);
  assert.ok(!/<script src=/.test(r.html), 'no external script');
});

test('search engines: a description, its own address and share tags on the real page; the previews are not indexed', async () => {
  const live: any = await call('landing.html', admin, { slug: SLUG, mode: 'live', post: `https://shop.example/api/lp/${SLUG}/order`, geo: '/g/', imgBase: 'https://shop.example/api/lp/img/' });
  assert.ok(live.html.includes('<meta name="description" content="خفيفة قابلة للطي">'));
  assert.ok(live.html.includes(`<link rel="canonical" href="https://shop.example/api/lp/${SLUG}">`));
  assert.ok(live.html.includes('<meta property="og:title" content="عربة أطفال">'));
  assert.ok(!live.html.includes('noindex'));
  const preview: any = await call('landing.html', admin, { slug: SLUG, mode: 'preview', geo: '/g/', imgBase: null });
  assert.ok(preview.html.includes('<meta name="robots" content="noindex">'));
  assert.ok(!preview.html.includes('canonical') && !preview.html.includes('og:title'));
});

test('a normal customer becomes a new order, at the page price', async () => {
  const input = await human();
  assert.deepEqual(await call('landing.submit', admin, input), { ok: true });
  const o = (await db.query(`SELECT o.*, i.unit_price, i.variant_id FROM orders o JOIN order_items i ON i.order_id = o.id WHERE o.phone = $1`, [input.phone]))[0];
  assert.ok(o, 'order created');
  assert.equal(o.conf_status, 'new');
  assert.equal(o.source, `Landing · ${SLUG}`);
  assert.equal(Number(o.unit_price), 9950);
  assert.equal(Number(o.variant_id), variantId);
});

test('a bot gets the same answer, but no order: it waits in « Commandes bloquées » with its reasons', async () => {
  const input = { ...(await human()), hp: 'http://spam', pw: '', t: 400, ki: 0, meta: { ip: '1.2.3.4', ua: 'python-requests/2.31' } };
  assert.deepEqual(await call('landing.submit', admin, input), { ok: true });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM orders WHERE phone = $1', [input.phone]))[0].n, 0);
  const list: any = await call('landing.blocked', admin, { status: 'blocked' });
  const b = list.rows.find((r: any) => r.phone === input.phone);
  assert.ok(b, 'listed as blocked');
  assert.equal(b.score, 100);
  for (const code of ['honeypot', 'ua_bot', 'pow_missing']) assert.ok(b.reasons.some((x: any) => x.code === code), code);
});

test('the same challenge cannot be used twice, and a too-fast order counts against it', async () => {
  const a = await human();
  await call('landing.submit', admin, a);
  const again = { ...a, phone: '0770112233', did: 'other' };
  await call('landing.submit', admin, again);
  const s = (await db.query(`SELECT verdict, score FROM landing_submits WHERE phone = '0770112233'`))[0];
  assert.ok(Number(s.score) >= 40, `replayed challenge scored ${s.score}`);
});

test('a blacklisted number alone is put to review; with one more signal it is blocked, and restoring makes a real order', async () => {
  const phone = '0550998877';
  await db.query(`INSERT INTO customers (phone, name, blacklisted, blacklist_reason) VALUES ($1, 'X', true, 'test') ON CONFLICT (phone) DO UPDATE SET blacklisted = true`, [phone]);
  await call('landing.submit', admin, await human({}, phone));
  assert.equal((await db.query('SELECT conf_status FROM orders WHERE phone = $1', [phone]))[0]?.conf_status, 'to_check');
  const fast = await human({}, phone);
  const ch = await makeChallenge(db, SLUG, Date.now() - 1500); // sent 1.5 s after the page opened
  await call('landing.submit', admin, { ...fast, ch, pw: solve(ch) });
  const b = (await db.query(`SELECT id, status FROM landing_blocked WHERE phone = $1 ORDER BY id DESC`, [phone]))[0];
  assert.equal(b?.status, 'blocked');
  const r: any = await call('landing.restore', await as(EMAILS.conf), { id: Number(b.id) }); // a confirmation agent may restore
  assert.ok(r.orderId);
  const o = (await db.query('SELECT conf_status, internal_note FROM orders WHERE id = $1', [r.orderId]))[0];
  assert.match(o.internal_note, /Restaurée/);
  await assert.rejects(call('landing.restore', admin, { id: Number(b.id) }));
});

test('a second order of the same product the same day still goes to « Nouvelle », with the warning in its note', async () => {
  const phone = '0661445566';
  await call('landing.submit', admin, await human({}, phone));
  await call('landing.submit', admin, await human({}, phone));
  const rows = await db.query(`SELECT conf_status, internal_note, channel, landing_id FROM orders WHERE phone = $1 ORDER BY id`, [phone]);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].conf_status, 'new');
  assert.match(rows[1].internal_note, /score anti-fraude/);
  assert.equal(rows[1].channel, 'landing');
  assert.ok(rows[1].landing_id);
});

test('signals: names, phones and the weighted score', () => {
  assert.deepEqual(nameSignals('Mohamed Amine Benali'), []);
  assert.deepEqual(nameSignals('محمد بن علي'), []);
  assert.ok(nameSignals('aaaaaa').some((r) => r.code === 'name_repeat'));
  assert.ok(nameSignals('qwerty').some((r) => r.code === 'name_keyboard'));
  assert.ok(nameSignals('xkcdfgh').some((r) => r.code === 'name_gibberish'));
  assert.ok(nameSignals('Ali 123').some((r) => r.code === 'name_digits'));
  assert.deepEqual(phoneSignals('0661234590'), []);
  assert.ok(phoneSignals('0555555555').length > 0);
  assert.ok(phoneSignals('0512345678').some((r) => r.code === 'phone_sequence'));
  const base: FraudFacts = {
    name: 'Amina Benali', phoneRaw: '0661445566', phone: '0661445566', qty: 1, honeypot: '', servedMs: 30_000, clientMs: 30_000, inputs: 30, pow: 'ok', userAgent: UA, webdriver: false,
    recent: { phone24h: 0, phoneSameProduct24h: 0, ip10m: 0, ip1h: 0, device1h: 0 }, history: { blacklisted: false, orders: 0, delivered: 0, returned: 0, cancelled: 0 }, ipCountry: null, ipWilaya: null, wilayaId: 16,
  };
  assert.equal(scoreOrder(base).verdict, 'allow');
  assert.equal(scoreOrder(base).score, 0);
  // an IP from another wilaya alone never blocks
  assert.equal(scoreOrder({ ...base, ipWilaya: 31 }).verdict, 'allow');
  // a customer who refuses parcels: review, and blocked when strict
  const refuser = { ...base, history: { blacklisted: false, orders: 3, delivered: 0, returned: 2, cancelled: 1 } };
  assert.equal(scoreOrder(refuser).verdict, 'allow');
  assert.equal(scoreOrder({ ...refuser, servedMs: 5000 }).verdict, 'review');
  assert.equal(scoreOrder({ ...refuser, servedMs: 5000, inputs: 0 }, 'strict').verdict, 'block');
  assert.equal(scoreOrder({ ...base, userAgent: 'Mozilla/5.0 HeadlessChrome/120' }).verdict, 'review');
  assert.equal(scoreOrder({ ...base, userAgent: 'Mozilla/5.0 HeadlessChrome/120', webdriver: true }).verdict, 'block');
});
