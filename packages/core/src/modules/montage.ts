// Montage: one « Montage » service for the whole shop. A product only says whether it can be mounted, its montage
// price and cost, and where (its own wilayas, or null: the shop's list). In an order, « + Montage » adds a line on the
// shared service product that points at the product it mounts (order_items.for_product_id): its price and cost are
// that product's, it never moves stock (a service), and it is refused where the product cannot be mounted.
import { z } from 'zod';
import { Db, num } from '../db';
import { bad, proc } from '../rpc';
import { getRaw, setRaw } from './admin';

export const MONTAGE_SKU = 'SERVICE-MONTAGE';
const ROW = 'montage';

export interface ProductMontage {
  price: number;
  cost: number;
  /** the product's own wilayas; null: the shop's list (Réglages › Montage) */
  wilayas: number[] | null;
}

export const MontageInput = z
  .object({
    price: z.number().int().min(0).max(10_000_000),
    cost: z.number().int().min(0).max(10_000_000).default(0),
    wilayas: z.array(z.number().int().min(1).max(69)).max(69).nullable().default(null),
  })
  .nullable();

/** A product's montage as kept (null: no montage). */
export function readMontage(raw: unknown): ProductMontage | null {
  const v: any = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!v || typeof v !== 'object') return null;
  const wilayas = Array.isArray(v.wilayas) ? [...new Set(v.wilayas.map(num).filter((w: number) => w >= 1 && w <= 69))].sort((a, b) => (a as number) - (b as number)) as number[] : null;
  return { price: Math.max(0, num(v.price)), cost: Math.max(0, num(v.cost)), wilayas };
}

/** The shop's montage wilayas (empty: every wilaya). */
export async function shopMontageWilayas(db: Db): Promise<number[]> {
  const v = await getRaw<any>(db, ROW, null);
  return Array.isArray(v?.wilayas) ? [...new Set<number>(v.wilayas.map(num).filter((w: number) => w >= 1 && w <= 69))].sort((a, b) => a - b) : [];
}

/** Where this product can be mounted: its own list, else the shop's; an empty list is every wilaya. */
export function montageAllowed(m: ProductMontage | null, shop: number[], wilayaId: number): boolean {
  if (!m) return false;
  const list = m.wilayas ?? shop;
  return !list.length || list.includes(wilayaId);
}

/** The shop's one « Montage » service product (made the first time a product gets montage). */
export async function montageProductId(db: Db, create = true): Promise<number | null> {
  const r = (await db.query(`SELECT id FROM products WHERE is_service AND sku = $1`, [MONTAGE_SKU]))[0];
  if (r) {
    await db.query(`UPDATE products SET active = true, archived_at = NULL WHERE id = $1 AND (NOT active OR archived_at IS NOT NULL)`, [r.id]).catch(() => undefined);
    return num(r.id);
  }
  if (!create) return null;
  const id = num(
    (await db.query(`INSERT INTO products (name, sku, price, cost, is_service, active, fixed_price, max_discount, weight_kg) VALUES ('Montage', $1, 0, 0, true, true, true, 0, 0) RETURNING id`, [MONTAGE_SKU]))[0].id,
  );
  await db.query(`INSERT INTO product_variants (product_id, title, sku, active) VALUES ($1, '', $2, true)`, [id, `${MONTAGE_SKU}-1`]);
  return id;
}

/**
 * The montage lines of an order: each must mount a product that is in the order, can be mounted, and in this wilaya.
 * `lines`: the priced lines (product, forProductId).
 */
export async function checkMontageLines(db: Db, lines: { productId: number; forProductId?: number | null; name: string; qty?: number }[], wilayaId: number, wilayaName = '') {
  const mount = lines.filter((l) => l.forProductId);
  if (!mount.length) return;
  const parents = await db.query(`SELECT id, name, montage FROM products WHERE id = ANY($1)`, [mount.map((l) => l.forProductId)]);
  const shop = await shopMontageWilayas(db);
  const inOrder = new Set(lines.filter((l) => !l.forProductId).map((l) => l.productId));
  for (const l of mount) {
    const p: any = parents.find((x: any) => num(x.id) === l.forProductId);
    if (!p) throw bad('Montage : produit introuvable');
    if (!inOrder.has(num(p.id))) throw bad(`Le montage de « ${p.name} » sans le produit : enlevez le montage ou remettez le produit`);
    const m = readMontage(p.montage);
    if (!m) throw bad(`« ${p.name} » n’a pas de montage`);
    if (mount.filter((x) => x.forProductId === l.forProductId).length > 1) throw bad(`Deux lignes de montage pour « ${p.name} »`);
    const pieces = lines.filter((x) => !x.forProductId && x.productId === l.forProductId).reduce((n, x) => n + (x.qty ?? 1), 0);
    if (l.qty !== undefined && l.qty > pieces) throw bad(`Plus de montages (${l.qty}) que de « ${p.name} » (${pieces})`);
    if (!montageAllowed(m, shop, wilayaId)) throw bad(`Pas de montage de « ${p.name} »${wilayaName ? ` à ${wilayaName}` : ' dans cette wilaya'}`);
  }
}

export const montageProcs = {
  /** Réglages › Montage: the shop's montage wilayas (empty: every wilaya). */
  'catalog.montage': proc(['depot', 'confirmation', 'suivi'], z.object({}), async (ctx) => {
    // the shared service and its line's variant (null until a product gets montage), for the « + Montage » lines
    const productId = await montageProductId(ctx.db, false);
    const variantId = productId ? (await ctx.db.query('SELECT id FROM product_variants WHERE product_id = $1 ORDER BY id LIMIT 1', [productId])).map((r: any) => num(r.id))[0] ?? null : null;
    return { wilayas: await shopMontageWilayas(ctx.db), productId, variantId };
  }),
  'catalog.saveMontage': proc(['depot'], z.object({ wilayas: z.array(z.number().int().min(1).max(69)).max(69) }), async (ctx, i) => {
    const wilayas = [...new Set(i.wilayas)].sort((a, b) => a - b);
    await setRaw(ctx.db, ROW, { wilayas }, ctx.session.profile.id || undefined);
    return { wilayas };
  }),
};
