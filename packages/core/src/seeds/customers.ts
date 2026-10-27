import type { Db } from '../db';

/**
 * Extra demo data for the customers feature (runs after the main demo seed). users: demo account key → id.
 * The trust of each demo customer: the parcels they refused since their last delivered one (the « 2 REFUS » chips).
 * Pilotix decides stop-desk / blacklist itself on their next parcel.
 */
export async function seed(db: Db, users: Record<string, number>, now: number): Promise<void> {
  void users;
  void now;
  await db.query(
    `UPDATE customers c SET refusals = x.n FROM (
       SELECT o.customer_id, count(*)::int AS n FROM orders o
       WHERE NOT o.is_exchange AND o.delivered_at IS NULL AND (o.follow_status IN ('returning','returned') OR o.returned_at IS NOT NULL)
         AND coalesce(o.returning_at, o.returned_at, o.updated_at) > coalesce((SELECT max(d.delivered_at) FROM orders d WHERE d.customer_id = o.customer_id), '-infinity'::timestamptz)
       GROUP BY o.customer_id) x
     WHERE x.customer_id = c.id`,
  );
}
