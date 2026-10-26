// Several shops on one PostgreSQL database: each shop has its own schema (its own tables, nothing shared), and the
// platform (shops, plans, payments, staff) has the schema "platform". The first shop — the server owner's — stays in
// "public", where it always was; the others are "shop_<id>". A shop's queries run with search_path = its schema, ext
// ("ext" holds the extensions, e.g. pg_trgm), so the same SQL works for every shop and can never reach another one.
import type { Db } from '../db';
import type { PGliteLike } from '../pglite';

export interface Tenancy {
  /** the platform's own tables (always written platform.<table>) */
  platform: Db;
  /** a shop's database: every query runs inside its schema */
  shop(schema: string): Db;
  /** runs a script of several statements inside a schema (migrations) */
  exec(schema: string, sql: string): Promise<void>;
}

export const SCHEMA_RE = /^(public|platform|shop_[1-9]\d{0,8})$/;

/** The search path of a schema (the name is checked: it is never written into SQL unchecked). */
export function searchPath(schema: string): string {
  if (!SCHEMA_RE.test(schema)) throw new Error(`Invalid schema name: ${schema}`);
  return `${schema}, ext`;
}

export const schemaOf = (shopId: number) => {
  const s = `shop_${shopId}`;
  if (!SCHEMA_RE.test(s)) throw new Error(`Invalid shop id: ${shopId}`);
  return s;
};

const fix = (params: unknown[]) => params.map((v) => (Array.isArray(v) || v === undefined ? v ?? null : v));

/**
 * PGlite (tests, the in-browser preview) as several shops. PGlite has a single connection: each call takes its turn
 * (a queue), sets the search path when it differs from the last one, then runs. A transaction keeps its turn until it
 * ends. Never call another schema's database from inside a transaction here: it would wait for itself.
 */
export function pgliteTenancy(pg: PGliteLike): Tenancy {
  let current = '';
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const enter = async (path: string) => {
    if (current === path) return;
    current = '';
    await pg.query(`SELECT set_config('search_path', $1, false)`, [path]);
    current = path;
  };
  const scoped = (path: string): Db => {
    const inTx = (t: { query<R = any>(sql: string, params?: unknown[]): Promise<{ rows: R[] }> }): Db => {
      const db: Db = {
        async query(sql, params = []) {
          return (await t.query(sql, fix(params))).rows;
        },
        async tx(fn) {
          return fn(db);
        },
      };
      return db;
    };
    return {
      query: (sql, params = []) =>
        exclusive(async () => {
          await enter(path);
          return (await pg.query(sql, fix(params))).rows;
        }),
      tx: (fn) =>
        exclusive(async () => {
          await enter(path);
          return pg.transaction((t) => fn(inTx(t)));
        }),
    };
  };
  const shops = new Map<string, Db>();
  return {
    platform: scoped(searchPath('platform')),
    shop(schema) {
      let d = shops.get(schema);
      if (!d) shops.set(schema, (d = scoped(searchPath(schema))));
      return d;
    },
    exec: (schema, sql) =>
      exclusive(async () => {
        await enter(searchPath(schema));
        await pg.exec(sql);
      }),
  };
}
