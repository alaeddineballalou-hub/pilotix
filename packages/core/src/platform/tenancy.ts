// Several shops on one PostgreSQL database: each shop has its own schema (its own tables, nothing shared), and the
// platform (shops, plans, payments, staff) has the schema "platform". The first shop — the server owner's — stays in
// "public", where it always was; the others are "shop_<id>". A shop's queries run with search_path = its schema, ext
// ("ext" holds the extensions, e.g. pg_trgm), so the same SQL works for every shop and can never reach another one.
//
// Since the move to shared tables (platform/shared.ts), every shop's rows live in the same tables ("public"), marked with
// their shop: a shop's database is the same tables seen through the shop's filter (app.shop_id, row level security).
// The schema names stay the shops' names here ("public" = shop #1, "shop_<id>" = shop <id>): nothing else changes for
// the code that calls them. A database not moved yet (before its first migration) keeps the old way.
import type { Db } from '../db';
import type { PGliteLike } from '../pglite';
import { sharedSql } from './shared';

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

/** Is this database in shared tables, and which shop owns the rows of shop #1 ("public")? */
export interface SharedMode {
  shared: boolean;
  primary: number;
}

/** Looks at the database: shared tables once px_tenantize has run (its filter function exists). */
export async function detectShared(q: (sql: string) => Promise<any[]>): Promise<SharedMode> {
  const r = (await q(`SELECT to_regproc('public.px_shop_id') IS NOT NULL AS shared, to_regclass('platform.shops') IS NOT NULL AS plat`))[0];
  let primary = 1;
  if (r?.plat) {
    const p = (await q('SELECT id FROM platform.shops WHERE primary_shop ORDER BY id LIMIT 1'))[0];
    if (p) primary = Number(p.id);
  }
  return { shared: !!r?.shared, primary };
}

/** The shop whose rows a schema name means: "public" (and the platform's own queries) is shop #1, "shop_<id>" is <id>. */
export function shopIdOf(schema: string, primary: number): number {
  if (schema === 'public' || schema === 'platform') return primary;
  const m = /^shop_([1-9]\d{0,8})$/.exec(schema);
  if (!m) throw new Error(`Invalid schema name: ${schema}`);
  return Number(m[1]);
}

/** In shared tables: the search path and the shop of a connection, set in one query. */
export const SHARED_ENTER = `SELECT set_config('search_path', 'public, ext', false), set_config('app.shop_id', $1, false)`;

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
  let role = false;
  let mode: Promise<SharedMode> | null = null;
  const getMode = () => (mode ??= detectShared(async (sql) => (await pg.query(sql)).rows));
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  /** Puts the single connection on this schema's shop (shared tables) or schema (the old way). */
  const enter = async (schema: string): Promise<boolean> => {
    const m = await getMode();
    const key = m.shared ? `shop:${shopIdOf(schema, m.primary)}` : `path:${searchPath(schema)}`;
    if (m.shared && !role) {
      current = '';
      // PGlite runs as a superuser, who skips row level security: the app's role is taken, as on a server
      await pg.query('SET ROLE px_app');
      role = true;
    }
    if (current === key) return m.shared;
    current = '';
    if (m.shared) await pg.query(SHARED_ENTER, [String(shopIdOf(schema, m.primary))]);
    else await pg.query(`SELECT set_config('search_path', $1, false)`, [searchPath(schema)]);
    current = key;
    return m.shared;
  };
  const scoped = (schema: string, isShop: boolean): Db => {
    const sqlOf = (shared: boolean, sql: string) => (shared && isShop ? sharedSql(sql) : sql);
    const inTx = (t: { query<R = any>(sql: string, params?: unknown[]): Promise<{ rows: R[] }> }, shared: boolean): Db => {
      const db: Db = {
        async query(sql, params = []) {
          return (await t.query(sqlOf(shared, sql), fix(params))).rows;
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
          const shared = await enter(schema);
          return (await pg.query(sqlOf(shared, sql), fix(params))).rows;
        }),
      tx: (fn) =>
        exclusive(async () => {
          const shared = await enter(schema);
          return pg.transaction((t) => fn(inTx(t, shared)));
        }),
    };
  };
  const shops = new Map<string, Db>();
  return {
    platform: scoped('platform', false),
    shop(schema) {
      shopIdOf(schema, 1); // checks the name
      let d = shops.get(schema);
      if (!d) shops.set(schema, (d = scoped(schema, true)));
      return d;
    },
    // migrations: as the owner (no filter), in the schema itself; the database may have changed way after
    exec: (schema, sql) =>
      exclusive(async () => {
        current = '';
        if (role) await pg.query('RESET ROLE');
        role = false;
        await pg.query(`SELECT set_config('search_path', $1, false), set_config('app.shop_id', '', false)`, [searchPath(schema)]);
        try {
          await pg.exec(sql);
        } finally {
          mode = null;
        }
      }),
  };
}
