import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { Client } from 'pg';
import { config } from '../config';

/** Applies every db/migrations/*.sql file not applied yet, in name order. */
async function main() {
  const dir = [resolve(__dirname, '../../../../db/migrations'), resolve(process.cwd(), 'db/migrations')].find((d) => {
    try {
      readdirSync(d);
      return true;
    } catch {
      return false;
    }
  });
  if (!dir) throw new Error('db/migrations folder not found');

  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  await client.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    console.log(`Applying ${file}…`);
    await client.query('BEGIN');
    try {
      await client.query(readFileSync(join(dir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  }
  await client.end();
  console.log('Database is up to date.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
