// Shared test setup: a fresh PostgreSQL (PGlite) with the demo shop, and a context per demo user.
import { Ctx, Db, HD_MIN_WIDTH, login, migrate, seedDemo } from '../index';
import { pgliteDb } from '../pglite';
import { DEMO_PASSWORD } from '@pilotix/shared';

export async function setup(orders = 400, expanded = false) {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  const db: Db = pgliteDb(pg as any);
  await migrate(db, async (sql) => {
    await pg.exec(sql);
  });
  await seedDemo(db, { orders, expanded });
  const events: unknown[] = [];
  /** Context for a demo account by email (e.g. 'samira@demo.pilotix.dz'). */
  const as = async (email: string, server?: Ctx['server']): Promise<Ctx> => ({ db, session: await login(db, email, DEMO_PASSWORD), now: () => Date.now(), emit: (e) => events.push(e), server });
  return { db, as, events, pg };
}

export const EMAILS = {
  admin: 'admin@demo.pilotix.dz',
  vendeur: 'vendeur@demo.pilotix.dz',
  manager: 'yacine@demo.pilotix.dz',
  manager2: 'amel@demo.pilotix.dz',
  conf: 'samira@demo.pilotix.dz',
  conf2: 'rania@demo.pilotix.dz',
  suivi: 'nadia@demo.pilotix.dz',
  depot: 'karim@demo.pilotix.dz',
  livreur: 'lamine@demo.pilotix.dz',
  marketer: 'lyes@demo.pilotix.dz',
};

/**
 * Produits › « Prêt »: gives a product what it misses to be sold (an HD main photo, a purchase price, a description, a
 * live landing page, a sales guide) and puts it back on sale if Pilotix kept it off, as a shop would before selling a
 * new product. `photo: false` leaves its photos to the test (a test of the photos adds its own).
 */
export async function makeReady(db: Db, productId: number, o: { photo?: boolean } = {}) {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF-ready-'.padEnd(64, 'x'))]).toString('base64');
  if (o.photo !== false)
    await db.query(
      `INSERT INTO product_photos (product_id, kind, store, data, w, h, bytes, thumb, position)
       SELECT $1, 'photo', 'local', $2, $3, $4, 70, 'data:image/jpeg;base64,' || $2, 0
        WHERE NOT EXISTS (SELECT 1 FROM product_photos WHERE product_id = $1 AND kind = 'photo')`,
      [productId, jpeg, HD_MIN_WIDTH, Math.round(HD_MIN_WIDTH * 1.25)],
    );
  await db.query(
    `UPDATE products p SET cost = GREATEST(1, round(p.price / 2))
      WHERE p.id = $1 AND COALESCE(p.cost, 0) <= 0
        AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.active AND COALESCE(v.cost, 0) > 0)`,
    [productId],
  );
  await db.query(`UPDATE products SET description = name WHERE id = $1 AND length(btrim(COALESCE(description, ''))) = 0`, [productId]);
  await db.query(
    `INSERT INTO landing_pages (product_id, slug, title) SELECT p.id, 'pret-' || p.id, p.name FROM products p
      WHERE p.id = $1 AND NOT EXISTS (SELECT 1 FROM landing_pages l WHERE l.product_id = p.id AND l.active)`,
    [productId],
  );
  await db.query(`INSERT INTO product_guides (product_id, guide) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM product_guides WHERE product_id = $1)`, [productId, JSON.stringify({ brief: 'Livré dans les 69 wilayas.' })]);
  await db.query(`UPDATE products SET active = true, ready_off = false WHERE id = $1 AND ready_off`, [productId]);
}
