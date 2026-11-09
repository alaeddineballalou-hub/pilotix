// « Envoyer des photos » (Confirmation): a confirmation agent sends a customer the photos of products — the order's,
// with their colour, or others he adds — from his own WhatsApp. The message opens in WhatsApp with the products' names
// and one link: WhatsApp shows its first photo, the customer opens it to see them all (photo_pages). The photos are the
// shop's own (its HD photos, its pages', the colour's and the product's), made public JPEG copies by the server.
// The page shows the shop's name and the products only: never the customer, the order or a price.
import { z } from 'zod';
import { iso, num } from '../db';
import { bad, Ctx, notFound, proc, publicApi } from '../rpc';
import { getSetting } from '../settings';
import { PhotoSrc, productPhotos } from './dellalphotos';
import { getOrder } from './orders';
import { assignedProductIds } from './productscope';

/** at most this many products in one send, and this many photos of each */
export const PHOTO_ITEMS_MAX = 10;
export const PHOTOS_PER_ITEM = 3;

const id = z.number().int().positive();
const Item = z.object({ productId: id, variantId: id.nullable() });
type ItemT = z.infer<typeof Item>;

/** the same product and colour once, in the order chosen */
const uniq = (items: ItemT[]) => {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = `${i.productId}:${i.variantId ?? 0}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/** what a product (and its colour) is called in the message and on the page: « Poussette canne — Rouge » */
async function namesOf(ctx: Ctx, items: ItemT[]) {
  const allowed = await assignedProductIds(ctx);
  const P = await ctx.db.query('SELECT id, name FROM products WHERE id = ANY($1)', [items.map((i) => i.productId)]);
  const V = await ctx.db.query('SELECT id, product_id, title FROM product_variants WHERE id = ANY($1)', [items.map((i) => i.variantId).filter((v): v is number => v !== null)]);
  const pn = new Map<number, string>(P.map((p: any) => [num(p.id), String(p.name)]));
  const vn = new Map<number, { p: number; t: string }>(V.map((v: any) => [num(v.id), { p: num(v.product_id), t: String(v.title ?? '') }]));
  return items.map((i) => {
    const name = pn.get(i.productId);
    // (an agent given some products only: those)
    if (!name || (allowed && !allowed.includes(i.productId))) throw notFound('Produit introuvable');
    const v = i.variantId === null ? null : vn.get(i.variantId);
    if (i.variantId !== null && (!v || v.p !== i.productId)) throw notFound('Variante introuvable');
    return { ...i, name, variant: v?.t.trim() || null, label: v?.t.trim() ? `${name} — ${v.t.trim()}` : name };
  });
}

/** the photos of a product (the colour's first), as sent */
const photosOf = (ctx: Ctx, i: ItemT) => productPhotos(ctx.db, i.productId, { variantId: i.variantId, size: 'send', max: PHOTOS_PER_ITEM, svg: true });

/** The photos each product (and colour) would send: small copies for the window, and how many. */
export async function photoThumbs(ctx: Ctx, items: ItemT[]) {
  const out = [];
  for (const i of await namesOf(ctx, uniq(items))) {
    const ph = await photosOf(ctx, i);
    out.push({ productId: i.productId, variantId: i.variantId, label: i.label, count: ph.length, thumbs: ph.map((p) => p.thumb).filter((t): t is string => !!t).slice(0, PHOTOS_PER_ITEM) });
  }
  return out;
}

/** a random key of 24 hex characters (the page's link cannot be guessed) */
function randomKey() {
  const b = new Uint8Array(12);
  globalThis.crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * The page of a send: the products' photos at public addresses (the server's JPEG copies; the preview keeps its own
 * pictures, and has no link). Returns its link and what the message lists.
 */
export async function sharePhotos(ctx: Ctx, orderId: number, items: ItemT[]) {
  const o = await getOrder(ctx, orderId);
  const named = await namesOf(ctx, uniq(items));
  if (!named.length) throw bad('Choisissez au moins un produit.');
  if (named.length > PHOTO_ITEMS_MAX) throw bad(`${PHOTO_ITEMS_MAX} produits au plus dans un envoi.`);
  const found: { label: string; photos: PhotoSrc[] }[] = [];
  for (const i of named) found.push({ label: i.label, photos: await photosOf(ctx, i) });
  const all = found.flatMap((f) => f.photos);
  if (!all.length) throw bad('Pas de photo pour ces produits : ajoutez-en dans Produits & stock (photo du produit ou de la couleur).');
  const base = publicApi(ctx);
  let urls: (string | null)[];
  if (ctx.server?.dellal && base) {
    const r: any = await ctx.server.dellal('photoLinks', { photos: all }, ctx);
    urls = Array.isArray(r?.urls) ? r.urls : [];
  } else urls = all.map((p) => p.thumb ?? p.url ?? null); // the preview: its own pictures (no public link)
  let k = 0;
  const pageItems = found
    .map((f) => ({ label: f.label, photos: f.photos.map(() => urls[k++] ?? null).filter((u): u is string => !!u) }))
    .filter((f) => f.photos.length);
  if (!pageItems.length) throw bad('Les photos n’ont pas pu être préparées : réessayez dans un instant.');
  await ctx.db.query(`DELETE FROM photo_pages WHERE created_at < now() - interval '90 days'`);
  const key = randomKey();
  const row = (await ctx.db.query('INSERT INTO photo_pages (key, order_id, items, created_by) VALUES ($1, $2, $3, $4) RETURNING id', [key, o.id, JSON.stringify(pageItems), ctx.session.profile.id]))[0];
  return {
    /** the page's link (null in the preview: it has no public address) */
    url: base ? `${base}/lp/ph/${num(row.id)}/${key}` : null,
    items: pageItems.map((f) => ({ label: f.label, photos: f.photos.length })),
    /** products without any photo: not on the page */
    missing: found.filter((f) => !pageItems.some((p) => p.label === f.label)).map((f) => f.label),
  };
}

/** A send's page, for its public address (the server's): the shop's name and the products' photos. */
export async function photoPage(ctx: Ctx, pageId: number, key: string) {
  const r = (await ctx.db.query('SELECT items, created_at FROM photo_pages WHERE id = $1 AND key = $2', [pageId, key]))[0];
  if (!r) throw notFound('Page introuvable');
  const items = ((typeof r.items === 'string' ? JSON.parse(r.items) : r.items) ?? []) as { label: string; photos: string[] }[];
  // the JPEG copies it shows stay while it is looked at (copies nobody uses for a month are removed)
  const ids = items.flatMap((i) => i.photos.map((u) => /\/lp\/dp\/(\d+)\//.exec(u)?.[1])).filter((x): x is string => !!x).map(Number);
  if (ids.length) await ctx.db.query('UPDATE dellal_photos SET used_at = now() WHERE id = ANY($1)', [ids]).catch(() => undefined);
  const shop = await getSetting(ctx.db, 'shop');
  return { shop: String(shop.name ?? ''), items, createdAt: iso(r.created_at) };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** only our own photos' addresses go in the page (https, no quote or space to break out of the attribute) */
const safeUrl = (u: string) => (/^https:\/\/[^\s"'<>]+$/i.test(u) ? u : null);

/**
 * The page the customer opens (and WhatsApp reads for its preview: og:image is the first photo). Plain HTML, nothing
 * loaded but the photos; never indexed.
 */
export function photoPageHtml(p: { shop: string; items: { label: string; photos: string[] }[] }) {
  const items = p.items.map((i) => ({ label: i.label, photos: i.photos.map(safeUrl).filter((u): u is string => !!u) })).filter((i) => i.photos.length);
  const first = items[0];
  const shop = p.shop.trim() || 'Pilotix';
  const title = first ? (items.length > 1 ? `${first.label} + ${items.length - 1}` : first.label) : shop;
  const desc = items.map((i) => i.label).join(' · ');
  const blocks = items
    .map(
      (i) =>
        `<section><h2>${esc(i.label)}</h2>${i.photos.map((u, k) => `<img src="${esc(u)}" alt="${esc(i.label)}${i.photos.length > 1 ? ` (${k + 1})` : ''}" loading="${k ? 'lazy' : 'eager'}">`).join('')}</section>`,
    )
    .join('');
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} · ${esc(shop)}</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(shop)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
${first ? `<meta property="og:image" content="${esc(first.photos[0])}">\n<meta property="og:image:secure_url" content="${esc(first.photos[0])}">\n<meta property="og:image:type" content="image/jpeg">\n<meta property="og:image:alt" content="${esc(first.label)}">\n<meta name="twitter:card" content="summary_large_image">` : ''}
<style>
*{box-sizing:border-box}
body{margin:0;background:#f6f3ee;color:#1b2a47;font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Arabic",sans-serif}
header{padding:18px 16px 6px;text-align:center}
header b{display:block;font-size:19px;letter-spacing:.2px}
header small{color:#5f6673;font-size:14px}
main{max-width:640px;margin:0 auto;padding:6px 12px 28px}
section{background:#fff;border-radius:16px;box-shadow:0 1px 3px rgba(27,42,71,.08);margin:12px 0;padding:12px 12px 4px}
h2{font-size:16px;margin:2px 4px 10px;overflow-wrap:anywhere}
img{display:block;width:100%;height:auto;border-radius:12px;margin:0 0 8px;background:#eee}
</style>
</head>
<body>
<header><b>${esc(shop)}</b><small>${items.length > 1 ? `${items.length} produits` : 'Votre produit'}</small></header>
<main>${blocks || '<p style="text-align:center;color:#5f6673">Ces photos ne sont plus disponibles.</p>'}</main>
</body>
</html>`;
}

export const photoShareProcs = {
  /** « Envoyer des photos »: the photos each product (and colour) would send, small copies for the window. */
  'confirmation.photoThumbs': proc(['confirmation'], z.object({ items: z.array(Item).min(1).max(PHOTO_ITEMS_MAX * 2) }), (ctx, i) => photoThumbs(ctx, i.items)),
  /** « Envoyer des photos »: the page of this send (its link goes in the WhatsApp message). */
  'confirmation.photoShare': proc(['confirmation'], z.object({ orderId: id, items: z.array(Item).min(1).max(PHOTO_ITEMS_MAX) }), (ctx, i) => sharePhotos(ctx, i.orderId, i.items)),
  /** A send's page, for its public address: read by the server only (admin = the system). */
  'photos.page': proc([], z.object({ id, key: z.string().regex(/^[a-f0-9]{24}$/) }), (ctx, i) => photoPage(ctx, i.id, i.key)),
};
