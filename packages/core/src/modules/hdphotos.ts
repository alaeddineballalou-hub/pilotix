// HD product photos for Dellal (Produits › a product › Photos HD): the shop adds one or more photos for each colour or
// size, or for the whole product, and the size chart. The page shrinks each one to 2048 px (JPEG) before it leaves the
// phone; on the server it goes once to Pilotix's Cloudflare R2 bucket (photostore.ts) and the shop keeps only its name
// there and a small copy (320 px) for the screens and for the AI. Dellal sends them when a customer asks for a photo of
// a colour or a size (send_photos: that variant's first), and the size chart when he asks which size to take.
// The browser preview has no bucket: its photos stay in its own database. A server whose bucket is not set refuses them.
// One upload feeds the screens too (Produits › a product › Photos, the only place to add a picture): the first photo of
// a colour / size is that line's small picture, and the product's first photo is its main picture (lists, orders, depot).
import { z } from 'zod';
import { Db, num } from '../db';
import { deleteObjects, OBJECT_KEY, putObject, readStore, StoreConf } from '../photostore';
import { bad, Ctx, notFound, proc } from '../rpc';
import { fromDataUrl, mimeOf } from './dellalphotos';

const DEPOT = ['depot'] as const;
const Id = z.number().int().positive();

/** how many photos, and how big: a photo of 2048 px weighs 0.3 to 1.5 MB; its small copy 15 to 40 KB. A product with many
 *  colours and sizes has one photo or more for each line: 120 for the whole product. */
export const HD = { perProduct: 120, perVariant: 8, sizeCharts: 2, maxBytes: 3_400_000, maxSide: 4096, thumbMax: 120_000, miniMax: 30_000, smallMax: 60_000 } as const;

type Store = { kind: 'r2'; conf: StoreConf } | { kind: 'local' } | { kind: 'off' };

/** Where this shop's photos go: the browser preview and the demo shop keep them; a server, Pilotix's bucket (or nowhere). */
export async function photoStore(ctx: Ctx): Promise<Store> {
  if (!ctx.server || ctx.shop?.demo) return { kind: 'local' };
  const conf = ctx.t ? await readStore(ctx.t.platform).catch(() => null) : null;
  return conf ? { kind: 'r2', conf } : { kind: 'off' };
}

const b64Bytes = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
const fromB64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const randomName = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
const slugOf = (ctx: Ctx) =>
  String(ctx.shop?.slug ?? 'shop')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 40) || 'shop';

/** The files waiting to leave the bucket (photos removed, products deleted): removed now, a few at a time. */
async function purgeTrash(db: Db, s: Store): Promise<void> {
  if (s.kind !== 'r2') return;
  const keys = (await db.query(`SELECT key FROM product_photo_trash ORDER BY at LIMIT 40`).catch(() => [])).map((r: any) => String(r.key));
  if (!keys.length) return;
  const done = await deleteObjects(s.conf, keys).catch(() => [] as string[]);
  if (done.length) await db.query(`DELETE FROM product_photo_trash WHERE key = ANY($1)`, [done]);
}

export interface HdPhoto {
  id: number;
  variantId: number | null;
  kind: 'photo' | 'sizes';
  thumb: string;
  w: number;
  h: number;
  bytes: number;
  position: number;
}

/** the small pictures an HD photo just changed: the product's main one, and each colour's / size's (null: none left) */
export interface SmallChange {
  product?: string | null;
  variants: Record<number, string | null>;
}

/** The product's first photo (its main picture) and each colour's / size's first one, in the photos' order. */
async function firsts(db: Db, productId: number) {
  const rows = await db.query(`SELECT id, variant_id, thumb FROM product_photos WHERE product_id = $1 AND kind = 'photo' ORDER BY position, id`, [productId]);
  const lines = new Map<number, number>();
  const thumb = new Map<number, string>();
  for (const r of rows) {
    const id = num(r.id);
    thumb.set(id, String(r.thumb));
    if (r.variant_id != null && !lines.has(num(r.variant_id))) lines.set(num(r.variant_id), id);
  }
  return { main: rows[0] ? num(rows[0].id) : null, lines, thumb };
}
type Firsts = Awaited<ReturnType<typeof firsts>>;

/**
 * After a photo is added, moved or removed: the small pictures follow. The product's main picture is its first photo's
 * small copy, a colour's / size's picture its own first photo's; a line (or a product) left without any photo loses its
 * picture. Only what changed is written. `added`: the photo just added and the lighter copy the page made of it.
 */
async function syncSmall(db: Db, productId: number, before: Firsts, added?: { id: number; small?: string | null }): Promise<SmallChange> {
  const after = await firsts(db, productId);
  const pic = (id: number | null | undefined) => (id == null ? null : added && added.id === id && added.small ? added.small : after.thumb.get(id) ?? null);
  const out: SmallChange = { variants: {} };
  if (after.main !== before.main) {
    out.product = pic(after.main);
    await db.query('UPDATE products SET photo = $2 WHERE id = $1', [productId, out.product]);
  }
  for (const v of new Set([...before.lines.keys(), ...after.lines.keys()])) {
    if (before.lines.get(v) === after.lines.get(v)) continue;
    out.variants[v] = pic(after.lines.get(v));
    await db.query('UPDATE product_variants SET photo = $3 WHERE id = $1 AND product_id = $2', [v, productId, out.variants[v]]);
  }
  return out;
}

async function view(ctx: Ctx, productId: number, s?: Store, changed: SmallChange = { variants: {} }) {
  const store = s ?? (await photoStore(ctx));
  const rows = await ctx.db.query(`SELECT id, variant_id, kind, thumb, w, h, bytes, position FROM product_photos WHERE product_id = $1 ORDER BY kind, position, id`, [productId]);
  const photos: HdPhoto[] = rows.map((r: any) => ({
    id: num(r.id),
    variantId: r.variant_id == null ? null : num(r.variant_id),
    kind: r.kind === 'sizes' ? 'sizes' : 'photo',
    thumb: String(r.thumb),
    w: num(r.w),
    h: num(r.h),
    bytes: num(r.bytes),
    position: num(r.position),
  }));
  return { store: store.kind, photos, bytes: photos.reduce((a, p) => a + p.bytes, 0), limits: HD, changed };
}

const product = async (db: Db, id: number) => (await db.query('SELECT id FROM products WHERE id = $1', [id]))[0] ?? null;
const variantOf = async (db: Db, productId: number, variantId: number | null | undefined) => {
  if (variantId == null) return null;
  const v = (await db.query('SELECT id FROM product_variants WHERE id = $1 AND product_id = $2', [variantId, productId]))[0];
  if (!v) throw bad('Cette variante n’est pas celle de ce produit.');
  return num(v.id);
};

export const AddInput = z.object({
  productId: Id,
  variantId: Id.nullable().optional(),
  kind: z.enum(['photo', 'sizes']).default('photo'),
  /** the photo: JPEG, base64 (no data: prefix), 2048 px on its long side at most */
  data: z.string().min(100).max(Math.ceil((HD.maxBytes * 4) / 3) + 4),
  w: z.number().int().min(1).max(HD.maxSide),
  h: z.number().int().min(1).max(HD.maxSide),
  /** its small copy: a JPEG data URL, 320 px */
  thumb: z.string().min(40).max(HD.thumbMax),
  /** a smaller one for the chats that send it: 160 px, a few KB */
  mini: z.string().min(40).max(HD.miniMax).optional(),
  /** a lighter 320 px copy (WebP or JPEG data URL) for the lists and the orders, when this photo becomes a picture */
  small: z.string().min(40).max(HD.smallMax).optional(),
});

/** Adds one HD photo (Produits › Photos, and Studio photo: `first` puts it before the others of its colour / size, so
 *  it is the one Dellal sends first for it, and that line's picture; a photo of the whole product goes before all, so
 *  it is the main picture). The small pictures follow (syncSmall). */
export async function addHdPhoto(ctx: Ctx, i: z.infer<typeof AddInput>, first = false) {
  if (!(await product(ctx.db, i.productId))) throw notFound('Produit introuvable');
  const variantId = i.kind === 'sizes' ? null : await variantOf(ctx.db, i.productId, i.variantId);
  const data = i.data.replace(/\s+/g, '');
  if (mimeOf(data) !== 'image/jpeg') throw bad('La photo doit être un JPEG (la page la prépare elle-même : réessayez).');
  const bytes = b64Bytes(data);
  if (bytes > HD.maxBytes) throw bad('Photo trop lourde (3,4 Mo au plus).');
  const t = fromDataUrl(i.thumb);
  if (!t || t.mime !== 'image/jpeg') throw bad('Petite copie invalide.');
  const mini = i.mini ? fromDataUrl(i.mini) : null;
  if (i.mini && (!mini || mini.mime !== 'image/jpeg')) throw bad('Petite copie invalide.');
  if (i.small && !/^data:image\/(jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(i.small)) throw bad('Petite copie invalide.');
  const n = (await ctx.db.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE kind = $2 AND variant_id IS NOT DISTINCT FROM $3::bigint)::int AS here FROM product_photos WHERE product_id = $1`,
    [i.productId, i.kind, variantId],
  ))[0];
  if (num(n?.total) >= HD.perProduct) throw bad(`${HD.perProduct} photos au plus par produit.`);
  if (i.kind === 'sizes' && num(n?.here) >= HD.sizeCharts) throw bad(`${HD.sizeCharts} photos du guide des tailles au plus.`);
  if (i.kind === 'photo' && num(n?.here) >= HD.perVariant) throw bad(`${HD.perVariant} photos au plus pour une même couleur / taille.`);
  const s = await photoStore(ctx);
  if (s.kind === 'off') throw bad('Le stockage des photos HD n’est pas encore activé sur ce serveur : Pilotix doit d’abord le configurer (Plateforme › Santé › Stockage des photos).');
  let key: string | null = null;
  if (s.kind === 'r2') {
    key = `${slugOf(ctx)}/p${i.productId}/${randomName()}.jpg`;
    if (!OBJECT_KEY.test(key)) throw bad('Nom de photo invalide');
    try {
      await putObject(s.conf, key, fromB64(data), 'image/jpeg');
    } catch (e: any) {
      throw bad(`La photo n’a pas pu être enregistrée : ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  const before = await firsts(ctx.db, i.productId);
  // first: before its own colour's / size's photos (the whole product's: before all); else after the others
  const head = first && variantId != null ? (await ctx.db.query(`SELECT min(position) AS p FROM product_photos WHERE product_id = $1 AND kind = 'photo' AND variant_id = $2`, [i.productId, variantId]))[0]?.p : null;
  const at = !first ? null : variantId == null ? 0 : head == null ? null : num(head);
  if (at != null) await ctx.db.query(`UPDATE product_photos SET position = position + 1 WHERE product_id = $1 AND position >= $2`, [i.productId, at]);
  const pos = at ?? num((await ctx.db.query(`SELECT coalesce(max(position), -1) + 1 AS p FROM product_photos WHERE product_id = $1`, [i.productId]))[0]?.p);
  const row = (await ctx.db.query(
    `INSERT INTO product_photos (product_id, variant_id, kind, store, key, data, w, h, bytes, thumb, mini, position) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [i.productId, variantId, i.kind, s.kind, key, s.kind === 'local' ? data : null, i.w, i.h, bytes, `data:image/jpeg;base64,${t.data}`, mini ? `data:image/jpeg;base64,${mini.data}` : null, pos],
  ))[0];
  const changed = await syncSmall(ctx.db, i.productId, before, { id: num(row.id), small: i.small ?? null });
  await purgeTrash(ctx.db, s).catch(() => undefined);
  return view(ctx, i.productId, s, changed);
}

export const hdPhotoProcs = {
  'photos.list': proc([...DEPOT], z.object({ productId: Id }), async (ctx, i) => {
    if (!(await product(ctx.db, i.productId))) throw notFound('Produit introuvable');
    const s = await photoStore(ctx);
    await purgeTrash(ctx.db, s).catch(() => undefined);
    return view(ctx, i.productId, s);
  }),

  'photos.add': proc([...DEPOT], AddInput, (ctx, i) => addHdPhoto(ctx, i)),

  /** another colour / size, the size chart or a photo, or its place (0 = first) */
  'photos.update': proc(
    [...DEPOT],
    z.object({ id: Id, variantId: Id.nullable().optional(), kind: z.enum(['photo', 'sizes']).optional(), position: z.number().int().min(0).max(999).optional() }),
    async (ctx, i) => {
      const r = (await ctx.db.query('SELECT id, product_id, kind, variant_id FROM product_photos WHERE id = $1', [i.id]))[0];
      if (!r) throw notFound('Photo introuvable');
      const productId = num(r.product_id);
      const before = await firsts(ctx.db, productId);
      const kind = i.kind ?? (r.kind === 'sizes' ? 'sizes' : 'photo');
      const variantId = kind === 'sizes' ? null : i.variantId !== undefined ? await variantOf(ctx.db, productId, i.variantId) : r.variant_id == null ? null : num(r.variant_id);
      await ctx.db.query('UPDATE product_photos SET kind = $2, variant_id = $3, position = coalesce($4, position) WHERE id = $1', [i.id, kind, variantId, i.position ?? null]);
      if (i.position !== undefined) {
        // the others move to make room, in their order
        const rows = await ctx.db.query(`SELECT id FROM product_photos WHERE product_id = $1 AND id <> $2 ORDER BY position, id`, [productId, i.id]);
        let p = 0;
        for (const x of rows) {
          if (p === i.position) p++;
          await ctx.db.query('UPDATE product_photos SET position = $2 WHERE id = $1', [x.id, p++]);
        }
      }
      return view(ctx, productId, undefined, await syncSmall(ctx.db, productId, before));
    },
  ),

  'photos.remove': proc([...DEPOT], z.object({ id: Id }), async (ctx, i) => {
    const r = (await ctx.db.query('SELECT product_id FROM product_photos WHERE id = $1', [i.id]))[0];
    if (!r) throw notFound('Photo introuvable');
    const productId = num(r.product_id);
    const before = await firsts(ctx.db, productId);
    await ctx.db.query('DELETE FROM product_photos WHERE id = $1', [i.id]);
    const changed = await syncSmall(ctx.db, productId, before);
    const s = await photoStore(ctx);
    await purgeTrash(ctx.db, s).catch(() => undefined);
    return view(ctx, productId, s, changed);
  }),
};
