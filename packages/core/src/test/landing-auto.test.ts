// Landing pages linked to the rest of Pilotix: orders go straight to « Nouvelle » (channel Landing, UTM, ad set),
// abandoned orders become orders by themselves, products without a page are flagged and made in one click, and Meta
// hears about real sales only (Conversions API outbox): never a blocked or fake order.
import { sha256Hex, zeroBits } from '@pilotix/shared';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { LANDING_POW_BITS, makeChallenge } from '../modules/landing';
import { EMAILS, setup } from './harness';

let db: Db;
let admin: Ctx;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
let productId: number;
let variants: { id: number }[];
const SLUG = 'auto-test';
const PIXEL = '998877665544332';
const UA = 'Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const at = (ctx: Ctx, ms: number): Ctx => ({ ...ctx, now: () => ms });

before(async () => {
  const s = await setup(200);
  db = s.db;
  as = s.as;
  admin = await s.as(EMAILS.admin);
  const p = (await db.query(`SELECT id FROM products WHERE sku = 'PX-POU'`))[0];
  productId = Number(p.id);
  variants = (await db.query(`SELECT id FROM product_variants WHERE product_id = $1 AND title <> '' ORDER BY id`, [productId])).map((r: any) => ({ id: Number(r.id) }));
  await call('landing.save', await s.as(EMAILS.marketer), { productId, slug: SLUG, title: 'Test', price: 9950, pixelId: PIXEL });
  await call('landing.settings.save', admin, { pixelId: '', testEventCode: '', purchaseAt: 'confirmed', abandonAfterMin: 20, autoCreate: false, capiToken: 'EAAtest' });
});

const solve = (ch: string) => {
  for (let n = 0; ; n++) if (zeroBits(sha256Hex(`${ch}:${n}`)) >= LANDING_POW_BITS) return String(n);
};
const rndPhone = () => `066${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
async function human(over: Record<string, unknown> = {}, phone = rndPhone()) {
  const ch = await makeChallenge(db, SLUG, Date.now() - 25_000);
  return { slug: SLUG, name: 'Amina Benali', phone, wilaya: 16, commune: 'Hydra', variant: variants[0].id, qty: 1, hp: '', ch, pw: solve(ch), t: 25_000, ki: 40, wd: false, fp: 'x', did: `d${Math.random()}`, vid: `v${Math.random().toString(36).slice(2, 8)}`, meta: { ip: `10.1.0.${Math.floor(Math.random() * 250)}`, ua: UA }, ...over };
}
const orderOf = async (phone: string) => (await db.query(`SELECT * FROM orders WHERE phone = $1 ORDER BY id DESC`, [phone]))[0];
const events = async (where: string, params: unknown[]) => db.query(`SELECT * FROM meta_events WHERE ${where} ORDER BY id`, params);

test('an order goes straight to « Nouvelle » as a Landing order, with its ad link (UTM, ad set) and the variant’s own price', async () => {
  const v = variants[1].id;
  await db.query(`UPDATE product_variants SET price = 10500 WHERE id = $1`, [v]);
  await call('landing.save', admin, { id: Number((await db.query(`SELECT id FROM landing_pages WHERE slug = $1`, [SLUG]))[0].id), productId, slug: SLUG, title: 'Test', price: null, pixelId: PIXEL });
  const input = await human({ variant: v, utm: { utm_source: 'facebook', adset_id: '120210000000777', fbclid: 'abc', junk: 'x' } });
  await call('landing.submit', admin, input);
  const o = await orderOf(input.phone as string);
  assert.equal(o.conf_status, 'new');
  assert.equal(o.channel, 'landing');
  assert.ok(o.landing_id);
  assert.equal(o.adset_id, '120210000000777');
  assert.deepEqual(o.utm, { utm_source: 'facebook', adset_id: '120210000000777', fbclid: 'abc' });
  const item = (await db.query(`SELECT unit_price FROM order_items WHERE order_id = $1`, [o.id]))[0];
  assert.equal(Number(item.unit_price), 10500);
  await db.query(`UPDATE product_variants SET price = NULL WHERE id = $1`, [v]);
});

test('Meta: a Purchase only when an agent confirms a landing order (never at submit, never twice)', async () => {
  const input = await human();
  await call('landing.submit', admin, input);
  const o = await orderOf(input.phone as string);
  assert.equal((await events(`order_id = $1`, [o.id])).length, 0, 'nothing at submit with « at confirmation »');
  const conf = await as(EMAILS.conf);
  await call('orders.setConf', conf, { ids: [Number(o.id)], status: 'confirmed' });
  let ev = await events(`order_id = $1`, [o.id]);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].event_name, 'Purchase');
  assert.equal(ev[0].pixel_id, PIXEL);
  assert.equal(ev[0].event_id, `purchase-${o.ref}`);
  await call('orders.setConf', conf, { ids: [Number(o.id)], status: 'callback', nextCallAt: new Date(Date.now() + 3600_000).toISOString() });
  await call('orders.setConf', conf, { ids: [Number(o.id)], status: 'confirmed' });
  ev = await events(`order_id = $1`, [o.id]);
  assert.equal(ev.length, 1, 'once per order');
});

test('Meta: a blocked order is never a Purchase, even in « at order » mode; a borderline one waits for a person', async () => {
  await call('landing.settings.save', admin, { pixelId: '', testEventCode: '', purchaseAt: 'order', abandonAfterMin: 20, autoCreate: false, capiToken: '' });
  const bot = { ...(await human()), hp: 'spam', pw: '', meta: { ip: '1.2.3.4', ua: 'curl/8.0' } };
  await call('landing.submit', admin, bot);
  assert.equal((await events(`event_name = 'Purchase' AND order_id IN (SELECT id FROM orders WHERE phone = $1)`, [bot.phone])).length, 0);
  assert.equal(await orderOf(bot.phone as string), undefined);
  const clear = await human();
  await call('landing.submit', admin, clear);
  const o = await orderOf(clear.phone as string);
  assert.equal((await events(`order_id = $1`, [o.id])).length, 1, 'a clear order counts at once in « at order » mode');
  // the same number again the same day: borderline (duplicate) → no Purchase until confirmed
  await call('landing.submit', admin, await human({}, clear.phone as string));
  const o2 = await orderOf(clear.phone as string);
  assert.notEqual(o2.id, o.id);
  assert.match(o2.internal_note, /score anti-fraude/);
  assert.equal((await events(`order_id = $1`, [o2.id])).length, 0);
  await call('landing.settings.save', admin, { pixelId: '', testEventCode: '', purchaseAt: 'confirmed', abandonAfterMin: 20, autoCreate: false, capiToken: '' });
});

test('Meta: the outbox sends hashed customer data through the Conversions API, and skips an order marked fake meanwhile', async () => {
  const sent: any[] = [];
  const server: Ctx['server'] = { courier: async () => ({}), hashPassword: async (p) => p, meta: async (action: string, args: any) => (sent.push({ action, args }), { received: args.events.length }) };
  const real = await human();
  await call('landing.submit', admin, real);
  const fake = await human();
  await call('landing.submit', admin, fake);
  const conf = await as(EMAILS.conf);
  const [a, b] = [await orderOf(real.phone as string), await orderOf(fake.phone as string)];
  await call('orders.setConf', conf, { ids: [Number(a.id), Number(b.id)], status: 'confirmed' });
  // the agent finds out the second one is fake before the job runs
  await db.query(`UPDATE orders SET conf_status = 'fake' WHERE id = $1`, [b.id]);
  await db.query(`UPDATE meta_events SET status = 'sent' WHERE status = 'queued' AND order_id NOT IN ($1, $2)`, [a.id, b.id]);
  const sys = await as(EMAILS.admin, server);
  const r: any = await call('landing.run', sys, {});
  assert.ok(r.meta.sent >= 1);
  const purchase = sent.flatMap((x) => x.args.events).find((e: any) => e.event_id === `purchase-${a.ref}`);
  assert.ok(purchase, 'the real one was sent');
  assert.equal(sent[0].action, 'capi');
  assert.equal(sent[0].args.pixelId, PIXEL);
  assert.equal(sent[0].args.token, 'EAAtest');
  assert.deepEqual(purchase.user_data.ph, [sha256Hex(`213${String(real.phone).slice(1)}`)]);
  assert.equal(purchase.user_data.client_user_agent, UA);
  assert.equal(purchase.custom_data.currency, 'DZD');
  assert.ok(!sent.flatMap((x) => x.args.events).some((e: any) => e.event_id === `purchase-${b.ref}`), 'the fake one was not');
  const skipped = (await events(`order_id = $1`, [b.id]))[0];
  assert.equal(skipped.status, 'skipped');
  // the log shows both
  const log: any = await call('landing.events', await as(EMAILS.marketer), {});
  assert.ok(log.rows.some((x: any) => x.ref === a.ref && x.status === 'sent'));
  assert.ok(log.rows.some((x: any) => x.ref === b.ref && x.status === 'skipped'));
});

test('abandoned: a number typed without ordering becomes a « Nouvelle » order after the delay, with no message to the customer', async () => {
  const t0 = Date.now();
  const phone = rndPhone();
  const lead = { ...(await human({}, phone)), name: 'Sara Haddad' };
  await call('landing.capture', at(admin, t0), lead);
  await call('landing.capture', at(admin, t0 + 1000), { ...lead, qty: 2 });
  const rows = await db.query(`SELECT * FROM landing_leads WHERE phone = $1`, [phone]);
  assert.equal(rows.length, 1, 'one lead per number and page');
  assert.equal(rows[0].qty, 2);
  // InitiateCheckout queued for Meta, with the browser's event id
  const ic = await events(`lead_id = $1`, [rows[0].id]);
  assert.equal(ic[0].event_name, 'InitiateCheckout');
  assert.equal(ic[0].event_id, `ic-${lead.vid}`);
  // 10 minutes later: still open
  await call('landing.run', at(admin, t0 + 10 * 60_000), {});
  assert.equal(await orderOf(phone), undefined);
  // 25 minutes later: an order in « Nouvelle »
  await call('landing.run', at(admin, t0 + 25 * 60_000), {});
  const o = await orderOf(phone);
  assert.ok(o, 'order created');
  assert.equal(o.conf_status, 'new');
  assert.equal(o.channel, 'landing');
  assert.match(o.source, /abandonnée/);
  assert.match(o.internal_note, /Commande abandonnée/);
  assert.equal(Number((await db.query(`SELECT qty FROM order_items WHERE order_id = $1`, [o.id]))[0].qty), 2);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM notifications WHERE order_id = $1`, [o.id]))[0].n, 0, 'no message sent');
  const l = (await db.query(`SELECT status, auto_order, order_id FROM landing_leads WHERE phone = $1`, [phone]))[0];
  assert.deepEqual([l.status, l.auto_order, Number(l.order_id)], ['converted', true, Number(o.id)]);
  // run again: no second order
  await call('landing.run', at(admin, t0 + 40 * 60_000), {});
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM orders WHERE phone = $1`, [phone]))[0].n, 1);
});

test('abandoned: a customer who orders is not added twice; one without wilaya waits in the list; a bot is never kept', async () => {
  const t0 = Date.now();
  const phone = rndPhone();
  const lead = await human({}, phone);
  await call('landing.capture', at(admin, t0), lead);
  await call('landing.submit', admin, lead);
  await call('landing.run', at(admin, t0 + 60 * 60_000), {});
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM orders WHERE phone = $1`, [phone]))[0].n, 1);
  assert.equal((await db.query(`SELECT status FROM landing_leads WHERE phone = $1`, [phone]))[0].status, 'converted');

  const noWilaya = rndPhone();
  await call('landing.capture', at(admin, t0), { ...(await human({}, noWilaya)), wilaya: 0, commune: '' });
  await call('landing.run', at(admin, t0 + 60 * 60_000), {});
  assert.equal(await orderOf(noWilaya), undefined);
  const list: any = await call('landing.leads', at(await as(EMAILS.conf), t0 + 60 * 60_000), { status: 'abandoned' });
  assert.ok(list.rows.some((r: any) => r.phone === noWilaya));

  const bot = rndPhone();
  await call('landing.capture', admin, { ...(await human({}, bot)), meta: { ip: '9.9.9.9', ua: 'python-requests/2.31' } });
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM landing_leads WHERE phone = $1`, [bot]))[0].n, 0);

  // a lead whose submit turns out fake: blocked, its InitiateCheckout dropped
  const fake = rndPhone();
  const f = await human({}, fake);
  await call('landing.capture', admin, f);
  await call('landing.submit', admin, { ...f, hp: 'x' });
  assert.equal((await db.query(`SELECT status FROM landing_leads WHERE phone = $1`, [fake]))[0].status, 'blocked');
  const ic = (await db.query(`SELECT e.status FROM meta_events e JOIN landing_leads a ON a.id = e.lead_id WHERE a.phone = $1`, [fake]))[0];
  assert.equal(ic.status, 'skipped');
});

test('products without a page: counted for marketers, one-click page, set aside, and made automatically when asked', async () => {
  const mk = await as(EMAILS.marketer);
  const before = (await call('orders.counts', mk, {})) as any;
  assert.ok(before.landing.noPage >= 1);
  assert.equal(((await call('orders.counts', await as(EMAILS.depot), {})) as any).landing, undefined, 'not for the depot');
  const missing: any[] = (await call('landing.missing', mk, {})) as any;
  const target = missing[0];
  const r: any = await call('landing.quickCreate', mk, { productId: target.id });
  assert.ok(r.created);
  assert.match(r.page.slug, /^[a-z0-9-]+$/);
  const again: any = await call('landing.quickCreate', mk, { productId: target.id });
  assert.equal(again.id, r.id);
  assert.equal(again.created, false);
  assert.ok(!((await call('landing.missing', mk, {})) as any[]).some((p) => p.id === target.id));
  // an accessory: no alert for it
  const other = ((await call('landing.missing', mk, {})) as any[])[0];
  await call('landing.ignore', mk, { productId: other.id, on: true });
  assert.ok(!((await call('landing.missing', mk, {})) as any[]).some((p) => p.id === other.id));
  // automatic: a new product gets its page at once
  await call('landing.settings.save', admin, { pixelId: '', testEventCode: '', purchaseAt: 'confirmed', abandonAfterMin: 20, autoCreate: true, capiToken: '' });
  const prod: any = await call('catalog.saveProduct', await as(EMAILS.depot), { name: 'Veilleuse étoile', price: 2500, variants: [] });
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM landing_pages WHERE product_id = $1`, [prod.id]))[0].n, 1);
  const cov: any = await call('landing.coverage', await as(EMAILS.depot), {});
  assert.ok(cov.pages.some((x: any) => x.productId === prod.id));
});

test('stock: a sold-out variant is marked on the page (when asked), and still ordered if the page was open before', async () => {
  const pid = Number((await db.query(`SELECT id FROM landing_pages WHERE slug = $1`, [SLUG]))[0].id);
  await call('landing.save', admin, { id: pid, productId, slug: SLUG, title: 'Test', price: 9950, pixelId: PIXEL, stockMode: 'hide' });
  const v = variants[2].id;
  await db.query(`UPDATE stock SET qty = 0 WHERE variant_id = $1`, [v]);
  const html: any = await call('landing.html', admin, { slug: SLUG, mode: 'live', post: '/o', geo: '/g/', lead: '/l', imgBase: '/i/' });
  assert.match(html.html, new RegExp(`<option value="${v}" disabled>[^<]*نفذت الكمية`));
  assert.match(html.html, /"px":"998877665544332"/, 'the page carries its pixel');
  assert.match(html.html, /connect\.facebook\.net\/en_US\/fbevents\.js/);
  const preview: any = await call('landing.preview', admin, { slug: SLUG });
  assert.doesNotMatch(preview.html, /"px":"\d/, 'never a pixel inside Pilotix');
  const input = await human({ variant: v });
  await call('landing.submit', admin, input);
  assert.ok(await orderOf(input.phone as string), 'a customer who opened the page before is not treated as a bot');
});
