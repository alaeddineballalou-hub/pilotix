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

const SURNAMES = ['Benali', 'Haddad', 'Mansouri', 'Belkacem', 'Saidi', 'Bouzid', 'Cherif', 'Djebbar', 'Ferhat', 'Hamidi', 'Kaci', 'Larbi', 'Meziane', 'Nouri', 'Ouali', 'Rahmani', 'Slimani', 'Taleb', 'Yahiaoui', 'Zerrouki', 'Amrani', 'Benaissa', 'Brahimi', 'Chaoui', 'Derradji', 'Guerfi', 'Hadjadj', 'Khelifi', 'Lounes', 'Mebarki'];
/** a different family name each time: the same full name sent with many numbers is a signal of its own */
let nameSeq = 0;
const custName = () => `Amina ${SURNAMES[nameSeq++ % SURNAMES.length]}`;
const solve = (ch: string) => {
  for (let n = 0; ; n++) if (zeroBits(sha256Hex(`${ch}:${n}`)) >= LANDING_POW_BITS) return String(n);
};
const rndPhone = () => `066${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
async function form(over: Record<string, unknown> = {}, slug = SLUG, t0 = Date.now()) {
  const ch = await makeChallenge(db, slug, t0 - 25_000);
  return { slug, name: custName(), phone: rndPhone(), wilaya: 16, commune: 'Hydra', variant: slug === SLUG ? variantId : null, qty: 1, hp: '', ch, pw: solve(ch), t: 25_000, ki: 40, wd: false, fp: `fp${Math.random().toString(36).slice(2, 14)}`, did: `d${Math.random()}`, vid: `v${Math.random().toString(36).slice(2, 9)}`, meta: { ip: `10.2.0.${Math.floor(Math.random() * 250)}`, ua: UA }, ...over };
}
const orders = async (phone: string) => db.query(`SELECT * FROM orders WHERE phone = $1 ORDER BY id`, [phone]);
/** orders given to this agent (a confirmation agent works on her own orders) */
const giveTo = async (ctx: Ctx, ids: unknown[]) => db.query('UPDATE orders SET agent_id = $2 WHERE id = ANY($1::bigint[])', [ids.map(Number), ctx.session.profile.id]);

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

test('the sweep clears old abandoned leads and puts borderline leads in Nouvelles with their review note', async () => {
  const t0 = Date.now();
  const old = await form({ name: '', phone: '0667284139', wilaya: 0, commune: '', variant: null, utm: { utm_source: 'facebook', utm_campaign: 'backlog' } }, SLUG, t0);
  const borderline = await form({ name: 'Alex1', phone: '0675429076', variant: null }, SLUG, t0);
  await call('landing.capture', at(admin, t0), old);
  await call('landing.capture', at(admin, t0), borderline);
  await db.query(`UPDATE landing_pages SET fraud_level = 'strict' WHERE slug = $1`, [SLUG]);
  await db.query(
    `UPDATE landing_leads SET status = 'abandoned', abandoned_at = last_at, note = 'Choisissez la variante' WHERE phone = $1`,
    [old.phone],
  );
  await db.query(
    `INSERT INTO landing_leads (landing_id, product_id, phone, status, auto_order, handled_at)
     SELECT id, product_id, 'unused-' || n, 'converted', true, now()
     FROM landing_pages CROSS JOIN generate_series(1,40) n WHERE slug = $1`,
    [SLUG],
  );
  try {
    await call('landing.run', at(admin, t0 + 25 * MIN), {});
    await call('landing.run', at(admin, t0 + 26 * MIN), {});
    const recovered = await orders(old.phone);
    const reviewed = await orders(borderline.phone);
    assert.equal(recovered.length, 1);
    assert.equal(reviewed.length, 1);
    assert.equal(recovered[0].conf_status, 'new');
    assert.equal(reviewed[0].conf_status, 'new');
    assert.equal(recovered[0].wilaya_id, null);
    assert.equal(recovered[0].utm.utm_campaign, 'backlog');
    assert.match(reviewed[0].internal_note, /score anti-fraude/);
    const [item] = await db.query(`SELECT i.product_id, v.product_id AS variant_product_id
      FROM order_items i JOIN product_variants v ON v.id = i.variant_id WHERE i.order_id = $1`, [recovered[0].id]);
    assert.equal(Number(item.product_id), productId);
    assert.equal(Number(item.variant_product_id), productId);
    const pending: any = await call('landing.leads', at(admin, t0 + 26 * MIN), { status: 'abandoned' });
    assert.equal(pending.total, 0);
  } finally {
    await db.query(`UPDATE landing_pages SET fraud_level = 'normal' WHERE slug = $1`, [SLUG]);
    await db.query(`DELETE FROM landing_leads WHERE phone LIKE 'unused-%'`);
  }
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

test('two lead records for one checkout converge and a late submit replaces the manually added draft', async () => {
  const t0 = Date.now();
  const f = await form({}, SLUG, t0);
  await call('landing.capture', at(admin, t0), f);
  await db.query(`INSERT INTO landing_leads (landing_id, product_id, variant_id, phone, qty, unit_price, status)
    SELECT landing_id, product_id, variant_id, phone, qty, unit_price, 'abandoned' FROM landing_leads WHERE phone = $1`, [f.phone]);
  const leads = await db.query('SELECT id FROM landing_leads WHERE phone = $1', [f.phone]);
  const agent = await as(EMAILS.conf);
  const recovered: any[] = await Promise.all(leads.map((l) => call('landing.convertLead', agent, { id: Number(l.id) })));
  assert.equal(recovered[0].orderId, recovered[1].orderId);
  assert.equal((await orders(f.phone as string)).length, 1);
  await call('landing.submit', at(admin, t0 + MIN), f);
  const rows = await orders(f.phone as string);
  assert.deepEqual(rows.map((o) => o.conf_status), ['duplicate', 'new']);
});

test('Add to orders accepts phone and source product, then confirmation requires complete details', async () => {
  const t0 = Date.now();
  const f = await form({ name: '', wilaya: 0, commune: '', variant: null, utm: { utm_source: 'facebook', utm_campaign: 'recovery' } }, SLUG, t0);
  await call('landing.capture', at(admin, t0), f);
  const lead = (await db.query('SELECT id FROM landing_leads WHERE phone = $1', [f.phone]))[0];
  const agent = await as(EMAILS.conf);
  const r: any = await call('landing.convertLead', agent, { id: Number(lead.id) });
  const again: any = await call('landing.convertLead', agent, { id: Number(lead.id) });
  assert.equal(r.orderId, again.orderId);
  const o = (await orders(f.phone as string))[0];
  assert.equal(o.customer_name, '');
  assert.equal(o.wilaya_id, null);
  assert.equal(o.channel, 'landing');
  assert.match(o.source, /review-test/);
  assert.equal(o.utm.utm_campaign, 'recovery');
  assert.ok(o.landing_id);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM notifications WHERE order_id = $1', [o.id]))[0].n, 0, 'no message');
  const item = (await db.query('SELECT product_id, variant_id FROM order_items WHERE order_id = $1', [o.id]))[0];
  assert.equal(Number(item.product_id), productId);
  const variants = await db.query(
    `SELECT v.id, COALESCE(sum(s.qty) FILTER (WHERE w.active), 0) AS stock
      FROM product_variants v LEFT JOIN stock s ON s.variant_id = v.id LEFT JOIN warehouses w ON w.id = s.warehouse_id
      WHERE v.product_id = $1 AND v.active GROUP BY v.id ORDER BY v.id`, [productId],
  );
  assert.ok(variants.length > 1);
  assert.equal(Number(item.variant_id), Number(variants.find((v) => Number(v.stock) > 0)?.id ?? variants[0].id));
  await giveTo(agent, [o.id]);
  const next = (status: string) => call('orders.setConf', agent, { ids: [r.orderId], status });
  await next('busy');
  await call('orders.update', agent, { id: r.orderId, customerName: '', internalNote: 'À rappeler' });
  await assert.rejects(next('confirmed'), /wilaya/i);
  await call('orders.update', agent, { id: r.orderId, customerName: 'Amina Benali', wilayaId: 16, commune: 'Hydra' });
  await assert.rejects(next('confirmed'), /adresse/i);
  await call('orders.update', agent, { id: r.orderId, address: '12 rue des Lilas' });
  await db.query('UPDATE order_items SET variant_id = NULL WHERE order_id = $1', [o.id]);
  await assert.rejects(next('confirmed'), /variante/i);
  await db.query('UPDATE order_items SET variant_id = $2 WHERE order_id = $1', [o.id, item.variant_id]);
  await next('confirmed');
  assert.equal((await orders(f.phone as string)).length, 1);
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
  const agent = await as(EMAILS.conf);
  await giveTo(agent, [o.id]);
  await call('orders.update', agent, { id: Number(o.id), address: '12 rue des Lilas' });
  await call('orders.setConf', agent, { ids: [Number(o.id)], status: 'confirmed' });
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
  await giveTo(conf, [g.id, b.id]);
  await call('orders.setConf', conf, { ids: [Number(g.id), Number(b.id)], status: 'confirmed' });
  await db.query(`UPDATE orders SET total = 1 WHERE id = $1`, [b.id]);
  await call('landing.run', await as(EMAILS.admin, server), {});
  const st = async (id: number) => (await db.query(`SELECT status, attempts FROM meta_events WHERE order_id = $1 AND event_name = 'Purchase'`, [id]))[0];
  assert.equal((await st(Number(g.id))).status, 'sent');
  const x = await st(Number(b.id));
  assert.equal(x.status, 'queued');
  assert.equal(Number(x.attempts), 1);
});

test('« at order » mode: a borderline order counts once an agent confirms it', async () => {
  await call('landing.settings.save', admin, { pixelId: '', testEventCode: '', purchaseAt: 'order', abandonAfterMin: 20, autoCreate: false, capiToken: '' });
  // borderline: a number on the blacklist (an order sent twice is merged into one, not borderline anymore)
  const f = await form();
  await db.query(`INSERT INTO customers (phone, name, blacklisted, blacklist_reason) VALUES ($1, 'X', true, 'test') ON CONFLICT (phone) DO UPDATE SET blacklisted = true`, [f.phone]);
  await call('landing.submit', admin, f);
  const second = (await orders(f.phone as string))[0];
  assert.match(second.internal_note, /anti-fraude/);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM meta_events WHERE order_id = $1`, [second.id]))[0].n, 0);
  const agent = await as(EMAILS.conf);
  await giveTo(agent, [second.id]);
  await call('orders.setConf', agent, { ids: [Number(second.id)], status: 'confirmed' });
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM meta_events WHERE order_id = $1 AND event_name = 'Purchase'`, [second.id]))[0].n, 1);
  // and, in « at order » mode, the agent's confirmation is reported too (for the reports)
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM meta_events WHERE order_id = $1 AND event_name = 'Confirmed'`, [second.id]))[0].n, 1);
  await call('landing.settings.save', admin, { pixelId: '', testEventCode: '', purchaseAt: 'confirmed', abandonAfterMin: 20, autoCreate: false, capiToken: '' });
});
