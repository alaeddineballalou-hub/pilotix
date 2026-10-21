import type { Db } from '../db';
import { num } from '../db';

/** Extra demo data for the catalog feature (runs after the main demo seed). users: demo account key → id. */
export async function seed(db: Db, users: Record<string, number>, now: number): Promise<void> {
  const day = 86_400_000;
  const at = (d: number) => new Date(now - d * day).toISOString();
  const depot = users.depot ?? null;
  const wh = await db.query('SELECT id FROM warehouses ORDER BY is_default DESC, id');
  const main = num(wh[0]?.id);
  const second = wh[1] ? num(wh[1].id) : null;
  const vars = await db.query('SELECT v.id, p.name FROM product_variants v JOIN products p ON p.id = v.product_id WHERE NOT p.is_service ORDER BY v.id');
  // A few realistic movements: arrivals, an inventory count, a breakage, a transfer to the second depot.
  for (const [k, v] of vars.entries()) {
    const vid = num(v.id);
    if (k % 3 === 0) {
      await db.query(`INSERT INTO stock_movements (variant_id, warehouse_id, delta, reason, user_id, note, created_at) VALUES ($1,$2,$3,'entry',$4,'Arrivage fournisseur',$5)`, [vid, main, 10 + (k % 4) * 5, depot, at(20 - k / 2)]);
      await db.query('UPDATE stock SET qty = qty + $3 WHERE variant_id = $1 AND warehouse_id = $2', [vid, main, 10 + (k % 4) * 5]);
    }
    if (k % 5 === 1) {
      await db.query(`INSERT INTO stock_movements (variant_id, warehouse_id, delta, reason, user_id, note, created_at) VALUES ($1,$2,-1,'loss',$3,'Carton abîmé',$4)`, [vid, main, depot, at(9 - k / 4)]);
      await db.query('UPDATE stock SET qty = qty - 1 WHERE variant_id = $1 AND warehouse_id = $2', [vid, main]);
    }
    if (second && k % 4 === 2) {
      const q = 3 + (k % 3);
      await db.query(`INSERT INTO stock_movements (variant_id, warehouse_id, delta, reason, user_id, note, created_at) VALUES ($1,$2,$3,'transfer_out',$4,'Vers Oran',$5), ($1,$6,$7,'transfer_in',$4,'Vers Oran',$5)`, [vid, main, -q, depot, at(6), second, q]);
      await db.query('UPDATE stock SET qty = qty - $3 WHERE variant_id = $1 AND warehouse_id = $2', [vid, main, q]);
      await db.query(`INSERT INTO stock (variant_id, warehouse_id, qty, alert_qty) VALUES ($1,$2,$3,2) ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET qty = stock.qty + EXCLUDED.qty`, [vid, second, q]);
    }
  }
}
