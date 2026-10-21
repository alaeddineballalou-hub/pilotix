import { FOLLOW_ON_ROAD } from '@pilotix/shared';
import { word } from '../couriers/demo';
import type { Db } from '../db';
import { num } from '../db';

/** Demo couriers: NOEST + a company without API next to Yalidine / ZR, stop desks, courier statuses, livreurs' rounds. */
export async function seed(db: Db, users: Record<string, number>, now: number): Promise<void> {
  const comp = async (name: string, kind: string, cred: object, settings: object, statusMap: object = {}) =>
    num((await db.query('INSERT INTO delivery_companies (name, kind, credentials, config) VALUES ($1,$2,$3,$4) RETURNING id', [name, kind, JSON.stringify(cred), JSON.stringify({ settings, statusMap })]))[0].id);
  const noest = await comp('NOEST Express', 'noest', { demo: true }, { base_url: 'https://app.noest-dz.com', validate: true });
  await comp('Coursier Bab Ezzouar', 'manual', {}, {});
  const cs = await db.query(`SELECT id, kind FROM delivery_companies`);
  const yal = num(cs.find((c: any) => c.kind === 'yalidine')?.id);
  const zr = num(cs.find((c: any) => c.kind === 'zr')?.id);
  await db.query(`UPDATE delivery_companies SET config = $2 WHERE id = $1`, [yal, JSON.stringify({ settings: { base_url: 'https://api.yalidine.app/v1/' }, statusMap: {} })]);
  await db.query(`UPDATE delivery_companies SET config = $2, phone = '0550 00 00 00' WHERE id = $1`, [zr, JSON.stringify({ settings: { base_url: 'https://api.zrexpress.app' }, statusMap: { 'Echec livraison · Client injoignable': 'failed' } })]);

  // NOEST tariffs + stop desks for ZR and NOEST
  const fees = await db.query('SELECT wilaya_id, home, desk, return_fee FROM delivery_fees WHERE company_id = $1', [yal]);
  for (const f of fees) await db.query('INSERT INTO delivery_fees (company_id, wilaya_id, home, desk, return_fee) VALUES ($1,$2,$3,$4,$5)', [noest, f.wilaya_id, num(f.home) - 50, num(f.desk) - 50, 150]);
  const desks: [number, string][] = [[16, 'Bab Ezzouar'], [16, 'Kouba'], [31, 'Bir El Djir'], [25, 'Constantine'], [9, 'Blida'], [19, 'Sétif']];
  for (const [k, [w, c]] of desks.entries()) {
    await db.query('INSERT INTO stopdesks (company_id, wilaya_id, commune, name, address, ext_id) VALUES ($1,$2,$3,$4,$5,$6)', [zr, w, c, `ZR ${c}`, 'Agence ZR', `zr-hub-${k + 1}`]);
    await db.query('INSERT INTO stopdesks (company_id, wilaya_id, commune, name, address, ext_id) VALUES ($1,$2,$3,$4,$5,$6)', [noest, w, c, `NOEST ${c}`, 'Station NOEST', `${String(w).padStart(2, '0')}A${k}`]);
  }
  await db.query(`UPDATE stopdesks SET ext_id = 'yal-' || id WHERE ext_id IS NULL`);

  // a few recent shipped parcels go to NOEST
  await db.query(
    `UPDATE orders SET company_id = $1, tracking = 'NST-' || (200000 + id) WHERE id IN (
       SELECT id FROM orders WHERE company_id = $2 AND follow_status = ANY($3) ORDER BY id DESC LIMIT 6)`,
    [noest, yal, FOLLOW_ON_ROAD],
  );
  // what each courier says about parcels with a tracking number
  const rows = await db.query(`SELECT o.id, o.follow_status, c.kind FROM orders o JOIN delivery_companies c ON c.id = o.company_id WHERE o.tracking IS NOT NULL AND o.follow_status IS NOT NULL`);
  for (const r of rows) {
    const s = r.follow_status === 'returned' ? 'returning' : r.follow_status === 'exchanged' ? 'delivered' : r.follow_status;
    await db.query('UPDATE orders SET ext_status = $2, ext_status_at = updated_at WHERE id = $1', [r.id, word(r.kind, s)]);
  }

  // livreurs: where their round ends; Lamine has parcels to pick up at the depot and some out today
  await db.query('INSERT INTO livreur_routes (profile_id, end_wilaya_id, end_commune) VALUES ($1, 16, $2), ($3, 16, $4)', [users.livreur, 'Bab Ezzouar', users.livreur2, 'Kouba']);
  const own = num((await db.query(`SELECT id FROM delivery_companies WHERE kind = 'own' LIMIT 1`))[0]?.id);
  const pick = await db.query(`SELECT id FROM orders WHERE follow_status IN ('to_prepare','prepared') AND wilaya_id = 16 AND livreur_id IS NULL ORDER BY id DESC LIMIT 3`);
  if (pick.length) await db.query('UPDATE orders SET company_id = $1, livreur_id = $2 WHERE id = ANY($3)', [own, users.livreur, pick.map((r: any) => num(r.id))]);
  const out = await db.query(`SELECT id FROM orders WHERE follow_status = 'out_for_delivery' AND livreur_id = $1`, [users.livreur]);
  if (out.length < 4) {
    const more = await db.query(`SELECT id FROM orders WHERE follow_status = 'out_for_delivery' AND wilaya_id IN (16, 9, 35, 42) AND livreur_id IS NULL ORDER BY id DESC LIMIT $1`, [4 - out.length]);
    if (more.length) await db.query('UPDATE orders SET company_id = $1, livreur_id = $2, tracking = NULL, ext_status = NULL WHERE id = ANY($3)', [own, users.livreur, more.map((r: any) => num(r.id))]);
  }
  const today = await db.query(`SELECT id FROM orders WHERE follow_status = 'delivered' AND livreur_id = $1 ORDER BY delivered_at DESC LIMIT 1`, [users.livreur]);
  if (today.length) await db.query(`UPDATE orders SET delivered_at = $2, cashed = false, cashed_at = NULL WHERE id = $1`, [today[0].id, new Date(now - 2 * 3_600_000).toISOString()]);
  await db.query(`UPDATE orders SET delivery_note = 'Appeler avant de venir, 2e étage' WHERE id = (SELECT id FROM orders WHERE livreur_id = $1 AND follow_status = 'out_for_delivery' ORDER BY id LIMIT 1)`, [users.livreur]);
}
