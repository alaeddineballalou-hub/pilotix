// Which ad an order came from when the ad has nothing in its « URL parameters »: Meta adds its own numbers to the link
// then (utm_campaign / utm_term / utm_content as advertisers saw them, or names Pilotix does not know). The page keeps
// them, the server turns them into the order's three ids (never over Pilotix's own), completes the ids it can from the
// shop's ads, and the card in Réglages counts the orders that found their ad that way.
import { sha256Hex, zeroBits } from '@pilotix/shared';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { LANDING_POW_BITS, makeChallenge, metaIdsOf, withAdIds } from '../modules/landing';
import { EMAILS, setup } from './harness';

let db: Db;
let admin: Ctx;
let productId: number;
let variantId: number;
const SLUG = 'poussette-ids';
const UA = 'Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const AD = '120211111111111111';
const ADSET = '120222222222222222';
const CAMPAIGN = '120233333333333333';

before(async () => {
  const s = await setup(60);
  db = s.db;
  admin = await s.as(EMAILS.admin);
  const p = (await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id WHERE p.sku = 'PX-POU' AND v.title <> '' ORDER BY v.id LIMIT 1`))[0];
  productId = Number(p.id);
  variantId = Number(p.vid);
  await call('landing.save', await s.as(EMAILS.marketer), { productId, slug: SLUG, title: 'عربة أطفال', color: '#db2777', price: 9950, description: '- خفيفة' });
  // the shop's ads as Pilotix read them from Meta
  await db.query(`INSERT INTO ad_campaigns (id, name) VALUES ($1, 'TEST') ON CONFLICT (id) DO NOTHING`, [CAMPAIGN]);
  await db.query(`INSERT INTO adsets (id, name, campaign_id) VALUES ($1, 'Poussettes', $2) ON CONFLICT (id) DO NOTHING`, [ADSET, CAMPAIGN]);
  await db.query(`INSERT INTO ads (id, adset_id, name) VALUES ($1, $2, 'Poussette POV') ON CONFLICT (id) DO NOTHING`, [AD, ADSET]);
});

const solve = (ch: string) => {
  for (let n = 0; ; n++) if (zeroBits(sha256Hex(`${ch}:${n}`)) >= LANDING_POW_BITS) return String(n);
};
const NAMES = ['Amina Benali', 'Sara Haddad', 'Nour Mansouri', 'Lina Belkacem', 'Meriem Saidi', 'Yasmine Bouzid'];
let seq = 0;
/** an order sent from the page as a person would, with the ad link's parameters */
async function order(utm: Record<string, string>) {
  const k = seq++;
  const phone = `0661${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
  const ch = await makeChallenge(db, SLUG, Date.now() - 25_000);
  await call('landing.submit', admin, {
    slug: SLUG, name: NAMES[k % NAMES.length], phone, wilaya: 16, commune: 'Hydra', variant: variantId, qty: 1, hp: '', ch, pw: solve(ch), t: 25_000, ki: 40, wd: false,
    fp: `fp${k}x${Math.random().toString(36).slice(2, 10)}`, did: `d${k}${Math.random()}`, meta: { ip: `10.1.0.${k + 10}`, ua: UA }, utm,
  });
  const o = (await db.query(`SELECT utm, adset_id FROM orders WHERE phone = $1 ORDER BY id DESC LIMIT 1`, [phone]))[0];
  assert.ok(o, 'the order was made');
  return { utm: (typeof o.utm === 'string' ? JSON.parse(o.utm) : o.utm) as Record<string, string>, adsetId: o.adset_id ? String(o.adset_id) : null };
}

test('Meta’s own numbers become the three ids; names never do; Pilotix’s own ids always come first', () => {
  assert.deepEqual(metaIdsOf({ utm_source: 'fb', utm_campaign: CAMPAIGN, utm_term: ADSET, utm_content: AD }), {
    utm_source: 'fb', utm_campaign: CAMPAIGN, utm_term: ADSET, utm_content: AD, ad_id: AD, adset_id: ADSET, campaign_id: CAMPAIGN, px_ids: 'meta',
  });
  assert.deepEqual(metaIdsOf({ utm_campaign: 'Poussettes octobre', utm_content: 'Vidéo POV' }), { utm_campaign: 'Poussettes octobre', utm_content: 'Vidéo POV' }, 'names are not ids');
  assert.deepEqual(metaIdsOf({ utm_content: '120299999999999999', ad_id: AD }), { utm_content: '120299999999999999', ad_id: AD }, 'ours kept, nothing marked');
  assert.equal(metaIdsOf({ utm_content: AD, ad_id: '{{ad.id}}' })?.ad_id, AD, 'an id Meta did not fill is not an id');
  assert.equal(metaIdsOf({ utm_content: '0661223344' })?.ad_id, undefined, 'a phone number is no Meta id');
  assert.equal(metaIdsOf(null), null);
});

test('the ids completed from the shop’s ads: one number is enough, under any name; never over an id the link carried', async () => {
  assert.deepEqual(await withAdIds(db, { ad_id: AD }), { ad_id: AD, adset_id: ADSET, campaign_id: CAMPAIGN, px_ids: 'found' });
  assert.deepEqual(await withAdIds(db, { adset_id: ADSET }), { adset_id: ADSET, campaign_id: CAMPAIGN, px_ids: 'found' });
  assert.deepEqual(await withAdIds(db, { fb_ad: AD, utm_source: 'fb' }), { fb_ad: AD, utm_source: 'fb', ad_id: AD, adset_id: ADSET, campaign_id: CAMPAIGN, px_ids: 'found' });
  assert.deepEqual(await withAdIds(db, { x_id: CAMPAIGN }), { x_id: CAMPAIGN, campaign_id: CAMPAIGN, px_ids: 'found' }, 'a campaign is not an ad');
  const ours = { ad_id: AD, adset_id: '120277777777777777', campaign_id: '120288888888888888' };
  assert.deepEqual(await withAdIds(db, ours), ours, 'the link’s own ids are never replaced');
  assert.deepEqual(await withAdIds(db, { zz: '120299999999999999' }), { zz: '120299999999999999' }, 'a number Pilotix does not know: kept as it came');
  assert.equal(await withAdIds(db, null), null);
});

test('an order from an ad with nothing in its URL parameters still knows its ad (Meta’s numbers), and its ad set for Pilot Checks', async () => {
  const o = await order({ utm_source: 'fb', utm_medium: 'paid', utm_campaign: CAMPAIGN, utm_term: ADSET, utm_content: AD, utm_id: CAMPAIGN });
  assert.equal(o.utm.ad_id, AD);
  assert.equal(o.utm.adset_id, ADSET);
  assert.equal(o.utm.campaign_id, CAMPAIGN);
  assert.equal(o.utm.px_ids, 'meta');
  assert.equal(o.utm.utm_id, CAMPAIGN, 'utm_id kept too');
  assert.equal(o.adsetId, ADSET);
});

test('Meta’s numbers under a name Pilotix does not know: the page keeps them, the server finds the ad among the shop’s', async () => {
  const o = await order({ utm_source: 'ig', meta_ad_number: AD, page: 'x' });
  assert.equal(o.utm.ad_id, AD);
  assert.equal(o.utm.adset_id, ADSET);
  assert.equal(o.utm.campaign_id, CAMPAIGN);
  assert.equal(o.utm.px_ids, 'found');
  assert.equal(o.utm.page, undefined, 'a word under an unknown name is not kept');
});

test('an ad with Pilotix’s line: its ids as they came, nothing marked', async () => {
  const o = await order({ utm_source: 'fb', utm_medium: 'paid', ad_id: AD, adset_id: ADSET, campaign_id: CAMPAIGN });
  assert.equal(o.utm.ad_id, AD);
  assert.equal(o.utm.px_ids, undefined);
});

test('the card counts the orders that found their ad with Meta’s own numbers (the proof Meta adds them)', async () => {
  const s: any = await call('ads.tags.state', admin, {});
  assert.ok(s.metaIdOrders >= 1, `counted: ${s.metaIdOrders}`);
});

test('the page keeps Meta’s numbers from the link, under any name (its size is checked in landing.test)', async () => {
  const r: any = await call('landing.html', admin, { slug: SLUG, mode: 'live', post: '/o', geo: '/g/', imgBase: null });
  assert.ok(r.html.includes('\\d{12,20}'), 'the page script keeps long numbers under any name');
});
