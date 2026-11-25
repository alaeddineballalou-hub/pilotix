import type { Db } from '../db';
import { num } from '../db';
import { ensureFaults } from '../modules/faults';

/**
 * Who is responsible (modules/faults.ts): the demo's returns get their line as Commandes › Annulé would on its first
 * look, plus what agents said themselves — the depot's errors (a wrong colour, a part missing after delivery) and two
 * « Pas moi » waiting for the seller.
 */
export async function seed(db: Db, users: Record<string, number>, now: number): Promise<void> {
  const back = (await db.query(`SELECT id FROM orders WHERE follow_status IN ('returning','returned') AND NOT is_exchange ORDER BY id`)).map((r: any) => num(r.id));
  await ensureFaults(db, back);
  const depot = users.depot ?? null;
  // the depot sent another colour than the order's: the depot checked the parcel when it came back (the latest returns
  // whose product did not match, so this month shows them)
  const swaps = await db.query(
    `SELECT f.id, f.order_id FROM order_faults f WHERE f.team IN ('unknown', 'client') ORDER BY (f.reason = 'not_matching') DESC, f.at DESC, f.id LIMIT 6`,
  );
  for (const [k, r] of swaps.entries()) {
    if (k > 3) break;
    await db.query(`UPDATE order_faults SET reason = 'wrong_variant', team = 'depot', person_id = $2, person_label = NULL, answers = $3, reported_by = $4 WHERE id = $1`, [
      r.id,
      k % 2 ? users.depot2 ?? depot : depot,
      JSON.stringify({ variant: k % 2 ? 'Gris' : 'Bleu' }),
      users.suivi ?? null,
    ]);
  }
  // after delivery (SAV): a part missing from a box the depot opened, a product of bad quality
  const delivered = await db.query(`SELECT o.id, (SELECT i.name FROM order_items i WHERE i.order_id = o.id ORDER BY i.id LIMIT 1) AS product FROM orders o
    WHERE o.follow_status = 'delivered' AND NOT o.is_exchange AND NOT EXISTS (SELECT 1 FROM order_faults f WHERE f.order_id = o.id) ORDER BY o.id DESC LIMIT 2`);
  const at = (days: number) => new Date(now - days * 86_400_000).toISOString();
  if (delivered[0])
    await db.query(`INSERT INTO order_faults (order_id, moment, reason, team, person_id, answers, reported_by, at) VALUES ($1,'sav','missing_part','depot',$2,$3,$4,$5) ON CONFLICT (order_id) DO NOTHING`, [
      delivered[0].id,
      depot,
      JSON.stringify({ sealed: false }),
      users.vendeur ?? null,
      at(3),
    ]);
  if (delivered[1])
    await db.query(`INSERT INTO order_faults (order_id, moment, reason, team, person_label, reported_by, at) VALUES ($1,'sav','bad_quality','produit',$2,$3,$4) ON CONFLICT (order_id) DO NOTHING`, [
      delivered[1].id,
      delivered[1].product,
      users.vendeur ?? null,
      at(5),
    ]);
  // « Pas moi »: the depot says it took the right colour; an agent says the customer gave that address himself
  const d = (await db.query(`SELECT id, person_id FROM order_faults WHERE team = 'depot' AND moment <> 'sav' AND person_id IS NOT NULL ORDER BY at DESC, id LIMIT 1`))[0];
  if (d) await db.query(`UPDATE order_faults SET contest_by = $2, contest_note = $3, contest_at = $4 WHERE id = $1`, [d.id, d.person_id, 'J’ai pris la bonne couleur, voir le scan du colis.', at(1)]);
  const c = (await db.query(`SELECT id, person_id FROM order_faults WHERE team = 'confirmation' AND person_id IS NOT NULL ORDER BY at DESC, id LIMIT 1`))[0];
  if (c) await db.query(`UPDATE order_faults SET contest_by = $2, contest_note = $3, contest_at = $4 WHERE id = $1`, [c.id, c.person_id, 'Le client m’a donné ces informations lui-même.', at(2)]);
}
