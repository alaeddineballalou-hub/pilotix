// AI Spy on Pilotix's own key (control room › Pilot AI › Spy AI): the owner saves the key of the main tool and of a
// backup, which never come back; a shop picks « Recherche Pilotix » and never brings a key; the main tool answers, the
// backup takes over when it fails; each shop has its own daily limit, which stops a search (and the morning scan) without
// marking anything « arrêtée »; the control room counts each shop's searches.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, Ctx, fromLibrary, login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, shopCtx, shopStatus, staffLogin, Tenancy } from '../index';
import { loadShop, passwordFromLink } from '../platform';
import type { REGISTRY } from '../registry';
import type { z } from 'zod';

type Reg = typeof REGISTRY;
const c = <N extends keyof Reg>(name: N, ctx: Ctx, input: z.input<Reg[N]['input']>) => call(name, ctx, input) as Promise<Awaited<ReturnType<Reg[N]['run']>>>;

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const PW = 'Boutique-Password-1';
const DAY = 86_400_000;

async function server() {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  const t = pgliteTenancy(pg as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  const pctx: PCtx = { t, staff, now: () => Date.now() };
  const p = <T = any>(name: string, input: unknown = {}) => platformCall(name, pctx, input) as Promise<T>;
  return { t, p };
}

/** What the search tools were asked, and whether the main one (ScrapeCreators) is down. */
const asked: { tool: string; key: string; q: string; country: string }[] = [];
let mainDown = false;
const ad = (id: string, page: string, body: string) =>
  fromLibrary({
    ad_archive_id: id,
    collation_count: 1,
    collation_id: `c${id}`,
    page_id: `p-${page}`,
    start_date: Math.floor(Date.now() / 1000) - 20 * 86_400,
    is_active: true,
    publisher_platform: ['FACEBOOK'],
    snapshot: { page_name: page, body: { text: body }, link_url: 'https://shop.dzbuild.app/p/1', cta_text: 'Order now', images: [{ resized_image_url: 'https://scontent.fbcdn.net/x.jpg' }] },
  });
const hooks: Ctx['server'] = {
  courier: async () => null,
  meta: async () => null,
  hashPassword: async (p) => p,
  spy: async (action, args: any) => {
    if (action === 'search') {
      asked.push({ tool: args.source, key: args.key, q: args.query, country: args.country });
      if (mainDown && args.source === 'scrapecreators') throw new Error('ScrapeCreators : plus de crédits');
      // one ad per keyword, its page named after the keyword
      return { count: 3, ads: [ad(`80${Math.abs([...String(args.query)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7))}`.slice(0, 15), `Seller ${args.query}`, `${args.query} 11900 دج`)!] };
    }
    if (action === 'media') return 'data:image/jpeg;base64,AAAA';
    if (action === 'site') return { checkedAt: new Date().toISOString(), ok: true, platform: 'DZBuild', title: 't', price: 11900, oldPrice: null, whatsapp: true, wilayas: 58, stopdesk: true };
    throw new Error(action);
  },
};

/** A shop's person as the server builds them: its rules, the whole server's data, the server's tools. */
async function as(t: Tenancy, shopId: number, email: string, password: string, now = () => Date.now()): Promise<Ctx> {
  const s = (await loadShop(t, { id: shopId }))!;
  const db = t.shop(s.schema);
  return { db, session: await login(db, email, password), now, emit: () => {}, shop: shopCtx(s, shopStatus(s, Date.now(), 3)), t, server: hooks };
}

async function product(db: Ctx['db'], name: string, sku: string) {
  await db.query(`INSERT INTO products (name, sku, price) VALUES ($1, $2, 12000)`, [name, sku]);
  return Number((await db.query(`SELECT id FROM products WHERE sku = $1`, [sku]))[0].id);
}

const SETTINGS = { dailyScan: true, scanHour: 0, ownPages: '', maxPerKeyword: 30 };

test('Pilotix’s key: saved in the control room and never shown; a shop never brings one; main tool, then the backup', async () => {
  const { t, p } = await server();
  const home = (await loadShop(t, { primary: true }))!;
  const a = await as(t, home.id, OWNER.email, OWNER.password);
  const pid = await product(a.db, 'Poussette', 'POUS');

  // nothing yet: off, no key, 20 a day; the shop may already pick « Recherche Pilotix », which is not ready
  const k0 = await p('p.spy.key');
  assert.deepEqual({ ...k0, today: undefined }, { enabled: false, main: 'scrapecreators', perShopDay: 20, keys: { scrapecreators: false, searchapi: false }, today: undefined });
  // a key a shop sends is ignored: on Pilotix's server a shop has none
  await c('spy.settings.save', a, { source: 'scrapecreators', ...SETTINGS, keys: { scrapecreators: 'shop-own-key-123456' } });
  const g0 = await c('spy.settings.get', a, {});
  assert.equal(g0.settings.source, 'pilotix', 'a tool chosen by a shop is Pilotix’s search');
  assert.deepEqual(g0.keys, { scrapecreators: false, searchapi: false });
  assert.equal(g0.platform, true);
  assert.deepEqual(g0.pilotix, { used: 0, max: 20, ready: false });
  assert.equal((await a.db.query(`SELECT count(*)::int AS n FROM settings WHERE key LIKE 'secret_spy_%' AND value::text LIKE '%shop-own-key%'`))[0].n, 0);
  await assert.rejects(c('spy.search', a, { productId: pid }), /pas encore prête/);
  assert.equal(asked.length, 0);

  // the owner saves both keys: a key with spaces is refused; the keys never come back
  await assert.rejects(p('p.spy.keySave', { enabled: true, main: 'scrapecreators', perShopDay: 20, keys: { scrapecreators: 'not a key' } }), /Clé invalide/);
  const k1 = await p('p.spy.keySave', { enabled: true, main: 'scrapecreators', perShopDay: 20, keys: { scrapecreators: ' sc-key-1234567890 ', searchapi: 'sa-key-1234567890' } });
  assert.deepEqual(k1.keys, { scrapecreators: true, searchapi: true });
  assert.ok(!JSON.stringify(await p('p.spy.key')).includes('1234567890'));
  assert.ok(!JSON.stringify(await c('spy.settings.get', a, {})).includes('1234567890'));
  const log = await t.platform.query<{ d: string }>(`SELECT details::text AS d FROM platform.audit WHERE action = 'spy.key'`);
  assert.equal(log.length, 1);
  assert.match(log[0].d, /"scrapecreators": ?"new"/);
  assert.ok(!log[0].d.includes('1234567890'), 'the audit says « new », never the key');

  // the shop searches with Pilotix's main tool, in Algeria; each keyword is one search of its day
  await c('spy.keywords.save', a, { productId: pid, keywords: [{ q: 'poussette', lang: 'fr' }, { q: 'عربة أطفال', lang: 'ar' }] });
  const r1 = await c('spy.search', a, { productId: pid });
  assert.deepEqual(asked.map((x) => [x.tool, x.key, x.country]), [['scrapecreators', 'sc-key-1234567890', 'DZ'], ['scrapecreators', 'sc-key-1234567890', 'DZ']]);
  assert.equal(r1.found, 2);
  assert.equal(r1.limited, false);
  assert.deepEqual(r1.quota, { used: 2, max: 20 });
  const v1 = await c('spy.view', a, { productId: pid });
  assert.equal(v1.source, 'pilotix');
  assert.equal(v1.hasKey, true);
  assert.deepEqual(v1.quota, { used: 2, max: 20, ready: true });
  assert.ok(v1.ads.some((x) => x.pageName === 'Seller poussette' && x.active));

  // the main tool fails: the backup answers, still one search per keyword
  asked.length = 0;
  mainDown = true;
  const r2 = await c('spy.search', a, { productId: pid });
  assert.deepEqual(asked.map((x) => x.tool), ['scrapecreators', 'searchapi', 'scrapecreators', 'searchapi']);
  assert.ok(asked.filter((x) => x.tool === 'searchapi').every((x) => x.key === 'sa-key-1234567890'));
  assert.equal(r2.found, 2);
  assert.deepEqual(r2.quota, { used: 4, max: 20 });
  // SearchAPI.io as the main tool: asked first, ScrapeCreators is then the backup (still down: never needed)
  asked.length = 0;
  await p('p.spy.keySave', { enabled: true, main: 'searchapi', perShopDay: 20 });
  assert.deepEqual((await p('p.spy.key')).keys, { scrapecreators: true, searchapi: true }, 'keys not sent are kept');
  await c('spy.search', a, { productId: pid });
  assert.deepEqual(asked.map((x) => x.tool), ['searchapi', 'searchapi']);
  mainDown = false;

  // removing a key; turned off, the shop is told to use the extension (which has no limit)
  await p('p.spy.keySave', { enabled: true, main: 'searchapi', perShopDay: 20, keys: { searchapi: null } });
  assert.deepEqual((await p('p.spy.key')).keys, { scrapecreators: true, searchapi: false });
  await p('p.spy.keySave', { enabled: false, main: 'scrapecreators', perShopDay: 20 });
  await assert.rejects(c('spy.search', a, { productId: pid }), /pas encore prête : utilisez l’extension/);
  assert.equal((await c('spy.settings.get', a, {})).pilotix?.ready, false);
  // « Tester » runs on the server only (no shop hook here: it says so)
  const tst = await p('p.spy.keyTest', { tool: 'scrapecreators' });
  assert.equal(tst.ok, false);
  await assert.rejects(p('p.spy.keyTest', { tool: 'searchapi' }), /Ajoutez d’abord la clé/);
  // the extension stays the shop's other choice
  await c('spy.settings.save', a, { source: 'extension', ...SETTINGS, keys: {} });
  assert.equal((await c('spy.settings.get', a, {})).settings.source, 'extension');
  await assert.rejects(c('spy.search', a, { productId: pid }), /extension/);
});

test('the daily limit: per shop and per day; a cut search marks nothing « arrêtée »; the morning scan waits for tomorrow', async () => {
  asked.length = 0;
  mainDown = false;
  const { t, p } = await server();
  const home = (await loadShop(t, { primary: true }))!;
  await p('p.spy.keySave', { enabled: true, main: 'scrapecreators', perShopDay: 3, keys: { scrapecreators: 'sc-key-1234567890' } });
  const a = await as(t, home.id, OWNER.email, OWNER.password);
  const pid = await product(a.db, 'Poussette', 'POUS');
  const bib = await product(a.db, 'Biberon', 'BIB');
  await c('spy.settings.save', a, { source: 'pilotix', ...SETTINGS, keys: {} });
  await c('spy.keywords.save', a, { productId: pid, keywords: [{ q: 'poussette', lang: 'fr' }, { q: 'عربة أطفال', lang: 'ar' }] });
  await c('spy.keywords.save', a, { productId: bib, keywords: [{ q: 'biberon', lang: 'fr' }, { q: 'رضاعة', lang: 'ar' }] });

  // 2 of 3: the poussette's two keywords
  const r1 = await c('spy.search', a, { productId: pid });
  assert.deepEqual(r1.quota, { used: 2, max: 3 });
  // the third search is the poussette's first keyword: the second waits, its ad is not « arrêtée »
  const r2 = await c('spy.search', a, { productId: pid });
  assert.equal(r2.limited, true);
  assert.equal(r2.keywords, 1);
  assert.equal(r2.stopped, 0);
  assert.deepEqual(r2.quota, { used: 3, max: 3 });
  const v = await c('spy.view', a, { productId: pid });
  assert.ok(v.ads.find((x) => x.pageName === 'Seller عربة أطفال')?.active, 'the keyword not searched keeps its ads active');
  assert.ok(v.keywords.every((k) => k.count === 3), 'each keyword keeps its place and count');
  assert.deepEqual(v.quota, { used: 3, max: 3, ready: true });
  // nothing left today: the shop is told plainly
  await assert.rejects(c('spy.search', a, { productId: bib }), /Limite du jour atteinte \(3 recherches par jour\)/);
  assert.equal(asked.length, 3);

  // the morning scan today: nothing left, it stops at once (the biberon was never searched)
  const s1 = await c('spy.scan', a, {});
  assert.deepEqual(s1, { ran: true, products: 0 });
  assert.equal(asked.length, 3);
  // tomorrow (Algeria's day): 3 new searches; the biberon (never scanned) comes first
  const tomorrow = await as(t, home.id, OWNER.email, OWNER.password, () => Date.now() + DAY);
  const s2 = await c('spy.scan', tomorrow, {});
  assert.equal(s2.ran, true);
  assert.deepEqual(asked.slice(3).map((x) => x.q), ['biberon', 'رضاعة', 'poussette']);
  assert.deepEqual((await c('spy.view', tomorrow, { productId: bib })).quota, { used: 3, max: 3, ready: true });

  // another shop has its own limit
  const biz = (await p<any[]>('p.plans.list')).find((x: any) => x.code === 'business');
  const made = await p('p.shops.create', { name: 'Cosmo', ownerName: 'Lina', ownerEmail: 'lina@cosmo.dz', planId: biz.id, trialDays: 14 });
  await passwordFromLink(t, made.mail.token, PW);
  const b = await as(t, made.id, 'lina@cosmo.dz', PW);
  const crem = await product(b.db, 'Crème', 'CREM');
  await c('spy.settings.save', b, { source: 'pilotix', ...SETTINGS, keys: {} });
  await c('spy.keywords.save', b, { productId: crem, keywords: [{ q: 'crème visage', lang: 'fr' }] });
  assert.deepEqual((await c('spy.search', b, { productId: crem })).quota, { used: 1, max: 3 });

  // the control room: today's searches of every shop, and each shop's in the Spy AI board
  const k = await p('p.spy.key');
  assert.deepEqual(k.today, { searches: 4, shops: 2 });
  const board = await p('p.spy.board', { days: 7 });
  assert.equal(board.kpi.searches, 4, 'the period ends today: tomorrow’s 3 are not in it yet');
  assert.equal(board.rows.find((r: any) => r.key === String(home.id))?.searches, 3);
  assert.equal(board.rows.find((r: any) => r.key === String(made.id))?.searches, 1);
  // a higher limit opens today again at once
  await p('p.spy.keySave', { enabled: true, main: 'scrapecreators', perShopDay: 5 });
  assert.equal((await c('spy.search', a, { productId: bib })).quota?.used, 5);
});
