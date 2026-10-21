import schema001 from './migrations/001_schema';
import m002 from './migrations/002_orders';
import m003 from './migrations/003_confirmation';
import m004 from './migrations/004_stats';
import m005 from './migrations/005_catalog';
import m006 from './migrations/006_customers';
import m007 from './migrations/007_suivi';
import m008 from './migrations/008_sav';
import m009 from './migrations/009_delivery';
import m010 from './migrations/010_cash';
import m011 from './migrations/011_admin';
import m012 from './migrations/012_ads';
import m013 from './migrations/013_tickets';

/** The only thing the core needs from a database: run SQL, and run a function in a transaction. */
export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

export const MIGRATIONS: [string, string][] = [['001_schema', schema001], ['002_orders', m002], ['003_confirmation', m003], ['004_stats', m004], ['005_catalog', m005], ['006_customers', m006], ['007_suivi', m007], ['008_sav', m008], ['009_delivery', m009], ['010_cash', m010], ['011_admin', m011], ['012_ads', m012], ['013_tickets', m013],];

/** Applies migrations not applied yet. `exec` runs a multi-statement SQL script. */
export async function migrate(db: Db, exec: (sql: string) => Promise<void>): Promise<string[]> {
  await exec('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  const applied: string[] = [];
  for (const [name, sql] of MIGRATIONS) {
    if (done.has(name)) continue;
    await exec(sql);
    await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    applied.push(name);
  }
  return applied;
}

// ---------------------------------------------------------------- small helpers
export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
export const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
export const iso = (v: unknown): string => new Date(v as string).toISOString();
export const isoOrNull = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

/** Builds a WHERE clause step by step with numbered parameters. */
export class Where {
  parts: string[] = [];
  params: unknown[] = [];
  /** add('o.status = ?', v) — each ? becomes the next $n */
  add(sql: string, ...values: unknown[]) {
    let s = sql;
    for (const v of values) {
      this.params.push(v);
      s = s.replace('?', `$${this.params.length}`);
    }
    this.parts.push(s);
    return this;
  }
  /** a parameter placeholder for use in ORDER BY / LIMIT etc. */
  p(v: unknown) {
    this.params.push(v);
    return `$${this.params.length}`;
  }
  get sql() {
    return this.parts.length ? `WHERE ${this.parts.join(' AND ')}` : '';
  }
}
