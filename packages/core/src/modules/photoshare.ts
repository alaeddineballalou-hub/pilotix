// « Envoyer des photos » (Confirmation): a confirmation agent sends a customer the photos of products — the order's,
// with their colour (or all their colours), or others he adds — from his own WhatsApp. On a phone the message goes
// first, then the real photos (the Pilotix app puts them straight into the customer's chat, a phone's browser through
// its share menu: a link carries text only). On a computer the message carries one link instead: WhatsApp shows its
// first photo, the customer opens it to see them all (photo_pages). The photos are the shop's own (its HD photos, its
// pages', the colour's and the product's), made public JPEG copies by the server.
// The page shows the shop's name and the products only: never the customer, the order or a price.
import { z } from 'zod';
import { iso, num } from '../db';
import { bad, Ctx, notFound, proc, publicApi } from '../rpc';
import { getSetting } from '../settings';
import { PhotoSrc, productPhotos } from './dellalphotos';
import { getOrder } from './orders';
import { assignedProductIds } from './productscope';

/** at most this many products in one send, and this many photos of one product (or one colour) */
export const PHOTO_ITEMS_MAX = 10;
export const PHOTOS_PER_ITEM = 3;
/** « Toutes les couleurs »: each colour's own photos, this many of one colour at most */
export const PHOTOS_PER_COLOUR = 10;
/** at most this many photos in one send (WhatsApp takes 30 at once) */
export const PHOTOS_MAX = 30;

const id = z.number().int().positive();
/** a product and its colour; `all`: every colour of the product, each with its own photos */
const Item = z.object({ productId: id, variantId: id.nullable(), all: z.boolean().optional() });
type ItemT = z.infer<typeof Item>;
type One = { productId: number; variantId: number | null; all: boolean };

/** the same product and colour once, in the order chosen (« all colours » has no colour of its own) */
const uniq = (items: ItemT[]): One[] => {
  const seen = new Set<string>();
  return items
    .map((i) => ({ productId: i.productId, variantId: i.all ? null : i.variantId, all: !!i.all }))
    .filter((i) => {
      const k = `${i.productId}:${i.all ? 'all' : (i.variantId ?? 0)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
};

/** what a product (and its colour) is called in the message and on the page: « Poussette canne — Rouge » */
async function namesOf(ctx: Ctx, items: One[]) {
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
type Named = Awaited<ReturnType<typeof namesOf>>[number];

/** one block of photos (one section of the page): a product, or one of its colours */
type Group = { label: string; colour: string | null; photos: PhotoSrc[] };

/**
 * The photos a product sends, by block: its colour's first (or the product's). « Toutes les couleurs »: each colour
 * with its own photos (a colour without any is left out); when no colour has its own, the product's.
 */
async function groupsOf(ctx: Ctx, i: Named): Promise<Group[]> {
  if (!i.all) return [{ label: i.label, colour: i.variant, photos: await productPhotos(ctx.db, i.productId, { variantId: i.variantId, size: 'send', max: PHOTOS_PER_ITEM, svg: true }) }];
  const V = await ctx.db.query(`SELECT id, title FROM product_variants WHERE product_id = $1 AND active AND btrim(coalesce(title, '')) <> '' ORDER BY id`, [i.productId]);
  const seen = new Set<string>();
  const out: Group[] = [];
  for (const v of V) {
    const vid = num(v.id);
    // only the colour's own photos (asked for a colour without any, the picker gives the product's)
    const own = (await productPhotos(ctx.db, i.productId, { variantId: vid, size: 'send', max: PHOTOS_PER_COLOUR, svg: true })).filter((p) => p.variantId === vid && !seen.has(p.src));
    own.forEach((p) => seen.add(p.src));
    const colour = String(v.title).trim();
    if (own.length) out.push({ label: `${i.name} — ${colour}`, colour, photos: own });
  }
  if (!out.length) out.push({ label: i.name, colour: null, photos: await productPhotos(ctx.db, i.productId, { variantId: null, size: 'send', max: PHOTOS_PER_ITEM, svg: true }) });
  return out;
}

/** The photos each product (and colour) would send: small copies for the window, and how many. */
export async function photoThumbs(ctx: Ctx, items: ItemT[]) {
  const out = [];
  for (const i of await namesOf(ctx, uniq(items))) {
    const g = await groupsOf(ctx, i);
    const photos = g.flatMap((x) => x.photos);
    /** « all colours »: the colours that have photos (the message lists them) */
    const colours = i.all ? g.map((x) => x.colour).filter((c): c is string => !!c) : [];
    // « all colours »: the first photo of each colour first
    const firsts = i.all ? [...g.map((x) => x.photos[0]), ...photos] : photos;
    const thumbs = [...new Set(firsts.map((p) => p?.thumb).filter((t): t is string => !!t))].slice(0, PHOTOS_PER_ITEM);
    const label = i.all && colours.length ? `${i.name} — ${colours.join(', ')}` : i.label;
    out.push({ productId: i.productId, variantId: i.variantId, all: i.all, label, colours, count: photos.length, thumbs });
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
 * The photos of a send, at public addresses (the server's JPEG copies; the preview keeps its own pictures, and has no
 * link), and their page. Returns the photos (the phone hands them to WhatsApp), the page's link (a computer's message
 * carries it) and what the message lists. 30 photos at most, in the order chosen.
 */
export async function sharePhotos(ctx: Ctx, orderId: number, items: ItemT[]) {
  const o = await getOrder(ctx, orderId);
  const named = await namesOf(ctx, uniq(items));
  if (!named.length) throw bad('Choisissez au moins un produit.');
  if (named.length > PHOTO_ITEMS_MAX) throw bad(`${PHOTO_ITEMS_MAX} produits au plus dans un envoi.`);
  // each product's blocks; the same photo once in a send; then 30 photos in all
  const seen = new Set<string>();
  let room = PHOTOS_MAX;
  let cut = 0;
  /** `had`: the product's photos (some may already be in the send: sent once) */
  const per: { label: string; had: number; blocks: Group[] }[] = [];
  for (const i of named) {
    const blocks: Group[] = [];
    let had = 0;
    for (const g of await groupsOf(ctx, i)) {
      had += g.photos.length;
      const fresh = g.photos.filter((p) => !seen.has(p.src));
      fresh.forEach((p) => seen.add(p.src));
      const take = fresh.slice(0, Math.max(0, room));
      cut += fresh.length - take.length;
      room -= take.length;
      if (take.length) blocks.push({ ...g, photos: take });
    }
    per.push({ label: i.label, had, blocks });
  }
  const all = per.flatMap((p) => p.blocks.flatMap((b) => b.photos));
  if (!all.length) throw bad('Pas de photo pour ces produits : ajoutez-en dans Produits & stock (photo du produit ou de la couleur).');
  const base = publicApi(ctx);
  let urls: (string | null)[];
  if (ctx.server?.dellal && base) {
    const r: any = await ctx.server.dellal('photoLinks', { photos: all }, ctx);
    urls = Array.isArray(r?.urls) ? r.urls : [];
  } else urls = all.map((p) => p.thumb ?? p.url ?? null); // the preview: its own pictures (no public link)
  let k = 0;
  const made = per.map((p) => ({
    ...p,
    blocks: p.blocks.map((b) => ({ label: b.label, photos: b.photos.map(() => urls[k++] ?? null).filter((u): u is string => !!u) })).filter((b) => b.photos.length),
  }));
  // one section per product and colour (a colour chosen on its own and again in « all colours »: together)
  const pageItems: { label: string; photos: string[] }[] = [];
  for (const b of made.flatMap((p) => p.blocks)) {
    const same = pageItems.find((x) => x.label === b.label);
    if (same) same.photos.push(...b.photos);
    else pageItems.push({ label: b.label, photos: [...b.photos] });
  }
  if (!pageItems.length) throw bad('Les photos n’ont pas pu être préparées : réessayez dans un instant.');
  await ctx.db.query(`DELETE FROM photo_pages WHERE created_at < now() - interval '90 days'`);
  const key = randomKey();
  const row = (await ctx.db.query('INSERT INTO photo_pages (key, order_id, items, created_by) VALUES ($1, $2, $3, $4) RETURNING id', [key, o.id, JSON.stringify(pageItems), ctx.session.profile.id]))[0];
  return {
    /** the page's link (null in the preview: it has no public address) */
    url: base ? `${base}/lp/ph/${num(row.id)}/${key}` : null,
    items: pageItems.map((f) => ({ label: f.label, photos: f.photos.length })),
    /** the photos themselves, in order: what the phone hands to WhatsApp */
    photos: pageItems.flatMap((f) => f.photos),
    /** photos left out (30 at most in one send) */
    cut,
    /** products without any photo, or whose photos could not be made: not sent (those only past the 30 are in `cut`) */
    missing: made.filter((m, j) => !m.blocks.length && (per[j].had === 0 || per[j].blocks.length > 0)).map((m) => m.label),
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
