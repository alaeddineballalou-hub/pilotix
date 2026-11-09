// Every shop in the same tables ("public"), each row marked with its shop (shop_id), instead of one schema per shop.
//
// Why: with one schema per shop, each shop added ~150 tables and ~440 indexes; every database connection kept notes on
// each shop it opened (~1.5 MB each) and PostgreSQL ran out of memory near 1,400 shops (pressure test, Nov 2026).
//
// How it stays safe (a shop never sees another's rows):
//  - the app's connections run as the role px_app, which the database itself filters (row level security): every
//    table of a shop has the policy « shop_id = the shop of this connection » for reading AND writing;
//  - the shop of a connection is set before every query (set_config('app.shop_id')); a connection without one sees
//    nothing and can write nothing (fail closed);
//  - shop_id is filled by the database (default: the connection's shop), so the app's SQL does not change.
//
// Keys: each table's key becomes (shop_id, its old key), so a shop's ids stay what they were (the data moved from the
// old schemas keeps its ids and every id written inside JSON stays right). New rows get ids from one sequence per
// table, above every id already used, so they never collide either.
//
// px_tenantize() converts what is not converted yet: run after every migration, it also converts the tables, keys and
// indexes that new migrations add (written the old way, without shop_id).

/** The role the app's connections take (no superuser, no bypass of row level security). */
export const APP_ROLE = 'px_app';

/** Tables that belong to the database as a whole, not to a shop. */
export const NOT_SHOP_TABLES = ['schema_migrations', 'shop_counters'];

/** Sequences that count per shop (an order's reference PX1001, a SAV ticket's number, the own tracking number). */
export const SHOP_COUNTERS = ['order_ref_seq', 'complaint_ref_seq', 'order_track_seq'];

export const SHARED_SQL = String.raw`
-- the role of the app's connections: may read and write, but only what the policies allow
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'px_app') THEN
    CREATE ROLE px_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $r$;
DO $g$ BEGIN
  EXECUTE format('GRANT px_app TO %I', current_user);
EXCEPTION WHEN others THEN NULL; -- already a member, or a superuser (who may take any role)
END $g$;

-- the shop of this connection (null: none, so nothing is visible)
CREATE OR REPLACE FUNCTION public.px_shop_id() RETURNS integer LANGUAGE sql STABLE PARALLEL SAFE AS
$f$ SELECT nullif(current_setting('app.shop_id', true), '')::integer $f$;

-- per-shop counters (in place of sequences shared by the whole table)
CREATE TABLE IF NOT EXISTS public.shop_counters (
  shop_id integer NOT NULL,
  name    text    NOT NULL,
  value   bigint  NOT NULL DEFAULT 0,
  PRIMARY KEY (shop_id, name)
);
CREATE OR REPLACE FUNCTION public.px_next(seq text) RETURNS bigint LANGUAGE plpgsql AS $f$
DECLARE
  s integer := public.px_shop_id();
  v bigint;
BEGIN
  IF s IS NULL THEN RAISE EXCEPTION 'px_next(%): no shop on this connection', seq; END IF;
  INSERT INTO public.shop_counters (shop_id, name, value) VALUES (s, seq, 1)
    ON CONFLICT (shop_id, name) DO UPDATE SET value = public.shop_counters.value + 1
    RETURNING value INTO v;
  RETURN v;
END $f$;
-- like setval(seq, v): the next px_next gives v + 1
CREATE OR REPLACE FUNCTION public.px_setval(seq text, v bigint) RETURNS bigint LANGUAGE plpgsql AS $f$
DECLARE s integer := public.px_shop_id();
BEGIN
  IF s IS NULL THEN RAISE EXCEPTION 'px_setval(%): no shop on this connection', seq; END IF;
  INSERT INTO public.shop_counters (shop_id, name, value) VALUES (s, seq, v)
    ON CONFLICT (shop_id, name) DO UPDATE SET value = EXCLUDED.value;
  RETURN v;
END $f$;
-- the counters' table is filtered like the shops' tables
ALTER TABLE public.shop_counters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS px_shop ON public.shop_counters;
CREATE POLICY px_shop ON public.shop_counters USING (shop_id = public.px_shop_id()) WITH CHECK (shop_id = public.px_shop_id());

-- Converts every shop table of "public" not converted yet. primary_id: the shop that owns the rows already there
-- (shop #1, whose tables were "public").
CREATE OR REPLACE FUNCTION public.px_tenantize(primary_id integer) RETURNS integer LANGUAGE plpgsql AS $t$
DECLARE
  r record;
  d text;
  n integer := 0;
  skip text[] := ARRAY['schema_migrations', 'shop_counters'];
BEGIN
  -- 1. the column: existing rows belong to the primary shop, new rows to the connection's shop
  FOR r IN SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
            WHERE s.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND c.relname <> ALL (skip)
              AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'shop_id' AND NOT a.attisdropped) LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN shop_id integer NOT NULL DEFAULT %s', r.relname, primary_id);
    n := n + 1;
  END LOOP;
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
            JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'shop_id' AND NOT a.attisdropped
            LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
            WHERE s.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND c.relname <> ALL (skip)
              AND coalesce(pg_get_expr(ad.adbin, ad.adrelid), '') NOT LIKE '%px_shop_id()%' LOOP
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN shop_id SET DEFAULT public.px_shop_id()', r.relname);
  END LOOP;

  -- 2. foreign keys without shop_id: kept aside, dropped (the keys they point at change), made again below
  CREATE TEMP TABLE IF NOT EXISTS px_fks (tbl text, name text, def text) ON COMMIT DROP;
  FOR r IN SELECT k.conname, c.relname, pg_get_constraintdef(k.oid) AS def
             FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace s ON s.oid = c.relnamespace
            WHERE s.nspname = 'public' AND k.contype = 'f' AND NOT c.relispartition AND c.relname <> ALL (skip)
              AND k.confrelid IN (SELECT c2.oid FROM pg_class c2 JOIN pg_namespace s2 ON s2.oid = c2.relnamespace WHERE s2.nspname = 'public')
              AND NOT (pg_get_constraintdef(k.oid) LIKE 'FOREIGN KEY (shop_id,%') LOOP
    INSERT INTO px_fks VALUES (r.relname, r.conname, r.def);
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', r.relname, r.conname);
  END LOOP;

  -- 3. primary keys and unique constraints: (shop_id, …)
  FOR r IN SELECT k.conname, c.relname, k.contype, pg_get_constraintdef(k.oid) AS def
             FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace s ON s.oid = c.relnamespace
            WHERE s.nspname = 'public' AND k.contype IN ('p', 'u') AND NOT c.relispartition AND c.relname <> ALL (skip)
              AND NOT (pg_get_constraintdef(k.oid) ~ '^(PRIMARY KEY|UNIQUE( NULLS NOT DISTINCT)?) \(shop_id[,)]') LOOP
    -- foreign keys of other tables still pointing at it (left by an older run): dropped with it, made again below
    INSERT INTO px_fks SELECT c2.relname, k2.conname, pg_get_constraintdef(k2.oid)
      FROM pg_constraint k2 JOIN pg_class c2 ON c2.oid = k2.conrelid
     WHERE k2.contype = 'f' AND k2.confrelid = (SELECT oid FROM pg_class WHERE relname = r.relname AND relnamespace = 'public'::regnamespace)
       AND NOT c2.relispartition;
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I CASCADE', r.relname, r.conname);
    d := regexp_replace(r.def, '^(PRIMARY KEY|UNIQUE NULLS NOT DISTINCT|UNIQUE) \(', '\1 (shop_id, ');
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I %s', r.relname, r.conname, d);
  END LOOP;

  -- 4. unique indexes that are not constraints (partial, on an expression): (shop_id, …)
  FOR r IN SELECT ci.relname AS idx, pg_get_indexdef(i.indexrelid) AS def
             FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid JOIN pg_class c ON c.oid = i.indrelid
             JOIN pg_namespace s ON s.oid = c.relnamespace
            WHERE s.nspname = 'public' AND i.indisunique AND NOT c.relispartition AND c.relname <> ALL (skip)
              AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)
              AND pg_get_indexdef(i.indexrelid) ~ 'USING btree \('
              AND NOT (pg_get_indexdef(i.indexrelid) ~ 'USING btree \(shop_id[,)]') LOOP
    EXECUTE format('DROP INDEX public.%I', r.idx);
    EXECUTE regexp_replace(r.def, 'USING btree \(', 'USING btree (shop_id, ');
  END LOOP;

  -- 5. the foreign keys again: (shop_id, col) → (shop_id, key); « SET NULL » empties only the column, never shop_id
  FOR r IN SELECT DISTINCT tbl, name, def FROM px_fks LOOP
    d := regexp_replace(r.def, '^FOREIGN KEY \(', 'FOREIGN KEY (shop_id, ');
    d := regexp_replace(d, 'REFERENCES ([^(]+)\(', 'REFERENCES \1(shop_id, ');
    IF d ~ 'ON DELETE SET (NULL|DEFAULT)' AND d !~ 'ON DELETE SET (NULL|DEFAULT) \(' THEN
      d := regexp_replace(d, 'ON DELETE SET (NULL|DEFAULT)', 'ON DELETE SET \1 (' || substring(r.def from '^FOREIGN KEY \(([^)]*)\)') || ')');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = r.name AND conrelid = format('public.%I', r.tbl)::regclass) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I %s', r.tbl, r.name, d);
    END IF;
  END LOOP;
  DELETE FROM px_fks;

  -- 6. the other indexes (b-tree): shop_id first, so one shop's rows are found without reading the others'
  FOR r IN SELECT ci.relname AS idx, pg_get_indexdef(i.indexrelid) AS def
             FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid JOIN pg_class c ON c.oid = i.indrelid
             JOIN pg_namespace s ON s.oid = c.relnamespace
            WHERE s.nspname = 'public' AND NOT i.indisunique AND NOT c.relispartition AND c.relname <> ALL (skip)
              AND ci.relkind IN ('i', 'I') AND NOT EXISTS (SELECT 1 FROM pg_inherits h WHERE h.inhrelid = i.indexrelid)
              AND pg_get_indexdef(i.indexrelid) ~ 'USING btree \('
              AND NOT (pg_get_indexdef(i.indexrelid) ~ 'USING btree \(shop_id[,)]') LOOP
    EXECUTE format('DROP INDEX public.%I', r.idx);
    EXECUTE regexp_replace(r.def, 'USING btree \(', 'USING btree (shop_id, ');
  END LOOP;

  -- 7. row level security on every shop table (and its partitions), for reading and writing
  FOR r IN SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
            WHERE s.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> ALL (skip)
              AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'shop_id' AND NOT a.attisdropped) LOOP
    IF NOT r.relrowsecurity THEN EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = r.relname AND policyname = 'px_shop') THEN
      EXECUTE format('CREATE POLICY px_shop ON public.%I USING (shop_id = public.px_shop_id()) WITH CHECK (shop_id = public.px_shop_id())', r.relname);
    END IF;
  END LOOP;

  -- 8. views read with the rights (and the filter) of whoever reads them
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
            WHERE s.nspname = 'public' AND c.relkind = 'v'
              AND NOT coalesce('security_invoker=on' = ANY (c.reloptions) OR 'security_invoker=true' = ANY (c.reloptions), false) LOOP
    EXECUTE format('ALTER VIEW public.%I SET (security_invoker = on)', r.relname);
  END LOOP;

  -- 9. columns counted by a shared sequence that must count per shop
  FOR r IN SELECT c.relname, a.attname FROM pg_attrdef ad JOIN pg_class c ON c.oid = ad.adrelid
             JOIN pg_namespace s ON s.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ad.adnum
            WHERE s.nspname = 'public' AND pg_get_expr(ad.adbin, ad.adrelid) ~ 'nextval\(''(order_ref_seq|complaint_ref_seq|order_track_seq)''' LOOP
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I SET DEFAULT %s', r.relname, r.attname,
      regexp_replace((SELECT pg_get_expr(ad2.adbin, ad2.adrelid) FROM pg_attrdef ad2 JOIN pg_attribute a2 ON a2.attrelid = ad2.adrelid AND a2.attnum = ad2.adnum
                       WHERE ad2.adrelid = format('public.%I', r.relname)::regclass AND a2.attname = r.attname),
        'nextval\(''(\w+)''::regclass\)', 'public.px_next(''\1'')', 'g'));
  END LOOP;

  -- 10. what the app's role may touch (row level security decides which rows)
  GRANT USAGE ON SCHEMA public TO px_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO px_app;
  GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO px_app;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO px_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO px_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO px_app;
  RETURN n;
END $t$;

-- Moves an old shop schema (one schema per shop) into the shared tables, keeping every id, then renames it
-- moved_<schema> (kept until it is dropped by hand: the way back). Every table's row count is checked; any difference,
-- a column or a table the shared tables do not have, stops the move (nothing is kept of it). Run as the owner, in a transaction, with session_replication_role = replica.
CREATE OR REPLACE FUNCTION public.px_move_shop(src text, sid integer) RETURNS jsonb LANGUAGE plpgsql AS $m$
DECLARE
  r record;
  cols text;
  a bigint;
  b bigint;
  moved integer := 0;
  m date;
BEGIN
  IF src !~ '^shop_[1-9][0-9]{0,8}$' OR to_regnamespace(src) IS NULL THEN RAISE EXCEPTION 'px_move_shop: no schema %', src; END IF;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE shop_id = sid) THEN RAISE EXCEPTION 'px_move_shop: shop % already has rows', sid; END IF;
  -- the months of its events must have their part of order_events
  IF to_regclass(format('%I.order_events', src)) IS NOT NULL THEN
    FOR m IN EXECUTE format('SELECT DISTINCT date_trunc(''month'', at)::date FROM %I.order_events', src) LOOP
      PERFORM public.ensure_events_partition(m);
    END LOOP;
  END IF;
  FOR r IN SELECT c.relname FROM pg_class c
            WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relispartition
              AND c.relname NOT IN ('schema_migrations', 'shop_counters')
              AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = c.oid AND x.attname = 'shop_id')
              AND to_regclass(format('%I.%I', src, c.relname)) IS NOT NULL LOOP
    -- the columns both have (a column only the old schema has is reported, never silently dropped)
    SELECT string_agg(quote_ident(o.attname), ', ' ORDER BY o.attnum) INTO cols
      FROM pg_attribute o JOIN pg_attribute n ON n.attrelid = format('public.%I', r.relname)::regclass AND n.attname = o.attname AND NOT n.attisdropped AND n.attgenerated = ''
     WHERE o.attrelid = format('%I.%I', src, r.relname)::regclass AND o.attnum > 0 AND NOT o.attisdropped AND o.attgenerated = '';
    EXECUTE format('SELECT count(*) FROM %I.%I', src, r.relname) INTO a;
    IF a = 0 THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute o
                WHERE o.attrelid = format('%I.%I', src, r.relname)::regclass AND o.attnum > 0 AND NOT o.attisdropped
                  AND NOT EXISTS (SELECT 1 FROM pg_attribute n WHERE n.attrelid = format('public.%I', r.relname)::regclass AND n.attname = o.attname AND NOT n.attisdropped)) THEN
      RAISE EXCEPTION 'px_move_shop(%): % has columns the shared table does not have', src, r.relname;
    END IF;
    EXECUTE format('INSERT INTO public.%I (shop_id, %s) SELECT %s, %s FROM %I.%I', r.relname, cols, sid, cols, src, r.relname);
    EXECUTE format('SELECT count(*) FROM public.%I WHERE shop_id = %s', r.relname, sid) INTO b;
    IF a <> b THEN RAISE EXCEPTION 'px_move_shop(%): % has % rows, % moved', src, r.relname, a, b; END IF;
    moved := moved + 1;
  END LOOP;
  -- a table of the old schema the shared tables do not have, with rows: stop (nothing must be left behind)
  FOR r IN SELECT c.relname FROM pg_class c WHERE c.relnamespace = to_regnamespace(src) AND c.relkind IN ('r', 'p') AND NOT c.relispartition
              AND c.relname <> 'schema_migrations' AND to_regclass(format('public.%I', c.relname)) IS NULL LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I', src, r.relname) INTO a;
    IF a > 0 THEN RAISE EXCEPTION 'px_move_shop(%): table % has no shared table', src, r.relname; END IF;
  END LOOP;
  -- its counters (order references, SAV tickets, own tracking numbers) carry on where they were
  FOR r IN SELECT unnest(ARRAY['order_ref_seq', 'complaint_ref_seq', 'order_track_seq']) AS name LOOP
    IF to_regclass(format('%I.%I', src, r.name)) IS NOT NULL THEN
      EXECUTE format('SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM %I.%I', src, r.name) INTO a;
      INSERT INTO public.shop_counters (shop_id, name, value) VALUES (sid, r.name, a)
        ON CONFLICT (shop_id, name) DO UPDATE SET value = greatest(public.shop_counters.value, EXCLUDED.value);
    END IF;
  END LOOP;
  EXECUTE format('ALTER SCHEMA %I RENAME TO %I', src, 'moved_' || src);
  RETURN jsonb_build_object('tables', moved);
END $m$;

-- after a move: every table's id sequence goes above the highest id of every shop (new rows never collide)
CREATE OR REPLACE FUNCTION public.px_fix_sequences() RETURNS void LANGUAGE plpgsql AS $q$
DECLARE r record; v bigint;
BEGIN
  FOR r IN SELECT s.relname AS seq, t.relname AS tbl, a.attname AS col
             FROM pg_class s JOIN pg_depend d ON d.objid = s.oid AND d.deptype IN ('a', 'i')
             JOIN pg_class t ON t.oid = d.refobjid JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
            WHERE s.relkind = 'S' AND s.relnamespace = 'public'::regnamespace AND NOT t.relispartition LOOP
    EXECUTE format('SELECT max(%I) FROM public.%I', r.col, r.tbl) INTO v;
    IF v IS NOT NULL THEN PERFORM setval(format('public.%I', r.seq), v); END IF;
  END LOOP;
END $q$;

-- the own tracking number (PXT…), counted per shop
CREATE OR REPLACE FUNCTION public.px_next_tracking() RETURNS text LANGUAGE sql AS
$f$ SELECT 'PXT' || lpad(((public.px_next('order_track_seq') * 48271) % 100000000)::text, 8, '0') $f$;
`;

/** After the conversion (it reads shop_id). */
export const AFTER_SHARED_SQL = String.raw`
-- The one place a shop reads another shop's rows: a partner's people (a confirmation agency, a marketer) read inside the
-- store's own transaction when their accounts are put in step with the store (agencies.ts syncLink). Only profiles,
-- only for the code that asks for them (no request can call it with SQL of its own).
CREATE OR REPLACE FUNCTION public.px_shop_profiles(sid integer) RETURNS SETOF public.profiles
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, ext AS
$f$ SELECT * FROM public.profiles WHERE shop_id = sid $f$;

GRANT EXECUTE ON FUNCTION public.px_shop_profiles(integer) TO px_app;
`;

/** Grants on the platform's schema and the extensions' (no row level security there: the platform's own tables). */
export const GRANTS_SQL = String.raw`
DO $g$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'px_app') THEN RETURN; END IF;
  IF to_regnamespace('platform') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA platform TO px_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA platform TO px_app;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA platform TO px_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA platform TO px_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA platform GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO px_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA platform GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO px_app;
  END IF;
  IF to_regnamespace('ext') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA ext TO px_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ext TO px_app;
  END IF;
END $g$;
`;

/**
 * The app's SQL, made right for shared tables (applied to every query of a shop's database):
 *  - ON CONFLICT (cols) → ON CONFLICT (shop_id, cols): the unique keys all start with shop_id now;
 *  - nextval / setval of a per-shop counter → px_next / px_setval.
 * An INSERT into platform.* keeps its ON CONFLICT as written (the platform's keys have no shop_id).
 */
export function sharedSql(sql: string): string {
  let out = sql;
  if (out.includes('ON CONFLICT')) {
    // from an INSERT to its own ON CONFLICT (never across another INSERT)
    out = out.replace(/(INSERT\s+INTO\s+)([\w."]+)((?:(?!INSERT\s)[\s\S])*?ON\s+CONFLICT\s*)\((?!\s*shop_id\s*[,)])/gi, (m, ins, table, mid) =>
      /^"?platform"?\./i.test(table) ? m : `${ins}${table}${mid}(shop_id, `,
    );
  }
  // GROUP BY x.id used to let the query read x's other columns (id was x's key): the key is (shop_id, id) now
  if (/GROUP\s+BY/i.test(out)) {
    out = out.replace(/(GROUP\s+BY\s+)((?:[^;()]|\([^()]*\))+?)(?=\s+(?:HAVING|ORDER|LIMIT|OFFSET|WINDOW|UNION|INTERSECT|EXCEPT|FOR)\b|\s*\)|\s*;|\s*$)/gi, (m, kw, list) => {
      const items = splitTop(list);
      if (!items.some((i) => /^(\w+\.)?id$/.test(i.trim()))) return m;
      const out2: string[] = [];
      for (const i of items) {
        const k = /^(\w+\.)?id$/.exec(i.trim());
        if (k && !items.some((j) => j.trim() === `${k[1] ?? ''}shop_id`)) out2.push(`${k[1] ?? ''}shop_id`);
        out2.push(i.trim());
      }
      return kw + out2.join(', ');
    });
  }
  if (/\b(nextval|setval)\s*\(/i.test(out)) {
    out = out
      .replace(/\bnextval\s*\(\s*'(order_ref_seq|complaint_ref_seq|order_track_seq)'(?:::regclass)?\s*\)/gi, "public.px_next('$1')")
      .replace(/\bsetval\s*\(\s*'(order_ref_seq|complaint_ref_seq|order_track_seq)'(?:::regclass)?\s*,/gi, "public.px_setval('$1',");
  }
  return out;
}

/** a, b(c, d), e → ["a", "b(c, d)", "e"] (commas outside parentheses) */
function splitTop(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
