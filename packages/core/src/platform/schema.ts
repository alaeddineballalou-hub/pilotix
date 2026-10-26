// The platform's tables (schema "platform"): the shops, their plans and payments, Pilotix staff, the e-mail → shop
// index used at login, settings and the journal. Applied before every shop's own migrations.
import type { Tenancy } from './tenancy';

const P001 = `
CREATE SCHEMA IF NOT EXISTS platform;
CREATE SCHEMA IF NOT EXISTS ext;

-- pg_trgm (fast search) moves to "ext": every shop's schema reaches it through its search path. Its indexes keep
-- working (they point to the operator classes, not to their schema).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm' AND n.nspname <> 'ext') THEN
    ALTER EXTENSION pg_trgm SET SCHEMA ext;
  ELSIF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE EXTENSION pg_trgm SCHEMA ext;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
-- a session that does not choose (psql, the backup) sees the first shop and the extensions
DO $$ BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path = public, ext', current_database());
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS platform.plans (
  id               serial PRIMARY KEY,
  code             text        NOT NULL UNIQUE,
  name             text        NOT NULL,
  price_month      integer     NOT NULL DEFAULT 0,
  price_year       integer,
  features         jsonb       NOT NULL DEFAULT '[]',
  max_users        integer,
  max_orders_month integer,
  description      text        NOT NULL DEFAULT '',
  public           boolean     NOT NULL DEFAULT true,
  active           boolean     NOT NULL DEFAULT true,
  sort             integer     NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform.shops (
  id               serial PRIMARY KEY,
  slug             text        NOT NULL UNIQUE,
  name             text        NOT NULL,
  schema_name      text        NOT NULL UNIQUE,
  plan_id          integer REFERENCES platform.plans(id),
  status           text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  status_reason    text,
  trial_ends_at    timestamptz,
  paid_until       timestamptz,
  never_expires    boolean     NOT NULL DEFAULT false,
  is_demo          boolean     NOT NULL DEFAULT false,
  primary_shop     boolean     NOT NULL DEFAULT false,
  features_on      jsonb       NOT NULL DEFAULT '[]',
  features_off     jsonb       NOT NULL DEFAULT '[]',
  max_users        integer,
  owner_name       text,
  owner_email      text,
  owner_phone      text,
  city             text,
  notes            text        NOT NULL DEFAULT '',
  last_active_at   timestamptz,
  reset_at         timestamptz,
  created_by       integer,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS shops_one_primary ON platform.shops (primary_shop) WHERE primary_shop;

-- e-mail (lower case) → shop: the login page finds the shop of an account (kept by a trigger on each shop's profiles)
CREATE TABLE IF NOT EXISTS platform.logins (
  email   text    PRIMARY KEY,
  shop_id integer NOT NULL REFERENCES platform.shops(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS logins_shop ON platform.logins (shop_id);

CREATE TABLE IF NOT EXISTS platform.payments (
  id          serial PRIMARY KEY,
  shop_id     integer     NOT NULL REFERENCES platform.shops(id),
  amount      integer     NOT NULL CHECK (amount >= 0),
  method      text        NOT NULL,
  reference   text,
  months      integer     NOT NULL CHECK (months BETWEEN 1 AND 60),
  plan_id     integer REFERENCES platform.plans(id),
  period_from timestamptz NOT NULL,
  period_to   timestamptz NOT NULL,
  paid_at     timestamptz NOT NULL DEFAULT now(),
  note        text,
  created_by  integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  void_at     timestamptz,
  void_by     integer,
  void_reason text
);
CREATE INDEX IF NOT EXISTS payments_shop ON platform.payments (shop_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS payments_paid ON platform.payments (paid_at DESC);

CREATE TABLE IF NOT EXISTS platform.staff (
  id            serial PRIMARY KEY,
  name          text        NOT NULL,
  email         text        NOT NULL UNIQUE,
  password_hash text        NOT NULL,
  role          text        NOT NULL DEFAULT 'support' CHECK (role IN ('owner', 'manager', 'support')),
  active        boolean     NOT NULL DEFAULT true,
  token_version integer     NOT NULL DEFAULT 0,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform.settings (
  key        text PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform.audit (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  staff_id   integer,
  staff_name text,
  shop_id    integer,
  action     text        NOT NULL,
  details    jsonb       NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS audit_at ON platform.audit (at DESC);
CREATE INDEX IF NOT EXISTS audit_shop ON platform.audit (shop_id, at DESC);

-- Keeps platform.logins in step with a shop's accounts, inside the same transaction. An e-mail already used by another
-- shop is refused (one account = one shop: the login page must know where to go). Closed accounts
-- (…@pilotix.invalid) and the demo accounts (…@demo.pilotix.dz, opened from the demo button) are not listed.
CREATE OR REPLACE FUNCTION platform.sync_login() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE
  sid   integer;
  e_old text;
  e_new text;
BEGIN
  SELECT id INTO sid FROM platform.shops WHERE schema_name = TG_TABLE_SCHEMA;
  IF sid IS NULL THEN RETURN NULL; END IF;
  IF TG_OP <> 'INSERT' THEN e_old := lower(OLD.email); END IF;
  IF TG_OP <> 'DELETE' THEN e_new := lower(NEW.email); END IF;
  IF e_new LIKE '%@pilotix.invalid' OR e_new LIKE '%@demo.pilotix.dz' OR e_new = '' THEN e_new := NULL; END IF;
  IF e_old IS NOT NULL AND e_old IS DISTINCT FROM e_new THEN
    DELETE FROM platform.logins WHERE email = e_old AND shop_id = sid;
  END IF;
  IF e_new IS NOT NULL AND e_new IS DISTINCT FROM e_old THEN
    INSERT INTO platform.logins (email, shop_id) VALUES (e_new, sid)
      ON CONFLICT (email) DO UPDATE SET shop_id = EXCLUDED.shop_id WHERE platform.logins.shop_id = EXCLUDED.shop_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Cet email est déjà utilisé' USING ERRCODE = '23505';
    END IF;
  END IF;
  RETURN NULL;
END $f$;
`;

// One e-mail, several shops (the owner of two shops, an agent working for two clients): the login index lists every
// shop of an e-mail; the login page asks the password of each one and offers the shops it opens. Sign-up by the shops
// themselves (email check, limits), and their own domain names (myshop.com) for their landing pages.
const P002 = `
ALTER TABLE platform.logins DROP CONSTRAINT IF EXISTS logins_pkey;
ALTER TABLE platform.logins ADD CONSTRAINT logins_pkey PRIMARY KEY (email, shop_id);

CREATE OR REPLACE FUNCTION platform.sync_login() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE
  sid   integer;
  e_old text;
  e_new text;
BEGIN
  SELECT id INTO sid FROM platform.shops WHERE schema_name = TG_TABLE_SCHEMA;
  IF sid IS NULL THEN RETURN NULL; END IF;
  IF TG_OP <> 'INSERT' THEN e_old := lower(OLD.email); END IF;
  IF TG_OP <> 'DELETE' THEN e_new := lower(NEW.email); END IF;
  IF e_new LIKE '%@pilotix.invalid' OR e_new LIKE '%@demo.pilotix.dz' OR e_new = '' THEN e_new := NULL; END IF;
  IF e_old IS NOT NULL AND e_old IS DISTINCT FROM e_new THEN
    DELETE FROM platform.logins WHERE email = e_old AND shop_id = sid;
  END IF;
  IF e_new IS NOT NULL AND e_new IS DISTINCT FROM e_old THEN
    INSERT INTO platform.logins (email, shop_id) VALUES (e_new, sid) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $f$;

ALTER TABLE platform.shops ADD COLUMN IF NOT EXISTS self_signup       boolean NOT NULL DEFAULT false;
ALTER TABLE platform.shops ADD COLUMN IF NOT EXISTS signup_ip         text;
ALTER TABLE platform.shops ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
ALTER TABLE platform.shops ADD COLUMN IF NOT EXISTS domain            text;
ALTER TABLE platform.shops ADD COLUMN IF NOT EXISTS domain_status     text NOT NULL DEFAULT 'none' CHECK (domain_status IN ('none', 'pending', 'ok'));
ALTER TABLE platform.shops ADD COLUMN IF NOT EXISTS domain_checked_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS shops_domain ON platform.shops (domain) WHERE domain IS NOT NULL;

-- sign-ups (limits per address and per e-mail) and the links that confirm a shop owner's e-mail
CREATE TABLE IF NOT EXISTS platform.signups (
  id      serial PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT now(),
  ip      text,
  email   text        NOT NULL,
  shop_id integer REFERENCES platform.shops(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS signups_ip ON platform.signups (ip, at DESC);
CREATE INDEX IF NOT EXISTS signups_email ON platform.signups (email, at DESC);

CREATE TABLE IF NOT EXISTS platform.email_checks (
  token_hash text        PRIMARY KEY,
  shop_id    integer     NOT NULL REFERENCES platform.shops(id) ON DELETE CASCADE,
  email      text        NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

export const PLATFORM_MIGRATIONS: [string, string][] = [
  ['p001_platform', P001],
  ['p002_accounts_signup_domains', P002],
];

/** Creates or updates the platform's tables. */
export async function migratePlatform(t: Tenancy): Promise<string[]> {
  await t.exec('public', 'CREATE SCHEMA IF NOT EXISTS platform; CREATE TABLE IF NOT EXISTS platform.migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await t.platform.query<{ name: string }>('SELECT name FROM platform.migrations')).map((r) => r.name));
  const applied: string[] = [];
  for (const [name, sql] of PLATFORM_MIGRATIONS) {
    if (done.has(name)) continue;
    await t.exec('public', sql);
    await t.platform.query('INSERT INTO platform.migrations (name) VALUES ($1)', [name]);
    applied.push(name);
  }
  return applied;
}

/** The trigger that keeps platform.logins in step with a shop's accounts (created once per shop schema). */
export async function ensureLoginTrigger(t: Tenancy, schema: string): Promise<void> {
  await t.exec(
    schema,
    `DO $$ BEGIN
       IF to_regclass('profiles') IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM pg_trigger WHERE tgname = 'profiles_login_sync' AND tgrelid = to_regclass('profiles')) THEN
         CREATE TRIGGER profiles_login_sync AFTER INSERT OR DELETE OR UPDATE OF email ON profiles
           FOR EACH ROW EXECUTE FUNCTION platform.sync_login();
       END IF;
     END $$;`,
  );
}
