import type { Db } from '../db';
import { getSetting, setSetting } from '../settings';

/** Extra demo data for the stats feature (runs after the main demo seed). users: demo account key → id. */
export async function seed(db: Db, users: Record<string, number>, now: number): Promise<void> {
  // Each agent manager starts with the Confirmation area (as in the original: "sans case cochée, il garde Confirmation").
  const scope = await getSetting(db, 'mgrScope');
  if (!Object.keys(scope).length && users.manager1 && users.manager2) {
    await setSetting(db, 'mgrScope', { [String(users.manager1)]: ['confirmation'], [String(users.manager2)]: ['confirmation', 'sav'] });
  }
  // Presence: one agent in a call on an order (shows "En appel · commande PX…"), the others seen recently.
  if (users.conf1) {
    await db.query(`UPDATE profiles SET presence = 'call', last_seen_at = $2 WHERE id = $1`, [users.conf1, new Date(now - 30_000).toISOString()]);
    await db.query(
      `UPDATE orders SET locked_by = $1, locked_until = $2
       WHERE id = (SELECT id FROM orders WHERE agent_id = $1 AND conf_status IN ('new','no_answer','busy','callback') ORDER BY created_at DESC LIMIT 1)`,
      [users.conf1, new Date(now + 10 * 60_000).toISOString()],
    );
  }
  for (const [k, ago] of [['conf2', 2], ['manager1', 1], ['manager2', 24]] as const) {
    if (!users[k]) continue;
    await db.query(`UPDATE profiles SET presence = $3, last_seen_at = $2 WHERE id = $1`, [users[k], new Date(now - ago * 60_000).toISOString(), ago > 10 ? 'offline' : 'online']);
    // a recent call, so the agent shows "En ligne · dernier appel il y a N min"
    await db.query(
      `INSERT INTO order_events (order_id, user_id, kind, at) SELECT id, $1, 'call', $2 FROM orders WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [users[k], new Date(now - ago * 60_000).toISOString()],
    );
  }
  if (users.conf3) await db.query(`UPDATE profiles SET presence = 'idle', last_seen_at = $2 WHERE id = $1`, [users.conf3, new Date(now - 90_000).toISOString()]);
}
