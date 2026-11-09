import type { Db } from './db';

/** Minimal shape of a PGlite instance (avoids a hard dependency on the package for the server build). */
export interface PGliteLike {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(fn: (tx: { query<R = any>(sql: string, params?: unknown[]): Promise<{ rows: R[] }> }) => Promise<T>): Promise<T>;
}

/** Wraps PGlite as a core Db. Nested transactions reuse the outer one. */
export function pgliteDb(pg: PGliteLike): Db {
  const make = (q: (sql: string, p?: unknown[]) => Promise<{ rows: any[] }>, inTx: boolean): Db => {
    const db: Db = {
      async query(sql, params = []) {
        return (await q(sql, params.map((v) => (Array.isArray(v) || v === undefined ? v ?? null : v)))).rows;
      },
      async tx(fn) {
        if (inTx) return fn(db);
        return pg.transaction((t) => fn(make((s, p) => t.query(s, p), true)));
      },
    };
    return db;
  };
  return make((s, p) => pg.query(s, p), false);
}
