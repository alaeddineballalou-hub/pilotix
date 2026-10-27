import type { Db } from '../db';
import { num } from '../db';

const iso = (t: number) => new Date(t).toISOString();

/** Every demo account has its own work: no order without a confirmation agent, no parcel on the road without a suivi agent,
 *  each livreur has parcels out today and a chat with the office, SAV tickets shared between the managers. Runs last. */
export async function seed(db: Db, users: Record<string, number>, now: number): Promise<void> {
  // confirmation: the orders nobody had taken go round the agents and the managers
  const agents = [users.conf1, users.conf2, users.conf3, users.manager1, users.manager2];
  const free = await db.query(`SELECT id, created_at FROM orders WHERE agent_id IS NULL ORDER BY id`);
  for (const [k, o] of free.entries()) {
    const at = iso(Math.min(Date.parse(String(o.created_at)) + 600_000, now - 60_000));
    await db.query('UPDATE orders SET agent_id = $2, assigned_at = COALESCE(assigned_at, $3) WHERE id = $1', [o.id, agents[k % agents.length], at]);
  }
  // suivi: every shipped parcel is followed by someone
  await db.query(`UPDATE orders SET follow_agent_id = $1 WHERE shipped_at IS NOT NULL AND follow_agent_id IS NULL`, [users.suivi]);

  // livreurs: Walid gets his own round too (parcels out today, one to pick up already there) and a chat with the office
  const own = num((await db.query(`SELECT id FROM delivery_companies WHERE kind = 'own' LIMIT 1`))[0]?.id);
  if (own && users.livreur2) {
    const out = await db.query(`SELECT count(*)::int AS n FROM orders WHERE follow_status = 'out_for_delivery' AND livreur_id = $1`, [users.livreur2]);
    const need = 4 - num(out[0]?.n);
    if (need > 0) {
      const more = await db.query(
        `SELECT id FROM orders WHERE follow_status = 'out_for_delivery' AND livreur_id IS NULL AND wilaya_id IN (16, 9, 35, 42) ORDER BY id DESC LIMIT $1`,
        [need],
      );
      if (more.length) await db.query('UPDATE orders SET company_id = $1, livreur_id = $2, tracking = NULL, ext_status = NULL WHERE id = ANY($3)', [own, users.livreur2, more.map((r: any) => num(r.id))]);
    }
    const first = (await db.query(`SELECT id FROM orders WHERE livreur_id = $1 AND follow_status = 'out_for_delivery' ORDER BY id LIMIT 1`, [users.livreur2]))[0];
    await db.query(
      `INSERT INTO chat_messages (livreur_id, user_id, order_id, body, created_at) VALUES
        ($1,$2,NULL,'Bonjour Walid, ta tournée de Kouba est prête au dépôt.',$4),
        ($1,$1,NULL,'Merci, je passe la récupérer.',$5),
        ($1,$1,$3,'Le client demande à être livré demain matin.',$6)`,
      [users.livreur2, users.suivi, first ? first.id : null, iso(now - 4 * 3_600_000), iso(now - 3.8 * 3_600_000), iso(now - 2_400_000)],
    );
  }

  // SAV: the tickets are shared between the two managers
  const tickets = await db.query(`SELECT id FROM complaints ORDER BY id`);
  for (const [k, t] of tickets.entries()) await db.query('UPDATE complaints SET assigned_to = $2 WHERE id = $1', [t.id, k % 2 ? users.manager2 : users.manager1]);
}
