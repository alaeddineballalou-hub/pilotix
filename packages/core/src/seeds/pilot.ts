// Demo « Pilot Auto Assign » (the in-browser demo and the demo shop; not the tests' base data): five rules, two clashes
// already answered, in « Pilot Auto Assign » mode; « Livraison privée » covers the Algiers area and Oran.
import { REGIONS } from '@pilotix/shared';
import type { Db } from '../db';
import { num } from '../db';
import { setSetting } from '../settings';

export async function seedPilotDemo(db: Db): Promise<void> {
  const cos = await db.query('SELECT id, kind, name FROM delivery_companies');
  const by = (f: (c: any) => boolean) => num(cos.find(f)?.id);
  const yal = by((c) => c.kind === 'yalidine');
  const zr = by((c) => c.kind === 'zr');
  const own = by((c) => c.kind === 'own');
  const noest = by((c) => c.kind === 'noest') || zr;
  if (!yal || !zr || !own) return;
  // « Livraison privée » covers the Algiers area and Oran (Couverture): the other wilayas switched off
  const zone = [16, 9, 35, 42, 31];
  for (let w = 1; w <= 69; w++)
    if (!zone.includes(w)) await db.query('INSERT INTO company_wilayas (company_id, wilaya_id, on_) VALUES ($1,$2,false) ON CONFLICT DO NOTHING', [own, w]);
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
