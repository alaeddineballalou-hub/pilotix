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

const SURNAMES = ['Benali', 'Haddad', 'Mansouri', 'Belkacem', 'Saidi', 'Bouzid', 'Cherif', 'Djebbar', 'Ferhat', 'Hamidi', 'Kaci', 'Larbi', 'Meziane', 'Nouri', 'Ouali', 'Rahmani', 'Slimani', 'Taleb', 'Yahiaoui', 'Zerrouki', 'Amrani', 'Benaissa', 'Brahimi', 'Chaoui', 'Derradji', 'Guerfi', 'Hadjadj', 'Khelifi', 'Lounes', 'Mebarki'];
/** a different family name each time: the same full name sent with many numbers is a signal of its own */
let nameSeq = 0;
const custName = () => `Amina ${SURNAMES[nameSeq++ % SURNAMES.length]}`;
const solve = (ch: string) => {
  for (let n = 0; ; n++) if (zeroBits(sha256Hex(`${ch}:${n}`)) >= LANDING_POW_BITS) return String(n);
};

/** what the page sends, as a person would: the page served 25 s earlier, the challenge solved, typed by hand */
async function human(over: Record<string, unknown> = {}, phone = `0661${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`) {
  const t0 = Date.now() - 25_000;
  const ch = await makeChallenge(db, SLUG, t0);
  return { slug: SLUG, name: custName(), phone, wilaya: 16, commune: 'Hydra', variant: variantId, qty: 1, hp: '', ch, pw: solve(ch), t: 25_000, ki: 40, wd: false, fp: `fp${Math.random().toString(36).slice(2, 14)}`, did: `d${Math.random()}`, meta: { ip: `10.0.0.${Math.floor(Math.random() * 250)}`, ua: UA }, ...over };
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

test('llms.txt: a title, then a link to every live page with its price', async () => {
  const r: any = await call('landing.llms', admin, { site: 'https://shop.example' });
  assert.match(r.text, /^# \S/);
  const { store }: any = await call('landing.store', admin, {});
  assert.ok(r.text.includes(`- [عربة أطفال](https://shop.example/${store}/${SLUG}): 9950.00 دج — خفيفة قابلة للطي`));
});

test('page address: site/<store>/<page>, the store from the shop name or chosen in Réglages, reserved names refused', async () => {
  const mk = await as(EMAILS.marketer);
  const base = { pixelId: '', testEventCode: '', purchaseAt: 'confirmed', abandonAfterMin: 20, autoCreate: false };
  const before: any = await call('landing.store', admin, {});
  assert.match(before.store, /^[a-z0-9-]{2,40}$/);
  await call('landing.settings.save', mk, { ...base, storeSlug: 'Ma-Boutique' });
  assert.deepEqual(await call('landing.store', admin, {}), { store: 'ma-boutique' });
  const r: any = await call('landing.html', admin, { slug: SLUG, mode: 'live', post: '/o', geo: '/g/', imgBase: null, site: 'https://shop.example' });
  assert.ok(r.html.includes(`<link rel="canonical" href="https://shop.example/ma-boutique/${SLUG}">`));
  await assert.rejects(call('landing.settings.save', mk, { ...base, storeSlug: 'api' }), /réservé/);
  await assert.rejects(call('landing.settings.save', mk, { ...base, storeSlug: 'ma boutique!' }), /lettres latines/);
  await call('landing.settings.save', mk, { ...base, storeSlug: '' });
  assert.deepEqual(await call('landing.store', admin, {}), before);
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

test('the same product sent again within 48 h, still to call: one order, the change written on it for the agent', async () => {
  const phone = '0661445566';
  await call('landing.submit', admin, await human({}, phone));
  await call('landing.submit', admin, await human({ qty: 2 }, phone));
  const rows = await db.query(`SELECT conf_status, internal_note, channel, landing_id FROM orders WHERE phone = $1 ORDER BY id`, [phone]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].conf_status, 'new');
  assert.match(rows[0].internal_note, /renvoyé la commande.*quantité 2/);
  assert.equal(rows[0].channel, 'landing');
  const s = await db.query(`SELECT merged FROM landing_submits WHERE phone = $1 ORDER BY id`, [phone]);
  assert.deepEqual(s.map((r: any) => r.merged), [false, true]);
  // once confirmed, a new one is a new order again (with the warning)
  await db.query(`UPDATE orders SET conf_status = 'confirmed' WHERE phone = $1`, [phone]);
  await call('landing.submit', admin, await human({}, phone));
  const after = await db.query(`SELECT internal_note FROM orders WHERE phone = $1 ORDER BY id`, [phone]);
  assert.equal(after.length, 2);
  assert.match(after[1].internal_note, /score anti-fraude/);
});

test('a competitor: one device sending a third number in an hour is blocked; a device agents marked « concurrent » too', async () => {
  const did = `team${Math.random()}`;
  const phones = ['0771203040', '0662918273', '0553746152'];
  for (const p of phones) await call('landing.submit', admin, await human({ did }, p));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM orders WHERE phone = ANY($1)', [phones.slice(0, 2)]))[0].n, 2);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM orders WHERE phone = $1', [phones[2]]))[0].n, 0);
  const b = (await db.query(`SELECT reasons FROM landing_blocked WHERE phone = $1`, [phones[2]]))[0];
  assert.ok(b.reasons.some((r: any) => r.code === 'device_numbers'));
  // an agent marks an order of another device « 🕵️ Concurrent »: that device's next order is blocked
  const did2 = `cmp${Math.random()}`;
  await call('landing.submit', admin, await human({ did: did2 }, '0661900111'));
  const o = (await db.query(`SELECT id FROM orders WHERE phone = '0661900111'`))[0];
  await call('orders.setConf', await as(EMAILS.conf), { ids: [Number(o.id)], status: 'fake', reason: '🕵️ Concurrent' });
  assert.equal((await db.query(`SELECT reason FROM fraud_marks WHERE order_id = $1`, [o.id]))[0]?.reason, 'competitor');
  await call('landing.submit', admin, await human({ did: did2 }, '0661900222'));
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM orders WHERE phone = '0661900222'`))[0].n, 0);
  const p: any = await call('landing.protection', admin, { days: 7 });
  assert.ok(p.totals.blocked >= 2);
  assert.ok(p.marks.some((m: any) => m.reason === 'competitor'));
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
    name: custName(), phoneRaw: '0661445566', phone: '0661445566', qty: 1, honeypot: '', servedMs: 30_000, clientMs: 30_000, inputs: 30, pow: 'ok', userAgent: UA, webdriver: false,
    recent: { phone24h: 0, phoneSameProduct24h: 0, ip10m: 0, ip1h: 0, device1h: 0 }, history: { blacklisted: false, orders: 0, delivered: 0, returned: 0, cancelled: 0 }, ipCountry: null, ipWilaya: null, wilayaId: 16,
  };
  assert.equal(scoreOrder(base).verdict, 'allow');
  assert.equal(scoreOrder(base).score, 0);
  // an IP from another wilaya alone never blocks
  assert.equal(scoreOrder({ ...base, ipWilaya: 31 }).verdict, 'allow');
  // a customer who refuses parcels: review, and blocked when strict
  const refuser = { ...base, history: { blacklisted: false, orders: 3, delivered: 0, returned: 2, cancelled: 1 } };
  assert.equal(scoreOrder(refuser).verdict, 'review');
  assert.equal(scoreOrder({ ...refuser, servedMs: 5000 }).verdict, 'review');
  assert.equal(scoreOrder({ ...refuser, servedMs: 5000, inputs: 0 }, 'strict').verdict, 'block');
  assert.equal(scoreOrder({ ...base, userAgent: 'Mozilla/5.0 HeadlessChrome/120' }).verdict, 'review');
  assert.equal(scoreOrder({ ...base, userAgent: 'Mozilla/5.0 HeadlessChrome/120', webdriver: true }).verdict, 'block');
  // a customer who already received and paid is not blocked by soft signals, only by a certain one
  const good = { ...base, history: { blacklisted: false, orders: 2, delivered: 2, returned: 0, cancelled: 0 } };
  assert.equal(scoreOrder({ ...good, qty: 12, ipCountry: 'FR', servedMs: 5000 }).verdict, 'allow');
  assert.equal(scoreOrder({ ...good, honeypot: 'x' }).verdict, 'block');
  // the competitor's hands: 3 numbers in an hour from one device; numbers in a row; one name for many numbers
  assert.equal(scoreOrder({ ...base, recent: { ...base.recent, deviceNumbers1h: 2, deviceNumbers24h: 2 } }).verdict, 'block');
  assert.equal(scoreOrder({ ...base, recent: { ...base.recent, deviceNumbers24h: 1 } }).verdict, 'allow'); // a family: two numbers
  assert.equal(scoreOrder({ ...base, recent: { ...base.recent, nearPhones24h: 2 } }).verdict, 'review');
  assert.equal(scoreOrder({ ...base, recent: { ...base.recent, nameOtherPhones7d: 2 } }).verdict, 'review');
  assert.equal(scoreOrder({ ...base, marks: { competitor: true, fake30d: 0 } }).verdict, 'block');
  assert.equal(scoreOrder({ ...base, marks: { competitor: false, fake30d: 1 } }).verdict, 'review');
  assert.equal(scoreOrder({ ...base, marks: { competitor: false, fake30d: 2 } }).verdict, 'block');
  // how they used the page: a phone with no touch screen is a mask; reading the page from an ad is a good sign
  const seen = { scroll: 60, pasted: false, tz: 'Africa/Algiers', touch: 5, fromAd: true };
  assert.equal(scoreOrder({ ...base, clientMs: 50_000, behavior: seen }).score, 0);
  assert.equal(scoreOrder({ ...base, clientMs: 9_000, behavior: { ...seen, scroll: 0, pasted: true, touch: 0, fromAd: false } }).verdict, 'review');
});

test('Protection: the buyers’ quality day by day, and each ad with its real buyers against the period before', async () => {
  const c = (await db.query(`INSERT INTO customers (phone, name, wilaya_id) VALUES ('0770123400', 'Client Pub', 16) ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name RETURNING id`))[0];
  const order = async (conf: string, follow: string | null = null) =>
    Number(
      (
        await db.query(
          `INSERT INTO orders (ref, customer_id, customer_name, phone, wilaya_id, commune, conf_status, follow_status, subtotal, delivery_fee, discount, total, channel)
           VALUES ('Q' || nextval('order_ref_seq'), $1, 'Client Pub', '0770123400', 16, 'Kouba', $2, $3, 1000, 0, 0, 1000, 'landing') RETURNING id`,
          [c.id, conf, follow],
        )
      )[0].id,
    );
  const submit = (verdict: string, daysAgo: number, orderId: number | null, merged = false) =>
    db.query(`INSERT INTO landing_submits (verdict, score, reasons, at, order_id, merged, utm) VALUES ($1, 0, '[]', $2, $3, $4, $5)`, [
      verdict,
      new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
      orderId,
      merged,
      JSON.stringify({ utm_source: 'facebook', utm_campaign: 'Bébé · Test', adset_id: 'qtest-adset' }),
    ]);
  await db.query(`INSERT INTO adsets (id, name, campaign) VALUES ('qtest-adset', 'Mamans Alger', 'Bébé · Test') ON CONFLICT (id) DO NOTHING`);
  // 5 days ago, from the ad set: 2 real (confirmed, delivered), 1 fake for the agent, 1 blocked, the first one sent again
  const first = await order('confirmed');
  await submit('allow', 5, first);
  await submit('allow', 5, first, true);
  await submit('allow', 5, await order('confirmed', 'delivered'));
  await submit('review', 5, await order('fake'));
  await submit('block', 5, null);
  // yesterday (not finished: agents still confirming) and 40 days ago (the period before)
  await submit('allow', 1, await order('new'));
  await submit('allow', 40, await order('confirmed'));

  const p: any = await call('landing.protection', admin, { days: 30 });
  assert.equal(p.quality.days.length, 30);
  assert.equal(p.quality.days[29].day, p.quality.today);
  const ad = p.ads.find((a: any) => a.key === 'qtest-adset');
  assert.ok(ad, 'the ad set is listed');
  // 6 orders this period; on the finished days: 4 buyers (one sent twice), 2 real, 2 fake; before: 1 buyer, real
  assert.deepEqual([ad.name, ad.campaign, ad.orders, ad.buyers, ad.good, ad.bad], ['Mamans Alger', 'Bébé · Test', 6, 4, 2, 2]);
  assert.deepEqual(ad.prev, { buyers: 1, good: 1, bad: 0 });
  // the day itself, in the quality line
  const d5 = p.quality.days[24];
  assert.ok(d5.buyers >= 4 && d5.good >= 2 && d5.bad >= 2);
  assert.ok(p.quality.previous && p.quality.previous.buyers >= 1);
});
