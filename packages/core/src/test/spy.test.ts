// AI Spy: competitors' Facebook ads for the shop's products. The library data (from the extension or a paid source)
// becomes grouped creatives with a score, own ads are recognised, stopped ads and followed pages make alerts, Claude's
// reading is parsed, and only admins choose the source and its keys.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, fromLibrary } from '../index';
import { builderOf, groupKey, jsonIn, linkExpiry, linkFresh, linkTypeOf, pageRules, pricesIn, RawAd, sitePageKey, SpySite, spyScore } from '../modules/spy';
import type { REGISTRY } from '../registry';
import { libraryItems, readSite, robotsAllow, runSpy, wallIn } from '../spy-server';
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

test('a single shop on its own server: only admins choose the source and its keys; keys never come back', async () => {
  // its own server (no control room); this one has no search tools (a test then says where it happens)
  const own: Ctx['server'] = { courier: async () => null, meta: async () => null, hashPassword: async (p) => p };
  const ad = await as(EMAILS.admin, own);
  const m = await as(EMAILS.marketer, own);
  await assert.rejects(c('spy.settings.save', m, { source: 'searchapi', dailyScan: true, scanHour: 6, ownPages: '', maxPerKeyword: 30, keys: { searchapi: 'k' } }), /Accès refusé/);
  await assert.rejects(c('spy.settings.save', ad, { source: 'pilotix', dailyScan: true, scanHour: 6, ownPages: '', maxPerKeyword: 30, keys: {} }), /serveur de Pilotix/);
  await c('spy.settings.save', ad, { source: 'searchapi', dailyScan: true, scanHour: 6, ownPages: '', maxPerKeyword: 30, keys: { searchapi: 'secret-key-123' } });
  const g = await c('spy.settings.get', m, {});
  assert.equal(g.settings.source, 'searchapi');
  assert.equal(g.keys.searchapi, true);
  assert.equal(g.platform, false);
  assert.equal(g.pilotix, null);
  assert.ok(!JSON.stringify(g).includes('secret-key-123'));
  const t = await c('spy.settings.test', ad, { source: 'searchapi' });
  assert.equal(t.ok, false);
  assert.match(t.message, /serveur/);

  // the browser preview shows a shop of Pilotix's server: « Recherche Pilotix » (its made-up day), no key boxes
  const g2 = await c('spy.settings.get', mk, {});
  assert.equal(g2.settings.source, 'pilotix', 'an own key counts as Pilotix’s search there');
  assert.deepEqual(g2.keys, { scrapecreators: false, searchapi: false });
  assert.equal(g2.platform, true);
  assert.deepEqual(g2.pilotix, { used: 6, max: 20, ready: true });
  const v = await c('spy.view', mk, { productId: pou });
  assert.equal(v.source, 'pilotix');
  assert.equal(v.hasKey, true);
  assert.match((await c('spy.settings.test', admin, { source: 'searchapi' })).message, /Pilotix/);
  await c('spy.settings.save', admin, { source: 'scrapecreators', dailyScan: false, scanHour: 6, ownPages: '', maxPerKeyword: 30, keys: { scrapecreators: 'x-key-123456' } });
  assert.equal((await c('spy.settings.get', ad, {})).keys.scrapecreators, false, 'a key sent from the preview is not kept');

  await c('spy.settings.save', ad, { source: 'extension', dailyScan: true, scanHour: 6, ownPages: '', maxPerKeyword: 30, keys: { searchapi: null } });
  assert.equal((await c('spy.settings.get', ad, {})).keys.searchapi, false);
  await assert.rejects(c('spy.search', m, { productId: pou }), /extension/);
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

test('a site’s « no robots » rule (robots.txt) and the protection walls against robots are read right', () => {
  const txt = ['User-agent: *', 'Disallow: /checkout', 'Disallow: /*?variant=', 'Allow: /products/', 'Disallow: /products/private$', '', '# others', 'User-agent: GPTBot', 'Disallow: /'].join('\n');
  assert.equal(robotsAllow(txt, '/products/chaise'), true);
  assert.equal(robotsAllow(txt, '/checkout/123'), false);
  assert.equal(robotsAllow(txt, '/products/chaise?variant=2'), false, 'the longest rule decides');
  assert.equal(robotsAllow(txt, '/products/private'), false);
  assert.equal(robotsAllow(txt, '/products/private-sale'), true, '« $ » is the end of the address');
  assert.equal(robotsAllow('User-agent: *\nDisallow: /', '/x'), false);
  assert.equal(robotsAllow('User-agent: *\nDisallow:', '/x'), true, '« Disallow: » alone forbids nothing');
  assert.equal(robotsAllow('User-agent: GPTBot\nDisallow: /', '/x'), true, 'another robot’s rule is not Pilotix’s');
  assert.equal(robotsAllow('User-agent: PilotixSpy\nDisallow: /\n\nUser-agent: *\nAllow: /', '/x'), false, 'a rule naming Pilotix comes first');
  assert.equal(robotsAllow('User-agent: Googlebot\nUser-agent: *\nDisallow: /shop/', '/shop/a'), false, 'two robots, one group');
  assert.equal(robotsAllow('User-agent: *\nDisallow: /shop/\nAllow: /shop/', '/shop/a'), true, 'Allow wins a tie');
  assert.equal(robotsAllow('<html><body>Page introuvable</body></html>', '/x'), true, 'a page instead of the file: no rule');
  const h = (o: Record<string, string> = {}) => new Headers(o);
  assert.equal(wallIn(403, h({ server: 'cloudflare' }), '<html>Sorry, you have been blocked</html>'), true);
  assert.equal(wallIn(403, h(), '<title>Attention Required! | Cloudflare</title>'), true);
  assert.equal(wallIn(503, h(), '<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script>'), true);
  assert.equal(wallIn(200, h({ 'cf-mitigated': 'challenge' }), ''), true);
  assert.equal(wallIn(200, h(), '<html><head><title>Just a moment...</title></head></html>'), true);
  assert.equal(wallIn(429, h(), ''), true, '« too many visits » is a no too');
  assert.equal(wallIn(404, h(), '<title>Page introuvable</title>'), false);
  assert.equal(wallIn(503, h(), '<title>Maintenance</title>'), false, 'a site in trouble is not a wall');
  assert.equal(wallIn(200, h(), '<title>Chaise haute</title><form><div class="g-recaptcha"></div></form>'), false, 'a shop page with a captcha on its form is read');
  assert.equal(sitePageKey('https://www.Shop.dz/products/chaise/?fbclid=1#top'), 'shop.dz/products/chaise');
  assert.equal(sitePageKey('https://shop.dz/'), 'shop.dz');
  assert.equal(sitePageKey('wa.me/213'), null);
});

test('the server reads a site once: never a page its rule forbids, never past a wall, the reason kept', async () => {
  const real = globalThis.fetch;
  const asked: string[] = [];
  const page = '<html><head><title>Lit parapluie</title></head><body><h1>Lit</h1><span>14 500 دج</span> <s>18 000 دج</s></body></html>';
  const html = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });
  globalThis.fetch = (async (input: any) => {
    const u = String(input);
    asked.push(u);
    if (u === 'https://norobots.spy-test.dz/robots.txt') return new Response('User-agent: *\nDisallow: /products/\nAllow: /products/ok', { status: 200 });
    if (u === 'https://walled.spy-test.dz/robots.txt') return new Response('', { status: 404 });
    if (u.startsWith('https://walled.spy-test.dz/'))
      return html('<html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script></body></html>', 403, { server: 'cloudflare', 'cf-mitigated': 'challenge' });
    if (u === 'https://open.spy-test.dz/robots.txt') return new Response('User-agent: GPTBot\nDisallow: /', { status: 200 });
    if (u.startsWith('https://open.spy-test.dz/') || u === 'https://norobots.spy-test.dz/products/ok') return html(page);
    return new Response('', { status: 500 });
  }) as typeof fetch;
  try {
    const ctx = { now: () => Date.now() } as Ctx;
    const site = (url: string) => runSpy('site', { url }, ctx) as Promise<SpySite>;
    const no = await site('https://norobots.spy-test.dz/products/lit?ref=fb');
    assert.deepEqual([no.ok, no.blocked, no.price], [false, 'robots', null]);
    assert.ok(!asked.some((u) => u.includes('/products/lit')), 'a page the rule forbids is never asked for');
    const ok = await site('https://norobots.spy-test.dz/products/ok');
    assert.deepEqual([ok.ok, ok.price, ok.oldPrice], [true, 14500, 18000]);
    assert.equal(asked.filter((u) => u === 'https://norobots.spy-test.dz/robots.txt').length, 1, 'the rule is read once for the site');
    const wall = await site('https://walled.spy-test.dz/lit');
    assert.deepEqual([wall.ok, wall.blocked], [false, 'wall']);
    assert.equal(asked.filter((u) => u === 'https://walled.spy-test.dz/lit').length, 1, 'one try, nothing to get round it');
    const open = await site('https://open.spy-test.dz/lit');
    assert.deepEqual([open.ok, open.price, open.title], [true, 14500, 'Lit parapluie']);
    const down = await site('https://gone.spy-test.dz/lit');
    assert.deepEqual([down.ok, down.blocked], [false, 'down']);
    assert.ok(!asked.includes('https://gone.spy-test.dz/lit'), 'no answer about the rule: the page waits');
  } finally {
    globalThis.fetch = real;
  }
});

test('sites in a round: a wall is asked once, an earlier reading stays; a price given by a person goes on its page and stays', async () => {
  const cha = Number((await db.query(`SELECT id FROM products WHERE sku = 'PX-CHA'`))[0].id);
  const asked: string[] = [];
  let mode: 'good' | 'robots' = 'good';
  const no = (blocked: 'robots' | 'wall'): SpySite => ({ checkedAt: new Date().toISOString(), ok: false, blocked, platform: null, title: null, price: null, oldPrice: null, whatsapp: false, wilayas: null, stopdesk: false });
  const server: Ctx['server'] = {
    courier: async () => null,
    meta: async () => null,
    hashPassword: async (p) => p,
    spy: async (action, args: any) => {
      if (action === 'media') return null;
      if (action !== 'site') throw new Error(action);
      asked.push(args.url);
      if (String(args.url).includes('walled.')) return no('wall');
      if (mode === 'robots') return no('robots');
      return { checkedAt: new Date().toISOString(), ok: true, platform: 'YouCan', title: 'Chaise', price: 8200, oldPrice: 9900, whatsapp: false, wilayas: 58, stopdesk: true };
    },
  };
  const m = await as(EMAILS.marketer, server);
  const ad = (id: string, page: string, link: string, text: string) => fromLibrary(item(id, page, text, { snapshot: { page_name: page, body: { text }, link_url: link, cards: [] } })) as RawAd;
  const ads = [
    ad('810000001', 'Wall Shop', 'https://walled.shop-test.dz/chaise-a', 'Chaise haute A'),
    ad('810000002', 'Wall Shop', 'https://walled.shop-test.dz/chaise-b', 'Chaise haute B'),
    ad('810000003', 'Open Shop', 'https://www.open.shop-test.dz/products/chaise/?fbclid=1', 'Chaise haute évolutive'),
  ];
  const since = new Date().toISOString();
  await c('spy.ingest', m, { productId: cha, keyword: 'chaise haute', count: 3, ads });
  await c('spy.finish', m, { productId: cha, since });
  assert.equal(asked.filter((u) => u.includes('walled.')).length, 1, 'a walled site is asked once per round');
  let v = await c('spy.view', m, { productId: cha });
  const walled = v.ads.filter((a) => a.pageName === 'Wall Shop');
  assert.equal(walled.length, 2);
  assert.ok(walled.every((a) => a.site?.ok === false && a.site.blocked === 'wall' && a.price === null));
  const open = v.ads.find((a) => a.pageName === 'Open Shop')!;
  assert.deepEqual([open.site?.ok, open.site?.price, open.site?.blocked], [true, 8200, null]);
  assert.ok(open.site?.readAt);

  // a week later the shop forbids robots: last week's reading stays, with its date
  mode = 'robots';
  const week = 8 * 86_400_000;
  const later: Ctx = { ...m, now: () => Date.now() + week };
  const since2 = new Date(Date.now() + week - 1000).toISOString();
  await c('spy.ingest', later, { productId: cha, keyword: 'chaise haute', count: 3, ads });
  await c('spy.finish', later, { productId: cha, since: since2 });
  v = await c('spy.view', later, { productId: cha });
  const open2 = v.ads.find((a) => a.pageName === 'Open Shop')!;
  assert.deepEqual([open2.site?.ok, open2.site?.blocked, open2.site?.price, open2.site?.readAt], [false, 'robots', 8200, open.site?.readAt]);

  // a price typed by hand goes on its page's ads (not on the shop's other page); it is the ad's price when it shows none
  const a = walled.find((x) => x.adId === '810000001')!;
  assert.equal((await c('spy.sitePrice', m, { via: 'hand', productId: cha, gkey: a.gkey, price: 7500, oldPrice: 9000 })).saved, 1);
  v = await c('spy.view', m, { productId: cha });
  let a1 = v.ads.find((x) => x.gkey === a.gkey)!;
  assert.deepEqual([a1.manual?.price, a1.manual?.oldPrice, a1.manual?.via, a1.price, a1.oldPrice], [7500, 9000, 'hand', 7500, 9000]);
  // Chrome: found by the page's address (www, a query, a last « / » or a # change nothing)
  const b = walled.find((x) => x.adId === '810000002')!;
  assert.equal((await c('spy.sitePrice', m, { via: 'chrome', url: 'https://www.walled.shop-test.dz/chaise-b/?utm_source=fb#top', price: 7600 })).saved, 1);
  v = await c('spy.view', m, { productId: cha });
  assert.deepEqual([v.ads.find((x) => x.gkey === b.gkey)!.manual?.via, v.ads.find((x) => x.gkey === b.gkey)!.price], ['chrome', 7600]);
  // another address of the same shop (a redirect): the ad on screen; another shop: nothing
  assert.equal((await c('spy.sitePrice', m, { via: 'chrome', url: 'https://walled.shop-test.dz/p/12345', price: 7700, productId: cha, gkey: a.gkey })).saved, 1);
  assert.equal((await c('spy.sitePrice', m, { via: 'chrome', url: 'https://nowhere-test.dz/chaise', price: 7000, productId: cha, gkey: a.gkey })).saved, 0);
  await assert.rejects(c('spy.sitePrice', m, { via: 'chrome', url: 'pas une adresse', price: 7000 }));

  // the server's next round never overwrites it; taken back by hand
  const later2: Ctx = { ...m, now: () => Date.now() + 2 * week };
  await c('spy.ingest', later2, { productId: cha, keyword: 'chaise haute', count: 3, ads });
  await c('spy.finish', later2, { productId: cha, since: new Date(Date.now() + 2 * week - 1000).toISOString() });
  v = await c('spy.view', later2, { productId: cha });
  a1 = v.ads.find((x) => x.gkey === a.gkey)!;
  assert.deepEqual([a1.manual?.price, a1.manual?.via, a1.site?.blocked], [7700, 'chrome', 'wall']);
  await c('spy.sitePrice', m, { via: 'hand', productId: cha, gkey: a.gkey, price: null });
  v = await c('spy.view', m, { productId: cha });
  assert.equal(v.ads.find((x) => x.gkey === a.gkey)!.manual, null);
});

test('« Lire la page »: the offers, the delivery and the promises of a page read by Chrome go on its ads', async () => {
  // the simple rules (no AI): short lines that name them, French or Arabic
  const r = pageRules('Poussette canne\n11 900 DA\nOffre : 2 achetées = 1 offerte\nالتوصيل مجاني لـ 58 ولاية\nGarantie 1 an\nالدفع عند الاستلام\nAjouter au panier');
  assert.deepEqual(r.offers, ['Offre : 2 achetées = 1 offerte']);
  assert.deepEqual([r.delivery, r.deliveryNote], [0, 'التوصيل مجاني لـ 58 ولاية']);
  assert.deepEqual(r.whyUs, ['Garantie 1 an', 'الدفع عند الاستلام']);
  assert.deepEqual([pageRules('Livraison : 400 DA partout').delivery, pageRules('Rien à dire ici').offers], [400, []]);

  const cha = Number((await db.query(`SELECT id FROM products WHERE sku = 'PX-CHA'`))[0].id);
  const ad = fromLibrary(item('820000001', 'Page Shop', 'Chaise pliante', { snapshot: { page_name: 'Page Shop', body: { text: 'Chaise pliante' }, link_url: 'https://page.shop-test.dz/chaise', cards: [] } })) as RawAd;
  await c('spy.ingest', mk, { productId: cha, keyword: 'chaise pliante', count: 1, ads: [ad] });
  const text = 'Chaise pliante\n8 500 DA\nPromo -20 % ce week-end\nLivraison 500 DA, 48 h\nQualité premium, garantie 2 ans';
  // no AI: the rules; a price and the page together
  const a = await c('spy.sitePrice', mk, { via: 'chrome', url: 'https://page.shop-test.dz/chaise', price: 8500, page: { text } });
  assert.equal(a.saved, 1);
  assert.deepEqual([a.read?.ai, a.read?.delivery, a.read?.offers, a.read?.whyUs], [false, 500, ['Promo -20 % ce week-end'], ['Qualité premium, garantie 2 ans']]);
  let v = await c('spy.view', mk, { productId: cha });
  let x = v.ads.find((y) => y.adId === '820000001')!;
  assert.deepEqual([x.manual?.price, x.pageRead?.delivery, x.pageRead?.deliveryNote], [8500, 500, 'Livraison 500 DA, 48 h']);
  // Claude (here the preview's page AI): its JSON; no price in DA on the page: the price stays
  const pageAi: Ctx['dellalAi'] = async () => ({
    content: [{ type: 'text', text: '{"offers":["Pack 2 chaises : 15 000 DA"],"delivery":0,"deliveryNote":"Gratuite partout","whyUs":["Garantie 2 ans","Inventé ? non"]}' }],
    stop_reason: 'end_turn',
  });
  const b = await c('spy.sitePrice', { ...mk, dellalAi: pageAi }, { via: 'chrome', url: 'https://page.shop-test.dz/chaise/', price: null, page: { text } });
  assert.deepEqual([b.saved, b.read?.ai, b.read?.delivery, b.read?.offers], [1, true, 0, ['Pack 2 chaises : 15 000 DA']]);
  v = await c('spy.view', mk, { productId: cha });
  x = v.ads.find((y) => y.adId === '820000001')!;
  assert.deepEqual([x.manual?.price, x.pageRead?.ai, x.pageRead?.deliveryNote], [8500, true, 'Gratuite partout']);
  // a page of no ad here: nothing read, nothing kept; nothing at all to read: refused
  const none = await c('spy.sitePrice', mk, { via: 'chrome', url: 'https://other-test.dz/x', price: null, page: { text } });
  assert.deepEqual(none, { saved: 0, read: null });
  await assert.rejects(c('spy.sitePrice', mk, { via: 'chrome', url: 'https://page.shop-test.dz/chaise', price: null, page: { text: '  ' } }));
});

test('tags: the AI’s Identique / Ressemble / Pas le même, a person’s choice that stays, the shop’s own tags', async () => {
  const lit = Number((await db.query(`SELECT id FROM products WHERE sku = 'PX-LIT'`))[0].id);
  const ad = (id: string, page: string, text: string) => fromLibrary(item(id, page, text, { snapshot: { page_name: page, body: { text }, link_url: `https://${id}.shop-test.dz/lit`, cards: [] } })) as RawAd;
  await c('spy.ingest', mk, { productId: lit, keyword: 'lit parapluie', count: 3, ads: [ad('830000001', 'Same Shop', 'Lit parapluie A'), ad('830000002', 'Near Shop', 'Lit cododo B'), ad('830000003', 'Other Shop', 'Poussette C')] });
  // the AI reads them: same product, a close one, another product
  const pageAi: Ctx['dellalAi'] = async (req) => {
    const list = JSON.parse(String(req.messages[0].content).split('Pubs :\n')[1]);
    const out = list.map((x: any) => ({ id: x.id, relevant: x.page !== 'Other Shop', same: x.page === 'Same Shop', hook: 'h', angle: 'a', offer: 'o', keep: 'k', weak: 'w', price: null }));
    return { content: [{ type: 'text', text: JSON.stringify(out) }], stop_reason: 'end_turn' };
  };
  const withAi: Ctx = { ...mk, dellalAi: pageAi };
  await c('spy.analyze', withAi, { productId: lit });
  let v = await c('spy.view', mk, { productId: lit });
  const by = (page: string) => v.ads.find((a) => a.pageName === page);
  assert.deepEqual([by('Same Shop')?.tag, by('Same Shop')?.tagBy, by('Near Shop')?.tag], ['same', 'ai', 'like']);
  assert.equal(by('Other Shop'), undefined, 'Pas le même: out of the list');
  // a person changes it: kept, even when the AI reads the ad again
  const near = by('Near Shop')!;
  await c('spy.tag', mk, { productId: lit, gkey: near.gkey, tag: 'same' });
  await db.query(`UPDATE spy_ads SET ai = NULL WHERE product_id = $1`, [lit]);
  await c('spy.analyze', withAi, { productId: lit });
  v = await c('spy.view', mk, { productId: lit });
  assert.deepEqual([by('Near Shop')?.tag, by('Near Shop')?.tagBy, by('Near Shop')?.same], ['same', 'person', true]);
  // the shop's own tags: one on an ad; taken out of the list, the ad gets the AI's again
  const saved = await c('spy.tagsSave', mk, { tags: [{ label: 'Concurrent direct' }, { label: 'concurrent DIRECT' }, { label: 'À copier' }] });
  assert.deepEqual(saved.tags.map((t) => t.label), ['Concurrent direct', 'À copier'], 'the same label once');
  const mine = saved.tags[0].id;
  await c('spy.tag', mk, { productId: lit, gkey: by('Same Shop')!.gkey, tag: mine });
  v = await c('spy.view', mk, { productId: lit });
  assert.deepEqual([by('Same Shop')?.tag, by('Same Shop')?.tagBy], [mine, 'person']);
  await assert.rejects(c('spy.tag', mk, { productId: lit, gkey: by('Same Shop')!.gkey, tag: 't:nope' }), /inconnu/);
  await c('spy.tagsSave', mk, { tags: [{ id: saved.tags[1].id, label: 'À copier' }] });
  v = await c('spy.view', mk, { productId: lit });
  assert.deepEqual([by('Same Shop')?.tag, by('Same Shop')?.tagBy], ['same', 'ai']);
  // Pas le même by hand = « Pas pertinente »; brought back, no tag of a person
  await c('spy.tag', mk, { productId: lit, gkey: near.gkey, tag: 'other' });
  assert.ok((await c('spy.hidden', mk, { productId: lit })).some((a) => a.gkey === near.gkey));
  await c('spy.hide', mk, { productId: lit, gkey: near.gkey, hidden: false });
  v = await c('spy.view', mk, { productId: lit });
  assert.equal(by('Near Shop')?.tagBy, 'ai');
});

test('Facebook’s ad library with the extension: an ad kept from there, with its tag, its page followed', async () => {
  const lit = Number((await db.query(`SELECT id FROM products WHERE sku = 'PX-LIT'`))[0].id);
  const raw = fromLibrary(item('840000001', 'Library Shop', 'Lit parapluie pliant 9900 DA', { page_id: 'p-lib-1', snapshot: { page_name: 'Library Shop', body: { text: 'Lit parapluie pliant 9900 DA' }, link_url: 'https://lib.shop-test.dz/lit', cards: [] } })) as RawAd;
  let info = await c('spy.libraryInfo', mk, { adIds: ['840000001'] });
  assert.ok(info.products.some((p) => p.id === lit));
  assert.deepEqual(info.ads, []);
  const r = await c('spy.libraryAd', mk, { productId: lit, ad: raw, tag: 'like', follow: true });
  assert.deepEqual([r.added, r.tag, r.tagBy, r.followed], [true, 'like', 'person', true]);
  info = await c('spy.libraryInfo', mk, { adIds: ['840000001', '999'] });
  assert.deepEqual(info.ads.map((a) => [a.adId, a.productId, a.tag]), [['840000001', lit, 'like']]);
  assert.ok(info.followed.some((f) => f.key === r.pageKey && f.name === 'Library Shop'));
  assert.equal(info.ads[0].pageKey, r.pageKey);
  const v = await c('spy.view', mk, { productId: lit });
  const a = v.ads.find((x) => x.adId === '840000001')!;
  assert.deepEqual([a.source, a.price, a.followed], ['library', 9900, true]);
  // without a tag and without AI: kept, no tag yet; unfollowed
  const r2 = await c('spy.libraryAd', mk, { productId: lit, ad: { ...raw, id: '840000002', body: 'Autre texte' }, follow: false });
  assert.deepEqual([r2.tag, r2.followed], [null, false]);
});

test('videos: Facebook’s link plays while it works; Pilotix keeps a copy of the followed pages’ and the tagged ads’ videos', async () => {
  const now = Date.now();
  const DAY = 86_400_000;
  const hex = (ms: number) => Math.floor(ms / 1000).toString(16).toUpperCase();
  const link = (n: number, until: number) => `https://video.falg1-1.fna.fbcdn.net/v/t42.1790-2/v${n}.mp4?_nc_cat=1&oe=${hex(until)}&oh=00_x`;
  const vid = (id: string, page: string, body: string, sd: string | null) =>
    item(id, page, body, {
      snapshot: { page_name: page, body: { text: body }, link_url: 'https://v.shop-test.dz/p', videos: [{ video_sd_url: sd, video_hd_url: 'https://evil.example/x.mp4', video_preview_image_url: 'https://scontent.fbcdn.net/p.jpg' }], cards: [] },
    });
  // the link: Facebook's servers only, the lighter file first; its « oe » part says when it stops working
  assert.equal(fromLibrary(vid('850000001', 'Vid Shop', 'x', link(1, now + 5 * DAY)))!.videoUrl, link(1, now + 5 * DAY));
  assert.equal(fromLibrary(vid('850000002', 'Vid Shop', 'x', null))!.videoUrl, null);
  assert.equal(linkExpiry(link(1, 1_800_000_000_000)), 1_800_000_000_000);
  assert.equal(linkFresh(link(1, now + 30 * 60_000), null, now), false);
  assert.equal(linkFresh(link(1, now + 2 * 3_600_000), null, now), true);
  assert.equal(linkFresh('https://video.fbcdn.net/v/x.mp4', now - DAY, now), true);
  assert.equal(linkFresh('https://video.fbcdn.net/v/x.mp4', now - 6 * DAY, now), false);

  // found by the extension: Facebook's link plays, no copy yet; an expired link plays nothing
  const lit = Number((await db.query(`SELECT id FROM products WHERE sku = 'PX-LIT'`))[0].id);
  const L = { tagged: link(2, now + 5 * DAY), followed: link(3, now + 5 * DAY), other: link(4, now + 5 * DAY), old: link(5, now - DAY) };
  const ads = [
    fromLibrary(vid('850000011', 'Vid Tagged', 'Lit parapluie vidéo A 9900 DA', L.tagged))!,
    fromLibrary(vid('850000012', 'Vid Followed', 'Lit parapluie vidéo B 9900 DA', L.followed))!,
    fromLibrary(vid('850000013', 'Vid Other', 'Lit parapluie vidéo C 9900 DA', L.other))!,
    fromLibrary(vid('850000014', 'Vid Old', 'Lit parapluie vidéo D 9900 DA', L.old))!,
  ];
  await c('spy.ingest', mk, { productId: lit, keyword: 'lit vidéo', count: 4, ads });
  let v = await c('spy.view', mk, { productId: lit });
  const by = (page: string) => v.ads.find((x) => x.pageName === page)!;
  assert.deepEqual([by('Vid Tagged').video, by('Vid Tagged').videoKept], [L.tagged, false]);
  assert.deepEqual([by('Vid Old').isVideo, by('Vid Old').video], [true, null]);

  // a person tags one, follows another page; the server's job copies those two videos, never the others
  await c('spy.tag', mk, { productId: lit, gkey: by('Vid Tagged').gkey, tag: 'same' });
  await c('spy.tag', mk, { productId: lit, gkey: by('Vid Old').gkey, tag: 'same' });
  await c('spy.follow', mk, { pageKey: by('Vid Followed').pageKey, pageName: 'Vid Followed', productId: lit, on: true });
  const kept: string[] = [];
  let refuse = false;
  const server: Ctx['server'] = {
    courier: async () => null,
    meta: async () => null,
    hashPassword: async (p) => p,
    publicApi: 'https://pilotix.test/api',
    spyVideo: async (action, a) => {
      assert.equal(action, 'keep');
      if (refuse) throw new Error('Vidéo indisponible (403)');
      kept.push(a.url);
      return { key: String(kept.length).padStart(24, 'a'), bytes: 123_456 };
    },
  };
  const a = await as(EMAILS.admin, server);
  assert.deepEqual(await c('spy.videos', a, {}), { kept: 2, failed: 0 });
  assert.deepEqual([...kept].sort(), [L.followed, L.tagged].sort());
  v = await c('spy.view', a, { productId: lit });
  assert.match(by('Vid Tagged').video ?? '', /^https:\/\/pilotix\.test\/api\/lp\/spyvid\/a{23}[12]\.mp4$/);
  assert.deepEqual([by('Vid Tagged').videoKept, by('Vid Followed').videoKept, by('Vid Other').videoKept], [true, true, false]);
  assert.equal(by('Vid Other').video, L.other);
  // nothing more to copy: the expired link is not tried
  assert.deepEqual(await c('spy.videos', a, {}), { kept: 0, failed: 0 });

  // a link the server cannot download: 3 tries, then left alone until the ad is seen again with a new link
  await c('spy.tag', mk, { productId: lit, gkey: by('Vid Other').gkey, tag: 'like' });
  refuse = true;
  for (let i = 0; i < 4; i++) await c('spy.videos', a, {});
  const row = async (page: string) => (await db.query(`SELECT video_tries, video_copy FROM spy_ads WHERE product_id = $1 AND page_name = $2`, [lit, page]))[0];
  assert.deepEqual([Number((await row('Vid Other')).video_tries), (await row('Vid Other')).video_copy], [3, null]);
  assert.equal(Number((await row('Vid Old')).video_tries), 0);
  refuse = false;
  const again = link(6, now + 4 * DAY);
  await c('spy.ingest', mk, { productId: lit, keyword: 'lit vidéo', count: 1, ads: [fromLibrary(vid('850000013', 'Vid Other', 'Lit parapluie vidéo C 9900 DA', again))!] });
  assert.deepEqual(await c('spy.videos', a, {}), { kept: 1, failed: 0 });
  assert.equal(kept.at(-1), again);
  // the browser preview (no server): Facebook's link, never the copy's address
  v = await c('spy.view', mk, { productId: lit });
  assert.deepEqual([by('Vid Other').video, by('Vid Other').videoKept], [again, true]);
});

test('the demo: its video ads play the demo’s own films; the followed pages’ ones are kept', async () => {
  const v = await c('spy.view', mk, { productId: pou });
  const videos = v.ads.filter((a) => a.isVideo && a.source === 'demo');
  assert.ok(videos.length >= 3);
  assert.ok(videos.every((a) => a.video === 'demo://spy-video/pou'));
  assert.deepEqual([...new Set(videos.filter((a) => a.videoKept).map((a) => a.pageName))], ['Bébé Confort DZ']);
});
