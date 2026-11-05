// Marketing › Catalogue: the shop makes its own lists of products (« Promo de la semaine », « Bébé 0-6 mois »), drags
// products into them, and sends each list to Meta. The shop has one Meta catalog (made by Pilotix in the ad account's
// business, its pixels linked to it); each list is a product set of that catalog, picked when making a catalog ad.
// The catalog holds the products that are in a sent list, one line per colour / size (item_group_id = the product, the
// id the landing pages' pixel sends): their page, pictures (a JPEG copy made by the browser: Meta takes no WebP), price
// (the page's crossed-out price as the old one), stock and brand. A list « mise à jour toute seule » sends again what
// changed (a price, the stock, a picture) every few minutes; a product taken out of every list leaves the catalog.
import { z } from 'zod';
import { Db, iso, isoOrNull, num, numOrNull } from '../db';
import { bad, Ctx, notFound, proc, publicApi } from '../rpc';
import { getSetting } from '../settings';
import { getRaw, META_TOKEN_KEY } from './admin';
import { landingStore } from './landingquery';

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

/** The lines Meta gets for a product: one per colour / size. */
export function itemsOf(p: Prod, w: Where): { retailerId: string; variantId: number; data: Record<string, unknown> }[] {
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
    // the colour's own picture first, then the page's
    const own = good.filter((x) => x.v === v.id);
    const pics = [...own, ...good.filter((x) => x.v !== v.id)].slice(0, 10);
    const label = page.variantLabel;
    const data: Record<string, unknown> = {
      id: `${p.id}-${v.id}`,
      item_group_id: String(p.id),
      title: (many && v.title ? `${page.title} – ${v.title}` : page.title).slice(0, 200),
      description: text,
      availability: v.stock > 0 ? 'in stock' : 'out of stock',
      condition: 'new',
      price: `${old ?? now} DZD`,
      ...(old ? { sale_price: `${now} DZD` } : {}),
      link,
      image: pics.map((x) => ({ url: urlOf(x), tag: [] as string[] })),
      brand: (p.brand || w.brand).slice(0, 100),
    };
    if (many && v.title) {
      if (COLOR.test(label)) data.color = v.title.slice(0, 200);
      else if (SIZE.test(label)) data.size = v.title.slice(0, 200);
    }
    return { retailerId: `${p.id}-${v.id}`, variantId: v.id, data };
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

/** Every few minutes: lists « mises à jour toutes seules » send what changed; Meta's answers come back. */
export async function runCatalog(ctx: Ctx): Promise<{ sent: number; removed: number; checked: number }> {
  const db = ctx.db;
  const s = await catalogSettings(db);
  if (!s.catalogId) return { sent: 0, removed: 0, checked: 0 };
  const auto = (
    await db.query(`SELECT DISTINCT lp.product_id FROM meta_catalog_list_products lp JOIN meta_catalog_lists l ON l.id = lp.list_id WHERE l.sent_at IS NOT NULL AND l.auto_update`)
  ).map((r: any) => num(r.product_id));
  const r = await syncProducts(ctx, auto);
  // the lists whose products changed since they were sent
  for (const l of await db.query(`SELECT id FROM meta_catalog_lists WHERE sent_at IS NOT NULL AND auto_update AND changed_at IS NOT NULL`)) {
    await syncSet(ctx, num(l.id));
    await db.query(`UPDATE meta_catalog_lists SET sent_at = $2, changed_at = NULL WHERE id = $1`, [l.id, iso(new Date(ctx.now()))]);
  }
  const checked = await checkBatches(ctx);
  return { sent: r.sent, removed: r.removed, checked };
}

// ---------------------------------------------------------------- the page
const PROBLEM_TEXT = {
  nopage: 'Meta montre chaque produit avec sa page : créez sa landing page.',
  photo: `Meta veut une photo d’au moins ${MIN_SIDE} px de côté : ajoutez-en une plus grande sur sa page.`,
  jpeg: 'Photo en préparation pour Meta.',
} as const;

async function board(ctx: Ctx) {
  const db = ctx.db;
  const s = await catalogSettings(db);
  const w = await whereOf(ctx);
  const prods = await loadProducts(db);
  const items = await db.query(`SELECT retailer_id, product_id, status, error FROM meta_catalog_items WHERE status <> 'deleted'`);
  const byProduct = new Map<number, { ok: number; pending: number; error: string | null }>();
  for (const r of items) {
    const k = byProduct.get(num(r.product_id)) ?? { ok: 0, pending: 0, error: null };
    if (r.status === 'ok') k.ok++;
    else if (r.status === 'pending') k.pending++;
    else if (r.status === 'error') k.error = k.error ?? String(r.error ?? 'Refusé par Meta');
    byProduct.set(num(r.product_id), k);
  }
  const listRows = await db.query(`SELECT * FROM meta_catalog_lists ORDER BY position, id`);
  const members = await db.query(`SELECT list_id, product_id FROM meta_catalog_list_products ORDER BY position, added_at`);
  const inLists = new Map<number, number[]>();
  for (const m of members) inLists.set(num(m.product_id), [...(inLists.get(num(m.product_id)) ?? []), num(m.list_id)]);
  const needJpeg = new Map<number, string | null>();
  const products = prods.map((p) => {
    const problem = problemOf(p, w.demo);
    const meta = byProduct.get(p.id);
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
      problemText: problem && problem !== 'jpeg' ? PROBLEM_TEXT[problem] : meta?.error ? `Meta : ${meta.error}` : null,
      meta: meta?.error ? ('error' as const) : meta?.pending ? ('pending' as const) : meta?.ok ? ('ok' as const) : null,
      lists: inLists.get(p.id) ?? [],
    };
  });
  const pById = new Map(products.map((p) => [p.id, p]));
  const lists = listRows.map((l: any) => {
    const pids = members.filter((m: any) => num(m.list_id) === num(l.id)).map((m: any) => num(m.product_id)).filter((x: number) => pById.has(x));
    const fix = pids.filter((x: number) => {
      const p = pById.get(x)!;
      return !!p.problem || p.meta === 'error';
    }).length;
    const pending = pids.some((x: number) => pById.get(x)!.meta === 'pending' || pById.get(x)!.preparing);
    const state = !l.sent_at ? 'new' : fix ? 'fix' : l.changed_at && !l.auto_update ? 'changed' : pending || l.changed_at ? 'pending' : 'ok';
    return {
      id: num(l.id),
      name: String(l.name),
      autoUpdate: !!l.auto_update,
      sentAt: isoOrNull(l.sent_at),
      changedAt: isoOrNull(l.changed_at),
      productIds: pids,
      fix,
      state: state as 'new' | 'fix' | 'changed' | 'pending' | 'ok',
      articles: items.filter((i: any) => pids.includes(num(i.product_id))).length,
    };
  });
  const ready = simulated(ctx) || (!!(await getRaw<string>(db, META_TOKEN_KEY, '')) && !!(await getSetting(db, 'meta')).adAccountId);
  return {
    catalog: { connected: !!s.catalogId, businessName: s.businessName, pixelsLinked: s.pixelsLinked, live: !simulated(ctx), ready, base: `${w.pages}/${w.store}` },
    products,
    lists,
    // the pictures the browser turns into JPEG for Meta (Catalogue does it by itself), a few at a time
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
  /** The products (with what stops them from going to Meta), the lists and the catalog. */
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

  /** A list goes away (and its product set at Meta; its products leave the catalog if no other sent list has them). */
  'metacatalog.listRemove': proc([...ROLES], z.object({ id }), async (ctx, i) => {
    const db = ctx.db;
    const l = await listOf(db, i.id);
    const pids = (await db.query(`SELECT product_id FROM meta_catalog_list_products WHERE list_id = $1`, [i.id])).map((r: any) => num(r.product_id));
    if (l.set_id && !simulated(ctx)) await ctx.server!.meta('catalogSetDelete', { setId: String(l.set_id) }, ctx).catch(() => null);
    await db.query(`DELETE FROM meta_catalog_lists WHERE id = $1`, [i.id]);
    if (l.sent_at && pids.length) {
      const still = new Set(await wanted(db));
      const out = pids.filter((p: number) => !still.has(p));
      if (out.length) await syncProducts(ctx, out);
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

  /** « Envoyer à Meta »: the list's products (what changed), then the list as a product set. */
  'metacatalog.send': proc([...ROLES], z.object({ id }), async (ctx, i) => {
    const db = ctx.db;
    await listOf(db, i.id);
    if (!simulated(ctx)) {
      const ready = !!(await getRaw<string>(db, META_TOKEN_KEY, '')) && !!(await getSetting(db, 'meta')).adAccountId;
      if (!ready) throw bad('Reliez d’abord votre compte Meta et votre compte pub (Pilot AI › Comptes)');
    }
    const pids = (await db.query(`SELECT product_id FROM meta_catalog_list_products WHERE list_id = $1`, [i.id])).map((r: any) => num(r.product_id));
    if (!pids.length) throw bad('La liste est vide : glissez-y des produits');
    const prods = await loadProducts(db, pids);
    const blocked = prods.filter((p) => problemOf(p, simulated(ctx))).map((p) => ({ productId: p.id, name: p.name, why: problemOf(p, simulated(ctx))! }));
    // a list sent the first time: its products are « wanted » from now on
    await db.query(`UPDATE meta_catalog_lists SET sent_at = COALESCE(sent_at, $2) WHERE id = $1`, [i.id, iso(new Date(ctx.now()))]);
    const r = await syncProducts(ctx, pids);
    await syncSet(ctx, i.id);
    await db.query(`UPDATE meta_catalog_lists SET sent_at = $2, changed_at = NULL, updated_at = $2 WHERE id = $1`, [i.id, iso(new Date(ctx.now()))]);
    return { sent: r.sent, errors: r.errors, blocked, ready: prods.length - blocked.length };
  }),

  /** A JPEG copy of a page's picture, made by the browser (Meta takes no WebP). */
  'metacatalog.photo': proc([...ROLES], z.object({ imageId: id, jpeg: z.string().min(100).max(4_800_000) }), async (ctx, i) => {
    if (!i.jpeg.startsWith('/9j/')) throw bad('Ce n’est pas une photo JPEG');
    const r = await ctx.db.query(`UPDATE landing_images SET jpg = $2 WHERE id = $1 RETURNING id`, [i.imageId, i.jpeg]);
    if (!r.length) throw notFound('Photo introuvable');
    return { ok: true };
  }),

  /** Server: a picture's JPEG copy, for Meta (/lp/img/<id>/meta.jpg). */
  'metacatalog.image': proc([], z.object({ id }), async (ctx, i) => {
    const r = (await ctx.db.query(`SELECT jpg FROM landing_images WHERE id = $1`, [i.id]))[0];
    if (!r?.jpg) throw notFound('Photo introuvable');
    return { base64: String(r.jpg) };
  }),

  /** Server: send what changed and read Meta's answers (every few minutes). */
  'metacatalog.run': proc([], z.object({}), (ctx) => runCatalog(ctx)),
};
