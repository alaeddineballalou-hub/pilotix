// AI Spy: the competitors' Facebook ads for the shop's own products (Algeria), with their creative, their site, their
// price, a score and Claude's reading. Each shop chooses where the ads come from:
//  - the Pilotix Chrome extension (free): the user's own Chrome opens the public Ad Library and hands the ads to
//    spy.ingest, one keyword at a time (Facebook refuses these pages to a server, never to a browser);
//  - ScrapeCreators or SearchAPI.io (paid keys, server side): spy.search on demand and the daily scan (spy.scan).
// Facebook's official Ad Library API returns no Algerian shop ads (only political ads and ads shown in the EU).
// Ads are grouped (same page + same text = one creative, its copies added up) and scored from what the library shows:
// days online, copies, video, placements, other sellers. Never spend: Meta does not publish it for Algeria.
// Claude (the Dellal key, or the page's Claude in the preview) reads them: relevance, hook, angle, offer, and a brief.
// The browser preview has seeded ads (seeds/spy.ts) and no network.
import { z } from 'zod';
import { Db, iso, isoOrNull, num, numOrNull } from '../db';
import { bad, Ctx, notFound, proc } from '../rpc';
import { getRaw, setRaw } from './admin';
import { AiRequest, AiResponse, aiKeyed, dellalSettings } from './dellal';

// ---------------------------------------------------------------- settings and secrets
export const SPY_SOURCES = ['extension', 'scrapecreators', 'searchapi'] as const;
export type SpySource = (typeof SPY_SOURCES)[number];
export type SpyPaidSource = Exclude<SpySource, 'extension'>;
export const isPaid = (s: SpySource): s is SpyPaidSource => s !== 'extension';

/** Secret keys (never returned by any action). */
export const SPY_SECRETS = { scrapecreators: 'secret_spy_scrapecreators', searchapi: 'secret_spy_searchapi' } as const;

export interface SpySettings {
  source: SpySource;
  /** paid sources: scan the followed products every morning */
  dailyScan: boolean;
  /** hour of the daily scan, Algeria time */
  scanHour: number;
  /** the shop's own pages or sites, one per line (their ads are marked « Vous ») */
  ownPages: string;
  /** most ads kept per keyword and search */
  maxPerKeyword: number;
}
export const DEFAULT_SPY: SpySettings = { source: 'extension', dailyScan: true, scanHour: 6, ownPages: '', maxPerKeyword: 30 };

export async function spySettings(db: Db): Promise<SpySettings> {
  return { ...DEFAULT_SPY, ...(await getRaw<Partial<SpySettings>>(db, 'spy', {})) };
}
const spyKey = async (db: Db, s: SpyPaidSource) => (await getRaw<string>(db, SPY_SECRETS[s], '')) || '';

// ---------------------------------------------------------------- what the sources hand over
/** One ad as a source gives it (the extension, ScrapeCreators, SearchAPI.io all mirror Facebook's own library data). */
export const RawAdSchema = z.object({
  id: z.string().min(3).max(40),
  collationId: z.string().max(40).nullish(),
  copies: z.number().int().min(1).max(1000).nullish(),
  pageId: z.string().max(40).nullish(),
  pageName: z.string().max(200),
  pageUrl: z.string().max(500).nullish(),
  /** Unix seconds */
  startedAt: z.number().int().nullish(),
  active: z.boolean().nullish(),
  platforms: z.array(z.string().max(40)).max(12).nullish(),
  body: z.string().max(6000).nullish(),
  title: z.string().max(600).nullish(),
  linkUrl: z.string().max(3000).nullish(),
  cta: z.string().max(100).nullish(),
  isVideo: z.boolean().nullish(),
  mediaUrl: z.string().max(4000).nullish(),
  /** a small picture the extension already made (data:image/jpeg;base64,…) */
  media: z.string().max(600_000).nullish(),
});
export type RawAd = z.infer<typeof RawAdSchema>;

const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

/**
 * One item of Facebook's library data (as the Ad Library page, ScrapeCreators and SearchAPI.io give it: ad_archive_id,
 * collation_count, start_date, snapshot{ body, link_url, images, videos, cards… }) → RawAd. Also used by the extension.
 */
export function fromLibrary(r: any): RawAd | null {
  if (!r || typeof r !== 'object') return null;
  const id = str(r.ad_archive_id ?? r.adArchiveID ?? r.adArchiveId ?? r.id);
  if (!/^\d{5,30}$/.test(id)) return null;
  const s = r.snapshot ?? {};
  const cards: any[] = Array.isArray(s.cards) ? s.cards : [];
  const c0 = cards[0] ?? {};
  const img = (Array.isArray(s.images) ? s.images[0] : null) ?? {};
  const vid = (Array.isArray(s.videos) ? s.videos[0] : null) ?? {};
  const body = typeof s.body === 'string' ? s.body : str(s.body?.text ?? s.body?.markup?.__html ?? c0.body);
  const start = r.start_date ?? r.startDate ?? r.start_date_string;
  const startedAt = typeof start === 'number' ? Math.round(start > 1e12 ? start / 1000 : start) : start ? Math.round(Date.parse(String(start)) / 1000) || null : null;
  const plat = r.publisher_platform ?? r.publisherPlatform ?? r.publisher_platforms;
  const media = str(
    img.resized_image_url ?? img.original_image_url ?? c0.resized_image_url ?? c0.original_image_url ?? vid.video_preview_image_url ?? c0.video_preview_image_url ?? '',
  );
  const clean = (t: string) => (/\{\{[^}]+\}\}/.test(t) ? '' : t).slice(0, 6000);
  return {
    id,
    collationId: str(r.collation_id ?? r.collationID ?? '') || null,
    copies: Math.max(1, Math.min(1000, Math.round(num(r.collation_count ?? r.collationCount ?? 1)) || 1)),
    pageId: str(r.page_id ?? s.page_id ?? '') || null,
    pageName: str(s.page_name ?? r.page_name ?? r.pageName ?? '').slice(0, 200) || '—',
    pageUrl: str(s.page_profile_uri ?? '') || null,
    startedAt,
    active: r.is_active === undefined && r.isActive === undefined ? true : !!(r.is_active ?? r.isActive),
    platforms: Array.isArray(plat) ? plat.map((p: unknown) => str(p).toUpperCase()).slice(0, 12) : [],
    body: clean(body || str(c0.body)),
    title: clean(str(s.title ?? c0.title ?? '')).slice(0, 600) || null,
    linkUrl: str(s.link_url ?? c0.link_url ?? '').slice(0, 3000) || null,
    cta: str(s.cta_text ?? c0.cta_text ?? '').slice(0, 100) || null,
    isVideo: !!(vid.video_sd_url || vid.video_hd_url || c0.video_sd_url || c0.video_hd_url || /VIDEO/i.test(str(s.display_format))),
    mediaUrl: media.slice(0, 4000) || null,
    media: null,
  };
}

// ---------------------------------------------------------------- reading an ad
const norm = (t: string) =>
  t
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, 140);
const hash = (t: string) => {
  let h = 5381;
  for (const ch of t) h = ((h * 33) ^ (ch.codePointAt(0) ?? 0)) >>> 0;
  return h.toString(36);
};
/** Same page + same text = the same creative (sellers duplicate one ad many times to scale it). */
export const groupKey = (a: Pick<RawAd, 'pageId' | 'pageName' | 'body' | 'title' | 'id'>) => `${a.pageId || norm(a.pageName)}#${hash(norm(a.body || a.title || a.id))}`;

/** Prices in DA written in a text: « 12900 دج », « 9,800 DA », « DZD4,400 », « 3 500 دج بدل 4 500 دج ». */
export function pricesIn(text: string): { price: number | null; old: number | null } {
  const t = text.replace(/[‎‏]/g, '');
  const vals: number[] = [];
  const val = (s: string) => Number(s.replace(/[\s.,  ]/g, ''));
  const after = /(\d{1,3}(?:[\s.,  ]\d{3})+|\d{3,6})(?:[.,]00)?\s*(?:دج|د\.ج|دينار|DZD|DA|Da|da)(?![a-zA-Z])/g;
  const before = /(?:DZD|دج)\s*(\d{1,3}(?:[\s.,  ]\d{3})+|\d{3,6})/g;
  for (const re of [after, before]) for (const m of t.matchAll(re)) vals.push(val(m[1]));
  const ok = [...new Set(vals.filter((v) => v >= 300 && v <= 400_000))];
  if (!ok.length) return { price: null, old: null };
  if (ok.length >= 2 && /(بدل|بدلا|عوض|au lieu|barr|بدلاً|avant|ancien prix|prix normal)/i.test(t)) return { price: Math.min(...ok), old: Math.max(...ok) };
  return { price: ok[0], old: null };
}

export type LinkType = 'site' | 'messenger' | 'whatsapp' | 'instagram' | 'page' | 'none';
const host = (u: string): string => {
  try {
    return new URL(u).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
};
/** Where the ad sends the customer: a site, or a conversation (about half of Algerian ads have no site). */
export function linkTypeOf(url: string | null | undefined, cta: string | null | undefined): LinkType {
  const h = url ? host(url) : '';
  if (/(^|\.)(wa\.me|whatsapp\.com)$/.test(h) || /whatsapp/i.test(cta ?? '')) return 'whatsapp';
  if (/(^|\.)(m\.me|messenger\.com)$/.test(h) || (!h && /message/i.test(cta ?? ''))) return 'messenger';
  if (/(^|\.)instagram\.com$/.test(h) || /instagram/i.test(cta ?? '')) return 'instagram';
  if (/(^|\.)(facebook\.com|fb\.com|fb\.me)$/.test(h)) return 'page';
  if (h) return 'site';
  return 'none';
}
const BUILDERS: [RegExp, string][] = [
  [/(^|\.)dzbuild\.app$/, 'DZBuild'],
  [/(^|\.)ayor\.ai$/, 'Ayor'],
  [/(^|\.)tassyir\.io$/, 'Tassyir'],
  [/(^|\.)justsell\.store$/, 'JustSell'],
  [/(^|\.)myecomsite\.net$/, 'MyEcomSite'],
  [/(^|\.)foorweb\.store$/, 'Foorweb'],
  [/(^|\.)youcan\.(shop|store)$/, 'YouCan'],
  [/(^|\.)myshopify\.com$/, 'Shopify'],
  [/(^|\.)mylightfunnels\.com$/, 'LightFunnels'],
  [/(^|\.)hanotify\.store$/, 'Hanotify'],
  [/(^|\.)flexdz\.store$/, 'FlexDZ'],
  [/(^|\.)ecomanager\.dz$/, 'EcoManager'],
];
/** The shop builder, when its address tells it (the site check reads the page for the others). */
export const builderOf = (url: string | null | undefined): string | null => {
  const h = url ? host(url) : '';
  for (const [re, name] of BUILDERS) if (re.test(h)) return name;
  return null;
};

// ---------------------------------------------------------------- score
export interface ScorePart {
  key: 'days' | 'copies' | 'active' | 'video' | 'placements' | 'others';
  value: number;
  max: number;
  /** the raw number behind it (days, copies, placements, other sellers) */
  n: number;
}
/** A score from what the library shows (0–100): it ranks ads; it does not prove they are profitable. */
export function spyScore(a: { days: number; copies: number; active: boolean; isVideo: boolean; placements: number }, otherSellers: number): { total: number; parts: ScorePart[] } {
  const parts: ScorePart[] = [
    { key: 'days', value: Math.round((Math.min(a.days, 90) / 90) * 35), max: 35, n: a.days },
    { key: 'copies', value: Math.round(20 * Math.min(1, Math.log(1 + a.copies) / Math.log(14))), max: 20, n: a.copies },
    { key: 'active', value: a.active ? 10 : 0, max: 10, n: a.active ? 1 : 0 },
    { key: 'video', value: a.isVideo ? 10 : 0, max: 10, n: a.isVideo ? 1 : 0 },
    { key: 'placements', value: Math.round(10 * Math.min(1, Math.max(0, a.placements - 1) / 4)), max: 10, n: a.placements },
    { key: 'others', value: Math.round(15 * Math.min(1, otherSellers / 3)), max: 15, n: otherSellers },
  ];
  return { total: Math.min(100, parts.reduce((s, p) => s + p.value, 0)), parts };
}

// ---------------------------------------------------------------- types for the app
export interface SpyKeyword {
  q: string;
  lang: 'ar' | 'darija' | 'fr' | 'en' | 'price';
  /** active ads Facebook found in Algeria at the last search */
  count: number | null;
  at: string | null;
}
export interface SpyAi {
  hook: string;
  angle: string;
  offer: string;
  keep: string;
  weak: string;
}
export interface SpySite {
  checkedAt: string;
  ok: boolean;
  platform: string | null;
  title: string | null;
  price: number | null;
  oldPrice: number | null;
  whatsapp: boolean;
  /** number of wilayas in the order form (58 or 69), when the page has one */
  wilayas: number | null;
  stopdesk: boolean;
}
export interface SpyAd {
  gkey: string;
  adId: string;
  adIds: string[];
  source: string;
  pageKey: string;
  pageName: string;
  pageUrl: string | null;
  body: string;
  title: string | null;
  linkUrl: string | null;
  linkType: LinkType;
  platform: string | null;
  cta: string | null;
  platforms: string[];
  isVideo: boolean;
  media: string | null;
  copies: number;
  startedAt: string | null;
  firstSeen: string;
  lastSeen: string;
  days: number;
  active: boolean;
  own: boolean;
  keyword: string | null;
  price: number | null;
  oldPrice: number | null;
  relevant: boolean | null;
  same: boolean | null;
  ai: SpyAi | null;
  site: SpySite | null;
  followed: boolean;
  score: number;
  scoreParts: ScorePart[];
}
export interface SpyBrief {
  summary: string;
  hooks: { ar: string; fr: string }[];
  offer: string;
  page: string;
  at: string;
  demo: boolean;
}
export interface SpyProductRow {
  id: number;
  name: string;
  sku: string;
  price: number;
  cost: number;
  photo: string | null;
  orders30: number;
  ads: number;
  ownAds: number;
  watch: boolean;
  scannedAt: string | null;
}
export type SpyFinding =
  | { kind: 'scaling'; productId: number; product: string; gkey: string; page: string; copies: number; days: number; price: number | null }
  | { kind: 'longest'; productId: number; product: string; gkey: string; page: string; days: number }
  | { kind: 'yourBest'; productId: number; product: string; gkey: string; copies: number; days: number; price: number | null }
  | { kind: 'cheaper'; productId: number; product: string; gkey: string; page: string; price: number; yours: number }
  | { kind: 'noOwnAd'; productId: number; product: string; orders: number; competitors: number }
  | { kind: 'newcomer'; productId: number; product: string; gkey: string; page: string; creatives: number; days: number };

// ---------------------------------------------------------------- reading the stored ads
const DAY = 86_400_000;
const pageKeyOf = (r: { page_id?: unknown; page_name?: unknown }) => str(r.page_id) || `n:${norm(str(r.page_name))}`;

function rowToAd(r: any, now: number, followed: Set<string>, others: number): SpyAd {
  const startedAt = isoOrNull(r.started_at);
  const firstSeen = iso(r.first_seen);
  const days = Math.max(0, Math.round((now - Date.parse(startedAt ?? firstSeen)) / DAY));
  const platforms: string[] = Array.isArray(r.platforms) ? r.platforms : [];
  const active = !!r.active;
  const isVideo = !!r.is_video;
  const copies = Math.max(1, num(r.copies));
  const pageKey = pageKeyOf(r);
  const sc = spyScore({ days, copies, active, isVideo, placements: Math.max(1, platforms.length) }, others);
  return {
    gkey: str(r.gkey),
    adId: str(r.ad_id),
    adIds: Array.isArray(r.ad_ids) ? r.ad_ids : [],
    source: str(r.source),
    pageKey,
    pageName: str(r.page_name),
    pageUrl: r.page_url ?? null,
    body: str(r.body),
    title: r.title ?? null,
    linkUrl: r.link_url ?? null,
    linkType: (r.link_type ?? 'none') as LinkType,
    platform: r.platform ?? null,
    cta: r.cta ?? null,
    platforms,
    isVideo,
    media: r.media ?? null,
    copies,
    startedAt,
    firstSeen,
    lastSeen: iso(r.last_seen),
    days,
    active,
    own: !!r.own,
    keyword: r.keyword ?? null,
    price: numOrNull(r.price),
    oldPrice: numOrNull(r.old_price),
    relevant: r.relevant === null || r.relevant === undefined ? null : !!r.relevant,
    same: r.same === null || r.same === undefined ? null : !!r.same,
    ai: (r.ai as SpyAi | null) ?? null,
    site: (r.site as SpySite | null) ?? null,
    followed: followed.has(pageKey),
    score: sc.total,
    scoreParts: sc.parts,
  };
}

async function followedKeys(db: Db): Promise<Set<string>> {
  return new Set((await db.query(`SELECT page_key FROM spy_follow`)).map((r: any) => str(r.page_key)));
}

/** A product's stored ads (not the ones marked « pas pertinente »), with their score. */
async function productAds(ctx: Ctx, productId: number, opts: { hidden?: boolean } = {}): Promise<SpyAd[]> {
  const rows = await ctx.db.query(`SELECT * FROM spy_ads WHERE product_id = $1 ${opts.hidden ? '' : 'AND relevant IS NOT FALSE'} ORDER BY last_seen DESC LIMIT 400`, [productId]);
  const now = ctx.now();
  const followed = await followedKeys(ctx.db);
  // other sellers: competitors' pages with an ad online for 30 days or more, for this product
  const longPages = new Set<string>();
  for (const r of rows) {
    if (r.own || r.relevant === false) continue;
    const start = Date.parse(isoOrNull(r.started_at) ?? iso(r.first_seen));
    if (now - start >= 30 * DAY) longPages.add(pageKeyOf(r));
  }
  return rows
    .map((r: any) => {
      const others = longPages.size - (longPages.has(pageKeyOf(r)) ? 1 : 0);
      return rowToAd(r, now, followed, others);
    })
    .sort((a, b) => b.score - a.score || b.days - a.days);
}

async function productRow(db: Db, id: number, now: number): Promise<SpyProductRow> {
  const r = (
    await db.query(
      `SELECT p.id, p.name, p.sku, p.price, p.cost, p.photo,
              (SELECT count(DISTINCT i.order_id) FROM order_items i JOIN orders o ON o.id = i.order_id WHERE i.product_id = p.id AND o.created_at >= $2) AS orders30,
              (SELECT count(*) FROM spy_ads a WHERE a.product_id = p.id AND a.relevant IS NOT FALSE AND NOT a.own) AS ads,
              (SELECT count(*) FROM spy_ads a WHERE a.product_id = p.id AND a.own AND a.active) AS own_ads,
              w.watch, w.scanned_at
       FROM products p LEFT JOIN spy_watch w ON w.product_id = p.id WHERE p.id = $1`,
      [id, new Date(now - 30 * DAY).toISOString()],
    )
  )[0];
  if (!r) throw notFound('Produit introuvable');
  return toProductRow(r);
}
const toProductRow = (r: any): SpyProductRow => ({
  id: num(r.id),
  name: str(r.name),
  sku: str(r.sku),
  price: num(r.price),
  cost: num(r.cost),
  photo: r.photo ?? null,
  orders30: num(r.orders30),
  ads: num(r.ads),
  ownAds: num(r.own_ads),
  watch: r.watch === null || r.watch === undefined ? true : !!r.watch,
  scannedAt: isoOrNull(r.scanned_at),
});

async function keywordsOf(db: Db, productId: number): Promise<SpyKeyword[]> {
  const r = (await db.query(`SELECT keywords FROM spy_watch WHERE product_id = $1`, [productId]))[0];
  return Array.isArray(r?.keywords) ? (r.keywords as SpyKeyword[]) : [];
}
async function saveKeywords(db: Db, productId: number, list: SpyKeyword[]) {
  await db.query(`INSERT INTO spy_watch (product_id, keywords) VALUES ($1, $2) ON CONFLICT (product_id) DO UPDATE SET keywords = EXCLUDED.keywords`, [productId, JSON.stringify(list)]);
}

// ---------------------------------------------------------------- storing ads
interface Ingested {
  added: number;
  updated: number;
  gkeys: string[];
}

/** The shop's own pages and sites (Réglages), and the landing pages' address. */
function ownMatcher(s: SpySettings, publicUrl?: string) {
  const lines = s.ownPages
    .split('\n')
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
  const own = new Set(lines.map((l) => host(l.startsWith('http') ? l : `https://${l}`) || l));
  const pub = publicUrl ? host(publicUrl) : '';
  return (a: RawAd) => {
    const name = a.pageName.trim().toLowerCase();
    const h = a.linkUrl ? host(a.linkUrl) : '';
    return lines.includes(name) || (!!h && (own.has(h) || [...own].some((o) => o.includes('.') && h.endsWith(`.${o}`)) || (!!pub && h === pub)));
  };
}

/**
 * Stores a search's ads for a product: copies of one creative are grouped, the oldest start date and the highest copy
 * count are kept, new creatives of followed pages and price changes become alerts. Facebook's picture links expire after
 * a few days: the picture the extension made (or the server downloaded) is kept with the ad.
 */
export async function ingestAds(ctx: Ctx, productId: number, source: string, keyword: string | null, raw: RawAd[]): Promise<Ingested> {
  const s = await spySettings(ctx.db);
  const isOwn = ownMatcher(s, ctx.server?.publicUrl);
  const groups = new Map<string, { ad: RawAd; ids: string[]; copies: number; start: number | null; media: string | null }>();
  for (const a of raw.slice(0, 400)) {
    const k = groupKey(a);
    const g = groups.get(k);
    const start = a.startedAt ?? null;
    if (!g) groups.set(k, { ad: a, ids: [a.id], copies: a.copies ?? 1, start, media: a.media ?? null });
    else {
      if (!g.ids.includes(a.id)) {
        g.ids.push(a.id);
        g.copies += a.copies ?? 1;
      }
      if (start !== null && (g.start === null || start < g.start)) {
        g.start = start;
        g.ad = { ...a, media: a.media ?? g.ad.media };
      }
      g.media = g.media ?? a.media ?? null;
    }
  }
  const followed = await followedKeys(ctx.db);
  const now = new Date(ctx.now()).toISOString();
  const out: Ingested = { added: 0, updated: 0, gkeys: [] };
  for (const [gkey, g] of groups) {
    const a = g.ad;
    const text = `${a.body ?? ''}\n${a.title ?? ''}`;
    const pr = pricesIn(text);
    const linkType = linkTypeOf(a.linkUrl, a.cta);
    const prev = (await ctx.db.query(`SELECT price, copies, ad_ids FROM spy_ads WHERE product_id = $1 AND gkey = $2`, [productId, gkey]))[0];
    const pageKey = a.pageId || `n:${norm(a.pageName)}`;
    const ids = [...new Set([...(prev?.ad_ids ?? []), ...g.ids])].slice(0, 60);
    await ctx.db.query(
      `INSERT INTO spy_ads (product_id, gkey, ad_id, ad_ids, source, page_id, page_name, page_url, body, title, link_url, link_type, platform, cta, platforms,
                            is_video, media, media_url, copies, started_at, first_seen, last_seen, active, own, keyword, price, old_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21,true,$22,$23,$24,$25)
       ON CONFLICT (product_id, gkey) DO UPDATE SET
         ad_id = EXCLUDED.ad_id, ad_ids = EXCLUDED.ad_ids, source = EXCLUDED.source, page_url = COALESCE(EXCLUDED.page_url, spy_ads.page_url),
         body = EXCLUDED.body, title = EXCLUDED.title, link_url = EXCLUDED.link_url, link_type = EXCLUDED.link_type,
         platform = COALESCE(EXCLUDED.platform, spy_ads.platform), cta = EXCLUDED.cta, platforms = EXCLUDED.platforms, is_video = EXCLUDED.is_video,
         media = COALESCE(EXCLUDED.media, spy_ads.media), media_url = COALESCE(EXCLUDED.media_url, spy_ads.media_url),
         copies = GREATEST(EXCLUDED.copies, spy_ads.copies), started_at = LEAST(COALESCE(EXCLUDED.started_at, spy_ads.started_at), COALESCE(spy_ads.started_at, EXCLUDED.started_at)),
         last_seen = EXCLUDED.last_seen, active = true, own = EXCLUDED.own,
         price = COALESCE(EXCLUDED.price, spy_ads.price), old_price = COALESCE(EXCLUDED.old_price, spy_ads.old_price)`,
      [
        productId,
        gkey,
        a.id,
        ids,
        source,
        a.pageId ?? null,
        a.pageName,
        a.pageUrl ?? null,
        (a.body ?? '').slice(0, 6000),
        a.title ?? null,
        a.linkUrl ?? null,
        linkType,
        builderOf(a.linkUrl),
        a.cta ?? null,
        a.platforms ?? [],
        !!a.isVideo,
        g.media,
        a.mediaUrl ?? null,
        Math.max(g.copies, ids.length),
        g.start ? new Date(g.start * 1000).toISOString() : null,
        now,
        isOwn(a),
        keyword,
        pr.price,
        pr.old,
      ],
    );
    out.gkeys.push(gkey);
    if (!prev) {
      out.added++;
      if (followed.has(pageKey)) await event(ctx.db, 'new_ad', a.pageName, productId, gkey, { price: pr.price });
    } else {
      out.updated++;
      if (followed.has(pageKey) && pr.price && prev.price && num(prev.price) !== pr.price) await event(ctx.db, 'price', a.pageName, productId, gkey, { from: num(prev.price), to: pr.price });
    }
  }
  return out;
}

async function event(db: Db, kind: 'new_ad' | 'stopped' | 'price', page: string, productId: number, gkey: string, data: unknown) {
  await db.query(`INSERT INTO spy_events (kind, page_name, product_id, gkey, data) VALUES ($1, $2, $3, $4, $5)`, [kind, page, productId, gkey, JSON.stringify(data ?? {})]);
}

/** After a full search of a product: what was not seen again has stopped (Facebook drops stopped Algerian ads). */
async function finishSearch(ctx: Ctx, productId: number, since: string): Promise<{ stopped: number }> {
  const gone = await ctx.db.query(`UPDATE spy_ads SET active = false WHERE product_id = $1 AND active AND last_seen < $2 RETURNING gkey, page_id, page_name`, [productId, since]);
  const followed = await followedKeys(ctx.db);
  for (const g of gone) if (followed.has(pageKeyOf(g))) await event(ctx.db, 'stopped', str(g.page_name), productId, str(g.gkey), {});
  await ctx.db.query(
    `INSERT INTO spy_watch (product_id, scanned_at) VALUES ($1, $2) ON CONFLICT (product_id) DO UPDATE SET scanned_at = EXCLUDED.scanned_at`,
    [productId, new Date(ctx.now()).toISOString()],
  );
  return { stopped: gone.length };
}

// ---------------------------------------------------------------- Claude
/** Claude's answer through the same path as Dellal (the page's Claude in the preview, the Dellal key on the server). */
async function ask(ctx: Ctx, system: string, user: string, maxTokens: number): Promise<string | null> {
  const inPage = !ctx.server?.dellal && ctx.dellalAi ? ctx.dellalAi : null;
  const keyed = await aiKeyed(ctx);
  if (!inPage && !keyed) return null;
  const s = await dellalSettings(ctx.db);
  const req: AiRequest = { model: s.model, system, messages: [{ role: 'user', content: user }], tools: [], max_tokens: maxTokens, feature: 'spy' };
  const res: AiResponse = inPage ? ((await inPage({ ...req, runTool: async () => ({}) })) as AiResponse) : ((await ctx.server!.dellal!('complete', req, ctx)) as AiResponse);
  return res.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
}
const aiOn = async (ctx: Ctx) => (!ctx.server?.dellal && !!ctx.dellalAi) || (await aiKeyed(ctx));

/** The first JSON value in a text (Claude sometimes wraps it in words or ``` fences). */
export function jsonIn<T>(text: string | null): T | null {
  if (!text) return null;
  const t = text.replace(/```(?:json)?/g, '');
  for (const [open, close] of [
    ['[', ']'],
    ['{', '}'],
  ] as const) {
    const a = t.indexOf(open);
    const b = t.lastIndexOf(close);
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1)) as T;
      } catch {
        /* try the other kind */
      }
    }
  }
  return null;
}

const ANALYST = `Tu es analyste de publicités e-commerce en Algérie (vente avec paiement à la livraison, prix en DA, textes en arabe, darija et français).
On te donne le produit d'une boutique et des pubs Facebook de concurrents trouvées par mot-clé.
Réponds UNIQUEMENT avec un tableau JSON, un objet par pub, dans le même ordre :
[{"id":"…","relevant":true|false,"same":true|false,"hook":"…","angle":"…","offer":"…","keep":"…","weak":"…","price":12900|null}]
- relevant : la pub vend-elle ce type de produit ? (false si elle parle d'autre chose : autre produit, recrutement, catalogue sans rapport)
- same : même produit ou presque (même usage, même gamme) ; false si c'est un produit proche mais différent
- hook (l'accroche), angle (l'argument principal), offer (prix, cadeau, livraison), keep (ce que la boutique peut reprendre), weak (le point faible) : une phrase courte en français simple, sans emoji
- price : le prix en DA lu dans la pub, sinon null
Ne parle jamais de dépenses publicitaires : Facebook ne les publie pas pour l'Algérie.`;

/** Claude reads the ads not read yet (relevance, same product or not, hook, angle, offer…), 10 at a time. */
async function analyze(ctx: Ctx, productId: number, max = 30): Promise<{ analyzed: number; demo: boolean }> {
  if (!(await aiOn(ctx))) return { analyzed: 0, demo: true };
  const p = await productRow(ctx.db, productId, ctx.now());
  const todo = await ctx.db.query(
    `SELECT gkey, page_name, body, title, cta, link_url, price, own FROM spy_ads WHERE product_id = $1 AND ai IS NULL AND relevant IS NOT FALSE ORDER BY copies DESC, started_at LIMIT $2`,
    [productId, max],
  );
  let done = 0;
  for (let i = 0; i < todo.length; i += 10) {
    const batch = todo.slice(i, i + 10);
    const user = `Produit de la boutique : « ${p.name} », vendu ${p.price} DA.\n\nPubs :\n${JSON.stringify(
      batch.map((r: any) => ({ id: str(r.gkey), page: str(r.page_name), texte: `${str(r.title)}\n${str(r.body)}`.trim().slice(0, 900), bouton: r.cta, lien: r.link_url, prix_lu: numOrNull(r.price), notre_pub: !!r.own })),
    )}`;
    const out = jsonIn<any[]>(await ask(ctx, ANALYST, user, 2500));
    if (!Array.isArray(out)) continue;
    for (const o of out) {
      const g = batch.find((r: any) => str(r.gkey) === str(o?.id));
      if (!g) continue;
      const ai: SpyAi = { hook: str(o.hook).slice(0, 300), angle: str(o.angle).slice(0, 300), offer: str(o.offer).slice(0, 300), keep: str(o.keep).slice(0, 400), weak: str(o.weak).slice(0, 400) };
      const price = Number.isFinite(Number(o.price)) && Number(o.price) >= 300 ? Math.round(Number(o.price)) : null;
      await ctx.db.query(`UPDATE spy_ads SET ai = $3, relevant = $4, same = $5, price = COALESCE(price, $6) WHERE product_id = $1 AND gkey = $2`, [
        productId,
        str(g.gkey),
        JSON.stringify(ai),
        g.own ? true : o.relevant !== false,
        !!o.same,
        price,
      ]);
      done++;
    }
  }
  return { analyzed: done, demo: false };
}

const STRATEGIST = `Tu conseilles une boutique algérienne (paiement à la livraison) face à ses concurrents sur Facebook.
On te donne son produit (prix, coût d'achat, commandes) et les pubs des concurrents (jours en ligne, copies, prix, texte), et les siennes.
Réponds UNIQUEMENT avec un objet JSON :
{"summary":"…","hooks":[{"ar":"…","fr":"…"},{"ar":"…","fr":"…"},{"ar":"…","fr":"…"}],"offer":"…","page":"…"}
- summary : 2 à 3 phrases simples en français avec les vrais chiffres (qui pousse le plus, depuis combien de jours, à quel prix, la position de la boutique)
- hooks : 3 accroches de pub en darija algérienne (écriture arabe, mots algériens, pas de dialecte d'un autre pays), chacune avec son idée en français
- offer : conseil de prix et d'offre qui garde une marge au-dessus du coût d'achat
- page : un conseil pour la page de commande (formulaire, 69 wilayas, preuves, packs)
Jamais de dépenses publicitaires inventées : Facebook ne les publie pas pour l'Algérie.`;

/** Rule-based brief when no AI is set (numbers only). */
function plainBrief(p: SpyProductRow, ads: SpyAd[], now: number): SpyBrief {
  const comp = ads.filter((a) => !a.own);
  const pages = new Set(comp.map((a) => a.pageKey)).size;
  const top = comp[0];
  const prices = comp.filter((a) => a.same !== false && a.price).map((a) => a.price as number);
  const parts = [`${pages} concurrent(s) trouvé(s) pour « ${p.name} ».`];
  if (top) parts.push(`La pub la plus forte : ${top.pageName}, ${top.days} jours en ligne, ${top.copies} copie(s)${top.price ? `, ${top.price} DA` : ''}.`);
  if (prices.length) parts.push(`Prix vus : ${Math.min(...prices)} à ${Math.max(...prices)} DA ; vous : ${p.price} DA.`);
  return { summary: parts.join(' '), hooks: [], offer: '', page: '', at: new Date(now).toISOString(), demo: true };
}

async function makeBrief(ctx: Ctx, productId: number): Promise<SpyBrief> {
  const p = await productRow(ctx.db, productId, ctx.now());
  const ads = await productAds(ctx, productId);
  if (!(await aiOn(ctx)) || !ads.length) return plainBrief(p, ads, ctx.now());
  const list = ads.slice(0, 14).map((a) => ({
    page: a.pageName,
    nous: a.own,
    jours: a.days,
    copies: a.copies,
    prix: a.price,
    meme_produit: a.same,
    site: a.linkType === 'site' ? a.platform ?? 'site' : a.linkType,
    texte: a.body.slice(0, 400),
  }));
  const user = `Produit : « ${p.name} » — prix ${p.price} DA, coût d'achat ${p.cost} DA, ${p.orders30} commandes en 30 jours.\n\nPubs :\n${JSON.stringify(list)}`;
  const o = jsonIn<any>(await ask(ctx, STRATEGIST, user, 1600));
  if (!o || typeof o !== 'object') return plainBrief(p, ads, ctx.now());
  const hooks = Array.isArray(o.hooks) ? o.hooks.slice(0, 3).map((h: any) => ({ ar: str(h?.ar).slice(0, 240), fr: str(h?.fr).slice(0, 240) })) : [];
  return { summary: str(o.summary).slice(0, 900), hooks, offer: str(o.offer).slice(0, 500), page: str(o.page).slice(0, 500), at: new Date(ctx.now()).toISOString(), demo: false };
}

const KEYWORDER = `Tu prépares des recherches dans la bibliothèque publicitaire de Facebook (pays : Algérie) pour trouver les concurrents d'un produit.
Facebook ne traduit pas les mots-clés : il faut chaque langue. Réponds UNIQUEMENT avec un tableau JSON de 5 à 8 objets :
[{"q":"…","lang":"ar"|"darija"|"fr"|"en"|"price"}]
- les noms que les vendeurs algériens écrivent vraiment dans leurs pubs : arabe, darija (écriture arabe), français, parfois anglais
- courts (1 à 3 mots), sans emoji, sans taille ni couleur
- jamais une phrase de livraison seule (« الدفع عند الاستلام », « livraison 58 wilayas ») : elle trouverait tous les produits du pays
- "price" : le prix de la boutique écrit comme les vendeurs (ex. « 4950 دج »)`;

/** Keywords from the product name when no AI is set. */
function plainKeywords(p: SpyProductRow): SpyKeyword[] {
  const base = p.name
    .toLowerCase()
    .replace(/\b\d+\s*(p|pouces?|cm|ml|kg|g)\b/gi, ' ')
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = base.split(' ').filter((w) => w.length > 2);
  const list: SpyKeyword[] = [];
  if (base) list.push({ q: base.split(' ').slice(0, 3).join(' '), lang: 'fr', count: null, at: null });
  if (words.length > 1) list.push({ q: words[0], lang: 'fr', count: null, at: null });
  if (p.price) list.push({ q: `${p.price} دج`, lang: 'price', count: null, at: null });
  return list;
}

async function suggestKeywords(ctx: Ctx, productId: number): Promise<SpyKeyword[]> {
  const p = await productRow(ctx.db, productId, ctx.now());
  let list: SpyKeyword[] | null = null;
  if (await aiOn(ctx)) {
    const o = jsonIn<any[]>(await ask(ctx, KEYWORDER, `Produit : « ${p.name} » (référence ${p.sku}), prix ${p.price} DA.`, 600));
    if (Array.isArray(o)) {
      const langs = ['ar', 'darija', 'fr', 'en', 'price'] as const;
      list = o
        .map((k: any) => ({ q: str(k?.q).trim().slice(0, 60), lang: (langs as readonly string[]).includes(k?.lang) ? (k.lang as SpyKeyword['lang']) : 'fr', count: null, at: null }))
        .filter((k) => k.q.length >= 2)
        .slice(0, 8);
    }
  }
  if (!list?.length) list = plainKeywords(p);
  const seen = new Set<string>();
  list = list.filter((k) => !seen.has(k.q.toLowerCase()) && !!seen.add(k.q.toLowerCase()));
  await saveKeywords(ctx.db, productId, list);
  return list;
}

// ---------------------------------------------------------------- the server's sources
export interface SpySearchResult {
  count: number | null;
  ads: RawAd[];
}
/** Server-only (ServerHooks.spy): the paid sources, pictures and competitors' sites. Missing in the browser preview. */
export type SpyServer = {
  (action: 'search', args: { source: SpyPaidSource; key: string; query: string; country: string; max: number }, ctx: Ctx): Promise<SpySearchResult>;
  (action: 'media', args: { url: string }, ctx: Ctx): Promise<string | null>;
  (action: 'site', args: { url: string }, ctx: Ctx): Promise<SpySite>;
};
const spyOf = (ctx: Ctx) => ctx.server?.spy as unknown as SpyServer | undefined;

/** Downloads missing pictures and reads competitors' sites (prices, builder, form) for a product's new ads. */
async function enrich(ctx: Ctx, productId: number): Promise<void> {
  const spy = spyOf(ctx);
  if (!spy) return;
  const noMedia = await ctx.db.query(`SELECT gkey, media_url FROM spy_ads WHERE product_id = $1 AND media IS NULL AND media_url IS NOT NULL AND active ORDER BY copies DESC LIMIT 40`, [productId]);
  for (const r of noMedia) {
    const m = await spy('media', { url: str(r.media_url) }, ctx).catch(() => null);
    if (m) await ctx.db.query(`UPDATE spy_ads SET media = $3 WHERE product_id = $1 AND gkey = $2`, [productId, str(r.gkey), m]);
  }
  const sites = await ctx.db.query(
    `SELECT gkey, link_url FROM spy_ads WHERE product_id = $1 AND link_type = 'site' AND active AND (site IS NULL OR (site->>'checkedAt')::timestamptz < $2) ORDER BY copies DESC LIMIT 15`,
    [productId, new Date(ctx.now() - 7 * DAY).toISOString()],
  );
  for (const r of sites) {
    const site = await spy('site', { url: str(r.link_url) }, ctx).catch(() => null);
    if (!site) continue;
    await ctx.db.query(`UPDATE spy_ads SET site = $3, platform = COALESCE($4, platform), price = COALESCE(price, $5), old_price = COALESCE(old_price, $6) WHERE product_id = $1 AND gkey = $2`, [
      productId,
      str(r.gkey),
      JSON.stringify(site),
      site.platform,
      site.price,
      site.oldPrice,
    ]);
  }
}

/** Searches a product's keywords with the paid source (server), stores the ads, then pictures, sites and Claude. */
async function searchPaid(ctx: Ctx, productId: number): Promise<{ keywords: number; found: number; added: number; stopped: number; analyzed: number }> {
  const s = await spySettings(ctx.db);
  if (!isPaid(s.source)) throw bad('La source est l’extension Chrome : la recherche se fait depuis votre navigateur.');
  const spy = spyOf(ctx);
  if (!spy) throw bad('Recherche indisponible sur ce serveur');
  const key = await spyKey(ctx.db, s.source);
  if (!key) throw bad('Ajoutez la clé de la source dans AI Spy › Réglages.');
  let kws = await keywordsOf(ctx.db, productId);
  if (!kws.length) kws = await suggestKeywords(ctx, productId);
  const since = new Date(ctx.now()).toISOString();
  let found = 0;
  let added = 0;
  const done: SpyKeyword[] = [];
  for (const k of kws.slice(0, 10)) {
    const r = await spy('search', { source: s.source, key, query: k.q, country: 'DZ', max: s.maxPerKeyword }, ctx);
    const ing = await ingestAds(ctx, productId, s.source, k.q, r.ads);
    found += r.ads.length;
    added += ing.added;
    done.push({ ...k, count: r.count ?? r.ads.length, at: since });
  }
  await saveKeywords(ctx.db, productId, [...done, ...kws.slice(10)]);
  const fin = await finishSearch(ctx, productId, since);
  await enrich(ctx, productId);
  const an = await analyze(ctx, productId);
  await ctx.db.query(`UPDATE spy_watch SET brief = NULL WHERE product_id = $1`, [productId]);
  return { keywords: done.length, found, added, stopped: fin.stopped, analyzed: an.analyzed };
}

// ---------------------------------------------------------------- findings (all products)
async function findings(ctx: Ctx): Promise<SpyFinding[]> {
  const prods = await ctx.db.query(`SELECT DISTINCT product_id FROM spy_ads`);
  const out: SpyFinding[] = [];
  const rows: { p: SpyProductRow; ads: SpyAd[] }[] = [];
  for (const r of prods) {
    const p = await productRow(ctx.db, num(r.product_id), ctx.now());
    rows.push({ p, ads: await productAds(ctx, p.id) });
  }
  const comp = rows.flatMap(({ p, ads }) => ads.filter((a) => !a.own && a.active).map((a) => ({ p, a })));
  // a competitor pushing hard right now: many copies of one creative in a few weeks
  const scaling = comp.filter(({ a }) => a.copies >= 5 && a.days <= 30).sort((x, y) => y.a.copies - x.a.copies)[0];
  if (scaling) out.push({ kind: 'scaling', productId: scaling.p.id, product: scaling.p.name, gkey: scaling.a.gkey, page: scaling.a.pageName, copies: scaling.a.copies, days: scaling.a.days, price: scaling.a.price });
  const longest = comp.filter(({ a }) => a.days >= 60).sort((x, y) => y.a.days - x.a.days)[0];
  if (longest) out.push({ kind: 'longest', productId: longest.p.id, product: longest.p.name, gkey: longest.a.gkey, page: longest.a.pageName, days: longest.a.days });
  const own = rows.flatMap(({ p, ads }) => ads.filter((a) => a.own && a.active).map((a) => ({ p, a }))).sort((x, y) => y.a.copies - x.a.copies)[0];
  if (own) out.push({ kind: 'yourBest', productId: own.p.id, product: own.p.name, gkey: own.a.gkey, copies: own.a.copies, days: own.a.days, price: own.a.price });
  const cheaper = comp.filter(({ p, a }) => a.same === true && a.price && p.price && a.price < p.price * 0.85).sort((x, y) => (x.a.price as number) / x.p.price - (y.a.price as number) / y.p.price)[0];
  if (cheaper) out.push({ kind: 'cheaper', productId: cheaper.p.id, product: cheaper.p.name, gkey: cheaper.a.gkey, page: cheaper.a.pageName, price: cheaper.a.price as number, yours: cheaper.p.price });
  const noOwn = rows.filter(({ p, ads }) => p.orders30 > 0 && !ads.some((a) => a.own && a.active) && ads.some((a) => !a.own)).sort((x, y) => y.p.orders30 - x.p.orders30)[0];
  if (noOwn) out.push({ kind: 'noOwnAd', productId: noOwn.p.id, product: noOwn.p.name, orders: noOwn.p.orders30, competitors: new Set(noOwn.ads.filter((a) => !a.own).map((a) => a.pageKey)).size });
  // a new seller: several creatives started in the last 3 days
  const byPage = new Map<string, { p: SpyProductRow; a: SpyAd; n: number }>();
  for (const x of comp.filter(({ a }) => a.days <= 3)) {
    const k = `${x.p.id}|${x.a.pageKey}`;
    const v = byPage.get(k);
    byPage.set(k, v ? { ...v, n: v.n + 1 } : { ...x, n: 1 });
  }
  const fresh = [...byPage.values()].filter((v) => v.n >= 2).sort((x, y) => y.n - x.n)[0];
  if (fresh) out.push({ kind: 'newcomer', productId: fresh.p.id, product: fresh.p.name, gkey: fresh.a.gkey, page: fresh.a.pageName, creatives: fresh.n, days: fresh.a.days });
  return out;
}

// ---------------------------------------------------------------- daily scan (paid sources, server)
/** Algeria's hour now (UTC+1, no daylight saving). */
const dzHour = (now: number) => new Date(now + 3_600_000).getUTCHours();
const dzDay = (now: number) => new Date(now + 3_600_000).toISOString().slice(0, 10);

async function scan(ctx: Ctx): Promise<{ ran: boolean; why?: string; products?: number }> {
  const s = await spySettings(ctx.db);
  if (!isPaid(s.source) || !s.dailyScan) return { ran: false, why: 'off' };
  if (!ctx.server?.spy || !(await spyKey(ctx.db, s.source))) return { ran: false, why: 'no source' };
  const now = ctx.now();
  if (dzHour(now) < s.scanHour) return { ran: false, why: 'too early' };
  if ((await getRaw<string>(ctx.db, 'spy_last_scan', '')) === dzDay(now)) return { ran: false, why: 'done today' };
  await setRaw(ctx.db, 'spy_last_scan', dzDay(now));
  const list = await ctx.db.query(`SELECT product_id FROM spy_watch WHERE watch AND jsonb_array_length(keywords) > 0 ORDER BY scanned_at NULLS FIRST LIMIT 12`);
  let n = 0;
  for (const r of list) {
    try {
      await searchPaid(ctx, num(r.product_id));
      n++;
    } catch {
      /* one product's failure (no credits, a refused key) never stops the others */
    }
  }
  return { ran: true, products: n };
}

// ---------------------------------------------------------------- procedures
const id = z.number().int().positive();
const KeywordInput = z.object({ q: z.string().trim().min(2).max(60), lang: z.enum(['ar', 'darija', 'fr', 'en', 'price']) });
const SettingsInput = z.object({
  source: z.enum(SPY_SOURCES),
  dailyScan: z.boolean(),
  scanHour: z.number().int().min(0).max(23),
  ownPages: z.string().max(2000),
  maxPerKeyword: z.number().int().min(5).max(100).default(30),
  /** a new key ('' = keep the stored one, null = remove it) */
  keys: z.object({ scrapecreators: z.string().max(400).nullish(), searchapi: z.string().max(400).nullish() }).default({}),
});

export const spyProcs = {
  /** The shop's products, best sellers first, with what AI Spy has on each. */
  'spy.products': proc(['marketer'], z.object({}), async (ctx) => {
    const rows = await ctx.db.query(
      `SELECT p.id, p.name, p.sku, p.price, p.cost, p.photo,
              (SELECT count(DISTINCT i.order_id) FROM order_items i JOIN orders o ON o.id = i.order_id WHERE i.product_id = p.id AND o.created_at >= $1) AS orders30,
              (SELECT count(*) FROM spy_ads a WHERE a.product_id = p.id AND a.relevant IS NOT FALSE AND NOT a.own) AS ads,
              (SELECT count(*) FROM spy_ads a WHERE a.product_id = p.id AND a.own AND a.active) AS own_ads,
              w.watch, w.scanned_at
       FROM products p LEFT JOIN spy_watch w ON w.product_id = p.id
       WHERE p.active AND NOT p.is_service
       ORDER BY orders30 DESC, p.name LIMIT 300`,
      [new Date(ctx.now() - 30 * DAY).toISOString()],
    );
    return rows.map(toProductRow);
  }),

  /** Everything AI Spy shows for one product. */
  'spy.view': proc(['marketer'], z.object({ productId: id }), async (ctx, { productId }) => {
    const s = await spySettings(ctx.db);
    const product = await productRow(ctx.db, productId, ctx.now());
    const w = (await ctx.db.query(`SELECT brief FROM spy_watch WHERE product_id = $1`, [productId]))[0];
    const events = await ctx.db.query(`SELECT id, at, kind, page_name, gkey, data FROM spy_events WHERE product_id = $1 ORDER BY at DESC LIMIT 20`, [productId]);
    return {
      product,
      keywords: await keywordsOf(ctx.db, productId),
      ads: await productAds(ctx, productId),
      brief: (w?.brief as SpyBrief | null) ?? null,
      events: events.map((e: any) => ({ id: num(e.id), at: iso(e.at), kind: str(e.kind) as 'new_ad' | 'stopped' | 'price', page: str(e.page_name), gkey: e.gkey ?? null, data: e.data ?? {} })),
      source: s.source,
      hasKey: isPaid(s.source) ? !!(await spyKey(ctx.db, s.source)) : true,
      ai: await aiOn(ctx),
      platform: !!ctx.t,
      demo: !ctx.server,
    };
  }),

  /** What the last scans found, all products together (shown at the top of AI Spy). */
  'spy.findings': proc(['marketer'], z.object({}), (ctx) => findings(ctx)),

  /** The ads marked « pas pertinente » (to bring one back). */
  'spy.hidden': proc(['marketer'], z.object({ productId: id }), async (ctx, { productId }) => (await productAds(ctx, productId, { hidden: true })).filter((a) => a.relevant === false)),

  'spy.keywords.save': proc(['marketer'], z.object({ productId: id, keywords: z.array(KeywordInput).max(12) }), async (ctx, i) => {
    const old = await keywordsOf(ctx.db, i.productId);
    const seen = new Set<string>();
    const list: SpyKeyword[] = i.keywords
      .filter((k) => !seen.has(k.q.toLowerCase()) && !!seen.add(k.q.toLowerCase()))
      .map((k) => old.find((o) => o.q.toLowerCase() === k.q.toLowerCase()) ?? { ...k, count: null, at: null });
    await saveKeywords(ctx.db, i.productId, list);
    return list;
  }),

  /** Keywords prepared by Claude (or from the product name without AI). */
  'spy.keywords.suggest': proc(['marketer'], z.object({ productId: id }), (ctx, { productId }) => suggestKeywords(ctx, productId)),

  /** Paid source: searches the product's keywords on the server now. */
  'spy.search': proc(['marketer'], z.object({ productId: id }), (ctx, { productId }) => searchPaid(ctx, productId)),

  /** Extension: the ads of one keyword, read by the user's Chrome in Facebook's Ad Library. */
  'spy.ingest': proc(['marketer'], z.object({ productId: id, keyword: z.string().trim().min(1).max(60), count: z.number().int().min(0).nullable(), ads: z.array(RawAdSchema).max(200) }), async (ctx, i) => {
    await productRow(ctx.db, i.productId, ctx.now());
    const r = await ingestAds(ctx, i.productId, 'extension', i.keyword, i.ads);
    const list = await keywordsOf(ctx.db, i.productId);
    const at = new Date(ctx.now()).toISOString();
    const k = list.find((x) => x.q.toLowerCase() === i.keyword.toLowerCase());
    await saveKeywords(ctx.db, i.productId, k ? list.map((x) => (x === k ? { ...x, count: i.count ?? i.ads.length, at } : x)) : [...list, { q: i.keyword, lang: 'fr', count: i.count ?? i.ads.length, at }]);
    return { added: r.added, updated: r.updated };
  }),

  /** Extension: the search of every keyword is over (what was not seen again has stopped; pictures, sites and Claude). */
  'spy.finish': proc(['marketer'], z.object({ productId: id, since: z.string().datetime() }), async (ctx, i) => {
    const fin = await finishSearch(ctx, i.productId, i.since);
    await enrich(ctx, i.productId);
    await ctx.db.query(`UPDATE spy_watch SET brief = NULL WHERE product_id = $1`, [i.productId]);
    return fin;
  }),

  /** Claude reads the ads not read yet. */
  'spy.analyze': proc(['marketer'], z.object({ productId: id }), (ctx, { productId }) => analyze(ctx, productId)),

  /** « Comment battre la concurrence »: kept until the next search, unless asked again. */
  'spy.brief': proc(['marketer'], z.object({ productId: id, refresh: z.boolean().default(false) }), async (ctx, i) => {
    const w = (await ctx.db.query(`SELECT brief FROM spy_watch WHERE product_id = $1`, [i.productId]))[0];
    if (w?.brief && !i.refresh) return w.brief as SpyBrief;
    const b = await makeBrief(ctx, i.productId);
    await ctx.db.query(
      `INSERT INTO spy_watch (product_id, brief, brief_at) VALUES ($1, $2, $3) ON CONFLICT (product_id) DO UPDATE SET brief = EXCLUDED.brief, brief_at = EXCLUDED.brief_at`,
      [i.productId, JSON.stringify(b), b.at],
    );
    return b;
  }),

  /** « Pas pertinente » (or back): the ad leaves the list, the score and the brief. */
  'spy.hide': proc(['marketer'], z.object({ productId: id, gkey: z.string().max(200), hidden: z.boolean() }), async (ctx, i) => {
    await ctx.db.query(`UPDATE spy_ads SET relevant = $3 WHERE product_id = $1 AND gkey = $2`, [i.productId, i.gkey, !i.hidden]);
    await ctx.db.query(`UPDATE spy_watch SET brief = NULL WHERE product_id = $1`, [i.productId]);
    return { ok: true };
  }),

  /** Follow a competitor's page: alerts for its new ads, stopped ads and price changes. */
  'spy.follow': proc(['marketer'], z.object({ pageKey: z.string().min(1).max(200), pageName: z.string().max(200), productId: id.nullable(), on: z.boolean() }), async (ctx, i) => {
    if (i.on)
      await ctx.db.query(
        `INSERT INTO spy_follow (page_key, page_name, product_id, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT (page_key) DO UPDATE SET page_name = EXCLUDED.page_name`,
        [i.pageKey, i.pageName, i.productId, ctx.session.profile.id],
      );
    else await ctx.db.query(`DELETE FROM spy_follow WHERE page_key = $1`, [i.pageKey]);
    return { ok: true };
  }),

  'spy.followed': proc(['marketer'], z.object({}), async (ctx) => {
    const rows = await ctx.db.query(
      `SELECT f.page_key, f.page_name, f.product_id, p.name AS product, (SELECT max(at) FROM spy_events e WHERE e.page_name = f.page_name) AS last_event
       FROM spy_follow f LEFT JOIN products p ON p.id = f.product_id ORDER BY f.created_at DESC`,
    );
    const active = new Map<string, number>();
    for (const a of await ctx.db.query(`SELECT page_id, page_name FROM spy_ads WHERE active AND NOT own AND relevant IS NOT FALSE`)) active.set(pageKeyOf(a), (active.get(pageKeyOf(a)) ?? 0) + 1);
    const events = await ctx.db.query(
      `SELECT e.id, e.at, e.kind, e.page_name, e.product_id, e.gkey, e.data, p.name AS product FROM spy_events e LEFT JOIN products p ON p.id = e.product_id ORDER BY e.at DESC LIMIT 30`,
    );
    return {
      pages: rows.map((r: any) => ({ pageKey: str(r.page_key), pageName: str(r.page_name), productId: numOrNull(r.product_id), product: r.product ?? null, activeAds: active.get(str(r.page_key)) ?? 0, lastEvent: isoOrNull(r.last_event) })),
      events: events.map((e: any) => ({
        id: num(e.id),
        at: iso(e.at),
        kind: str(e.kind) as 'new_ad' | 'stopped' | 'price',
        page: str(e.page_name),
        productId: numOrNull(e.product_id),
        product: e.product ?? null,
        gkey: e.gkey ?? null,
        data: (e.data ?? {}) as { price?: number; from?: number; to?: number },
      })),
    };
  }),

  'spy.settings.get': proc(['marketer'], z.object({}), async (ctx) => {
    const s = await spySettings(ctx.db);
    return {
      settings: s,
      keys: { scrapecreators: !!(await spyKey(ctx.db, 'scrapecreators')), searchapi: !!(await spyKey(ctx.db, 'searchapi')) },
      ai: await aiOn(ctx),
      platform: !!ctx.t,
      lastScan: (await getRaw<string>(ctx.db, 'spy_last_scan', '')) || null,
      demo: !ctx.server,
    };
  }),

  'spy.settings.save': proc([], SettingsInput, async (ctx, i) => {
    const { keys, ...s } = i;
    await setRaw(ctx.db, 'spy', s, ctx.session.profile.id);
    for (const k of ['scrapecreators', 'searchapi'] as const) {
      const v = keys[k];
      if (v === null) await setRaw(ctx.db, SPY_SECRETS[k], '', ctx.session.profile.id);
      else if (v && v.trim()) await setRaw(ctx.db, SPY_SECRETS[k], v.trim(), ctx.session.profile.id);
    }
    return { ok: true };
  }),

  /** One real search in Algeria with a paid source's key (the stored one, or the one being typed). */
  'spy.settings.test': proc([], z.object({ source: z.enum(['scrapecreators', 'searchapi']), key: z.string().max(400).optional(), query: z.string().trim().min(2).max(60).default('poussette') }), async (ctx, i) => {
    const spy = spyOf(ctx);
    if (!spy) return { ok: false, count: 0, sample: [] as { page: string; text: string }[], message: 'Aperçu : le test se fait sur votre serveur Pilotix.' };
    const key = i.key?.trim() || (await spyKey(ctx.db, i.source));
    if (!key) throw bad('Ajoutez d’abord la clé.');
    const r = await spy('search', { source: i.source, key, query: i.query, country: 'DZ', max: 10 }, ctx);
    return { ok: r.ads.length > 0, count: r.count ?? r.ads.length, sample: r.ads.slice(0, 3).map((a) => ({ page: a.pageName, text: (a.body ?? '').slice(0, 120) })), message: '' };
  }),

  /** Include a product in the daily scan (or not). */
  'spy.watch': proc(['marketer'], z.object({ productId: id, on: z.boolean() }), async (ctx, i) => {
    await ctx.db.query(`INSERT INTO spy_watch (product_id, watch) VALUES ($1, $2) ON CONFLICT (product_id) DO UPDATE SET watch = EXCLUDED.watch`, [i.productId, i.on]);
    return { ok: true };
  }),

  /** The daily scan (scheduled job, every hour: it runs once a day after the chosen hour). */
  'spy.scan': proc([], z.object({}), (ctx) => scan(ctx)),
};
