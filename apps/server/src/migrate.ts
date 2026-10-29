// npm run db:migrate   → the platform's tables, then every shop's (shop #1 in "public", the others in shop_<id>)
// npm run db:seed      → creates the first admin (SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD) and a default depot
import * as core from '@pilotix/core';
import { Pool } from 'pg';
import { config } from './config';
import { poolTenancy } from './core.service';

async function main() {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
  const t = poolTenancy(pool);
  const db = t.shop('public');
  if (process.argv[2] === 'seed') {
    await core.seedBase(db, { email: process.env.SEED_ADMIN_EMAIL || 'admin@pilotix.dz', password: process.env.SEED_ADMIN_PASSWORD || '' });
    // the first administrator of the first shop is also the owner of the control room (same e-mail and password)
    await core.bootstrapPlatform(t);
    console.log('Admin ready.');
  } else if (process.argv[2] === 'demo') {
    // Fills an EMPTY database with the demo shop (for testing a server). Never on a real shop: it creates accounts
    // whose password is public (demo-pilotix), so it is refused in production unless asked on purpose.
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== '1') throw new Error('Demo data refused in production (set ALLOW_DEMO_SEED=1 only on a test server)');
    const n = Number((await db.query('SELECT count(*)::int AS n FROM orders'))[0].n);
    if (n > 0) throw new Error('Database is not empty');
    await core.seedDemo(db, { orders: Number(process.env.DEMO_ORDERS || 1500) });
    await core.seedPilotDemo(db);
    console.log('Demo data created.');
  } else {
    const applied = await core.migrateAll(t);
    const done = Object.entries(applied).filter(([, v]) => v.length);
    console.log(done.length ? done.map(([k, v]) => `${k}: ${v.join(', ')}`).join('\n') : 'Database is up to date.');
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
