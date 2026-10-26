// AI Spy: competitors' Facebook ads for the shop's products. The library data (from the extension or a paid source)
// becomes grouped creatives with a score, own ads are recognised, stopped ads and followed pages make alerts, Claude's
// reading is parsed, and only admins choose the source and its keys.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, fromLibrary } from '../index';
import { builderOf, groupKey, jsonIn, linkTypeOf, pricesIn, RawAd, spyScore } from '../modules/spy';
import type { REGISTRY } from '../registry';
import { libraryItems, readSite } from '../spy-server';
import { EMAILS, setup } from './harness';
import type { z } from 'zod';

type Reg = typeof REGISTRY;
/** call() with the action's real input and output types */
const c = <N extends keyof Reg>(name: N, ctx: Ctx, input: z.input<Reg[N]['input']>) => call(name, ctx, input) as Promise<Awaited<ReturnType<Reg[N]['run']>>>;

let db: Db;
let admin: Ctx;
let mk: Ctx;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
let pou: number;
let bib: number;

before(async () => {
  const s = await setup(150);
  db = s.db;
  as = s.as;
  admin = await s.as(EMAILS.admin);
  mk = await s.as(EMAILS.marketer);
  pou = Number((await db.query(`SELECT id FROM products WHERE sku = 'PX-POU'`))[0].id);
  bib = Number((await db.query(`SELECT id FROM products WHERE sku = 'PX-BIB'`))[0].id);
});

const item = (id: string, page: string, body: string, over: Record<string, unknown> = {}) => ({
  ad_archive_id: id,
  collation_count: 1,
  collation_id: `c${id}`,
  page_id: `p-${page}`,
  start_date: Math.floor(Date.now() / 1000) - 40 * 86_400,
  is_active: true,
  publisher_platform: ['FACEBOOK', 'INSTAGRAM'],
  snapshot: { page_name: page, body: { text: body }, link_url: 'https://shop.dzbuild.app/p/1', cta_text: 'Order now', images: [{ resized_image_url: 'https://scontent.fbcdn.net/x.jpg' }], videos: [], cards: [] },
  ...over,
});

test('library data → an ad (Facebook page, ScrapeCreators and SearchAPI.io share the shape)', () => {
  const a = fromLibrary(item('1234567890123', 'Shop A', 'عربة أطفال 9800 دج'))!;
  assert.equal(a.id, '1234567890123');
  assert.equal(a.pageName, 'Shop A');
  assert.equal(a.body, 'عربة أطفال 9800 دج');
  assert.equal(a.linkUrl, 'https://shop.dzbuild.app/p/1');
  assert.equal(a.mediaUrl, 'https://scontent.fbcdn.net/x.jpg');
  assert.deepEqual(a.platforms, ['FACEBOOK', 'INSTAGRAM']);
  assert.equal(a.isVideo, false);
  // a dynamic ad's template text is not kept; a video is recognised; ISO dates work
  const v = fromLibrary(item('1234567890124', 'Shop B', '{{product.brand}}', { start_date: '2026-09-01T00:00:00Z', snapshot: { page_name: 'Shop B', body: { text: '{{product.name}}' }, videos: [{ video_sd_url: 'https://v', video_preview_image_url: 'https://p' }], cards: [] } }))!;
  assert.equal(v.body, '');
  assert.equal(v.isVideo, true);
  assert.equal(v.mediaUrl, 'https://p');
  assert.equal(v.startedAt, Math.round(Date.parse('2026-09-01T00:00:00Z') / 1000));
  assert.equal(fromLibrary({ snapshot: {} }), null);
  // a provider's answer: the ads wherever their list is
  const nested = { data: { edges: [{ node: { collated_results: [item('111111', 'A', 'x')] } }, { node: { collated_results: [item('222222', 'B', 'y')] } }] } };
  assert.deepEqual(
    libraryItems(nested).map((x) => x.ad_archive_id),
    ['111111', '222222'],
  );
  assert.equal(libraryItems({ searchResults: [item('333333', 'C', 'z')], searchResultsCount: 58 }).length, 1);
});

test('prices, links and shop builders read from an ad', () => {
  assert.deepEqual(pricesIn('سرير 12900 دج بدل 18000 دج'), { price: 12900, old: 18000 });
  assert.deepEqual(pricesIn('Poussette DZD4,400 livraison'), { price: 4400, old: null });
  assert.deepEqual(pricesIn('🔥 كل هذا بسعر Déstockage: 9,800 دج'), { price: 9800, old: null });
  assert.deepEqual(pricesIn('3 500 دج بدل 4 500 دج + 2 إيطاجار'), { price: 3500, old: 4500 });
  assert.deepEqual(pricesIn('livraison 58 wilayas, 0770 12 34 56'), { price: null, old: null });
  assert.equal(linkTypeOf('https://wa.me/213555', null), 'whatsapp');
  assert.equal(linkTypeOf('https://api.whatsapp.com/send', 'Send WhatsApp message'), 'whatsapp');
  assert.equal(linkTypeOf('https://m.me/shop', null), 'messenger');
  assert.equal(linkTypeOf(null, 'Send message'), 'messenger');
  assert.equal(linkTypeOf('https://instagram.com/x', null), 'instagram');
  assert.equal(linkTypeOf('https://fb.me/x', null), 'page');
  assert.equal(linkTypeOf('https://icosiumkids.dzbuild.app/product/1', 'Order now'), 'site');
  assert.equal(builderOf('https://icosiumkids.dzbuild.app/product/1'), 'DZBuild');
  assert.equal(builderOf('https://metaluxe.a.ayor.ai/x'), 'Ayor');
  assert.equal(builderOf('https://shop.example.dz'), null);
  // same page + same text (spaces, emojis aside) = one creative
  assert.equal(groupKey({ id: '1', pageId: 'p1', pageName: 'A', body: 'Poussette 🔥 9800 DA', title: null }), groupKey({ id: '2', pageId: 'p1', pageName: 'A', body: 'poussette 9800 da', title: null }));
  assert.notEqual(groupKey({ id: '1', pageId: 'p1', pageName: 'A', body: 'Poussette', title: null }), groupKey({ id: '1', pageId: 'p2', pageName: 'B', body: 'Poussette', title: null }));
});

test('the score only uses what the library shows', () => {
  const strong = spyScore({ days: 120, copies: 13, active: true, isVideo: true, placements: 5 }, 3);
  assert.equal(strong.total, 100);
  const fresh = spyScore({ days: 1, copies: 1, active: true, isVideo: false, placements: 1 }, 0);
  assert.ok(fresh.total < 20);
  assert.deepEqual(
    strong.parts.map((p) => p.key),
    ['days', 'copies', 'active', 'video', 'placements', 'others'],
  );
});

test('the demo shop shows competitors, its own ad, a brief and findings', async () => {
  const products = await c('spy.products', mk, {});
  const p = products.find((x) => x.id === pou)!;
  assert.ok(p.ads >= 4);
  assert.equal(p.ownAds, 1);
  const v = await c('spy.view', mk, { productId: pou });
  assert.equal(v.demo, true);
  assert.ok(v.ads.length >= 5);
  assert.ok(v.ads.every((a, i) => i === 0 || v.ads[i - 1].score >= a.score), 'sorted by score');
  assert.ok(v.ads.some((a) => a.own));
  assert.ok(v.ads.every((a) => a.media?.startsWith('data:image/svg+xml')));
  assert.equal(v.ads[0].scoreParts.length, 6);
  assert.ok(v.brief && v.brief.hooks.length === 3);
  assert.ok(v.keywords.length >= 3);
  const f = await c('spy.findings', mk, {});
  const kinds = f.map((x) => x.kind);
  for (const k of ['scaling', 'longest', 'yourBest', 'cheaper', 'newcomer']) assert.ok(kinds.includes(k as any), `finding ${k}`);
  const followed = await c('spy.followed', mk, {});
  assert.equal(followed.pages.length, 2);
  assert.ok(followed.events.length >= 3);
});

test('extension: copies are grouped, own ads recognised, stopped ads and followed pages make alerts', async () => {
  await c('spy.settings.save', admin, { source: 'extension', dailyScan: true, scanHour: 6, ownPages: 'Ma Boutique\nmaboutique.dz', maxPerKeyword: 30, keys: {} });
  const raw = (x: any) => fromLibrary(x) as RawAd;
  const since1 = new Date().toISOString();
  const ads = [
    raw(item('500000001', 'Rival', 'Biberon anti-colique 1500 دج', { collation_count: 3 })),
    raw(item('500000002', 'Rival', 'Biberon anti-colique 1500 دج', { collation_count: 2, start_date: Math.floor(Date.now() / 1000) - 80 * 86_400 })),
    raw(item('500000003', 'Other', 'Biberon 1200 DA', { snapshot: { page_name: 'Other', body: { text: 'Biberon 1200 DA' }, link_url: 'https://m.me/other', cards: [] } })),
    raw(item('500000004', 'Ma Boutique', 'Notre biberon 1450 دج', { snapshot: { page_name: 'Ma Boutique', body: { text: 'Notre biberon 1450 دج' }, link_url: 'https://www.maboutique.dz/p/bib', cards: [] } })),
  ];
  await c('spy.follow', mk, { pageKey: 'p-Other', pageName: 'Other', productId: bib, on: true });
  const r = await c('spy.ingest', mk, { productId: bib, keyword: 'biberon', count: 41, ads });
  assert.deepEqual(r, { added: 3, updated: 0 });
  await c('spy.finish', mk, { productId: bib, since: since1 });
  let v = await c('spy.view', mk, { productId: bib });
  const rival = v.ads.find((a) => a.pageName === 'Rival')!;
  assert.equal(rival.copies, 5);
  assert.equal(rival.adId, '500000002', 'the oldest copy is shown');
  assert.ok(rival.days >= 79);
  assert.equal(rival.price, 1500);
  assert.equal(rival.platform, 'DZBuild');
  assert.equal(v.ads.find((a) => a.pageName === 'Other')!.linkType, 'messenger');
  assert.equal(v.ads.find((a) => a.pageName === 'Ma Boutique')!.own, true);
  assert.equal(v.keywords.find((k) => k.q === 'biberon')!.count, 41);
  assert.ok(v.ads.find((a) => a.pageName === 'Other')!.followed);

  // next search: « Other » is gone (stopped), « Rival » changed nothing
  await new Promise((res) => setTimeout(res, 5));
  const since2 = new Date().toISOString();
  await c('spy.ingest', mk, { productId: bib, keyword: 'biberon', count: 40, ads: [ads[0], ads[1], ads[3]] });
  const fin = await c('spy.finish', mk, { productId: bib, since: since2 });
  assert.equal(fin.stopped, 1);
  v = await c('spy.view', mk, { productId: bib });
  assert.equal(v.ads.find((a) => a.pageName === 'Other')!.active, false);
  const ev = await c('spy.followed', mk, {});
  assert.ok(ev.events.some((e) => e.kind === 'new_ad' && e.page === 'Other'));
  assert.ok(ev.events.some((e) => e.kind === 'stopped' && e.page === 'Other'));

  // « pas pertinente »: out of the list, still in « masquées »
  await c('spy.hide', mk, { productId: bib, gkey: rival.gkey, hidden: true });
  v = await c('spy.view', mk, { productId: bib });
  assert.ok(!v.ads.some((a) => a.gkey === rival.gkey));
  assert.equal((await c('spy.hidden', mk, { productId: bib })).length, 1);
  await c('spy.hide', mk, { productId: bib, gkey: rival.gkey, hidden: false });
});

test('only admins choose the source and its keys; keys never come back', async () => {
  await assert.rejects(c('spy.settings.save', mk, { source: 'searchapi', dailyScan: true, scanHour: 6, ownPages: '', maxPerKeyword: 30, keys: { searchapi: 'k' } }), /Accès refusé/);
  await c('spy.settings.save', admin, { source: 'searchapi', dailyScan: true, scanHour: 6, ownPages: '', maxPerKeyword: 30, keys: { searchapi: 'secret-key-123' } });
  const g = await c('spy.settings.get', mk, {});
  assert.equal(g.settings.source, 'searchapi');
  assert.equal(g.keys.searchapi, true);
  assert.ok(!JSON.stringify(g).includes('secret-key-123'));
  // in the preview (no server) a test explains itself instead of failing
  const t = await c('spy.settings.test', admin, { source: 'searchapi' });
  assert.equal(t.ok, false);
  assert.match(t.message, /serveur/);
  await c('spy.settings.save', admin, { source: 'extension', dailyScan: true, scanHour: 6, ownPages: '', maxPerKeyword: 30, keys: { searchapi: null } });
  assert.equal((await c('spy.settings.get', admin, {})).keys.searchapi, false);
  await assert.rejects(c('spy.search', mk, { productId: pou }), /extension/);
});

test('paid source: the server searches every keyword, stores, reads sites; the daily scan runs once a day', async () => {
  const asked: string[] = [];
  const server: Ctx['server'] = {
    courier: async () => null,
    meta: async () => null,
    hashPassword: async (p) => p,
    spy: async (action, args: any) => {
      if (action === 'search') {
        asked.push(args.query);
        assert.equal(args.key, 'sc-key');
        assert.equal(args.country, 'DZ');
        return { count: 12, ads: [fromLibrary(item(`70000${asked.length}`, `Seller ${args.query}`, `Poussette ${args.query} 11900 دج`))] };
      }
      if (action === 'media') return 'data:image/jpeg;base64,AAAA';
      if (action === 'site') return { checkedAt: new Date().toISOString(), ok: true, platform: 'DZBuild', title: 't', price: 11900, oldPrice: 15000, whatsapp: true, wilayas: 58, stopdesk: true };
      throw new Error(action);
    },
  };
  const a = await as(EMAILS.admin, server);
  await c('spy.settings.save', a, { source: 'scrapecreators', dailyScan: true, scanHour: 0, ownPages: '', maxPerKeyword: 30, keys: { scrapecreators: 'sc-key' } });
  await c('spy.keywords.save', a, { productId: pou, keywords: [{ q: 'poussette', lang: 'fr' }, { q: 'عربة أطفال', lang: 'ar' }] });
  const r = await c('spy.search', a, { productId: pou });
  assert.deepEqual(asked, ['poussette', 'عربة أطفال']);
  assert.equal(r.found, 2);
  const v = await c('spy.view', a, { productId: pou });
  const got = v.ads.find((x) => x.pageName === 'Seller poussette')!;
  assert.equal(got.media, 'data:image/jpeg;base64,AAAA');
  assert.equal(got.site?.oldPrice, 15000);
  assert.equal(got.site?.wilayas, 58);
  assert.equal(v.keywords[0].count, 12);
  // the demo ads were not seen by this search: they stop
  assert.ok(r.stopped >= 5);
  // the hourly job: once a day
  asked.length = 0;
  const s1 = await c('spy.scan', a, {});
  assert.equal(s1.ran, true);
  assert.ok(asked.length >= 2);
  const s2 = await c('spy.scan', a, {});
  assert.deepEqual(s2, { ran: false, why: 'done today' });
  await c('spy.settings.save', a, { source: 'extension', dailyScan: true, scanHour: 6, ownPages: '', maxPerKeyword: 30, keys: {} });
});

test('Claude reads the ads (page AI in the preview); without AI the keywords come from the product name', async () => {
  const plain = await c('spy.keywords.suggest', mk, { productId: bib });
  assert.ok(plain.length >= 2);
  assert.ok(plain.some((k) => k.lang === 'price' && /دج/.test(k.q)));
  assert.deepEqual(await c('spy.analyze', mk, { productId: bib }), { analyzed: 0, demo: true });
  await db.query(`UPDATE spy_ads SET ai = NULL WHERE product_id = $1`, [bib]);
  const pageAi: Ctx['dellalAi'] = async (req) => {
    const list = JSON.parse(String(req.messages[0].content).split('Pubs :\n')[1]);
    const out = list.map((x: any) => ({ id: x.id, relevant: !/Other/.test(x.page), same: true, hook: 'Accroche', angle: 'Angle', offer: 'Offre', keep: 'À garder', weak: 'Faible', price: null }));
    return { content: [{ type: 'text', text: 'Voici :\n```json\n' + JSON.stringify(out) + '\n```' }], stop_reason: 'end_turn' };
  };
  const withAi: Ctx = { ...mk, dellalAi: pageAi };
  const r = await c('spy.analyze', withAi, { productId: bib });
  assert.ok(r.analyzed >= 2);
  const v = await c('spy.view', mk, { productId: bib });
  assert.ok(!v.ads.some((a) => a.pageName === 'Other'), 'not relevant → hidden');
  assert.equal(v.ads.find((a) => a.pageName === 'Rival')!.ai?.hook, 'Accroche');
  assert.deepEqual(jsonIn<number[]>('```json\n[1,2]\n```'), [1, 2]);
  assert.equal(jsonIn('pas de json'), null);
});

test("a competitor's page: builder, price, crossed price, the order form", () => {
  const options = Array.from({ length: 70 }, (_, i) => `<option value="${i}">${i}</option>`).join('');
  const html = `<html><head><title>Poussette 3 en 1</title><script src="https://cdn.shopify.com/s.js"></script></head><body><h1>Poussette</h1><span>9,800.00 DZD</span> <s>13,900.00 DZD</s><select name="wilaya">${options}</select><a href="https://wa.me/213">WhatsApp</a> توصيل إلى المكتب</body></html>`;
  const s = readSite(html, 'https://www.finlandshop.site/poussette', 0);
  assert.equal(s.platform, 'Shopify');
  assert.equal(s.price, 9800);
  assert.equal(s.oldPrice, 13900);
  assert.equal(s.wilayas, 69);
  assert.equal(s.whatsapp, true);
  assert.equal(s.stopdesk, true);
  assert.equal(s.title, 'Poussette 3 en 1');
  const plain = readSite('<html><body>Livraison 58 wilayas — 4950 دج</body></html>', 'https://babyjoydz.net/product/1', 0);
  assert.equal(plain.wilayas, 58);
  assert.equal(plain.price, 4950);
});
