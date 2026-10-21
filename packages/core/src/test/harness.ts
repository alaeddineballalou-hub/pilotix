// Shared test setup: a fresh PostgreSQL (PGlite) with the demo shop, and a context per demo user.
import { Ctx, Db, login, migrate, seedDemo } from '../index';
import { pgliteDb } from '../pglite';
import { DEMO_PASSWORD } from '@pilotix/shared';

export async function setup(orders = 400) {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  const db: Db = pgliteDb(pg as any);
  await migrate(db, async (sql) => {
    await pg.exec(sql);
  });
  await seedDemo(db, { orders });
  const events: unknown[] = [];
  /** Context for a demo account by email (e.g. 'samira@demo.pilotix.dz'). */
  const as = async (email: string, server?: Ctx['server']): Promise<Ctx> => ({ db, session: await login(db, email, DEMO_PASSWORD), now: () => Date.now(), emit: (e) => events.push(e), server });
  return { db, as, events };
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
