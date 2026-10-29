// Demo « Pilot Auto Assign » (the in-browser demo and the demo shop; not the tests' base data): five rules, two clashes
// already answered, in « Pilot Auto Assign » mode.
import { REGIONS } from '@pilotix/shared';
import type { Db } from '../db';
import { num } from '../db';
import { setSetting } from '../settings';

export async function seedPilotDemo(db: Db): Promise<void> {
  await seedSuiviMotifsDemo(db);
  const cos = await db.query('SELECT id, kind, name FROM delivery_companies');
  const by = (f: (c: any) => boolean) => num(cos.find(f)?.id);
  const yal = by((c) => c.kind === 'yalidine');
  const zr = by((c) => c.kind === 'zr');
  const own = by((c) => c.kind === 'own');
  const noest = by((c) => c.kind === 'noest') || zr;
  if (!yal || !zr || !own) return;
  const prods = await db.query(`SELECT id, name FROM products WHERE name IN ('Lit parapluie', 'Chaise haute évolutive') ORDER BY id`);
  const big = prods.map((p: any) => num(p.id));
  const alger = ['Kouba', 'Hydra', 'Bab Azzouar', 'Bordj El Kiffan', 'Rouiba'].map((c) => ({ w: 16, c }));
  await setSetting(db, 'pilot', {
    mode: 'auto',
    rules: [
      { id: 'r1', wilayas: [], except: false, communes: [], products: big, to: yal, strict: true, on: true },
      { id: 'r2', wilayas: [16], except: false, communes: alger, products: [], to: own, strict: true, on: true },
      { id: 'r3', wilayas: REGIONS.ouest, except: false, communes: [], products: [], to: zr, strict: false, on: true },
      { id: 'r4', wilayas: REGIONS.est, except: false, communes: [], products: [], to: noest, strict: false, on: true },
      { id: 'r5', wilayas: [31], except: false, communes: [{ w: 31, c: 'Bir El Djir' }], products: [], to: own, strict: false, on: true },
    ],
    // big items go with Yalidine even in our livreurs' communes; Bir El Djir stays with our livreurs inside the west
    clashes: [
      { a: 'r1', b: 'r2', win: 'r1' },
      { a: 'r3', b: 'r5', win: 'r5' },
    ],
  });
}

/**
 * Demo: alerts already treated in Suivi, with their motif (« Résolu » then delivered or not, « Perdu »), so Dashboard ›
 * Suivi › « Motifs du Suivi » and the treated parcels show something.
 */
export async function seedSuiviMotifsDemo(db: Db): Promise<void> {
  if ((await db.query(`SELECT 1 FROM order_events WHERE kind = 'suivi_motif' LIMIT 1`)).length) return;
  const resolved: [string, string][] = [['new_date', 'Nouvelle date de livraison'], ['reached', 'Client joint, il attend'], ['address', 'Adresse corrigée'], ['phone', 'Téléphone corrigé'], ['desk', 'Livraison au bureau']];
  const lost: [string, string][] = [['refused', 'Refus du client'], ['unreachable', 'Injoignable après les appels'], ['price', 'Prix ou frais trop chers'], ['elsewhere', 'A acheté ailleurs'], ['not_ordered', 'N’a pas commandé']];
  const pick = (rows: any[], n: number) => rows.slice(0, n);
  const del = pick(await db.query(`SELECT id, delivered_at FROM orders WHERE follow_status = 'delivered' AND delivered_at > now() - interval '7 days' ORDER BY id DESC LIMIT 40`), 22);
  const road = await db.query(`SELECT id FROM orders WHERE follow_status = 'out_for_delivery' AND sub_status = 'alert_traitee' ORDER BY id DESC LIMIT 10`);
  const back = pick(await db.query(`SELECT id FROM orders WHERE follow_status IN ('returning', 'returned') AND updated_at > now() - interval '7 days' ORDER BY id DESC LIMIT 30`), 18);
  const add = (id: number, out: string, m: [string, string], days: number) =>
    db.query(`INSERT INTO order_events (order_id, user_id, kind, from_value, to_value, note, at) VALUES ($1, NULL, 'suivi_motif', $2, $3, $4, now() - ($5 || ' days')::interval)`, [id, out, m[0], m[1], String(days)]);
  // more « Nouvelle date » and « Client joint » saved; « Refus » and « Injoignable » lose the most
  const wR = [0, 0, 0, 1, 1, 2, 3, 4];
  const wL = [0, 0, 0, 1, 1, 1, 2, 3, 4];
  let k = 0;
  for (const r of del) await add(num(r.id), 'resolved', resolved[wR[k++ % wR.length]], 1 + (k % 5));
  for (const r of road) await add(num(r.id), 'resolved', resolved[wR[k++ % wR.length]], 1);
  for (const r of back) await add(num(r.id), 'lost', lost[wL[k++ % wL.length]], 1 + (k % 5));
  // some « Résolu » that still came back
  const lateBack = await db.query(`SELECT id FROM orders WHERE follow_status = 'returned' ORDER BY id LIMIT 5`);
  for (const r of lateBack) await add(num(r.id), 'resolved', resolved[k++ % 2], 3);
}
