// SAV tickets follow their exchange parcel by themselves:
//  - parcel delivered (or exchanged)          → ticket "Livré"
//  - parcel came back and was scanned at the depot ("Retournée") → ticket "Annulé"
// Called after every delivery status change and before SAV pages read tickets.
import { Db } from '../db';

const ACTIVE = `c.status IN ('open','progress')`;

export async function settleTickets(db: Db, userId: number | null) {
  const rows = await db.query(
    `SELECT c.id, c.notes, ex.ref, ex.follow_status FROM complaints c JOIN orders ex ON ex.id = c.exchange_order_id
     WHERE ${ACTIVE} AND ex.follow_status IN ('delivered','exchanged','returned')`,
  );
  for (const r of rows) {
    const done = r.follow_status === 'returned' ? 'closed' : 'resolved';
    const notes = typeof r.notes === 'string' ? JSON.parse(r.notes) : r.notes ?? [];
    notes.push({
      at: new Date().toISOString(),
      userId,
      text: done === 'resolved' ? `Échange ${r.ref} livré au client` : `Colis ${r.ref} retourné et scanné au dépôt : ticket annulé`,
      status: done,
    });
    await db.query(`UPDATE complaints SET status=$2, resolved_at=now(), updated_at=now(), notes=$3 WHERE id=$1`, [r.id, done, JSON.stringify(notes)]);
  }
  return rows.length;
}
