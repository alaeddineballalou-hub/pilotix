// Dépôt, picking first (phones): the products to take for the confirmed orders still to prepare, how many were
// actually taken, and the orders that have all their products — ready to pack, then to send to dispatch.
//
// Rules
// - What is taken goes to the oldest orders first (confirmed first, then created), one whole order line at a time:
//   a line that needs 2 gets 2 or waits. Units taken that no line could use wait in a pool and are used first next time.
// - An order is ready once every one of its products (services aside) has been taken.
// - "Mettre en rupture": what is still missing for that product goes on the list "À ramener au dépôt".
//   The line leaves the list when the product is fully taken, or by hand ("Reçu").
import { variantLook, VariantLook } from '@pilotix/shared';
import { z } from 'zod';
import { Db, num, numOrNull } from '../db';
import { bad, Ctx, proc } from '../rpc';
import { autoDispatch } from './dispatch';
import { getOrder } from './orders';

const id = z.number().int().positive();
const DEPOT = ['depot'] as const;
const key = (productId: number, variantId: number | null) => `${productId}:${variantId ?? 0}`;

export interface PickRow {
  productId: number;
  variantId: number | null;
  name: string;
  variant: string;
  /** units still to take for the orders waiting */
  need: number;
  /** orders waiting for this product */
  orders: number;
  stock: number;
  /** units already taken that wait for a whole order line */
  pool: number;
  /** on the list "À ramener au dépôt" */
  restock: number;
  /** the variant's colour and size, shown big on the card (the picker takes by colour) */
  look: VariantLook;
  /** the product's photo (a link or a small data: picture), null: none */
  photo: string | null;
}

/** The products to take, most needed first: what the waiting orders still need. */
export async function pickList(db: Db): Promise<PickRow[]> {
  const rows = await db.query(
    `SELECT i.product_id, i.variant_id, p.name, COALESCE(v.title, i.variant_title, '') AS title, p.photo, p.options,
            sum(i.qty - i.picked_qty)::int AS need, count(DISTINCT o.id)::int AS orders,
            (SELECT COALESCE(sum(s.qty), 0)::int FROM stock s WHERE s.variant_id = i.variant_id) AS stock
     FROM order_items i JOIN orders o ON o.id = i.order_id JOIN products p ON p.id = i.product_id
     LEFT JOIN product_variants v ON v.id = i.variant_id
     WHERE o.conf_status = 'confirmed' AND o.follow_status = 'to_prepare' AND NOT p.is_service AND i.picked_qty < i.qty
     GROUP BY i.product_id, i.variant_id, p.name, COALESCE(v.title, i.variant_title, ''), p.photo, p.options
     ORDER BY lower(p.name), lower(COALESCE(v.title, i.variant_title, ''))`,
  );
  const pool = new Map((await db.query('SELECT product_id, variant_id, qty FROM depot_pick_pool WHERE qty > 0')).map((r: any) => [key(num(r.product_id), numOrNull(r.variant_id)), num(r.qty)]));
  const rest = new Map((await db.query('SELECT product_id, variant_id, qty FROM depot_restock')).map((r: any) => [key(num(r.product_id), numOrNull(r.variant_id)), num(r.qty)]));
  return rows.map((r: any) => {
    const k = key(num(r.product_id), numOrNull(r.variant_id));
    return {
      productId: num(r.product_id),
      variantId: numOrNull(r.variant_id),
      name: r.name as string,
      variant: (r.title as string) || '',
      need: num(r.need),
      orders: num(r.orders),
      stock: num(r.stock),
      pool: pool.get(k) ?? 0,
      restock: rest.get(k) ?? 0,
      look: variantLook((r.title as string) || '', (typeof r.options === 'string' ? JSON.parse(r.options) : r.options) ?? []),
      photo: (r.photo as string | null) || null,
    };
  });
}

/** The orders still to prepare that have all their products: ready to pack. */
async function readyIds(db: Db): Promise<number[]> {
  const rows = await db.query(
    `SELECT o.id FROM orders o
     WHERE o.conf_status = 'confirmed' AND o.follow_status = 'to_prepare'
       AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id)
       AND NOT EXISTS (SELECT 1 FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = o.id AND NOT p.is_service AND i.picked_qty < i.qty)
     ORDER BY o.confirmed_at NULLS LAST, o.created_at, o.id`,
  );
  return rows.map((r: any) => num(r.id));
}

/** "J'ai pris n" for one product: serves whole lines, oldest orders first; returns what happened. */
export async function pick(ctx: Ctx, i: { productId: number; variantId: number | null; qty: number; rupture: boolean }) {
  return ctx.db.tx(async (tx) => {
    const vid = i.variantId ?? null;
    const poolRow = (await tx.query('SELECT qty FROM depot_pick_pool WHERE product_id = $1 AND variant_id IS NOT DISTINCT FROM $2', [i.productId, vid]))[0];
    let left = i.qty + (poolRow ? num(poolRow.qty) : 0);
    const lines = await tx.query(
      `SELECT i.id, i.order_id, i.qty, i.picked_qty FROM order_items i JOIN orders o ON o.id = i.order_id
       WHERE o.conf_status = 'confirmed' AND o.follow_status = 'to_prepare' AND i.product_id = $1 AND i.variant_id IS NOT DISTINCT FROM $2 AND i.picked_qty < i.qty
       ORDER BY o.confirmed_at NULLS LAST, o.created_at, o.id, i.id FOR UPDATE OF i`,
      [i.productId, vid],
    );
    const needAll = lines.reduce((s: number, l: any) => s + num(l.qty) - num(l.picked_qty), 0);
    if (!lines.length) throw bad('Plus rien à prendre pour ce produit.');
    const before = new Set(await readyIds(tx));
    let served = 0;
    for (const l of lines) {
      const need = num(l.qty) - num(l.picked_qty);
      if (need > left) continue;
      await tx.query('UPDATE order_items SET picked_qty = qty WHERE id = $1', [l.id]);
      left -= need;
      served += need;
    }
    // units taken that no whole line could use wait for the next pick
    await tx.query('DELETE FROM depot_pick_pool WHERE product_id = $1 AND variant_id IS NOT DISTINCT FROM $2', [i.productId, vid]);
    if (left > 0) await tx.query('INSERT INTO depot_pick_pool (product_id, variant_id, qty) VALUES ($1, $2, $3)', [i.productId, vid, left]);
    // what is still missing: on the list "À ramener au dépôt", or off it when everything was taken
    const missing = Math.max(0, needAll - served - left);
    const had = (await tx.query('SELECT qty FROM depot_restock WHERE product_id = $1 AND variant_id IS NOT DISTINCT FROM $2', [i.productId, vid]))[0];
    if (missing === 0 || i.rupture || had) await tx.query('DELETE FROM depot_restock WHERE product_id = $1 AND variant_id IS NOT DISTINCT FROM $2', [i.productId, vid]);
    // rupture: the whole shortfall; already on the list: kept, never more than what is still missing
    const keep = missing === 0 ? 0 : i.rupture ? missing : had ? Math.min(num(had.qty), missing) : 0;
    if (keep > 0) await tx.query('INSERT INTO depot_restock (product_id, variant_id, qty, updated_by) VALUES ($1, $2, $3, $4)', [i.productId, vid, keep, ctx.session.profile.id]);
    const after = await readyIds(tx);
    const fresh = after.filter((x) => !before.has(x));
    ctx.emit({ type: 'orders' });
    return { served, waiting: left, missing, readyNow: fresh.length, ready: after.length, freshIds: fresh };
  });
}

export const pickingProcs = {
  /** The products to take (phones, "À préparer"). */
  'depot.pickList': proc([...DEPOT], z.object({}), (ctx) => pickList(ctx.db)),

  /** "J'ai pris n" for one product; rupture: what is still missing goes on "À ramener au dépôt". */
  'depot.pick': proc(
    [...DEPOT],
    z.object({ productId: id, variantId: id.nullable(), qty: z.number().int().min(0).max(100_000), rupture: z.boolean().default(false) }),
    async (ctx, i) => {
      const { freshIds, ...r } = await pick(ctx, i);
      // picked whole: an order with a company goes to « En dispatch » by itself; the others wait in « À attribuer »
      const d = freshIds.length ? await autoDispatch(ctx, freshIds) : { dispatched: 0, toAssign: 0, failed: [] };
      return { ...r, dispatched: d.dispatched, toAssign: d.toAssign, refused: d.failed.length };
    },
  ),

  /** The orders that have all their products (phones, "En préparation"). */
  'depot.ready': proc([...DEPOT], z.object({}), async (ctx) => Promise.all((await readyIds(ctx.db)).slice(0, 200).map((oid) => getOrder(ctx, oid)))),

  /** "À ramener au dépôt": the products missing at the depot. */
  'depot.restock': proc([...DEPOT], z.object({}), async (ctx) =>
    (
      await ctx.db.query(
        `SELECT r.product_id, r.variant_id, r.qty, r.updated_at, p.name, COALESCE(v.title, '') AS title
         FROM depot_restock r JOIN products p ON p.id = r.product_id LEFT JOIN product_variants v ON v.id = r.variant_id
         ORDER BY lower(p.name), lower(COALESCE(v.title, ''))`,
      )
    ).map((r: any) => ({ productId: num(r.product_id), variantId: numOrNull(r.variant_id), name: r.name as string, variant: (r.title as string) || '', qty: num(r.qty) })),
  ),

  /** "Reçu": the product came back, it leaves the list. */
  'depot.restockDone': proc([...DEPOT], z.object({ productId: id, variantId: id.nullable() }), async (ctx, i) => {
    await ctx.db.query('DELETE FROM depot_restock WHERE product_id = $1 AND variant_id IS NOT DISTINCT FROM $2', [i.productId, i.variantId ?? null]);
    ctx.emit({ type: 'orders' });
    return { ok: true };
  }),
};
