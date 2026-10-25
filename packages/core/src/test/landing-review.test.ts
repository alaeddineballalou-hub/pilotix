// The cases an independent review found (each one reproduced first): duplicate orders around abandoned orders, the
// lead path and the fake-order check, stock of products without variants, Meta events that must not be lost or
// refused, and the « Abandonnées » tabs.
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
let variantId: number;
let plainProduct: number;
const SLUG = 'review-test';
const PLAIN = 'review-plain';
const UA = 'Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const at = (ctx: Ctx, ms: number): Ctx => ({ ...ctx, now: () => ms });
const MIN = 60_000;

before(async () => {
  const s = await setup(150);
  db = s.db;
  as = s.as;
  admin = await s.as(EMAILS.admin);
  const p = (await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id WHERE p.sku = 'PX-POU' AND v.title <> '' ORDER BY v.id LIMIT 1`))[0];
  productId = Number(p.id);
  variantId = Number(p.vid);
  plainProduct = Number((await db.query(`SELECT id FROM products WHERE sku = 'PX-TAP'`))[0].id);
  const mk = await s.as(EMAILS.marketer);
  await call('landing.save', mk, { productId, slug: SLUG, title: 'R', price: 9950, pixelId: '111122223333444' });
  await call('landing.save', mk, { productId: plainProduct, slug: PLAIN, title: 'P', pixelId: '111122223333444' });
});

const solve = (ch: string) => {
  for (let n = 0; ; n++) if (zeroBits(sha256Hex(`${ch}:${n}`)) >= LANDING_POW_BITS) return String(n);
};
const rndPhone = () => `066${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
async function form(over: Record<string, unknown> = {}, slug = SLUG, t0 = Date.now()) {
  const ch = await makeChallenge(db, slug, t0 - 25_000);
  return { slug, name: 'Amina Benali', phone: rndPhone(), wilaya: 16, commune: 'Hydra', variant: slug === SLUG ? variantId : null, qty: 1, hp: '', ch, pw: solve(ch), t: 25_000, ki: 40, wd: false, fp: 'x', did: `d${Math.random()}`, vid: `v${Math.random().toString(36).slice(2, 9)}`, meta: { ip: `10.2.0.${Math.floor(Math.random() * 250)}`, ua: UA }, ...over };
}
const orders = async (phone: string) => db.query(`SELECT * FROM orders WHERE phone = $1 ORDER BY id`, [phone]);

test('« Abandonnées »: every tab answers, with and without a search', async () => {
  const conf = await as(EMAILS.conf);
  for (const status of ['abandoned', 'converted', 'dismissed', 'all'] as const) {
    await call('landing.leads', conf, { status });
    await call('landing.leads', conf, { status, q: 'Amina' });
  }
});

test('a customer who ordered and comes back (or whose lead arrives late) gets no second, silent order', async () => {
  const t0 = Date.now();
  const f = await form();
  await call('landing.submit', at(admin, t0), f);
  await call('landing.capture', at(admin, t0 + 5_000), f); // the 3G lead after the order
  await call('landing.capture', at(admin, t0 + 3600_000), { ...f, vid: 'later' }); // back an hour later, autofill
  await call('landing.run', at(admin, t0 + 2 * 3600_000), {});
  assert.equal((await orders(f.phone as string)).length, 1);
});

test('a lead needs the page’s challenge; a number blocked as fake is not kept; a fake lead goes to « Commandes bloquées », not Commandes', async () => {
  const t0 = Date.now();
  const bare = await form({ ch: '' });
  await call('landing.capture', at(admin, t0), bare);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM landing_leads WHERE phone = $1`, [bare.phone]))[0].n, 0);
  const blocked = await form({ hp: 'x' });
  await call('landing.submit', at(admin, t0), blocked);
  await call('landing.capture', at(admin, t0 + 1000), { ...blocked, hp: '' });
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM landing_leads WHERE phone = $1 AND status = 'open'`, [blocked.phone]))[0].n, 0);
  // a scripted lead that looks fake (keyboard name, repeated digits, 9 pieces)
  const fake = await form({ name: 'asdfgh qwerty', phone: '0555555555', qty: 9 });
  await call('landing.capture', at(admin, t0), fake);
  await call('landing.run', at(admin, t0 + 25 * MIN), {});
  assert.equal((await orders('0555555555')).length, 0, 'no order');
  const b = (await db.query(`SELECT reasons FROM landing_blocked WHERE phone = '0555555555' ORDER BY id DESC`))[0];
  assert.ok(b, 'in « Commandes bloquées »');
});

test('an abandoned order of a product without variants keeps its stock variant (reserved and shipped like the others)', async () => {
  const t0 = Date.now();
  const f = await form({}, PLAIN, t0);
  await call('landing.capture', at(admin, t0), f);
  await call('landing.run', at(admin, t0 + 25 * MIN), {});
  const o = (await orders(f.phone as string))[0];
  const item = (await db.query(`SELECT variant_id FROM order_items WHERE order_id = $1`, [o.id]))[0];
  const plain = (await db.query(`SELECT id FROM product_variants WHERE product_id = $1 AND title = ''`, [plainProduct]))[0];
  assert.equal(Number(item.variant_id), Number(plain.id));
});

test('the page left open: Pilotix adds the order, then the customer validates → one live order, the other cancelled as a duplicate', async () => {
  const t0 = Date.now();
  const f = await form({}, SLUG, t0);
  await call('landing.capture', at(admin, t0), f);
  await call('landing.run', at(admin, t0 + 25 * MIN), {});
  assert.equal((await orders(f.phone as string)).length, 1);
  const late = await form({ phone: f.phone, vid: f.vid, did: f.did }, SLUG, t0 + 26 * MIN);
  await call('landing.submit', at(admin, t0 + 26 * MIN), late);
  const os = await orders(f.phone as string);
  assert.equal(os.length, 2);
  assert.deepEqual(os.map((o: any) => o.conf_status), ['duplicate', 'new']);
  assert.doesNotMatch(os[1].internal_note ?? '', /anti-fraude/, 'the customer’s own order is not marked as a duplicate of Pilotix’s');
});

test('a corrected digit updates the same lead: no abandoned order for a stranger’s number', async () => {
  const t0 = Date.now();
  const f = await form({}, SLUG, t0);
  const typo = String(f.phone).slice(0, 9) + ((Number(String(f.phone).slice(-1)) + 1) % 10);
  await call('landing.capture', at(admin, t0), { ...f, phone: typo });
  await call('landing.capture', at(admin, t0 + 2000), f);
  await call('landing.submit', at(admin, t0 + 4000), f);
  await call('landing.run', at(admin, t0 + 40 * MIN), {});
  assert.equal((await orders(typo)).length, 0);
  assert.equal((await orders(f.phone as string)).length, 1);
});

test('two clicks on « Ajouter aux commandes » (or a click racing the job) make one order', async () => {
  const t0 = Date.now() - 30 * MIN;
  const f = await form({}, SLUG, t0);
  await call('landing.capture', at(admin, t0), f);
  const lead = (await db.query(`SELECT id FROM landing_leads WHERE phone = $1`, [f.phone]))[0];
  const conf = await as(EMAILS.conf);
  const r = await Promise.allSettled([call('landing.convertLead', conf, { id: Number(lead.id) }), call('landing.convertLead', conf, { id: Number(lead.id) }), call('landing.run', admin, {})]);
  assert.ok(r.some((x) => x.status === 'fulfilled'));
  assert.equal((await orders(f.phone as string)).length, 1);
});

test('« Compléter »: a lead without wilaya becomes a silent order once the agent gives it', async () => {
  const t0 = Date.now() - 30 * MIN;
  const f = await form({ wilaya: 0, commune: '' }, SLUG, t0);
  await call('landing.capture', at(admin, t0), f);
  await call('landing.run', admin, {});
  const lead = (await db.query(`SELECT id, status, note FROM landing_leads WHERE phone = $1`, [f.phone]))[0];
  assert.equal(lead.status, 'abandoned');
  assert.match(lead.note, /Wilaya/);
  const before = (await call('landing.leads', admin, { status: 'all', page: 1, pageSize: 10 })) as any;
  const r: any = await call('landing.convertLead', await as(EMAILS.conf), { id: Number(lead.id), wilayaId: 31, commune: 'Oran' });
  // added by an agent: not a customer who came back
  const after = (await call('landing.leads', admin, { status: 'all', page: 1, pageSize: 10 })) as any;
  assert.equal(after.stats.recovered, before.stats.recovered);
  assert.equal(after.stats.converted, before.stats.converted + 1);
  const o = (await db.query(`SELECT * FROM orders WHERE id = $1`, [r.orderId]))[0];
  assert.equal(Number(o.wilaya_id), 31);
  assert.equal(o.channel, 'landing');
  assert.ok(o.landing_id);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM notifications WHERE order_id = $1`, [o.id]))[0].n, 0, 'no message');
});

test('Meta: the Purchase of an abandoned order carries the browser it came from; without a token events wait, then leave', async () => {
  const sent: any[] = [];
  const server: Ctx['server'] = { courier: async () => ({}), hashPassword: async (p) => p, meta: async (_a: string, args: any) => (sent.push(args), { received: args.events.length }) };
  await db.query(`DELETE FROM settings WHERE key IN ('secret_landing_capi_token', 'secret_meta_token')`);
  await db.query(`UPDATE meta_events SET status = 'skipped' WHERE status IN ('queued','sending')`);
  const t0 = Date.now() - 30 * MIN;
  const f = await form({}, SLUG, t0);
  await call('landing.capture', at(admin, t0), f);
  await call('landing.run', admin, {});
  const o = (await orders(f.phone as string))[0];
  await call('orders.setConf', await as(EMAILS.conf), { ids: [Number(o.id)], status: 'confirmed' });
  const sys = await as(EMAILS.admin, server);
  await call('landing.run', sys, {});
  let ev = (await db.query(`SELECT * FROM meta_events WHERE order_id = $1`, [o.id]))[0];
  assert.equal(ev.status, 'queued', 'waiting for a token, not failed');
  assert.match(ev.error, /Jeton/);
  await call('landing.settings.save', admin, { pixelId: '', testEventCode: '', purchaseAt: 'confirmed', abandonAfterMin: 20, autoCreate: false, capiToken: 'EAAnew' });
  await call('landing.run', sys, {});
  ev = (await db.query(`SELECT * FROM meta_events WHERE order_id = $1`, [o.id]))[0];
  assert.equal(ev.status, 'sent');
  const purchase = sent.flatMap((x) => x.events).find((e: any) => e.event_id === `purchase-${o.ref}`);
  assert.equal(purchase.action_source, 'website');
  assert.equal(purchase.user_data.client_user_agent, UA);
});

test('Meta: an event Meta refuses does not take the others down with it', async () => {
  const server: Ctx['server'] = {
    courier: async () => ({}),
    hashPassword: async (p) => p,
    meta: async (_a: string, args: any) => {
      if (args.events.some((e: any) => e.custom_data?.value === 1)) throw new Error('Meta : Invalid parameter');
      return { received: args.events.length };
    },
  };
  const conf = await as(EMAILS.conf);
  const good = await form();
  const bad = await form();
  await call('landing.submit', admin, good);
  await call('landing.submit', admin, bad);
  const [g, b] = [(await orders(good.phone as string))[0], (await orders(bad.phone as string))[0]];
  await call('orders.setConf', conf, { ids: [Number(g.id), Number(b.id)], status: 'confirmed' });
  await db.query(`UPDATE orders SET total = 1 WHERE id = $1`, [b.id]);
  await call('landing.run', await as(EMAILS.admin, server), {});
  const st = async (id: number) => (await db.query(`SELECT status, attempts FROM meta_events WHERE order_id = $1`, [id]))[0];
  assert.equal((await st(Number(g.id))).status, 'sent');
  const x = await st(Number(b.id));
  assert.equal(x.status, 'queued');
  assert.equal(Number(x.attempts), 1);
});

test('« at order » mode: a borderline order counts once an agent confirms it', async () => {
  await call('landing.settings.save', admin, { pixelId: '', testEventCode: '', purchaseAt: 'order', abandonAfterMin: 20, autoCreate: false, capiToken: '' });
  const f = await form();
  await call('landing.submit', admin, f);
  await call('landing.submit', admin, await form({ phone: f.phone }));
  const second = (await orders(f.phone as string))[1];
  assert.match(second.internal_note, /anti-fraude/);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM meta_events WHERE order_id = $1`, [second.id]))[0].n, 0);
  await call('orders.setConf', await as(EMAILS.conf), { ids: [Number(second.id)], status: 'confirmed' });
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM meta_events WHERE order_id = $1 AND event_name = 'Purchase'`, [second.id]))[0].n, 1);
  await call('landing.settings.save', admin, { pixelId: '', testEventCode: '', purchaseAt: 'confirmed', abandonAfterMin: 20, autoCreate: false, capiToken: '' });
});
