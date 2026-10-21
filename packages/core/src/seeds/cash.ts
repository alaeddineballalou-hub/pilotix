import type { Db } from '../db';
import { num } from '../db';

/** Versements for orders the demo marked cashed (one per company / livreur and day), so "Déjà reçu" has history. */
export async function seed(db: Db, users: Record<string, number>, now: number): Promise<void> {
  void now;
  const rows = await db.query(
    `SELECT o.id, o.total, o.delivery_cost, o.company_id, o.livreur_id, o.cashed_at, c.kind,
       (SELECT coalesce(max(p.weight_kg),0) FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = o.id) AS kg
     FROM orders o LEFT JOIN delivery_companies c ON c.id = o.company_id
     WHERE o.cashed AND o.handover_id IS NULL AND o.cashed_at IS NOT NULL ORDER BY o.cashed_at`,
  );
  const groups = new Map<string, any[]>();
  for (const r of rows) {
    const k = `${r.livreur_id ? 'l' + r.livreur_id : 'c' + (r.company_id ?? 0)}:${new Date(r.cashed_at).toISOString().slice(0, 10)}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const list of groups.values()) {
    const own = !!list[0].livreur_id;
    const collected = list.reduce((s, o) => s + num(o.total), 0);
    const fees = list.reduce((s, o) => s + (own ? (Number(o.kg) >= 5 ? 250 : 150) : num(o.delivery_cost)), 0);
    const at = new Date(list[list.length - 1].cashed_at).toISOString();
    const h = await db.query('INSERT INTO cash_handovers (company_id, livreur_id, orders, collected, fees, net, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', [
      list[0].company_id, list[0].livreur_id, list.map((o) => num(o.id)), collected, fees, collected - fees, users.admin, at,
    ]);
    await db.query('UPDATE orders SET handover_id = $1, cashed_at = $3 WHERE id = ANY($2)', [h[0].id, list.map((o) => num(o.id)), at]);
  }
  // Lamine's question to the office about a parcel
  const o = (await db.query(`SELECT id FROM orders WHERE livreur_id = $1 AND follow_status = 'out_for_delivery' ORDER BY id LIMIT 1`, [users.livreur]))[0];
  if (o) await db.query(`INSERT INTO chat_messages (livreur_id, user_id, order_id, body, created_at) VALUES ($1,$1,$2,'Le client ne répond pas, je repasse cet après-midi ?', $3)`, [users.livreur, o.id, new Date(Date.now() - 1_800_000).toISOString()]);
}
