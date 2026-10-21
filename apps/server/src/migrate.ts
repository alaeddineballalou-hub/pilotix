// npm run db:migrate   → applies the core migrations
// npm run db:seed      → creates the first admin (SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD) and a default depot
import * as core from '@pilotix/core';
import { Pool } from 'pg';
import { config } from './config';
import { poolDb } from './core.service';

async function main() {
  const pool = new Pool({ connectionString: config.databaseUrl });
  const db = poolDb(pool);
  if (process.argv[2] === 'seed') {
    await core.seedBase(db, { email: process.env.SEED_ADMIN_EMAIL || 'admin@pilotix.dz', password: process.env.SEED_ADMIN_PASSWORD || '' });
    console.log('Admin ready.');
  } else if (process.argv[2] === 'demo') {
    // Fills an EMPTY database with the demo shop (for testing a server). Never on a real shop.
    const n = Number((await db.query('SELECT count(*)::int AS n FROM orders'))[0].n);
    if (n > 0) throw new Error('Database is not empty');
    await core.seedDemo(db, { orders: Number(process.env.DEMO_ORDERS || 1500) });
    console.log('Demo data created.');
  } else {
    const applied = await core.migrate(db, async (sql) => {
      await pool.query(sql);
    });
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
