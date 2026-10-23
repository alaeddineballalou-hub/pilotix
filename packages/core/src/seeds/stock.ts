import type { Db } from '../db';
import { num } from '../db';

/** Demo suppliers, purchases over the last month (paid, half paid, not paid yet) and one inventory. Runs after the catalog seed. */
export async function seed(db: Db, users: Record<string, number>, now: number): Promise<void> {
  const day = 86_400_000;
  const at = (d: number) => new Date(now - d * day).toISOString();
  const depot = users.depot ?? null;
  const wh = await db.query('SELECT id FROM warehouses WHERE active ORDER BY is_default DESC, id');
  if (!wh.length) return;
  const main = num(wh[0].id);
  const vars = await db.query(
    `SELECT v.id, p.id AS pid, p.cost FROM product_variants v JOIN products p ON p.id = v.product_id WHERE NOT p.is_service AND p.active AND v.active ORDER BY v.id`,
  );
  if (!vars.length) return;

  const suppliers: [string, string, string, string][] = [
    ['Bébé Import Alger', '0550 12 34 56', 'Zone industrielle, Rouiba', 'Livre le mardi. Paiement à 30 jours.'],
    ['Atlas Kids Distribution', '0661 98 76 54', 'Es Senia, Oran', 'Poussettes et sièges auto.'],
    ['Grossiste El Eulma', '0770 45 67 89', 'Marché Dubaï, El Eulma', 'Paiement comptant.'],
  ];
  const sids: number[] = [];
  for (const [name, phone, address, note] of suppliers) {
    sids.push(num((await db.query('INSERT INTO suppliers (name, phone, address, note, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id', [name, phone, address, note, at(75)]))[0].id));
  }

  const add = async (vid: number, delta: number) =>
    db.query(`INSERT INTO stock (variant_id, warehouse_id, qty) VALUES ($1,$2,$3) ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET qty = stock.qty + EXCLUDED.qty`, [vid, main, delta]);

  // five purchases: three paid, one half paid, the last one not paid yet
  const plans = [
    { d: 28, s: 0, share: 1, pick: [0, 1, 2, 3] },
    { d: 21, s: 1, share: 1, pick: [4, 5, 6] },
    { d: 14, s: 2, share: 1, pick: [7, 8] },
    { d: 7, s: 0, share: 0.5, pick: [1, 3, 9, 10] },
    { d: 2, s: 1, share: 0, pick: [2, 5, 11] },
  ];
  for (const pl of plans) {
    const lines = pl.pick
      .filter((x) => x < vars.length)
      .map((x, j) => ({ vid: num(vars[x].id), qty: 6 + ((x + j) % 4) * 4, cost: Math.max(200, num(vars[x].cost) - (x % 3) * 50) }));
    if (!lines.length) continue;
    const total = lines.reduce((s, l) => s + l.qty * l.cost, 0);
    const paid = Math.min(total, Math.round((total * pl.share) / 100) * 100);
    const pid = num((await db.query(`SELECT nextval(pg_get_serial_sequence('purchases', 'id')) AS id`))[0].id);
    const ref = `ACH-${String(pid).padStart(4, '0')}`;
    await db.query('INSERT INTO purchases (id, ref, supplier_id, warehouse_id, total, paid, paid_at, note, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [
      pid, ref, sids[pl.s], main, total, paid, paid > 0 ? at(pl.d) : null, pl.share < 1 ? 'Reste à payer à la prochaine livraison' : '', depot, at(pl.d),
    ]);
    for (const l of lines) {
      await db.query('INSERT INTO purchase_lines (purchase_id, variant_id, qty, unit_cost) VALUES ($1,$2,$3,$4)', [pid, l.vid, l.qty, l.cost]);
      await db.query(`INSERT INTO stock_movements (variant_id, warehouse_id, delta, reason, user_id, note, purchase_id, created_at) VALUES ($1,$2,$3,'purchase',$4,$5,$6,$7)`, [
        l.vid, main, l.qty, depot, `Achat ${ref} — ${suppliers[pl.s][0]}`, pid, at(pl.d),
      ]);
      await add(l.vid, l.qty);
    }
  }

  // one inventory ten days ago in the main depot: most counts right, a few pieces missing, one found
  const counted = await db.query('SELECT s.variant_id, s.qty, p.cost FROM stock s JOIN product_variants v ON v.id = s.variant_id JOIN products p ON p.id = v.product_id WHERE s.warehouse_id = $1 AND s.qty > 3 ORDER BY s.variant_id LIMIT 12', [main]);
  if (counted.length) {
    const iid = num((await db.query(`SELECT nextval(pg_get_serial_sequence('inventories', 'id')) AS id`))[0].id);
    const ref = `INV-${String(iid).padStart(4, '0')}`;
    const diffs = [-1, 0, 0, -2, 0, 0, 0, 1, 0, 0, 0, 0];
    let changed = 0;
    let found = 0;
    let missing = 0;
    let value = 0;
    await db.query('INSERT INTO inventories (id, ref, warehouse_id, counted, note, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [iid, ref, main, counted.length, 'Inventaire de fin de mois', depot, at(10)]);
    for (const [k, r] of counted.entries()) {
      const delta = diffs[k] ?? 0;
      if (!delta) continue;
      changed++;
      if (delta > 0) found += delta;
      else missing -= delta;
      value += delta * num(r.cost);
      await db.query(`INSERT INTO stock_movements (variant_id, warehouse_id, delta, reason, user_id, note, inventory_id, created_at) VALUES ($1,$2,$3,'count',$4,$5,$6,$7)`, [
        num(r.variant_id), main, delta, depot, `Inventaire ${ref} — Inventaire de fin de mois`, iid, at(10),
      ]);
      await add(num(r.variant_id), delta);
    }
    await db.query('UPDATE inventories SET changed = $2, found = $3, missing = $4, value = $5 WHERE id = $1', [iid, changed, found, missing, value]);
  }

  // alert levels in the main depot: about one month of sales (at least 5), so the best sellers running low show in « Alertes »
  const sold = await db.query(
    `SELECT i.variant_id, sum(i.qty)::int AS n FROM order_items i JOIN orders o ON o.id = i.order_id
     WHERE i.variant_id IS NOT NULL AND o.shipped_at >= $1 GROUP BY 1`,
    [at(30)],
  );
  for (const r of sold) {
    const level = Math.max(5, Math.ceil(num(r.n) / 5) * 5);
    await db.query('UPDATE stock SET alert_qty = $3 WHERE variant_id = $1 AND warehouse_id = $2', [num(r.variant_id), main, level]);
  }
}
