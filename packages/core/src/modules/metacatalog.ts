// Marketing › Catalogue: the shop makes its own lists of products (« Promo de la semaine », « Bébé 0-6 mois »), drags
// products into them, and sends each list to Meta, and to TikTok too when « Envoyer aussi à TikTok » is on. The shop has
// one Meta catalog (made by Pilotix in the ad account's business, its pixels linked to it) and one TikTok catalog (in
// its TikTok Business Center, for Algeria in dinars, its TikTok pixel bound to it); each list is a product set of each,
// picked when making a catalog ad. A catalog holds the products that are in a sent list, one line per colour / size
// (item_group_id = the product, the id the landing pages' pixels send): their page, pictures (a JPEG copy made by the
// browser: neither takes WebP), price (the page's crossed-out price as the old one), stock and brand. A list « mise à
// jour toute seule » sends again what changed (a price, the stock, a picture) every few minutes; a product taken out of
// every list leaves the catalogs. TikTok's problems never stop Meta's sending: they show on the page.
import { z } from 'zod';
import { Db, iso, isoOrNull, num, numOrNull } from '../db';
import { bad, Ctx, notFound, proc, publicApi } from '../rpc';
import { getSetting } from '../settings';
import { getRaw, META_TOKEN_KEY } from './admin';
import { landingStore } from './landingquery';
import { SOCIAL_KEYS } from './social';

const ROLES = ['marketer'] as const;
const id = z.number().int().positive();
const me = (ctx: Ctx) => ctx.session.profile.id;
/** the browser preview has no server: nothing goes to Meta, every send succeeds at once */
const simulated = (ctx: Ctx) => !ctx.server;
/** Meta's smallest picture side */
export const MIN_SIDE = 500;
/** Meta takes up to 5,000 lines a call; 3,000 is safer */
const BATCH = 3000;
const SETTINGS_KEY = 'metacatalog';

export interface CatalogSettings {
  catalogId: string;
  businessName: string;
  pixelsLinked: boolean;
  at: string | null;
}
const DEFAULTS: CatalogSettings = { catalogId: '', businessName: '', pixelsLinked: false, at: null };

export async function catalogSettings(db: Db): Promise<CatalogSettings> {
  const r = (await db.query(`SELECT value FROM settings WHERE key = $1`, [SETTINGS_KEY]))[0];
  const v = r?.value && typeof r.value === 'object' ? r.value : {};
  return { ...DEFAULTS, ...v };
}
async function saveSettings(db: Db, v: CatalogSettings) {
  await db.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [SETTINGS_KEY, JSON.stringify(v)]);
}

// ---------------------------------------------------------------- the products as Meta sees them
interface Pic {
  /** a picture stored by Pilotix (landing_images), or null for one at an address */
  id: number | null;
  url: string | null;
  w: number;
  h: number;
  jpg: boolean;
  /** the colour it shows */
  v: number | null;
}
interface Prod {
  id: number;
  name: string;
  brand: string | null;
  price: number;
  page: { slug: string; title: string; price: number | null; oldPrice: number | null; description: string; variantLabel: string; pics: Pic[] } | null;
  variants: { id: number; title: string; price: number | null; stock: number }[];
}

async function loadProducts(db: Db, ids?: number[]): Promise<Prod[]> {
  const rows = await db.query(
    `SELECT p.id, p.name, p.brand, p.price,
       l.slug, l.title, l.price AS l_price, l.old_price, l.description, l.variant_label, l.images,
       (SELECT COALESCE(json_agg(json_build_object('id', v.id, 'title', v.title, 'price', v.price,
          'stock', (SELECT COALESCE(sum(s.qty), 0) FROM stock s WHERE s.variant_id = v.id)) ORDER BY v.id), '[]'::json)
        FROM product_variants v WHERE v.product_id = p.id AND v.active) AS variants
     FROM products p
     LEFT JOIN LATERAL (SELECT * FROM landing_pages x WHERE x.product_id = p.id AND x.active ORDER BY x.id LIMIT 1) l ON true
     WHERE p.active AND NOT p.is_service AND p.archived_at IS NULL ${ids ? 'AND p.id = ANY($1)' : ''}
     ORDER BY lower(p.name), p.id`,
    ids ? [ids] : [],
  );
  const picIds = new Set<number>();
  for (const r of rows) for (const e of arr(r.images)) if (e?.id) picIds.add(num(e.id));
  const pics = new Map<number, { w: number; h: number; jpg: boolean }>();
  if (picIds.size)
    for (const r of await db.query(`SELECT id, w, h, jpg IS NOT NULL AS jpg FROM landing_images WHERE id = ANY($1)`, [[...picIds]]))
      pics.set(num(r.id), { w: num(r.w), h: num(r.h), jpg: !!r.jpg });
  return rows.map((r: any) => ({
    id: num(r.id),
    name: String(r.name),
    brand: r.brand ? String(r.brand) : null,
    price: num(r.price),
    page: r.slug
      ? {
          slug: String(r.slug),
          title: String(r.title || r.name),
          price: numOrNull(r.l_price),
          oldPrice: numOrNull(r.old_price),
          description: String(r.description ?? ''),
          variantLabel: String(r.variant_label ?? ''),
          pics: arr(r.images)
            .map((e: any): Pic | null => {
              if (e?.id) {
                const k = pics.get(num(e.id));
                return k ? { id: num(e.id), url: null, w: k.w, h: k.h, jpg: k.jpg, v: numOrNull(e.v) } : null;
              }
              return e?.url ? { id: null, url: String(e.url), w: num(e.w), h: num(e.h), jpg: false, v: numOrNull(e.v) } : null;
            })
            .filter((x: Pic | null): x is Pic => !!x),
        }
      : null,
    variants: arr(r.variants).map((v: any) => ({ id: num(v.id), title: String(v.title ?? ''), price: numOrNull(v.price), stock: num(v.stock) })),
  }));
}
const arr = (v: unknown): any[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const x = JSON.parse(v);
      return Array.isArray(x) ? x : [];
    } catch {
      return [];
    }
  }
  return [];
};

/** A picture Meta can download: a JPEG copy of a stored one, or an https JPEG / PNG address (the demo: any). */
const usable = (p: Pic, demo = false) =>
  p.w >= MIN_SIDE && p.h >= MIN_SIDE && (p.id ? p.jpg : !!p.url && (demo || /^https:\/\/\S+\.(jpe?g|png)(\?\S*)?$/i.test(p.url)));

/** Why a product cannot go to Meta (null: it can). */
export function problemOf(p: Prod, demo = false): 'nopage' | 'photo' | 'jpeg' | null {
  if (!p.page) return 'nopage';
  const big = p.page.pics.filter((x) => x.w >= MIN_SIDE && x.h >= MIN_SIDE && (x.id || demo || /^https:\/\//i.test(x.url ?? '')));
  if (!big.length) return 'photo';
  // a stored picture still without its JPEG copy: the browser makes it (Catalogue does it by itself)
  if (!big.some((x) => usable(x, demo))) return 'jpeg';
  return null;
}

/** The page's description as plain text (no « # », « ** », « - »). */
export function plainText(s: string): string {
  return s
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').replace(/^\s*[-*]\s+/, '• ').replace(/\*\*|__|`/g, '').trim())
    .filter((l, i, a) => l || (i > 0 && a[i - 1]))
    .join('\n')
    .trim();
}

interface Where {
  pages: string;
  store: string;
  api: string;
  brand: string;
  /** the browser preview: nothing goes to Meta */
  demo: boolean;
}
async function whereOf(ctx: Ctx): Promise<Where> {
  const shop = String((await getSetting(ctx.db, 'shop')).name ?? '') || 'Boutique';
  const pages = String(ctx.server?.pagesUrl?.() ?? ctx.server?.publicUrl ?? 'https://pilotix.online').replace(/\/+$/, '');
  return { pages, store: await landingStore(ctx.db), api: ctx.server ? publicApi(ctx) : 'https://pilotix.online/api', brand: shop, demo: simulated(ctx) };
}

const COLOR = /lon|لون|couleur|color|colour/i;
const SIZE = /taille|مقاس|size|pointure|عمر|âge|age/i;

/** One line of a catalog (a colour / size of a product), before Meta's or TikTok's own names. */
export interface Line {
  id: string;
  variantId: number;
  /** the product: every colour / size of it shares it (the id the pixels send) */
  group: string;
  title: string;
  description: string;
  inStock: boolean;
  /** the price before a sale (the page's crossed-out one), else the price */
  price: number;
  salePrice: number | null;
  link: string;
  /** the colour's own picture first, then the page's (10 at most) */
  images: string[];
  brand: string;
  color: string | null;
  size: string | null;
}

/** A product's lines: one per colour / size (none when it cannot go). */
export function linesOf(p: Prod, w: Where): Line[] {
  if (problemOf(p, w.demo) || !p.page) return [];
  const page = p.page;
  const link = `${w.pages}/${w.store ? `${w.store}/` : ''}${page.slug}`;
  const urlOf = (x: Pic) => (x.id ? `${w.api}/lp/img/${x.id}/meta.jpg` : String(x.url));
  const good = page.pics.filter((x) => usable(x, w.demo));
  const text = plainText(page.description).slice(0, 5000) || page.title;
  const many = p.variants.length > 1;
  return p.variants.map((v) => {
    const now = v.price ?? page.price ?? p.price;
    const old = page.oldPrice && page.oldPrice > now ? page.oldPrice : null;
    const own = good.filter((x) => x.v === v.id);
    const pics = [...own, ...good.filter((x) => x.v !== v.id)].slice(0, 10);
    const named = many && !!v.title;
    const color = named && COLOR.test(page.variantLabel);
    return {
      id: `${p.id}-${v.id}`,
      variantId: v.id,
      group: String(p.id),
      title: named ? `${page.title} – ${v.title}` : page.title,
      description: text,
      inStock: v.stock > 0,
      price: old ?? now,
      salePrice: old ? now : null,
      link,
      images: pics.map(urlOf),
      brand: p.brand || w.brand,
      color: color ? v.title : null,
      size: named && !color && SIZE.test(page.variantLabel) ? v.title : null,
    };
  });
}

/** The lines Meta gets for a product: one per colour / size (Meta's names). */
export function itemsOf(p: Prod, w: Where): { retailerId: string; variantId: number; data: Record<string, unknown> }[] {
  return linesOf(p, w).map((l) => {
    const data: Record<string, unknown> = {
      id: l.id,
      item_group_id: l.group,
      title: l.title.slice(0, 200),
      description: l.description,
      availability: l.inStock ? 'in stock' : 'out of stock',
      condition: 'new',
      price: `${l.price} DZD`,
      ...(l.salePrice !== null ? { sale_price: `${l.salePrice} DZD` } : {}),
      link: l.link,
      image: l.images.map((url) => ({ url, tag: [] as string[] })),
      brand: l.brand.slice(0, 100),
    };
    if (l.color) data.color = l.color.slice(0, 200);
    else if (l.size) data.size = l.size.slice(0, 200);
    return { retailerId: l.id, variantId: l.variantId, data };
  });
}

/** Without emoji (TikTok refuses them in a title or a brand). */
export const noEmoji = (s: string) =>
  s
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{1F1E6}-\u{1F1FF}\u{E0020}-\u{E007F}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

/** The products TikTok gets for a product: one per colour / size (TikTok's names). */
export function ttItemsOf(p: Prod, w: Where): { skuId: string; variantId: number; data: Record<string, unknown> }[] {
  return linesOf(p, w).map((l) => {
    const detail: Record<string, string> = { condition: 'NEW' };
    if (l.color) detail.color = l.color.slice(0, 100);
    else if (l.size) detail.size = l.size.slice(0, 100);
    const data: Record<string, unknown> = {
      sku_id: l.id,
      item_group_id: l.group,
      title: (noEmoji(l.title) || noEmoji(p.name) || l.group).slice(0, 500),
      description: l.description.slice(0, 10_000),
      availability: l.inStock ? 'IN_STOCK' : 'OUT_OF_STOCK',
      brand: (noEmoji(l.brand) || 'Boutique').slice(0, 150),
      image_url: l.images[0],
      ...(l.images.length > 1 ? { additional_image_urls: l.images.slice(1, 11) } : {}),
      product_detail: detail,
      price_info: { price: l.price, currency: 'DZD', ...(l.salePrice !== null ? { sale_price: l.salePrice } : {}) },
      landing_page: { landing_page_url: l.link },
    };
    return { skuId: l.id, variantId: l.variantId, data };
  });
}

/** A short fingerprint of what was sent (to send only what changed). */
export function hashOf(o: unknown): string {
  const s = JSON.stringify(o);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0') + s.length.toString(16);
}

// ---------------------------------------------------------------- sending
async function pixelIds(db: Db): Promise<string[]> {
  const ids = (await db.query(`SELECT pixel_id FROM tracking_pixels WHERE platform = 'meta'`).catch(() => [])).map((r: any) => String(r.pixel_id));
  const legacy = String((await getSetting(db, 'landing')).pixelId ?? '').trim();
  return [...new Set([...ids, legacy].filter((x) => /^\d{5,20}$/.test(x)))];
}

async function ensureCatalog(ctx: Ctx): Promise<CatalogSettings> {
  const s = await catalogSettings(ctx.db);
  if (s.catalogId) return s;
  if (simulated(ctx)) {
    const v = { ...s, catalogId: 'demo-catalog', businessName: 'BabyJoy DZ', pixelsLinked: true, at: iso(new Date(ctx.now())) };
    await saveSettings(ctx.db, v);
    return v;
  }
  const shop = String((await getSetting(ctx.db, 'shop')).name ?? '') || 'Boutique';
  const r: any = await ctx.server!.meta('catalogSetup', { name: `Pilotix · ${shop}`, pixelIds: await pixelIds(ctx.db) }, ctx);
  const v = { catalogId: String(r.catalogId), businessName: String(r.businessName ?? ''), pixelsLinked: !!r.pixelsLinked, at: iso(new Date(ctx.now())) };
  await saveSettings(ctx.db, v);
  return v;
}

/** Products in at least one sent list: what the catalog must hold. */
async function wanted(db: Db): Promise<number[]> {
  return (await db.query(`SELECT DISTINCT lp.product_id FROM meta_catalog_list_products lp JOIN meta_catalog_lists l ON l.id = lp.list_id WHERE l.sent_at IS NOT NULL`)).map((r: any) => num(r.product_id));
}

/**
 * Sends to Meta what changed for these products (all of them with `force`), and takes out of the catalog the lines of
 * products no longer in any sent list. Returns what was sent.
 */
async function syncProducts(ctx: Ctx, productIds: number[], o: { force?: boolean } = {}): Promise<{ sent: number; removed: number; errors: number }> {
  const db = ctx.db;
  const at = iso(new Date(ctx.now()));
  const s = await ensureCatalog(ctx);
  const w = await whereOf(ctx);
  // only the products a sent list still has go (the others leave the catalog below)
  const all = new Set(await wanted(db));
  const go = productIds.filter((x) => all.has(x));
  const prods = go.length ? await loadProducts(db, go) : [];
  const have = new Map<string, { hash: string | null; status: string }>();
  for (const r of await db.query(`SELECT retailer_id, hash, status FROM meta_catalog_items`)) have.set(String(r.retailer_id), { hash: r.hash ? String(r.hash) : null, status: String(r.status) });
  const requests: { method: 'UPDATE' | 'DELETE'; data: Record<string, unknown> }[] = [];
  const rows: { retailerId: string; productId: number; variantId: number | null; hash: string | null }[] = [];
  const keep = new Set<string>();
  for (const p of prods)
    for (const it of itemsOf(p, w)) {
      keep.add(it.retailerId);
      const hash = hashOf(it.data);
      const cur = have.get(it.retailerId);
      if (!o.force && cur && cur.hash === hash && cur.status !== 'error') continue;
      requests.push({ method: 'UPDATE', data: it.data });
      rows.push({ retailerId: it.retailerId, productId: p.id, variantId: it.variantId, hash });
    }
  // lines no longer wanted: a product out of every sent list, a colour removed, a product that lost its page
  const gone: string[] = [];
  for (const [rid, cur] of have) {
    if (cur.status === 'deleted') continue;
    const pid = Number(rid.split('-')[0]);
    if (keep.has(rid)) continue;
    if (!all.has(pid) || productIds.includes(pid)) gone.push(rid);
  }
  for (const rid of gone) requests.push({ method: 'DELETE', data: { id: rid } });
  let errors = 0;
  if (requests.length) {
    const failed = new Map<string, string>();
    for (let i = 0; i < requests.length; i += BATCH) {
      const part = requests.slice(i, i + BATCH);
      if (simulated(ctx)) continue;
      const r: any = await ctx.server!.meta('catalogBatch', { catalogId: s.catalogId, requests: part }, ctx);
      for (const e of r.errors ?? []) failed.set(String(e.id), String(e.message));
      if (r.handle) await db.query(`INSERT INTO meta_catalog_batches (handle, ids, sent_at) VALUES ($1, $2, $3)`, [r.handle, part.map((x) => String(x.data.id)), at]);
    }
    for (const r of rows) {
      const err = failed.get(r.retailerId);
      if (err) errors++;
      await db.query(
        `INSERT INTO meta_catalog_items (retailer_id, product_id, variant_id, hash, status, error, sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (retailer_id) DO UPDATE SET product_id = EXCLUDED.product_id, variant_id = EXCLUDED.variant_id, hash = EXCLUDED.hash,
           status = EXCLUDED.status, error = EXCLUDED.error, sent_at = EXCLUDED.sent_at, checked_at = NULL`,
        [r.retailerId, r.productId, r.variantId, err ? null : r.hash, err ? 'error' : simulated(ctx) ? 'ok' : 'pending', err ?? null, at],
      );
    }
    if (gone.length) await db.query(`UPDATE meta_catalog_items SET status = 'deleted', hash = NULL, error = NULL, sent_at = $2 WHERE retailer_id = ANY($1)`, [gone, at]);
  }
  return { sent: rows.length, removed: gone.length, errors };
}

/** The list's product set at Meta: the lines of its products that can go. */
async function syncSet(ctx: Ctx, listId: number) {
  const db = ctx.db;
  const l = (await db.query(`SELECT * FROM meta_catalog_lists WHERE id = $1`, [listId]))[0];
  if (!l) return;
  const s = await catalogSettings(db);
  const ids = (
    await db.query(
      `SELECT i.retailer_id FROM meta_catalog_items i JOIN meta_catalog_list_products lp ON lp.product_id = i.product_id
       WHERE lp.list_id = $1 AND i.status <> 'deleted' ORDER BY i.retailer_id`,
      [listId],
    )
  ).map((r: any) => String(r.retailer_id));
  let setId = l.set_id ? String(l.set_id) : null;
  if (simulated(ctx)) setId = setId ?? `demo-set-${listId}`;
  else if (ids.length || setId) {
    const r: any = await ctx.server!.meta('catalogSet', { catalogId: s.catalogId, setId, name: String(l.name), ids: ids.length ? ids : ['none'] }, ctx);
    setId = String(r.setId);
  }
  await db.query(`UPDATE meta_catalog_lists SET set_id = $2 WHERE id = $1`, [listId, setId]);
}

/** Meta's answer about the batches sent a little while ago. */
async function checkBatches(ctx: Ctx): Promise<number> {
  if (simulated(ctx)) return 0;
  const db = ctx.db;
  const s = await catalogSettings(db);
  const open = await db.query(`SELECT * FROM meta_catalog_batches WHERE done_at IS NULL AND sent_at < $1 ORDER BY id LIMIT 10`, [iso(new Date(ctx.now() - 60_000))]);
  let n = 0;
  for (const b of open) {
    const r: any = await ctx.server!.meta('catalogStatus', { catalogId: s.catalogId, handle: String(b.handle) }, ctx).catch(() => null);
    if (!r) continue;
    const errs = new Map<string, string>((r.errors ?? []).map((e: any) => [String(e.id), String(e.message)]));
    const at = iso(new Date(ctx.now()));
    for (const rid of b.ids as string[]) {
      const e = errs.get(rid);
      await db.query(
        `UPDATE meta_catalog_items SET status = CASE WHEN status = 'deleted' THEN status WHEN $2::text IS NOT NULL THEN 'error' WHEN $3 THEN 'ok' ELSE status END,
           error = $2, hash = CASE WHEN $2::text IS NOT NULL THEN NULL ELSE hash END, checked_at = $4 WHERE retailer_id = $1`,
        [rid, e ?? null, !!r.done, at],
      );
    }
    if (r.done || errs.size) {
      await db.query(`UPDATE meta_catalog_batches SET done_at = $2 WHERE id = $1`, [b.id, at]);
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- TikTok: the same lists
const TT_KEY = 'ttcatalog';
/** TikTok takes up to 5,000 products a call; 1,000 keeps each call small */
const TT_BATCH = 1000;
/** an upload TikTok has not answered after this long is sent again */
const TT_GIVE_UP = 6 * 3_600_000;

export interface TtSettings {
  /** « Envoyer aussi à TikTok » */
  on: boolean;
  bcId: string;
  bcName: string;
  catalogId: string;
  pixelBound: boolean;
  /** TikTok's last refusal, shown on the page until TikTok takes the lists again */
  error: string | null;
  at: string | null;
}
const TT_DEFAULTS: TtSettings = { on: false, bcId: '', bcName: '', catalogId: '', pixelBound: false, error: null, at: null };

export async function ttSettings(db: Db): Promise<TtSettings> {
  const r = (await db.query(`SELECT value FROM settings WHERE key = $1`, [TT_KEY]))[0];
  const v = r?.value && typeof r.value === 'object' ? r.value : {};
  return { ...TT_DEFAULTS, ...v };
}
async function ttPatch(db: Db, patch: Partial<TtSettings>): Promise<TtSettings> {
  const v = { ...(await ttSettings(db)), ...patch };
  await db.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [TT_KEY, JSON.stringify(v)]);
  return v;
}
const why = (e: unknown) => String((e as any)?.message ?? e).slice(0, 300);

/** The TikTok Ads account is linked (Pilot AI › Comptes): its key and an ad account. */
async function ttLinked(ctx: Ctx): Promise<boolean> {
  if (simulated(ctx)) return true;
  if (!(await getRaw<string>(ctx.db, SOCIAL_KEYS.tiktokAdsToken, ''))) return false;
  return !!(await getRaw<any>(ctx.db, SOCIAL_KEYS.tiktokAds, null))?.advertiserId;
}
/** Meta can take the lists: the Facebook account and its ad account are linked. */
async function metaReady(ctx: Ctx): Promise<boolean> {
  return simulated(ctx) || (!!(await getRaw<string>(ctx.db, META_TOKEN_KEY, '')) && !!(await getSetting(ctx.db, 'meta')).adAccountId);
}
/** The shop's TikTok pixel (the default one first), bound to the catalog. */
async function ttPixel(db: Db): Promise<string> {
  const r = (await db.query(`SELECT pixel_id FROM tracking_pixels WHERE platform = 'tiktok' ORDER BY is_default DESC, id LIMIT 1`).catch(() => []))[0];
  const x = String(r?.pixel_id ?? '').trim();
  return /^[A-Z0-9]{10,30}$/.test(x) ? x : '';
}
/** TikTok's API, on the server (social-server.ts); the token never leaves it. */
async function tt(ctx: Ctx, action: string, args: Record<string, unknown>): Promise<any> {
  if (!ctx.server?.social) throw bad('TikTok indisponible sur ce serveur');
  return ctx.server.social(action, args, ctx);
}

async function ensureTt(ctx: Ctx): Promise<TtSettings> {
  const s = await ttSettings(ctx.db);
  if (s.catalogId) return s;
  const at = iso(new Date(ctx.now()));
  if (simulated(ctx)) return ttPatch(ctx.db, { bcId: 'demo-bc', bcName: 'BabyJoy DZ', catalogId: 'demo-tt-catalog', pixelBound: true, error: null, at });
  const shop = String((await getSetting(ctx.db, 'shop')).name ?? '') || 'Boutique';
  const r = await tt(ctx, 'ttCatalogSetup', { name: `Pilotix · ${shop}`, pixelCode: await ttPixel(ctx.db) });
  return ttPatch(ctx.db, { bcId: String(r.bcId), bcName: String(r.bcName ?? ''), catalogId: String(r.catalogId), pixelBound: !!r.pixelBound, error: null, at });
}

/**
 * Sends to TikTok what changed for these products (also what TikTok refused, with `retry`), and takes out of its
 * catalog the products no longer in any sent list. TikTok answers later (ttCheck).
 */
async function ttSyncProducts(ctx: Ctx, productIds: number[], o: { retry?: boolean } = {}): Promise<{ sent: number; removed: number }> {
  const db = ctx.db;
  const at = iso(new Date(ctx.now()));
  const s = await ensureTt(ctx);
  const w = await whereOf(ctx);
  const all = new Set(await wanted(db));
  const go = productIds.filter((x) => all.has(x));
  const prods = go.length ? await loadProducts(db, go) : [];
  const have = new Map<string, { hash: string | null; status: string }>();
  for (const r of await db.query(`SELECT sku_id, hash, status FROM tiktok_catalog_items`)) have.set(String(r.sku_id), { hash: r.hash ? String(r.hash) : null, status: String(r.status) });
  const up: Record<string, unknown>[] = [];
  const rows: { skuId: string; productId: number; variantId: number; hash: string }[] = [];
  const keep = new Set<string>();
  for (const p of prods)
    for (const it of ttItemsOf(p, w)) {
      keep.add(it.skuId);
      const hash = hashOf(it.data);
      const cur = have.get(it.skuId);
      // unchanged: not again (a refused one waits for a change, or « Envoyer »)
      if (cur && cur.hash === hash && cur.status !== 'deleted' && (cur.status !== 'error' || !o.retry)) continue;
      up.push(it.data);
      rows.push({ skuId: it.skuId, productId: p.id, variantId: it.variantId, hash });
    }
  const gone: string[] = [];
  for (const [sku, cur] of have) {
    if (cur.status === 'deleted' || keep.has(sku)) continue;
    const pid = Number(sku.split('-')[0]);
    if (!all.has(pid) || productIds.includes(pid)) gone.push(sku);
  }
  if (!simulated(ctx)) {
    for (let i = 0; i < up.length; i += TT_BATCH) {
      const part = up.slice(i, i + TT_BATCH);
      const r = await tt(ctx, 'ttCatalogUpload', { bcId: s.bcId, catalogId: s.catalogId, products: part });
      if (r?.logId) await db.query(`INSERT INTO tiktok_catalog_batches (log_id, ids, sent_at) VALUES ($1, $2, $3)`, [String(r.logId), part.map((x) => String(x.sku_id)), at]);
    }
    for (let i = 0; i < gone.length; i += TT_BATCH) await tt(ctx, 'ttCatalogDelete', { bcId: s.bcId, catalogId: s.catalogId, skuIds: gone.slice(i, i + TT_BATCH) });
  }
  for (const r of rows)
    await db.query(
      `INSERT INTO tiktok_catalog_items (sku_id, product_id, variant_id, hash, status, error, sent_at) VALUES ($1,$2,$3,$4,$5,NULL,$6)
       ON CONFLICT (sku_id) DO UPDATE SET product_id = EXCLUDED.product_id, variant_id = EXCLUDED.variant_id, hash = EXCLUDED.hash,
         status = EXCLUDED.status, error = NULL, sent_at = EXCLUDED.sent_at, checked_at = NULL`,
      [r.skuId, r.productId, r.variantId, r.hash, simulated(ctx) ? 'ok' : 'pending', at],
    );
  if (gone.length) await db.query(`UPDATE tiktok_catalog_items SET status = 'deleted', hash = NULL, error = NULL, sent_at = $2 WHERE sku_id = ANY($1)`, [gone, at]);
  return { sent: rows.length, removed: gone.length };
}

/** The list's product set at TikTok: every colour / size of its products that went. */
async function ttSyncSet(ctx: Ctx, listId: number): Promise<boolean> {
  const db = ctx.db;
  const l = (await db.query(`SELECT * FROM meta_catalog_lists WHERE id = $1`, [listId]))[0];
  if (!l) return false;
  const s = await ttSettings(db);
  const groups = (
    await db.query(
      `SELECT DISTINCT i.product_id FROM tiktok_catalog_items i JOIN meta_catalog_list_products lp ON lp.product_id = i.product_id
       WHERE lp.list_id = $1 AND i.status <> 'deleted' ORDER BY i.product_id`,
      [listId],
    )
  ).map((r: any) => String(r.product_id));
  let setId = l.tt_set_id ? String(l.tt_set_id) : null;
  if (simulated(ctx)) setId = setId ?? `demo-tt-set-${listId}`;
  else if (groups.length || setId) setId = String((await tt(ctx, 'ttCatalogSet', { bcId: s.bcId, catalogId: s.catalogId, setId, name: String(l.name), groupIds: groups })).setId || setId || '') || null;
  await db.query(`UPDATE meta_catalog_lists SET tt_set_id = $2, tt_sent_at = $3 WHERE id = $1`, [listId, setId, iso(new Date(ctx.now()))]);
  return true;
}
/** TikTok did not take the list's new content: the next run sends it again. */
const ttLate = (db: Db, listId: number) => db.query(`UPDATE meta_catalog_lists SET tt_sent_at = NULL WHERE id = $1`, [listId]);

/** TikTok's answer about the uploads sent a little while ago (one it never answers is sent again). */
async function ttCheck(ctx: Ctx): Promise<number> {
  if (simulated(ctx)) return 0;
  const db = ctx.db;
  const s = await ttSettings(db);
  const now = ctx.now();
  const open = await db.query(`SELECT * FROM tiktok_catalog_batches WHERE done_at IS NULL AND sent_at < $1 ORDER BY id LIMIT 10`, [iso(new Date(now - 60_000))]);
  let n = 0;
  for (const b of open) {
    const sentAt = new Date(b.sent_at).getTime();
    const r: any = await tt(ctx, 'ttCatalogLog', { bcId: s.bcId, catalogId: s.catalogId, logId: String(b.log_id) }).catch(() => null);
    const late = !r?.done && sentAt < now - TT_GIVE_UP;
    if (!r?.done && !late) continue;
    const errs = new Map<string, string>((r?.errors ?? []).map((e: any) => [String(e.id), String(e.message)]));
    const at = iso(new Date(now));
    for (const sku of b.ids as string[]) {
      const e = late ? 'TikTok n’a pas répondu : Pilotix renvoie ce produit.' : errs.get(sku) ?? (r.failed ? 'Refusé par TikTok' : null);
      // only the lines this upload sent (a newer one waits for its own answer); one never answered goes again (no hash)
      await db.query(
        `UPDATE tiktok_catalog_items SET status = CASE WHEN $2::text IS NOT NULL THEN 'error' ELSE 'ok' END, error = $2,
           hash = CASE WHEN $3 THEN NULL ELSE hash END, checked_at = $4
         WHERE sku_id = $1 AND status <> 'deleted' AND sent_at <= $5`,
        [sku, e, late, at, iso(new Date(sentAt))],
      );
    }
    await db.query(`UPDATE tiktok_catalog_batches SET done_at = $2 WHERE id = $1`, [b.id, at]);
    n++;
  }
  return n;
}

/** The lists already sent go to TikTok (« Envoyer aussi à TikTok » just turned on, or TikTok refused them before). */
async function ttSendSent(ctx: Ctx, o: { retry?: boolean; onlyLate?: boolean } = {}): Promise<number> {
  const db = ctx.db;
  const lists = await db.query(`SELECT id FROM meta_catalog_lists WHERE sent_at IS NOT NULL ${o.onlyLate ? 'AND tt_sent_at IS NULL' : ''} ORDER BY position, id`);
  if (!lists.length) return 0;
  const pids = (await db.query(`SELECT DISTINCT product_id FROM meta_catalog_list_products WHERE list_id = ANY($1)`, [lists.map((l: any) => num(l.id))])).map((r: any) => num(r.product_id));
  const r = await ttSyncProducts(ctx, pids, { retry: o.retry });
  for (const l of lists) await ttSyncSet(ctx, num(l.id));
  return r.sent;
}

/** Every few minutes: lists « mises à jour toutes seules » send what changed; Meta's and TikTok's answers come back. */
export async function runCatalog(ctx: Ctx): Promise<{ sent: number; removed: number; checked: number; tiktok: number }> {
  const db = ctx.db;
  const s = await catalogSettings(db);
  const t = await ttSettings(db);
  // each catalog goes on its own: one whose account is no longer linked waits
  const metaGo = !!s.catalogId && (await metaReady(ctx));
  const ttGo = t.on && !!t.catalogId && (await ttLinked(ctx));
  const out = { sent: 0, removed: 0, checked: 0, tiktok: 0 };
  if (!metaGo && !ttGo) return out;
  // a TikTok step that fails is written on the page; it never stops Meta's
  let ttError: string | null = null;
  const ttStep = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      ttError = ttError ?? why(e);
      return null;
    }
  };
  const auto = (
    await db.query(`SELECT DISTINCT lp.product_id FROM meta_catalog_list_products lp JOIN meta_catalog_lists l ON l.id = lp.list_id WHERE l.sent_at IS NOT NULL AND l.auto_update`)
  ).map((r: any) => num(r.product_id));
  if (metaGo) {
    const r = await syncProducts(ctx, auto);
    out.sent = r.sent;
    out.removed = r.removed;
  }
  if (ttGo) {
    out.tiktok = (await ttStep(() => ttSyncProducts(ctx, auto)))?.sent ?? 0;
    // a list TikTok did not take yet (refused, or sent before)
    out.tiktok += (await ttStep(() => ttSendSent(ctx, { onlyLate: true }))) ?? 0;
  }
  // the lists whose products changed since they were sent
  for (const l of await db.query(`SELECT id FROM meta_catalog_lists WHERE sent_at IS NOT NULL AND auto_update AND changed_at IS NOT NULL`)) {
    if (metaGo) await syncSet(ctx, num(l.id));
    if (ttGo && !(await ttStep(() => ttSyncSet(ctx, num(l.id))))) await ttLate(db, num(l.id));
    await db.query(`UPDATE meta_catalog_lists SET sent_at = $2, changed_at = NULL WHERE id = $1`, [l.id, iso(new Date(ctx.now()))]);
  }
  if (metaGo) out.checked = await checkBatches(ctx);
  if (ttGo) {
    out.checked += (await ttStep(() => ttCheck(ctx))) ?? 0;
    if (ttError !== t.error) await ttPatch(db, { error: ttError });
  }
  return out;
}

// ---------------------------------------------------------------- the page
const PROBLEM_TEXT = {
  nopage: 'Meta et TikTok montrent chaque produit avec sa page : créez sa landing page.',
  photo: `Meta et TikTok veulent une photo d’au moins ${MIN_SIDE} px de côté : ajoutez-en une plus grande sur sa page.`,
  jpeg: 'Photo en préparation.',
} as const;

type NetState = 'ok' | 'pending' | 'error' | null;
/** What a catalog holds of each product: refused (with why), waiting for the answer, or taken. */
function statesOf(rows: any[], refused: string): Map<number, { state: NetState; error: string | null }> {
  const by = new Map<number, { ok: number; pending: number; error: string | null }>();
  for (const r of rows) {
    const k = by.get(num(r.product_id)) ?? { ok: 0, pending: 0, error: null };
    if (r.status === 'ok') k.ok++;
    else if (r.status === 'pending') k.pending++;
    else if (r.status === 'error') k.error = k.error ?? String(r.error ?? refused);
    by.set(num(r.product_id), k);
  }
  return new Map([...by].map(([pid, k]) => [pid, { state: k.error ? 'error' : k.pending ? 'pending' : k.ok ? 'ok' : null, error: k.error }]));
}

async function board(ctx: Ctx) {
  const db = ctx.db;
  const s = await catalogSettings(db);
  const t = await ttSettings(db);
  const w = await whereOf(ctx);
  const prods = await loadProducts(db);
  const items = await db.query(`SELECT retailer_id, product_id, status, error FROM meta_catalog_items WHERE status <> 'deleted'`);
  const ttItems = t.on ? await db.query(`SELECT sku_id, product_id, status, error FROM tiktok_catalog_items WHERE status <> 'deleted'`) : [];
  const metaOf = statesOf(items, 'Refusé par Meta');
  const ttOf = statesOf(ttItems, 'Refusé par TikTok');
  const listRows = await db.query(`SELECT * FROM meta_catalog_lists ORDER BY position, id`);
  const members = await db.query(`SELECT list_id, product_id FROM meta_catalog_list_products ORDER BY position, added_at`);
  const inLists = new Map<number, number[]>();
  for (const m of members) inLists.set(num(m.product_id), [...(inLists.get(num(m.product_id)) ?? []), num(m.list_id)]);
  const needJpeg = new Map<number, string | null>();
  const products = prods.map((p) => {
    const problem = problemOf(p, w.demo);
    const meta = metaOf.get(p.id);
    const tk = ttOf.get(p.id);
    // a list's product asks the browser for its JPEG copies
    if (p.page && inLists.has(p.id))
      for (const x of p.page.pics) if (x.id && !x.jpg && x.w >= MIN_SIDE && x.h >= MIN_SIDE) needJpeg.set(x.id, ctx.server ? `${publicApi(ctx)}/lp/img/${x.id}/960.webp` : null);
    const first = p.page?.pics[0] ?? null;
    const thumb = first ? (first.id ? (ctx.server ? `${publicApi(ctx)}/lp/img/${first.id}/160.webp` : null) : first.url) : null;
    const stock = p.variants.reduce((n, v) => n + v.stock, 0);
    const now = p.page?.price ?? p.price;
    return {
      id: p.id,
      name: p.name,
      price: now,
      oldPrice: p.page?.oldPrice && p.page.oldPrice > now ? p.page.oldPrice : null,
      variants: p.variants.length,
      stock,
      thumb,
      slug: p.page?.slug ?? null,
      problem: problem === 'jpeg' ? null : problem,
      preparing: problem === 'jpeg',
      problemText:
        problem && problem !== 'jpeg' ? PROBLEM_TEXT[problem] : meta?.error ? `Meta : ${meta.error}` : tk?.error ? (/^TikTok/i.test(tk.error) ? tk.error : `TikTok : ${tk.error}`) : null,
      meta: meta?.state ?? null,
      /** null when « Envoyer aussi à TikTok » is off */
      tiktok: tk?.state ?? null,
      lists: inLists.get(p.id) ?? [],
    };
  });
  const pById = new Map(products.map((p) => [p.id, p]));
  const metaOk = await metaReady(ctx);
  const ttOk = t.on && (await ttLinked(ctx));
  const lists = listRows.map((l: any) => {
    const pids = members.filter((m: any) => num(m.list_id) === num(l.id)).map((m: any) => num(m.product_id)).filter((x: number) => pById.has(x));
    const ps = pids.map((x: number) => pById.get(x)!);
    const fix = ps.filter((p) => !!p.problem || p.meta === 'error' || p.tiktok === 'error').length;
    const pending = ps.some((p) => p.meta === 'pending' || p.preparing || p.tiktok === 'pending');
    const state = !l.sent_at ? 'new' : fix ? 'fix' : l.changed_at && !l.auto_update ? 'changed' : pending || l.changed_at || (ttOk && !l.tt_sent_at) ? 'pending' : 'ok';
    // where the list is: each catalog's own state (the page shows them once TikTok is on)
    const net = (on: boolean, sent: boolean, k: 'meta' | 'tiktok') =>
      !on || !l.sent_at ? null : !sent ? ('wait' as const) : ps.some((p) => p[k] === 'error') ? ('fix' as const) : ps.some((p) => p[k] === 'pending') || l.changed_at ? ('pending' as const) : ('ok' as const);
    return {
      id: num(l.id),
      name: String(l.name),
      autoUpdate: !!l.auto_update,
      sentAt: isoOrNull(l.sent_at),
      changedAt: isoOrNull(l.changed_at),
      productIds: pids,
      fix,
      state: state as 'new' | 'fix' | 'changed' | 'pending' | 'ok',
      metaState: net(metaOk || !!l.set_id, !!l.set_id, 'meta'),
      tiktokState: net(t.on, !!l.tt_sent_at, 'tiktok'),
      articles: items.filter((i: any) => pids.includes(num(i.product_id))).length,
    };
  });
  return {
    catalog: { connected: !!s.catalogId, businessName: s.businessName, pixelsLinked: s.pixelsLinked, live: !simulated(ctx), ready: metaOk, base: `${w.pages}/${w.store}` },
    tiktok: {
      /** the TikTok Ads account is linked (Pilot AI › Comptes) */
      linked: await ttLinked(ctx),
      on: t.on,
      connected: !!t.catalogId,
      bcName: t.bcName,
      pixelBound: t.pixelBound,
      error: t.error,
      articles: ttItems.filter((i: any) => i.status === 'ok' || i.status === 'pending').length,
    },
    products,
    lists,
    // the pictures the browser turns into JPEG for Meta and TikTok (Catalogue does it by itself), a few at a time
    needJpeg: [...needJpeg].slice(0, 40).map(([pic, url]) => ({ id: pic, url })),
    articles: items.filter((i: any) => i.status === 'ok' || i.status === 'pending').length,
  };
}

async function touch(db: Db, listIds: number[], now: number) {
  if (listIds.length) await db.query(`UPDATE meta_catalog_lists SET changed_at = $2, updated_at = $2 WHERE id = ANY($1) AND sent_at IS NOT NULL`, [listIds, iso(new Date(now))]);
}
async function listOf(db: Db, listId: number) {
  const l = (await db.query(`SELECT * FROM meta_catalog_lists WHERE id = $1`, [listId]))[0];
  if (!l) throw notFound('Liste introuvable');
  return l;
}

export const metacatalogProcs = {
  /** The products (with what stops them from going to Meta and TikTok), the lists and the catalogs. */
  'metacatalog.board': proc([...ROLES], z.object({}), (ctx) => board(ctx)),

  /** A new list, or its new name. */
  'metacatalog.listSave': proc([...ROLES], z.object({ id: id.optional(), name: z.string().trim().min(2, 'Donnez un nom à la liste').max(80) }), async (ctx, i) => {
    const db = ctx.db;
    if (i.id) {
      await listOf(db, i.id);
      await db.query(`UPDATE meta_catalog_lists SET name = $2, updated_at = now(), changed_at = CASE WHEN sent_at IS NOT NULL THEN now() ELSE changed_at END WHERE id = $1`, [i.id, i.name]);
      return { id: i.id };
    }
    if (num((await db.query(`SELECT count(*)::int AS n FROM meta_catalog_lists`))[0]?.n) >= 50) throw bad('50 listes au plus');
    const r = await db.query(
      `INSERT INTO meta_catalog_lists (name, position, created_by) VALUES ($1, (SELECT COALESCE(max(position), 0) + 1 FROM meta_catalog_lists), $2) RETURNING id`,
      [i.name, me(ctx)],
    );
    return { id: num(r[0].id) };
  }),

  /**
   * A list goes away (and its product sets at Meta and TikTok; its products leave the catalogs if no other sent list
   * has them).
   */
  'metacatalog.listRemove': proc([...ROLES], z.object({ id }), async (ctx, i) => {
    const db = ctx.db;
    const l = await listOf(db, i.id);
    const pids = (await db.query(`SELECT product_id FROM meta_catalog_list_products WHERE list_id = $1`, [i.id])).map((r: any) => num(r.product_id));
    const t = await ttSettings(db);
    if (l.set_id && !simulated(ctx)) await ctx.server!.meta('catalogSetDelete', { setId: String(l.set_id) }, ctx).catch(() => null);
    if (l.tt_set_id && t.catalogId && !simulated(ctx)) await tt(ctx, 'ttCatalogSetDelete', { bcId: t.bcId, catalogId: t.catalogId, setId: String(l.tt_set_id) }).catch(() => null);
    await db.query(`DELETE FROM meta_catalog_lists WHERE id = $1`, [i.id]);
    if (l.sent_at && pids.length) {
      const still = new Set(await wanted(db));
      const out = pids.filter((p: number) => !still.has(p));
      if (out.length && (await catalogSettings(db)).catalogId && (await metaReady(ctx))) await syncProducts(ctx, out);
      if (out.length && t.on && t.catalogId && (await ttLinked(ctx))) await ttSyncProducts(ctx, out).catch(async (e) => void (await ttPatch(db, { error: why(e) })));
    }
    return { ok: true };
  }),

  /** « Mettre à jour tout seul » on or off. */
  'metacatalog.listAuto': proc([...ROLES], z.object({ id, on: z.boolean() }), async (ctx, i) => {
    await listOf(ctx.db, i.id);
    await ctx.db.query(`UPDATE meta_catalog_lists SET auto_update = $2, updated_at = now() WHERE id = $1`, [i.id, i.on]);
    return { on: i.on };
  }),

  /** A product dropped in a list (from the products, or moved from another list). */
  'metacatalog.add': proc([...ROLES], z.object({ listId: id, productId: id, fromListId: id.optional() }), async (ctx, i) => {
    const db = ctx.db;
    await listOf(db, i.listId);
    const p = (await db.query(`SELECT id FROM products WHERE id = $1 AND active AND NOT is_service AND archived_at IS NULL`, [i.productId]))[0];
    if (!p) throw notFound('Produit introuvable');
    const n = num((await db.query(`SELECT count(*)::int AS n FROM meta_catalog_list_products WHERE list_id = $1`, [i.listId]))[0]?.n);
    if (n >= 1000) throw bad('1 000 produits au plus par liste');
    const r = await db.query(
      `INSERT INTO meta_catalog_list_products (list_id, product_id, position, added_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING list_id`,
      [i.listId, i.productId, n + 1, iso(new Date(ctx.now()))],
    );
    const changed = r.length ? [i.listId] : [];
    if (i.fromListId && i.fromListId !== i.listId) {
      const d = await db.query(`DELETE FROM meta_catalog_list_products WHERE list_id = $1 AND product_id = $2 RETURNING list_id`, [i.fromListId, i.productId]);
      if (d.length) changed.push(i.fromListId);
    }
    await touch(db, changed, ctx.now());
    // the preview has no background job: a list « mise à jour toute seule » is sent at once
    if (simulated(ctx)) await runCatalog(ctx);
    return { added: r.length > 0 };
  }),

  /** A product taken out of a list. */
  'metacatalog.remove': proc([...ROLES], z.object({ listId: id, productId: id }), async (ctx, i) => {
    const d = await ctx.db.query(`DELETE FROM meta_catalog_list_products WHERE list_id = $1 AND product_id = $2 RETURNING list_id`, [i.listId, i.productId]);
    await touch(ctx.db, d.length ? [i.listId] : [], ctx.now());
    if (simulated(ctx)) await runCatalog(ctx);
    return { removed: d.length > 0 };
  }),

  /**
   * « Envoyer »: the list's products (what changed), then the list as a product set, at Meta and, when « Envoyer aussi
   * à TikTok » is on, at TikTok (what TikTok refuses is written on the page; Meta's sending goes on).
   */
  'metacatalog.send': proc([...ROLES], z.object({ id }), async (ctx, i) => {
    const db = ctx.db;
    await listOf(db, i.id);
    const meta = await metaReady(ctx);
    const t = await ttSettings(db);
    const tiktok = t.on && (await ttLinked(ctx));
    if (!meta && !tiktok) throw bad(t.on ? 'Reliez d’abord votre compte Meta ou TikTok (Pilot AI › Comptes)' : 'Reliez d’abord votre compte Meta et votre compte pub (Pilot AI › Comptes)');
    const pids = (await db.query(`SELECT product_id FROM meta_catalog_list_products WHERE list_id = $1`, [i.id])).map((r: any) => num(r.product_id));
    if (!pids.length) throw bad('La liste est vide : glissez-y des produits');
    const prods = await loadProducts(db, pids);
    const blocked = prods.filter((p) => problemOf(p, simulated(ctx))).map((p) => ({ productId: p.id, name: p.name, why: problemOf(p, simulated(ctx))! }));
    // a list sent the first time: its products are « wanted » from now on
    await db.query(`UPDATE meta_catalog_lists SET sent_at = COALESCE(sent_at, $2) WHERE id = $1`, [i.id, iso(new Date(ctx.now()))]);
    let r = { sent: 0, errors: 0 };
    if (meta) {
      r = await syncProducts(ctx, pids);
      await syncSet(ctx, i.id);
    }
    let ttOut: { sent: number; error: string | null } | null = null;
    if (tiktok) {
      try {
        const x = await ttSyncProducts(ctx, pids, { retry: true });
        await ttSyncSet(ctx, i.id);
        ttOut = { sent: x.sent, error: null };
        if (t.error) await ttPatch(db, { error: null });
      } catch (e) {
        ttOut = { sent: 0, error: why(e) };
        await ttPatch(db, { error: ttOut.error });
        await ttLate(db, i.id);
      }
    }
    await db.query(`UPDATE meta_catalog_lists SET sent_at = $2, changed_at = NULL, updated_at = $2 WHERE id = $1`, [i.id, iso(new Date(ctx.now()))]);
    return { sent: r.sent, errors: r.errors, blocked, ready: prods.length - blocked.length, meta, tiktok: ttOut };
  }),

  /**
   * « Envoyer aussi à TikTok » on or off. On: the TikTok catalog is made the first time (in the account's Business
   * Center, for Algeria), then the lists already sent go to it at once. What TikTok refuses comes back as `error` (and
   * stays on the page); the switch stays off when there is no catalog. Off: nothing more goes to TikTok (what is there
   * stays, for the ads that use it).
   */
  'metacatalog.tiktok': proc([...ROLES], z.object({ on: z.boolean() }), async (ctx, i) => {
    const db = ctx.db;
    if (!i.on) {
      await ttPatch(db, { on: false, error: null });
      return { on: false, sent: 0, error: null as string | null };
    }
    if (!(await ttLinked(ctx))) throw bad('Reliez d’abord votre compte TikTok Ads (Pilot AI › Comptes)');
    try {
      await ensureTt(ctx);
    } catch (e) {
      const error = why(e);
      await ttPatch(db, { on: false, error });
      return { on: false, sent: 0, error };
    }
    await ttPatch(db, { on: true, error: null });
    try {
      return { on: true, sent: await ttSendSent(ctx, { retry: true }), error: null as string | null };
    } catch (e) {
      const error = why(e);
      await ttPatch(db, { error });
      return { on: true, sent: 0, error };
    }
  }),

  /** A JPEG copy of a page's picture, made by the browser (Meta and TikTok take no WebP). */
  'metacatalog.photo': proc([...ROLES], z.object({ imageId: id, jpeg: z.string().min(100).max(4_800_000) }), async (ctx, i) => {
    if (!i.jpeg.startsWith('/9j/')) throw bad('Ce n’est pas une photo JPEG');
    const r = await ctx.db.query(`UPDATE landing_images SET jpg = $2 WHERE id = $1 RETURNING id`, [i.imageId, i.jpeg]);
    if (!r.length) throw notFound('Photo introuvable');
    return { ok: true };
  }),

  /** Server: a picture's JPEG copy, for Meta and TikTok (/lp/img/<id>/meta.jpg). */
  'metacatalog.image': proc([], z.object({ id }), async (ctx, i) => {
    const r = (await ctx.db.query(`SELECT jpg FROM landing_images WHERE id = $1`, [i.id]))[0];
    if (!r?.jpg) throw notFound('Photo introuvable');
    return { base64: String(r.jpg) };
  }),

  /** Server: send what changed and read Meta's and TikTok's answers (every few minutes). */
  'metacatalog.run': proc([], z.object({}), (ctx) => runCatalog(ctx)),
};
