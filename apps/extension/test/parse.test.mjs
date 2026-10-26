// Pilotix Spy: tests of the pure parts (no Chrome needed). Run: node apps/extension/test/parse.test.mjs
// A fake Ad Library page goes through readAdLibrary (what the Facebook tab runs) and fromLibrary (the port of
// packages/core's fromLibrary). When packages/core is built (packages/core/dist), the port is also compared with the
// real fromLibrary and every ad is checked against the real RawAdSchema.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { checkSearch, fromLibrary, libraryUrl, readAdLibrary } from '../parse.js';
import { fitSize, toBase64 } from '../pictures.js';
import { originPattern, pilotixOrigin, scriptId } from '../sites.js';

// ---------------------------------------------------------------- a fake Ad Library page
const videoItem = {
  ad_archive_id: '1234567890123',
  collation_count: 4,
  collation_id: '987654321',
  page_id: '111222333',
  start_date: 1760000000,
  is_active: true,
  publisher_platform: ['facebook', 'instagram'],
  snapshot: {
    page_name: 'Bébé Store DZ',
    page_profile_uri: 'https://www.facebook.com/bebestoredz/',
    // braces, an escaped quote, a backslash just before a quote and a "<" (Facebook writes it \u003C)
    body: { text: 'Poussette 3 en 1 {promo} "pliable" à 12900 دج <b> C:\\' },
    title: 'Poussette 3 en 1',
    link_url: 'https://bebestore.dzbuild.app/p/poussette',
    caption: 'bebestore.dzbuild.app',
    cta_text: 'Commander',
    cta_type: 'SHOP_NOW',
    display_format: 'VIDEO',
    images: [],
    videos: [
      {
        video_preview_image_url: 'https://scontent.xx.fbcdn.net/v/t15/preview.jpg?x=1',
        video_sd_url: 'https://video.xx.fbcdn.net/v/sd.mp4',
        video_hd_url: null,
      },
    ],
    cards: [],
  },
};
const imageItem = {
  ad_archive_id: '2234567890123',
  collation_id: '887654321',
  page_id: '444555666',
  start_date: 1760000000000, // in milliseconds: fromLibrary turns it into seconds
  is_active: false,
  publisher_platform: ['facebook', 'messenger'],
  snapshot: {
    page_name: 'Maman Shop',
    page_profile_uri: 'https://www.facebook.com/mamanshop/',
    body: { text: 'Promo poussette 9 800 DA, livraison 58 wilayas' },
    title: null,
    link_url: '',
    cta_text: 'Envoyer un message',
    display_format: 'IMAGE',
    images: [{ resized_image_url: 'https://scontent.xx.fbcdn.net/v/t39/resized.jpg', original_image_url: 'https://scontent.xx.fbcdn.net/v/t39/original.jpg' }],
    videos: [],
    cards: [],
  },
};
const dcoItem = {
  ad_archive_id: '3234567890123',
  collation_count: 2,
  page_id: '777888999',
  start_date: 1761000000,
  is_active: true,
  publisher_platform: ['FACEBOOK'],
  snapshot: {
    page_name: 'Kids Market',
    body: { text: '{{product.name}}' },
    title: '{{product.name}}',
    display_format: 'DCO',
    images: [],
    videos: [],
    cards: [
      {
        body: 'Poussette canne légère',
        title: 'Poussette canne',
        link_url: 'https://kidsmarket.youcan.shop/p/canne',
        cta_text: 'Acheter',
        resized_image_url: 'https://scontent.xx.fbcdn.net/v/t39/card.jpg',
        original_image_url: 'https://scontent.xx.fbcdn.net/v/t39/card-orig.jpg',
      },
    ],
  },
};
const badItem = { ad_archive_id: 'abc', snapshot: { page_name: 'No id' } };

const connection = {
  count: 57,
  edges: [{ node: { collated_results: [videoItem, imageItem] } }, { node: { collated_results: [dcoItem, badItem] } }],
  page_info: { end_cursor: 'AQHR{x}', has_next_page: true },
};
const facebookJson = (conn) => JSON.stringify(conn).replace(/</g, '\\u003C');
const page = (conn) =>
  [
    '<!DOCTYPE html><html><head><title>Bibliothèque publicitaire</title>',
    // a first occurrence of the key that is not the data (must be skipped)
    '<script>requireLazy(["Relay"],function(){var q={"search_results_connection":null,"x":"}"};});</script>',
    '</head><body><div id="root"></div>',
    `<script type="application/json" data-sjs>{"require":[["ScheduledServerJS","handle",null,[{"__bbox":{"result":{"data":{"ad_library_main":{"search_results_connection":${facebookJson(conn)}}}}}}]]]}</script>`,
    '</body></html>',
  ].join('');

// ---------------------------------------------------------------- readAdLibrary
test('readAdLibrary finds the connection, its count and the collated items', () => {
  const r = readAdLibrary(30, page(connection));
  assert.equal(r.found, true);
  assert.equal(r.count, 57);
  assert.equal(r.items.length, 4);
  assert.deepEqual(r.items[0], videoItem); // braces, quotes and backslashes inside strings survived
  assert.deepEqual(r.items[2], dcoItem);
});

test('readAdLibrary keeps at most max items', () => {
  const r = readAdLibrary(2, page(connection));
  assert.equal(r.items.length, 2);
  assert.equal(r.count, 57);
});

test('readAdLibrary: a page with count 0 is an empty result, not a failure', () => {
  const r = readAdLibrary(30, page({ count: 0, edges: [] }));
  assert.deepEqual(r, { found: true, count: 0, items: [] });
});

test('readAdLibrary: login wall, captcha or a page still streaming → not found', () => {
  assert.equal(readAdLibrary(30, '<html><body><form id="login_form"></form></body></html>').found, false);
  assert.equal(readAdLibrary(30, '<script>{"search_results_connection":{"count":3,"edges":[{"node":').found, false);
  assert.equal(readAdLibrary(30, '<script>{"search_results_connection":null}</script>').found, false);
});

test('readAdLibrary stays self-contained (Chrome sends only its source to the tab)', () => {
  // Rebuild it from its source alone, as chrome.scripting.executeScript does, and run it again.
  const copy = new Function(`return (${readAdLibrary.toString()})`)();
  assert.equal(copy(30, page(connection)).items.length, 4);
});

// ---------------------------------------------------------------- fromLibrary
test('fromLibrary: video ad', () => {
  assert.deepEqual(fromLibrary(videoItem), {
    id: '1234567890123',
    collationId: '987654321',
    copies: 4,
    pageId: '111222333',
    pageName: 'Bébé Store DZ',
    pageUrl: 'https://www.facebook.com/bebestoredz/',
    startedAt: 1760000000,
    active: true,
    platforms: ['FACEBOOK', 'INSTAGRAM'],
    body: 'Poussette 3 en 1 {promo} "pliable" à 12900 دج <b> C:\\',
    title: 'Poussette 3 en 1',
    linkUrl: 'https://bebestore.dzbuild.app/p/poussette',
    cta: 'Commander',
    isVideo: true,
    mediaUrl: 'https://scontent.xx.fbcdn.net/v/t15/preview.jpg?x=1',
    media: null,
  });
});

test('fromLibrary: image ad', () => {
  assert.deepEqual(fromLibrary(imageItem), {
    id: '2234567890123',
    collationId: '887654321',
    copies: 1,
    pageId: '444555666',
    pageName: 'Maman Shop',
    pageUrl: 'https://www.facebook.com/mamanshop/',
    startedAt: 1760000000,
    active: false,
    platforms: ['FACEBOOK', 'MESSENGER'],
    body: 'Promo poussette 9 800 DA, livraison 58 wilayas',
    title: null,
    linkUrl: null,
    cta: 'Envoyer un message',
    isVideo: false,
    mediaUrl: 'https://scontent.xx.fbcdn.net/v/t39/resized.jpg',
    media: null,
  });
});

test('fromLibrary: dynamic (DCO) ad with {{product.name}} templates', () => {
  const a = fromLibrary(dcoItem);
  assert.equal(a.id, '3234567890123');
  assert.equal(a.copies, 2);
  assert.equal(a.body, ''); // the template is dropped (same rule as packages/core)
  assert.equal(a.title, null);
  assert.equal(a.linkUrl, 'https://kidsmarket.youcan.shop/p/canne'); // from the first card
  assert.equal(a.cta, 'Acheter');
  assert.equal(a.mediaUrl, 'https://scontent.xx.fbcdn.net/v/t39/card.jpg');
  assert.equal(a.isVideo, false);
  assert.equal(a.pageUrl, null);
  assert.deepEqual(a.platforms, ['FACEBOOK']);
});

test('fromLibrary: an item without a valid ad id is dropped', () => {
  assert.equal(fromLibrary(badItem), null);
  assert.equal(fromLibrary(null), null);
  const ads = readAdLibrary(30, page(connection)).items.map(fromLibrary).filter(Boolean);
  assert.deepEqual(
    ads.map((a) => a.id),
    ['1234567890123', '2234567890123', '3234567890123'],
  );
});

// Same result as packages/core (when it is built), and valid for the RawAdSchema that spy.ingest checks.
test('fromLibrary matches packages/core and RawAdSchema', (t) => {
  let core;
  try {
    core = createRequire(import.meta.url)('../../../packages/core/dist/modules/spy.js');
  } catch {
    t.skip('packages/core is not built (npm run build -w @pilotix/core)');
    return;
  }
  for (const item of [videoItem, imageItem, dcoItem, badItem]) assert.deepEqual(fromLibrary(item), core.fromLibrary(item));
  for (const item of [videoItem, imageItem, dcoItem]) {
    const ad = { ...fromLibrary(item), media: `data:image/jpeg;base64,${'A'.repeat(1000)}` };
    const r = core.RawAdSchema.safeParse(ad);
    assert.ok(r.success, JSON.stringify(r.error?.issues));
  }
});

// ---------------------------------------------------------------- the search, the addresses, the pictures
test('checkSearch validates the query, the country and max', () => {
  assert.deepEqual(checkSearch({ query: '  poussette  ' }), { query: 'poussette', country: 'DZ', max: 30 });
  assert.deepEqual(checkSearch({ query: 'x', country: 'ma', max: 100 }), { query: 'x', country: 'MA', max: 60 });
  assert.equal(checkSearch({ query: 'x', max: 0 }).max, 1);
  assert.equal(checkSearch({ query: 'x', max: 'abc' }).max, 30);
  assert.throws(() => checkSearch({ query: '   ' }), /entre 1 et 60/);
  assert.throws(() => checkSearch({ query: 'a'.repeat(61) }), /entre 1 et 60/);
  assert.throws(() => checkSearch({ query: 42 }), /entre 1 et 60/);
  assert.throws(() => checkSearch({ query: 'x', country: 'DZA' }), /2 lettres/);
});

test('libraryUrl is the Ad Library search Pilotix links to', () => {
  assert.equal(
    libraryUrl('poussette bébé', 'DZ'),
    'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=DZ&q=poussette%20b%C3%A9b%C3%A9&search_type=keyword_unordered&media_type=all',
  );
});

test('pilotixOrigin accepts https sites and http://localhost only', () => {
  assert.equal(pilotixOrigin('app.maboutique.dz'), 'https://app.maboutique.dz');
  assert.equal(pilotixOrigin(' https://App.MaBoutique.dz/admin/spy?x=1 '), 'https://app.maboutique.dz');
  assert.equal(pilotixOrigin('localhost:5173'), 'http://localhost:5173');
  assert.equal(pilotixOrigin('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
  assert.throws(() => pilotixOrigin('http://app.maboutique.dz'), /https/);
  assert.throws(() => pilotixOrigin('https://web.facebook.com'), /Facebook/);
  assert.throws(() => pilotixOrigin(''), /Tapez/);
  assert.throws(() => pilotixOrigin('ftp://x.dz'), /invalide/);
  assert.equal(originPattern('https://app.maboutique.dz'), 'https://app.maboutique.dz/*');
  assert.match(scriptId('https://app.maboutique.dz'), /^pilotix-[0-9a-z]+$/);
  assert.equal(scriptId('https://app.maboutique.dz'), scriptId('https://app.maboutique.dz'));
  assert.notEqual(scriptId('https://app.maboutique.dz'), scriptId('https://app.autre.dz'));
});

test('pictures: size and base64', () => {
  assert.deepEqual(fitSize(800, 600), { width: 400, height: 300 });
  assert.deepEqual(fitSize(400, 1200), { width: 200, height: 600 });
  assert.deepEqual(fitSize(200, 100), { width: 200, height: 100 }); // never enlarged
  assert.deepEqual(fitSize(0, 100), { width: 0, height: 0 });
  const bytes = new Uint8Array(100_003).map((_, i) => (i * 7919) & 255);
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'));
});
