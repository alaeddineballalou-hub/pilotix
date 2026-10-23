// The stock numbers several screens share: what confirmed orders already promised, and the products to reorder
// (the menu's count on « Produits & stock » is the length of the « Alertes » list).
import { Db, num } from '../db';

/** Quantity promised to confirmed orders not shipped yet, per variant and depot. */
export const RESERVED = `SELECT i.variant_id, COALESCE(o.warehouse_id, (SELECT id FROM warehouses WHERE active ORDER BY is_default DESC, id LIMIT 1)) AS wid, sum(i.qty)::int AS n
  FROM order_items i JOIN orders o ON o.id = i.order_id
  WHERE i.variant_id IS NOT NULL AND o.conf_status IN ('confirmed','no_stock') AND (o.follow_status IS NULL OR o.follow_status IN ('to_prepare','prepared'))
  GROUP BY 1, 2`;

/** Products to reorder: on sale (product and variant active), and what is left in a depot (stock − reserved) is at or
 *  under its alert level — 0 when no level is set, so a product out of stock is always in the list. */
export async function lowStockCount(db: Db): Promise<number> {
  const r = await db.query(
    `WITH r AS (${RESERVED})
     SELECT count(*)::int AS n
     FROM product_variants v JOIN products p ON p.id = v.product_id CROSS JOIN warehouses wh
     LEFT JOIN stock s ON s.variant_id = v.id AND s.warehouse_id = wh.id
     LEFT JOIN r ON r.variant_id = v.id AND r.wid = wh.id
     WHERE NOT p.is_service AND wh.active AND p.active AND v.active
       AND (s.variant_id IS NOT NULL OR wh.id = (SELECT id FROM warehouses WHERE active ORDER BY is_default DESC, id LIMIT 1) OR COALESCE(r.n, 0) <> 0)
       AND COALESCE(s.qty, 0) - COALESCE(r.n, 0) <= COALESCE(s.alert_qty, 0)`,
  );
  return num(r[0]?.n);
}
