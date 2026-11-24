// « Le chemin de la commande » (24 Nov 2026, the owner's choice 3): every order keeps how it came (`came`); the person
// who made it is named only when a person did (never the account the server works with); the order card reads the path
// (orders.origin); old orders get `came` once. (What the history shows in place of a name: orders.test, delivery.test.)
import { cameOf, sha256Hex, zeroBits } from '@pilotix/shared';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { CAME_BACKFILL_SQL } from '../migrations/130_order_came';
import { LANDING_POW_BITS, makeChallenge } from '../modules/landing';
import { EMAILS, setup } from './harness';

let db: Db;
let admin: Ctx;
let as: (email: string) => Promise<Ctx>;
let productId: number;
let variantId: number;
const SLUG = 'chemin-test';
const UA = 'Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';

before(async () => {
  const s = await setup(60);
  db = s.db;
  as = s.as;
  admin = await s.as(EMAILS.admin);
  const p = (await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id WHERE p.sku = 'PX-POU' AND v.title <> '' ORDER BY v.id LIMIT 1`))[0];
  productId = Number(p.id);
  variantId = Number(p.vid);
  await call('landing.save', await s.as(EMAILS.marketer), { productId, slug: SLUG, title: 'عربة أطفال', color: '#db2777', price: 9950, description: '- خفيفة' });
});

const solve = (ch: string) => {
  for (let n = 0; ; n++) if (zeroBits(sha256Hex(`${ch}:${n}`)) >= LANDING_POW_BITS) return String(n);
};
let seq = 0;
/** what the page sends, as a person would (the page served 25 s earlier, the challenge solved, typed by hand) */
async function form(over: Record<string, unknown> = {}) {
  const t0 = Date.now() - 25_000;
  const ch = await makeChallenge(db, SLUG, t0);
  const phone = `0662${String(100000 + seq++ * 7919).slice(-6)}`;
  const names = ['Benali', 'Haddad', 'Mansouri', 'Saidi'];
  return {
    slug: SLUG, name: `Yasmine ${names[seq % names.length]}`, phone, wilaya: 4, commune: "Aïn M'Lila", variant: variantId, qty: 1, hp: '', ch, pw: solve(ch), t: 25_000, ki: 40, wd: false,
    fp: `fp${Math.random().toString(36).slice(2, 14)}`, did: `d${Math.random()}`, meta: { ip: `10.1.0.${seq}`, ua: UA }, ...over,
  };
}
const orderOf = async (phone: string) => Number((await db.query('SELECT id FROM orders WHERE phone = $1 ORDER BY id DESC LIMIT 1', [phone]))[0].id);

test('a landing page order came by itself: no person named on it, its path from the page', async () => {
  const input = await form();
  assert.deepEqual(await call('landing.submit', admin, input), { ok: true });
  const id = await orderOf(input.phone);
  assert.equal((await db.query('SELECT came FROM orders WHERE id = $1', [id]))[0].came, 'form');
  const o: any = await call('orders.get', admin, { id });
  assert.equal(o.came, 'form');
  // its creation says its page, not the account the page runs with
  const made = ((await call('orders.events', admin, { id })) as any[]).find((e) => e.kind === 'created');
  assert.equal(made.userId, null);
  assert.match(made.userName, /^Page de vente/);
  const path: any = await call('orders.origin', admin, { id });
  assert.equal(path.came, 'form');
  assert.equal(path.by, null);
  assert.deepEqual(path.page, { slug: SLUG, title: 'عربة أطفال', group: null });
  assert.equal(path.ad, null);
  assert.equal(path.noAd, 'none');
  const sub = (await db.query('SELECT verdict, score FROM landing_submits WHERE order_id = $1', [id]))[0];
  assert.deepEqual(path.check, { verdict: sub.verdict, score: Number(sub.score) });
  assert.equal(path.conf.status, 'new');
  assert.equal(path.conf.by, null);
});

test('the ad the customer came from: its name, ad set and campaign from the ads Pilotix reads', async () => {
  await db.query(`INSERT INTO adsets (id, name, campaign) VALUES ('120222220000000001', 'Balançoire', 'TEST') ON CONFLICT (id) DO NOTHING`);
  await db.query(`INSERT INTO ads (id, adset_id, name) VALUES ('120211110000000001', '120222220000000001', 'Vidéo 2') ON CONFLICT (id) DO NOTHING`);
  const input = await form({ utm: { utm_source: 'fb', ad_id: '120211110000000001', adset_id: '120222220000000001', campaign_id: '120233330000000001' } });
  assert.deepEqual(await call('landing.submit', admin, input), { ok: true });
  const path: any = await call('orders.origin', admin, { id: await orderOf(input.phone) });
  const { ids: _ids, ...ad } = path.ad;
  assert.deepEqual(ad, { platform: 'Facebook', name: 'Vidéo 2', id: '120211110000000001', adset: 'Balançoire', campaign: 'TEST' });
  assert.equal(path.noAd, null);
  // a link from an ad that carried none of its ids
  const bare = await form({ utm: { utm_source: 'ig' } });
  await call('landing.submit', admin, bare);
  assert.equal(((await call('orders.origin', admin, { id: await orderOf(bare.phone) })) as any).noAd, 'noIds');
});

test('an order typed by an agent is hers: her name as its maker and on its creation', async () => {
  const samira = await as(EMAILS.conf);
  const o: any = await call('orders.create', samira, {
    customerName: 'Client Appel', phone: '0661707070', wilayaId: 16, commune: 'Kouba', channel: 'appel',
    items: [{ productId, variantId, qty: 1 }],
  });
  assert.equal(o.came, 'hand');
  assert.equal(o.createdBy, samira.session.profile.id);
  assert.equal(o.creatorName, samira.session.profile.name);
  const ev: any[] = await call('orders.events', samira, { id: o.id });
  assert.equal(ev.find((e) => e.kind === 'created').userId, samira.session.profile.id);
  const path: any = await call('orders.origin', samira, { id: o.id });
  assert.equal(path.came, 'hand');
  assert.equal(path.by, samira.session.profile.name);
  assert.equal(path.channel, 'appel');
  assert.equal(path.page, null);
  assert.equal(path.noAd, null);
});

test('the shop’s site and a duplicate: how they came, and who made them only when a person did', async () => {
  // the site's order (its API key works with an administrator's account): the customer made it on the site
  const site: any = await call('orders.create', admin, { via: 'api', customerName: 'Client Site', phone: '0661717171', wilayaId: 16, commune: 'Kouba', channel: 'site', source: 'Ma boutique', items: [{ productId, variantId, qty: 1 }] });
  assert.equal(site.came, 'site');
  const path: any = await call('orders.origin', admin, { id: site.id });
  assert.equal(path.by, null, 'never the account the site works with');
  assert.equal(path.channelName, 'Ma boutique');
  assert.equal(path.conf.by, null);
  // « Dupliquer »: a copy, made by the person who copied it, from the original
  const done: any = await call('orders.duplicate', admin, { ids: [site.id] });
  const copy: any = await call('orders.origin', admin, { id: Number(done.ids[0]) });
  assert.equal(copy.came, 'copy');
  assert.equal(copy.by, admin.session.profile.name);
  assert.equal(copy.from?.ref, site.ref);
});

test('old orders: Pilotix’s own lines show as Pilotix’s, and every order gets how it came, once', async () => {
  const adminId = admin.session.profile.id;
  const cust = async (phone: string) => Number((await db.query(`INSERT INTO customers (phone, name, wilaya_id) VALUES ($1, 'Ancien', 16) ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [phone]))[0].id);
  const old = async (ref: string, phone: string, v: { channel?: string; source?: string | null; exchange?: boolean; note?: string | null }) =>
    Number(
      (
        await db.query(
          `INSERT INTO orders (ref, created_by, customer_id, customer_name, phone, wilaya_id, channel, source, is_exchange, internal_note, created_at)
           VALUES ($1,$2,$3,'Ancien',$4,16,$5,$6,$7,$8, now() - interval '3 days') RETURNING id`,
          [ref, adminId, await cust(phone), phone, v.channel ?? 'autre', v.source ?? null, !!v.exchange, v.note ?? null],
        )
      )[0].id,
    );
  await db.query(`INSERT INTO sales_channels (kind, name, webhook_key) VALUES ('sheets', 'Feuille Ventes', 'k1'), ('shopify', 'Boutique Shopify', 'k2')`);
  const ids = {
    form: await old('PXOLD1', '0550000001', { channel: 'landing', source: 'Landing · balancoire-simple' }),
    abandoned: await old('PXOLD2', '0550000002', { channel: 'landing', source: 'Landing · balancoire-simple · abandonnée' }),
    meta_form: await old('PXOLD3', '0550000003', { channel: 'facebook', source: 'Formulaire « Poussettes »' }),
    chat: await old('PXOLD4', '0550000004', { channel: 'facebook', source: 'Dellal · messenger · pub 1202' }),
    chat_auto: await old('PXOLD5', '0550000005', { channel: 'instagram', source: 'Dellal · instagram · commande auto' }),
    sheet: await old('PXOLD6', '0550000006', { source: 'Feuille Ventes' }),
    site: await old('PXOLD7', '0550000007', { channel: 'site', source: 'Boutique Shopify' }),
    test: await old('PXOLD8', '0550000008', { channel: 'site', source: 'site (simulation)' }),
    hand: await old('PXOLD9', '0550000009', { channel: 'appel' }),
    restored: await old('PXOLD10', '0550000010', { channel: 'landing', source: 'Landing · balancoire-simple' }),
    recovered: await old('PXOLD11', '0550000011', { channel: 'landing', source: 'Landing · balancoire-simple · abandonnée' }),
  };
  await db.query(`INSERT INTO landing_blocked (phone, status, order_id, handled_by) VALUES ('0550000010', 'restored', $1, $2)`, [ids.restored, adminId]);
  await db.query(`INSERT INTO landing_leads (phone, status, order_id, auto_order, handled_by) VALUES ('0550000011', 'converted', $1, false, $2)`, [ids.recovered, adminId]);
  // the app reads how an old order came from what Pilotix wrote on it, even before the database does
  const before: any = await call('orders.get', admin, { id: ids.chat });
  assert.equal(before.came, 'chat');
  assert.equal(cameOf({ channel: 'landing', source: 'Landing · x' }), 'form');
  // the path never names the account an old order was made with, unless a person typed it
  await db.query(`INSERT INTO order_events (order_id, user_id, kind, to_value, at) SELECT o.id, $1::bigint, 'created', 'new', o.created_at FROM orders o WHERE o.id = ANY($2::bigint[])`, [adminId, [ids.chat, ids.hand]]);
  assert.equal(((await call('orders.origin', admin, { id: ids.chat })) as any).by, null);
  assert.equal(((await call('orders.origin', admin, { id: ids.chat })) as any).conf.by, null);
  assert.equal(((await call('orders.origin', admin, { id: ids.hand })) as any).by, admin.session.profile.name);
  assert.equal(((await call('orders.origin', admin, { id: ids.hand })) as any).conf.by, admin.session.profile.name);
  // once, in the database
  await db.query(CAME_BACKFILL_SQL);
  const came = new Map((await db.query('SELECT id, came FROM orders WHERE id = ANY($1)', [Object.values(ids)])).map((r: any) => [Number(r.id), r.came]));
  for (const [k, id] of Object.entries(ids)) assert.equal(came.get(id), k, k);
  // already given: never changed again
  await db.query(`UPDATE orders SET came = 'hand' WHERE id = $1`, [ids.form]);
  await db.query(CAME_BACKFILL_SQL);
  assert.equal((await db.query('SELECT came FROM orders WHERE id = $1', [ids.form]))[0].came, 'hand');
});
