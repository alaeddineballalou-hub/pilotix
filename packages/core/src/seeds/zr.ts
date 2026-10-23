// Demo: ZR Express services used from Pilotix — pickup bags of the last days (processed by ZR), today's bag being
// processed, and today's last parcels still waiting for a bag.
import { fakeTracking } from '../couriers/demo';
import type { Db } from '../db';
import { num } from '../db';

export async function seed(db: Db, users: Record<string, number>, now: number): Promise<void> {
  const zr = num((await db.query(`SELECT id FROM delivery_companies WHERE kind = 'zr' ORDER BY id LIMIT 1`))[0]?.id);
  if (!zr) return;
  const shipped = await db.query(
    `SELECT id, shipped_at FROM orders WHERE company_id = $1 AND follow_status = 'shipped' AND tracking IS NOT NULL AND shipped_at IS NOT NULL ORDER BY shipped_at DESC`,
    [zr],
  );
  if (shipped.length < 6) return;
  const waiting = shipped.slice(0, 4); // handed over just now: no bag yet
  const today = shipped.slice(4, 9); // today's bag, ZR is processing it
  const older = shipped.slice(9);
  // still at the depot side for ZR: « Prêt à expédier »
  await db.query(`UPDATE orders SET ext_status = 'Pret a expedier' WHERE id = ANY($1)`, [waiting.map((r: any) => num(r.id))]);
  let n = 0;
  const bag = async (rows: any[], createdAt: number, unprocessed: number, state: string) => {
    n++;
    const id = num(
      (
        await db.query(
          `INSERT INTO pickup_bags (company_id, ext_id, tracking, state, parcels, unprocessed, created_by, created_at, synced_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id`,
          [zr, `demo-bag-${n}`, `SAC-${String(160000 + n * 4111).slice(-6)}`, state, rows.length, unprocessed, users.depot ?? null, new Date(createdAt).toISOString()],
        )
      )[0].id,
    );
    for (const r of rows) await db.query('INSERT INTO pickup_bag_parcels (bag_id, order_id, added_at) VALUES ($1,$2,$3)', [id, num(r.id), new Date(createdAt).toISOString()]);
  };
  // older parcels: one bag per day, all processed
  const byDay = new Map<string, any[]>();
  for (const r of older) {
    const d = new Date(r.shipped_at).toISOString().slice(0, 10);
    byDay.set(d, [...(byDay.get(d) ?? []), r]);
  }
  for (const rows of [...byDay.values()].slice(0, 4).reverse()) {
    const last = Math.max(...rows.map((r: any) => Date.parse(new Date(r.shipped_at).toISOString())));
    await bag(rows, last + 20 * 60_000, 0, 'Traité');
  }
  if (today.length) await bag(today, now - 40 * 60_000, Math.min(2, today.length), 'En cours de traitement');

  // an SAV exchange waiting to leave whose original parcel ZR delivered: sent to ZR, it becomes ZR's own exchange
  const x = (await db.query(`SELECT id, original_order_id FROM orders WHERE is_exchange AND original_order_id IS NOT NULL AND tracking IS NULL AND follow_status IN ('to_prepare','prepared') ORDER BY id LIMIT 1`))[0];
  if (x) {
    const o = (await db.query(`SELECT ref FROM orders WHERE id = $1 AND follow_status IN ('delivered','exchanged','in_exchange')`, [x.original_order_id]))[0];
    if (o) {
      await db.query(`UPDATE orders SET company_id = $2, tracking = $3, ext_status = 'Livré' WHERE id = $1`, [x.original_order_id, zr, fakeTracking('zr', o.ref, 0)]);
      await db.query(`UPDATE orders SET company_id = $2 WHERE id = $1`, [x.id, zr]);
    }
  }
}
