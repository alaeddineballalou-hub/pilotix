// « Confirmée sans stock »: orders confirmed while one of their products had nothing left. They wait outside the depot.
// When stock comes back (a purchase, a count, a transfer, a returned parcel, a cancelled order freeing its pieces), the
// oldest ones that can now be served whole go to « À préparer » by themselves — oldest first, each one whole, so a
// newer order never jumps an older one that the stock can serve. The « Sans stock » list shows how long each waits;
// past the shop's number of days (Préférences, 3 at the start) it is late.
import { z } from 'zod';
import { Db, iso, num } from '../db';
import { proc } from '../rpc';
import { getPrefs } from './prefs';

const WAITING = `o.conf_status = 'no_stock' AND o.follow_status IS NULL`;

/** What is left of each variant for the waiting orders: stock (active depots) − what confirmed orders already hold. */
async function leftFor(db: Db, variantIds: number[]): Promise<Map<number, number>> {
  const left = new Map<number, number>();
  if (!variantIds.length) return left;
  for (const s of await db.query(
    `SELECT s.variant_id, sum(s.qty)::int AS n FROM stock s JOIN warehouses w ON w.id = s.warehouse_id AND w.active WHERE s.variant_id = ANY($1) GROUP BY 1`,
    [variantIds],
  ))
    left.set(num(s.variant_id), num(s.n));
  for (const r of await db.query(
    `SELECT i.variant_id, sum(i.qty)::int AS n FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE i.variant_id = ANY($1) AND o.conf_status = 'confirmed' AND (o.follow_status IS NULL OR o.follow_status IN ('to_prepare','prepared'))
      GROUP BY 1`,
    [variantIds],
  ))
    left.set(num(r.variant_id), (left.get(num(r.variant_id)) ?? 0) - num(r.n));
  return left;
}

/**
 * Sends to the depot the oldest « sans stock » orders whose products are all there now. `variantIds`: only when one of
 * them is waited for (a stock movement of these variants). Returns the orders sent.
 */
export async function releaseNoStock(db: Db, userId: number | null, variantIds?: number[]): Promise<number[]> {
  if (variantIds) {
    if (!variantIds.length) return [];
    const any = await db.query(`SELECT 1 FROM order_items i JOIN orders o ON o.id = i.order_id WHERE i.variant_id = ANY($1) AND ${WAITING} LIMIT 1`, [variantIds]);
    if (!any.length) return [];
  }
  const waiting = await db.query(`SELECT o.id FROM orders o WHERE ${WAITING} ORDER BY o.confirmed_at NULLS LAST, o.created_at, o.id`);
  if (!waiting.length) return [];
  const ids = waiting.map((w: any) => num(w.id));
  const items = await db.query(
    `SELECT i.order_id, i.variant_id, i.qty, p.active AND COALESCE(v.active, true) AS on_sale
       FROM order_items i JOIN products p ON p.id = i.product_id LEFT JOIN product_variants v ON v.id = i.variant_id
      WHERE i.order_id = ANY($1) AND NOT p.is_service`,
    [ids],
  );
  const left = await leftFor(db, [...new Set(items.filter((i: any) => i.variant_id).map((i: any) => num(i.variant_id)))]);
  const sent: number[] = [];
  for (const oid of ids) {
    const its = items.filter((i: any) => num(i.order_id) === oid);
    // a line without its variant or a product switched off: a person decides (it stays in the list)
    if (!its.length || its.some((i: any) => !i.variant_id || !i.on_sale)) continue;
    const need = new Map<number, number>();
    for (const i of its) need.set(num(i.variant_id), (need.get(num(i.variant_id)) ?? 0) + num(i.qty));
    if (![...need].every(([v, q]) => (left.get(v) ?? 0) >= q)) continue;
    for (const [v, q] of need) left.set(v, (left.get(v) ?? 0) - q);
    const moved = await db.query(
      `UPDATE orders SET conf_status = 'confirmed', follow_status = 'to_prepare', updated_at = now(), version = version + 1
        WHERE id = $1 AND conf_status = 'no_stock' AND follow_status IS NULL RETURNING id`,
      [oid],
    );
    if (!moved.length) continue;
    await db.query('INSERT INTO order_events (order_id, user_id, kind, from_value, to_value, note) VALUES ($1,$2,$3,$4,$5,$6)', [
      oid,
      userId,
      'conf_status',
      'no_stock',
      'confirmed',
      'Stock revenu : envoyée au dépôt (les plus anciennes d’abord)',
    ]);
    await db.query('INSERT INTO order_events (order_id, user_id, kind, from_value, to_value) VALUES ($1,$2,$3,$4,$5)', [oid, userId, 'follow_status', null, 'to_prepare']);
    sent.push(oid);
  }
  return sent;
}

/** The « Sans stock » list: oldest first, how long each waits, which product is missing. */
export async function noStockList(db: Db, now: number) {
  const days = (await getPrefs(db)).noStockDays;
  const rows = await db.query(
    `SELECT o.id, o.ref, o.customer_name, o.wilaya_id, o.total, COALESCE(o.confirmed_at, o.created_at) AS since
       FROM orders o WHERE ${WAITING} ORDER BY o.confirmed_at NULLS LAST, o.created_at, o.id LIMIT 300`,
  );
  const ids = rows.map((r: any) => num(r.id));
  const items = ids.length
    ? await db.query(
        `SELECT i.order_id, i.variant_id, i.qty, p.name, COALESCE(v.title, i.variant_title, '') AS title, p.active AND COALESCE(v.active, true) AS on_sale
           FROM order_items i JOIN products p ON p.id = i.product_id LEFT JOIN product_variants v ON v.id = i.variant_id
          WHERE i.order_id = ANY($1) AND NOT p.is_service ORDER BY i.id`,
        [ids],
      )
    : [];
  const left = await leftFor(db, [...new Set(items.filter((i: any) => i.variant_id).map((i: any) => num(i.variant_id)))]);
  const list = rows.map((r: any) => {
    const since = new Date(r.since).getTime();
    const waited = Math.max(0, Math.floor((now - since) / 86_400_000));
    return {
      id: num(r.id),
      ref: r.ref as string,
      customerName: r.customer_name as string,
      wilayaId: num(r.wilaya_id),
      total: num(r.total),
      since: iso(r.since),
      days: waited,
      late: waited >= days,
      items: items
        .filter((i: any) => num(i.order_id) === num(r.id))
        .map((i: any) => {
          const l = i.variant_id ? (left.get(num(i.variant_id)) ?? 0) : 0;
          return { name: i.name as string, variant: (i.title as string) || '', qty: num(i.qty), left: Math.max(0, l), missing: !i.on_sale || l < num(i.qty), off: !i.on_sale };
        }),
    };
  });
  return { days, list, late: list.filter((x) => x.late).length };
}

export const noStockProcs = {
  /** The « Sans stock » list (the depot and the confirmation team). Sends first the orders the stock can now serve. */
  'depot.noStock': proc(['depot', 'confirmation'], z.object({}), async (ctx) => {
    await releaseNoStock(ctx.db, null);
    return noStockList(ctx.db, ctx.now());
  }),
};
