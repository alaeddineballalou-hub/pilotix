import type { Db } from './db';
import { sharedSql } from './platform/shared';

/** Minimal shape of a PGlite instance (avoids a hard dependency on the package for the server build). */
export interface PGliteLike {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(fn: (tx: { query<R = any>(sql: string, params?: unknown[]): Promise<{ rows: R[] }> }) => Promise<T>): Promise<T>;
}

/**
 * Wraps PGlite as a core Db: one shop (#1), the whole database. Nested transactions reuse the outer one. In shared
 * tables (after migrate) its rows are shop #1's (app.shop_id), and its SQL is made right for them (sharedSql).
 */
export function pgliteDb(pg: PGliteLike): Db {
  let started: Promise<unknown> | null = null;
  let shared = false;
  const start = () => (started ??= pg.query(`SELECT set_config('app.shop_id', '1', false)`));
  // looked at again until true (the database becomes shared when it is migrated), only for SQL that would change
  const fixSql = async (sql: string) => {
    if (!shared && /ON\s+CONFLICT|nextval|setval/i.test(sql)) shared = (await pg.query(`SELECT to_regproc('public.px_shop_id') IS NOT NULL AS s`)).rows[0]?.s === true;
    return shared ? sharedSql(sql) : sql;
  };
  const make = (q: (sql: string, p?: unknown[]) => Promise<{ rows: any[] }>, inTx: boolean): Db => {
    const db: Db = {
      async query(sql, params = []) {
        await start();
        return (await q(await fixSql(sql), params.map((v) => (Array.isArray(v) || v === undefined ? v ?? null : v)))).rows;
      },
      async tx(fn) {
        if (inTx) return fn(db);
        await start();
        return pg.transaction((t) => fn(make((s, p) => t.query(s, p), true)));
      },
    };
    return db;
  };
  return make((s, p) => pg.query(s, p), false);
}
