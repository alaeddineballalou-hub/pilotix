// Ad sets › Produit by itself (the owner, 27 Nov 2026): each ad's landing page gives its ad set its products (the link
// wins over a hand choice; an ad made from a post takes the page its orders came through), and Publicité counts each
// ad's spend for the product of its own page. The products table's « Leads » counts every order, the abandoned carts in.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { linkAdsets, productShares, slugOfLink, type ShopAddress } from '../modules/adlinks';
import { landingStore } from '../modules/landingquery';
import { mkCompute } from '../modules/marketers';
import { EMAILS, setup } from './harness';

let db: Db;
let owner: Ctx;
let addr: ShopAddress;
const pid = async (sku: string) => Number((await db.query('SELECT id FROM products WHERE sku = $1', [sku]))[0].id);
const slugOf = async (productId: number) => String((await db.query('SELECT slug FROM landing_pages WHERE product_id = $1 AND active ORDER BY id LIMIT 1', [productId]))[0].slug);
const set = async (id: string) => (await db.query('SELECT product_ids, group_id, link_auto FROM adsets WHERE id = $1', [id]))[0];
const ids = (v: unknown) => ((v ?? []) as unknown[]).map(Number).sort((a, b) => a - b);

before(async () => {
  const s = await setup(60);
  db = s.db;
  owner = await s.as(EMAILS.vendeur);
  addr = { own: 'babyjoydz.net', hosts: ['go.pilotix.online', 'pilotix.online'], store: await landingStore(db) };
});

test('a link is one of the boutique’s pages only on its own addresses', () => {
  const a: ShopAddress = { own: 'babyjoydz.net', hosts: ['go.pilotix.online', 'pilotix.online'], store: 'baby-joy-dz' };
  assert.equal(slugOfLink('https://babyjoydz.net/poussette-manege?utm_source=facebook&fbclid=x', a), 'poussette-manege');
  assert.equal(slugOfLink('https://www.babyjoydz.net/poussette-manege/', a), 'poussette-manege');
  assert.equal(slugOfLink('https://go.pilotix.online/baby-joy-dz/pouf-bebe?utm_campaign=1', a), 'pouf-bebe');
  assert.equal(slugOfLink('https://pilotix.online/baby-joy-dz/pouf-bebe', a), 'pouf-bebe');
  // the platform's address of another store, another site, a chat: not its pages
  assert.equal(slugOfLink('https://go.pilotix.online/maison-fatima/pouf-bebe', a), null);
  assert.equal(slugOfLink('https://shop.example.com/pouf-bebe', a), null);
  assert.equal(slugOfLink('https://m.me/babyjoy', a), null);
  assert.equal(slugOfLink(null, a), null);
  assert.equal(slugOfLink('not a link', a), null);
  // the store's root (its site), not a page
  assert.equal(slugOfLink('https://babyjoydz.net/', a), null);
});

test('an ad set’s spend goes to its products by its ads', () => {
  const s = productShares([1, 2], [
    { productId: 1, cents: 600 },
    { productId: 2, cents: 200 },
    { productId: null, cents: 200 },
  ]);
  assert.ok(Math.abs((s.get(1) ?? 0) - 0.7) < 1e-9, 'its own ad + half of the ad with no page');
  assert.ok(Math.abs((s.get(2) ?? 0) - 0.3) < 1e-9);
  // no ad spend known: equal parts, as before
  const eq = productShares([1, 2], []);
  assert.equal(eq.get(1), 0.5);
  assert.equal(eq.get(2), 0.5);
  // an ad of a product the ad set does not sell counts like an ad with no page
  const out = productShares([1], [{ productId: 9, cents: 100 }]);
  assert.equal(out.get(1), 1);
  assert.equal(out.has(9), false);
});

test('the demo: the stroller’s ad set follows its ads’ page; the Messenger test stays for a person', async () => {
  const s = await set('120200001');
  assert.deepEqual(ids(s.product_ids), [await pid('PX-POU')]);
  assert.equal(s.link_auto, true);
  const m = await set('120200005');
  assert.deepEqual(ids(m.product_ids), []);
  assert.equal(m.link_auto, false);
});

test('the link wins over a hand choice, and the hand choice is closed then', async () => {
  const lit = await pid('PX-LIT');
  const bib = await pid('PX-BIB');
  await db.query(`INSERT INTO adsets (id, name, campaign, product_ids, status) VALUES ('990000001', 'Main — lit', 'TEST', $1, 'ACTIVE')`, [[bib]]);
  const r = await linkAdsets(db, [{ id: '990000011', adsetId: '990000001', name: 'Vidéo lit', link: `https://go.pilotix.online/${addr.store}/${await slugOf(lit)}?utm_source=fb` }], addr);
  assert.equal(r.known, 1);
  assert.equal(r.changed, 1);
  const s = await set('990000001');
  assert.deepEqual(ids(s.product_ids), [lit]);
  assert.equal(s.link_auto, true);
  const ad = (await db.query(`SELECT link_slug, link_product_id, link_from FROM ads WHERE id = '990000011'`))[0];
  assert.equal(Number(ad.link_product_id), lit);
  assert.equal(ad.link_from, 'ad');
  await assert.rejects(call('ads.link', owner, { adsetId: '990000001', productIds: [bib] }), /lien de la pub/);
  // the overview says it
  const ov: any = await call('ads.overview', owner, { from: '2025-01-01', to: '2025-01-02' });
  const row = ov.adsets.find((a: any) => a.id === '990000001');
  assert.equal(row.linkAuto, true);
  assert.deepEqual(row.linkPages, [await slugOf(lit)]);
});

test('an ad made from a post (no link on it): the page its orders came through', async () => {
  const tap = await pid('PX-TAP');
  const page = Number((await db.query('SELECT id FROM landing_pages WHERE product_id = $1 AND active ORDER BY id LIMIT 1', [tap]))[0].id);
  await db.query(`INSERT INTO adsets (id, name, campaign, product_ids, status) VALUES ('990000002', 'SCALE — post gagnant', 'SCALE', '{}', 'ACTIVE')`);
  await db.query(`UPDATE orders SET utm = jsonb_build_object('ad_id', '990000021'), landing_id = $1 WHERE id IN (SELECT id FROM orders ORDER BY id LIMIT 2)`, [page]);
  await linkAdsets(db, [{ id: '990000021', adsetId: '990000002', name: 'Post gagnant', link: null }], addr);
  const ad = (await db.query(`SELECT link_product_id, link_from FROM ads WHERE id = '990000021'`))[0];
  assert.equal(Number(ad.link_product_id), tap);
  assert.equal(ad.link_from, 'orders');
  assert.deepEqual(ids((await set('990000002')).product_ids), [tap]);
  // a message ad (no page, no order through a page): nothing known, a person chooses as before
  await db.query(`INSERT INTO adsets (id, name, campaign, product_ids, status) VALUES ('990000003', 'Messages', 'MSG', '{}', 'ACTIVE')`);
  await linkAdsets(db, [{ id: '990000031', adsetId: '990000003', name: 'Pub messages', link: 'https://m.me/babyjoy' }], addr);
  const m = await set('990000003');
  assert.deepEqual(ids(m.product_ids), []);
  assert.equal(m.link_auto, false);
});

test('an ad set selling two products: each ad’s spend counts for its own product', async () => {
  const sac = await pid('PX-SAC');
  const lit = await pid('PX-LIT');
  await db.query(`INSERT INTO adsets (id, name, campaign, product_ids, status) VALUES ('990000004', 'SCALE — limite basse', 'SCALE', '{}', 'ACTIVE')`);
  await linkAdsets(db, [
    { id: '990000041', adsetId: '990000004', name: 'Sac', link: `https://babyjoydz.net/${await slugOf(sac)}` },
    { id: '990000042', adsetId: '990000004', name: 'Lit', link: `https://babyjoydz.net/${await slugOf(lit)}?fbclid=1` },
  ], addr);
  assert.deepEqual(ids((await set('990000004')).product_ids), [sac, lit].sort((a, b) => a - b));
  // a day far from the demo's: Meta's ad set day $10.00, its ads $7.50 (sac) and $2.50 (lit)
  const day = '2025-01-10';
  await db.query(`INSERT INTO ad_insights (day, adset_id, spend_cents, impressions, reach, clicks, lpv, purchases, video_3s, thruplays) VALUES ($1, '990000004', 1000, 1000, 800, 20, 15, 1, 0, 0)`, [day]);
  await db.query(
    `INSERT INTO ad_daily (day, ad_id, adset_id, spend_cents, impressions, reach, clicks, lpv, purchases, video_3s, thruplays)
     VALUES ($1, '990000041', '990000004', 750, 700, 600, 15, 10, 1, 0, 0), ($1, '990000042', '990000004', 250, 300, 200, 5, 5, 0, 0, 0)`,
    [day],
  );
  const ov: any = await call('ads.overview', owner, { from: day, to: day });
  const spend = (p: number) => ov.products.find((x: any) => x.productId === p)?.spendUsd ?? 0;
  assert.ok(Math.abs(spend(sac) - 7.5) < 1e-9, `sac: ${spend(sac)}`);
  assert.ok(Math.abs(spend(lit) - 2.5) < 1e-9, `lit: ${spend(lit)}`);
  // one product's page: its own share, in its total and its day
  const one: any = await call('ads.overview', owner, { from: day, to: day, productId: lit });
  assert.ok(Math.abs(one.totals.spendUsd - 2.5) < 1e-9, `total: ${one.totals.spendUsd}`);
  assert.ok(Math.abs(one.days[0].spendUsd - 2.5) < 1e-9, `day: ${one.days[0].spendUsd}`);
});

test('« Leads »: every order of the product, its abandoned carts in it', async () => {
  const pou = await pid('PX-POU');
  const today = new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
  const from = new Date(Date.now() + 3_600_000 - 30 * 86_400_000).toISOString().slice(0, 10);
  const ov: any = await call('ads.overview', owner, { from, to: today });
  const row = ov.products.find((x: any) => x.productId === pou);
  assert.ok(row, 'the stroller has ads');
  // the demo's abandoned carts of the stroller (made orders by Pilotix), as Landing pages › Abandonnées counts them
  const carts = Number(
    (
      await db.query(
        `WITH firsts AS (SELECT DISTINCT ON (i.order_id) i.order_id, i.product_id FROM order_items i ORDER BY i.order_id, i.is_upsell, i.id)
         SELECT count(*)::int AS n FROM sales o JOIN firsts f ON f.order_id = o.id
          WHERE f.product_id = $1 AND o.conf_status <> 'duplicate' AND o.created_at >= $2 AND o.created_at < $3
            AND (o.came IN ('abandoned', 'recovered') OR (o.came IS NULL AND o.source ~ '·\\s*abandonnée$'))`,
        [pou, new Date(Date.parse(from + 'T00:00:00Z') - 3_600_000).toISOString(), new Date(Date.parse(today + 'T00:00:00Z') + 86_400_000 - 3_600_000).toISOString()],
      )
    )[0].n,
  );
  assert.ok(carts > 0, 'the demo has abandoned carts of the stroller');
  assert.equal(row.money.cart, carts);
  assert.ok(row.money.n >= carts, 'the carts are among the leads');
  assert.ok(row.money.n > row.money.c, 'more leads than confirmed');
  assert.equal(ov.totals.cart >= carts, true);
});

test('Marketer: an ad set selling two products counts each ad’s purchases for its own product', async () => {
  const sac = await pid('PX-SAC');
  const lit = await pid('PX-LIT');
  // M1 sells the bag and the travel cot (9 purchases on the bag's ad, 1 on the cot's); M2 sells the cot (1 purchase)
  await db.query(`INSERT INTO adsets (id, name, campaign, product_ids, status) VALUES ('990000005', 'SCALE — deux produits', 'SCALE', '{}', 'PAUSED'), ('990000006', 'TEST — lit', 'TEST', $1, 'PAUSED')`, [[lit]]);
  await linkAdsets(db, [
    { id: '990000051', adsetId: '990000005', name: 'Sac', link: `https://babyjoydz.net/${await slugOf(sac)}` },
    { id: '990000052', adsetId: '990000005', name: 'Lit', link: `https://babyjoydz.net/${await slugOf(lit)}` },
  ], addr);
  await db.query(`INSERT INTO ads (id, adset_id, name) VALUES ('990000061', '990000006', 'Lit test')`);
  const day = '2025-02-10';
  await db.query(
    `INSERT INTO ad_insights (day, adset_id, spend_cents, impressions, reach, clicks, lpv, purchases, video_3s, thruplays)
     VALUES ($1, '990000005', 2000, 1000, 800, 20, 15, 10, 0, 0), ($1, '990000006', 500, 400, 300, 5, 4, 1, 0, 0)`,
    [day],
  );
  await db.query(
    `INSERT INTO ad_daily (day, ad_id, adset_id, spend_cents, impressions, reach, clicks, lpv, purchases, video_3s, thruplays)
     VALUES ($1, '990000051', '990000005', 1500, 700, 600, 15, 10, 9, 0, 0), ($1, '990000052', '990000005', 500, 300, 200, 5, 5, 1, 0, 0),
            ($1, '990000061', '990000006', 500, 400, 300, 5, 4, 1, 0, 0)`,
    [day],
  );
  // two orders of the travel cot that month
  await db.query(
    `UPDATE orders SET created_at = '2025-02-10T10:00:00Z' WHERE id IN (
       SELECT o.id FROM orders o WHERE NOT o.is_exchange AND o.conf_status <> 'duplicate'
          AND (SELECT i.product_id FROM order_items i WHERE i.order_id = o.id ORDER BY i.is_upsell, i.id LIMIT 1) = $1
        ORDER BY o.id LIMIT 2)`,
    [lit],
  );
  const r = await mkCompute(db, Date.now(), (x) => x.id === '990000005' || x.id === '990000006');
  const m1 = r.rows.find((x) => x.id === '990000005')!;
  const m2 = r.rows.find((x) => x.id === '990000006')!;
  // the cot's 2 orders: 1 purchase each side on the cot, so half each (equal parts of M1's 10 purchases would give it 5 of 6)
  assert.ok(Math.abs(m1.n - 1) < 1e-9, `M1: ${m1.n}`);
  assert.ok(Math.abs(m2.n - 1) < 1e-9, `M2: ${m2.n}`);
});

test('« En cours »: the confirmed orders still to deliver, never a cancelled one nor a return', async () => {
  const pou = await pid('PX-POU');
  const today = new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
  const from = new Date(Date.now() + 3_600_000 - 30 * 86_400_000).toISOString().slice(0, 10);
  const range = [new Date(Date.parse(from + 'T00:00:00Z') - 3_600_000).toISOString(), new Date(Date.parse(today + 'T00:00:00Z') + 86_400_000 - 3_600_000).toISOString()];
  const count = async () =>
    Number(
      (
        await db.query(
          `WITH firsts AS (SELECT DISTINCT ON (i.order_id) i.order_id, i.product_id FROM order_items i ORDER BY i.order_id, i.is_upsell, i.id)
           SELECT count(*)::int AS n FROM sales o JOIN firsts f ON f.order_id = o.id
            WHERE f.product_id = $1 AND o.created_at >= $2 AND o.created_at < $3 AND o.conf_status IN ('confirmed', 'no_stock')
              AND COALESCE(o.follow_status, '') NOT IN ('delivered', 'exchanged', 'returned', 'lost', 'cancelled', 'returning')`,
          [pou, ...range],
        )
      )[0].n,
    );
  const row = async () => ((await call('ads.overview', owner, { from, to: today })) as any).products.find((x: any) => x.productId === pou);
  const before = await count();
  assert.ok(before > 0, 'the demo has strollers still on their way');
  assert.equal((await row()).money.run, before);
  // one of them cancelled at the door: it leaves « En cours »
  await db.query(
    `UPDATE orders SET follow_status = 'cancelled' WHERE id = (
       SELECT o.id FROM sales o WHERE o.conf_status = 'confirmed' AND COALESCE(o.follow_status, '') NOT IN ('delivered', 'exchanged', 'returned', 'lost', 'cancelled', 'returning')
          AND o.created_at >= $2 AND o.created_at < $3
          AND (SELECT i.product_id FROM order_items i WHERE i.order_id = o.id ORDER BY i.is_upsell, i.id LIMIT 1) = $1
        ORDER BY o.id LIMIT 1)`,
    [pou, ...range],
  );
  const r = await row();
  assert.equal(r.money.run, before - 1);
  assert.ok(r.money.run <= r.money.c - r.money.d, 'never more than the confirmed not delivered');
});
