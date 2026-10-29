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
// shop of an e-mail. Sign-up by the shops themselves (its log: platform.signups), and their own domain names
// (myshop.com) for their landing pages. (p003 then gives every person one account: one password for all their shops.)
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

/**
 * Accounts (one e-mail, one password, several stores), each store's owner (who created it), sign-ups by e-mail,
 * invitations, numbered payment receipts, messages between stores and Pilotix, reminders already sent, the control
 * room's two-step codes, referrals, and the plans' new limits.
 */
const P003 = `
-- a shop its owner deleted: its row stays (payments, journal), its data is gone
ALTER TABLE platform.shops DROP CONSTRAINT IF EXISTS shops_status_check;
ALTER TABLE platform.shops ADD CONSTRAINT shops_status_check CHECK (status IN ('active', 'suspended', 'archived', 'deleted'));
ALTER TABLE platform.shops ADD COLUMN IF NOT EXISTS owner_account_id integer;
ALTER TABLE platform.shops ADD COLUMN IF NOT EXISTS deleted_at       timestamptz;
ALTER TABLE platform.shops ADD COLUMN IF NOT EXISTS max_drivers      integer;
ALTER TABLE platform.shops ADD COLUMN IF NOT EXISTS self_signup      boolean NOT NULL DEFAULT false;
ALTER TABLE platform.shops ADD COLUMN IF NOT EXISTS referral_code    text;
ALTER TABLE platform.shops ADD COLUMN IF NOT EXISTS referred_by      integer REFERENCES platform.shops(id);
CREATE UNIQUE INDEX IF NOT EXISTS shops_referral_code ON platform.shops (referral_code) WHERE referral_code IS NOT NULL;

ALTER TABLE platform.plans ADD COLUMN IF NOT EXISTS max_drivers integer;

-- one person = one account (e-mail, password), whatever the number of stores they work in
CREATE TABLE IF NOT EXISTS platform.accounts (
  id                serial PRIMARY KEY,
  email             text        NOT NULL UNIQUE,
  name              text        NOT NULL DEFAULT '',
  language          text        NOT NULL DEFAULT 'fr',
  -- null: invited, the password is not chosen yet
  password_hash     text,
  token_version     integer     NOT NULL DEFAULT 0,
  email_verified_at timestamptz,
  -- stores this person may own (null = the platform's setting)
  max_stores        integer,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_login_at     timestamptz
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shops_owner_account') THEN
    ALTER TABLE platform.shops ADD CONSTRAINT shops_owner_account FOREIGN KEY (owner_account_id) REFERENCES platform.accounts(id);
  END IF;
END $$;

-- one-time links of an account: new password, invitation (choose a password), e-mail check
CREATE TABLE IF NOT EXISTS platform.account_tokens (
  token_hash   text PRIMARY KEY,
  account_id   integer     NOT NULL REFERENCES platform.accounts(id) ON DELETE CASCADE,
  kind         text        NOT NULL CHECK (kind IN ('reset', 'invite', 'verify')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS account_tokens_account ON platform.account_tokens (account_id, created_at DESC);

-- a sign-up waits for its e-mail to be confirmed (nothing is created before)
CREATE TABLE IF NOT EXISTS platform.signup_requests (
  id              serial PRIMARY KEY,
  token_hash      text        NOT NULL UNIQUE,
  email           text        NOT NULL,
  name            text        NOT NULL,
  phone           text,
  store_name      text        NOT NULL,
  slug            text,
  password_hash   text        NOT NULL,
  language        text        NOT NULL DEFAULT 'fr',
  referral_code   text,
  -- when the person accepted the terms of use and the privacy policy
  terms_at        timestamptz NOT NULL,
  ip              text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  shop_id         integer
);
CREATE INDEX IF NOT EXISTS signup_requests_created ON platform.signup_requests (created_at DESC);
CREATE INDEX IF NOT EXISTS signup_requests_email ON platform.signup_requests (email, created_at DESC);

-- payment receipts: one number per payment, counted per year (PX-2026-0001)
ALTER TABLE platform.payments ADD COLUMN IF NOT EXISTS receipt_no text;
CREATE UNIQUE INDEX IF NOT EXISTS payments_receipt ON platform.payments (receipt_no) WHERE receipt_no IS NOT NULL;

-- « Contacter Pilotix »: a store writes, Pilotix answers (the store chooses what it tells)
CREATE TABLE IF NOT EXISTS platform.support_threads (
  id           serial PRIMARY KEY,
  shop_id      integer     NOT NULL REFERENCES platform.shops(id),
  author_email text        NOT NULL,
  author_name  text        NOT NULL,
  subject      text        NOT NULL,
  status       text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  unread_staff boolean     NOT NULL DEFAULT true,
  unread_shop  boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_threads_shop ON platform.support_threads (shop_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS support_threads_updated ON platform.support_threads (updated_at DESC);
CREATE TABLE IF NOT EXISTS platform.support_messages (
  id         serial PRIMARY KEY,
  thread_id  integer     NOT NULL REFERENCES platform.support_threads(id) ON DELETE CASCADE,
  from_staff boolean     NOT NULL,
  author     text        NOT NULL,
  body       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_messages_thread ON platform.support_messages (thread_id, id);

-- reminders already e-mailed (one per shop, kind and end date)
CREATE TABLE IF NOT EXISTS platform.reminders (
  shop_id integer     NOT NULL REFERENCES platform.shops(id) ON DELETE CASCADE,
  kind    text        NOT NULL,
  ends_at text        NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, kind, ends_at)
);

-- control room: the code e-mailed at each login (two-step login)
CREATE TABLE IF NOT EXISTS platform.staff_codes (
  id         serial PRIMARY KEY,
  staff_id   integer     NOT NULL REFERENCES platform.staff(id) ON DELETE CASCADE,
  code_hash  text        NOT NULL,
  attempts   integer     NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE INDEX IF NOT EXISTS staff_codes_staff ON platform.staff_codes (staff_id, created_at DESC);

-- referrals: a store brought another one; its reward when that one first pays
CREATE TABLE IF NOT EXISTS platform.referrals (
  id               serial PRIMARY KEY,
  referrer_shop_id integer     NOT NULL REFERENCES platform.shops(id),
  referred_shop_id integer     NOT NULL UNIQUE REFERENCES platform.shops(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  rewarded_at      timestamptz,
  reward_months    integer,
  payment_id       integer
);
CREATE INDEX IF NOT EXISTS referrals_referrer ON platform.referrals (referrer_shop_id);
`;

// Cloudflare Turnstile, managed by Pilotix for every shop: the widgets it made in the platform's Cloudflare account
// (10 domains each on the free plan) and the domains in each; the account id and its API token are platform settings.
const P004 = `
CREATE TABLE IF NOT EXISTS platform.turnstile_widgets (
  sitekey    text        PRIMARY KEY,
  secret     text        NOT NULL,
  name       text        NOT NULL,
  domains    text[]      NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

// Confirmation agencies. An agency is a « shop » of its own kind: its team logs in on the same page as a store's and
// lands in the agency's space. Stores and agencies have a public code (typed to find each other); an agency has its
// usual prices and is checked by Pilotix before it can work. A link joins an agency to a store: asked by either side,
// accepted by the other; it carries the agency's prices (only the agency sets them), the tasks (confirmation, suivi)
// and the store's products given to the agency (only the store chooses them). The agency's people work on the store's
// orders from the agency's space; its bills are its monthly payment requests to the store.
const P005 = `
ALTER TABLE platform.shops ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'store';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shops_kind_check') THEN
    ALTER TABLE platform.shops ADD CONSTRAINT shops_kind_check CHECK (kind IN ('store', 'agency'));
  END IF;
END $$;
ALTER TABLE platform.shops ADD COLUMN IF NOT EXISTS public_code text;
CREATE UNIQUE INDEX IF NOT EXISTS shops_public_code ON platform.shops (public_code) WHERE public_code IS NOT NULL;
ALTER TABLE platform.shops ADD COLUMN IF NOT EXISTS agency_verified_at timestamptz;
ALTER TABLE platform.shops ADD COLUMN IF NOT EXISTS agency_prices jsonb;
ALTER TABLE platform.signup_requests ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'store';

CREATE TABLE IF NOT EXISTS platform.agency_links (
  id             serial PRIMARY KEY,
  agency_id      integer     NOT NULL REFERENCES platform.shops(id),
  store_id       integer     NOT NULL REFERENCES platform.shops(id),
  status         text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'refused', 'cancelled', 'ended')),
  requested_by   text        NOT NULL CHECK (requested_by IN ('agency', 'store')),
  requester      text        NOT NULL DEFAULT '',
  tasks          jsonb       NOT NULL DEFAULT '["confirmation"]',
  prices         jsonb       NOT NULL,
  -- new prices from the agency, waiting for the store's yes (the old ones stay until then)
  prices_new     jsonb,
  -- null = every product (also the new ones); else the ids of the products the store gives
  products       jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  answered_at    timestamptz,
  started_at     timestamptz,
  ended_at       timestamptz,
  ended_by       text
);
CREATE UNIQUE INDEX IF NOT EXISTS agency_links_open ON platform.agency_links (agency_id, store_id) WHERE status IN ('pending', 'active');
CREATE INDEX IF NOT EXISTS agency_links_store ON platform.agency_links (store_id, status);
CREATE INDEX IF NOT EXISTS agency_links_agency ON platform.agency_links (agency_id, status);

-- the agency's payment requests to a store: one per month, its numbers kept as they were counted
CREATE TABLE IF NOT EXISTS platform.agency_bills (
  id           serial PRIMARY KEY,
  link_id      integer     NOT NULL REFERENCES platform.agency_links(id),
  month        text        NOT NULL,
  amount       integer     NOT NULL CHECK (amount >= 0),
  details      jsonb       NOT NULL,
  status       text        NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'paid', 'received')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  paid_at      timestamptz,
  received_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS agency_bills_month ON platform.agency_bills (link_id, month);
`;

// Marketers: a partner's space like an agency's (its team, its sellers, its prices, its bills) for the people who run
// the stores' ads. Same links and bills as the agencies (agency_links.agency_id is the partner, whatever its kind);
// the store gives it products, and it gets paid on its ad sets' results.
const P006 = `
ALTER TABLE platform.shops DROP CONSTRAINT IF EXISTS shops_kind_check;
ALTER TABLE platform.shops ADD CONSTRAINT shops_kind_check CHECK (kind IN ('store', 'agency', 'marketer'));
`;

// Every account has its own phone number (one number = one account), proven once, when the account is opened, by a
// code sent by WhatsApp when Pilotix turned the code on (control room › Réglages). The codes: 6 digits, kept hashed, 10
// minutes, 5 tries; a sign-up's code belongs to no account yet (account_id null).
const P007 = `
ALTER TABLE platform.accounts ADD COLUMN IF NOT EXISTS phone             text;
ALTER TABLE platform.accounts ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_phone ON platform.accounts (phone) WHERE phone IS NOT NULL;
ALTER TABLE platform.signup_requests ADD COLUMN IF NOT EXISTS phone_verified boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS platform.phone_codes (
  id         serial PRIMARY KEY,
  account_id integer     REFERENCES platform.accounts(id) ON DELETE CASCADE,
  phone      text        NOT NULL,
  code_hash  text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  attempts   integer     NOT NULL DEFAULT 0,
  used_at    timestamptz
);
CREATE INDEX IF NOT EXISTS phone_codes_account ON platform.phone_codes (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS phone_codes_phone ON platform.phone_codes (phone, created_at DESC);
`;

// Pro marketers: a marketer's space paid by the month (staff turn it on: control room › Marketers) shows on Pilotix's
// list of marketers (the stores' search and the public page). Its own words (pro_profile), the numbers Pilotix last
// counted across the stores its people worked for (pro_stats, counted again when older than a few hours), its paid
// months (pro_payments) and its request (pro_asked_at: « Passer Pro », until staff answer).
const P008 = `
ALTER TABLE platform.shops ADD COLUMN IF NOT EXISTS pro_until    timestamptz;
ALTER TABLE platform.shops ADD COLUMN IF NOT EXISTS pro_asked_at timestamptz;
ALTER TABLE platform.shops ADD COLUMN IF NOT EXISTS pro_profile  jsonb;
ALTER TABLE platform.shops ADD COLUMN IF NOT EXISTS pro_stats    jsonb;
ALTER TABLE platform.shops ADD COLUMN IF NOT EXISTS pro_stats_at timestamptz;
CREATE TABLE IF NOT EXISTS platform.pro_payments (
  id          serial PRIMARY KEY,
  shop_id     integer     NOT NULL REFERENCES platform.shops(id),
  amount      integer     NOT NULL CHECK (amount >= 0),
  method      text        NOT NULL,
  months      integer     NOT NULL CHECK (months BETWEEN 1 AND 36),
  period_from timestamptz NOT NULL,
  period_to   timestamptz NOT NULL,
  note        text,
  created_by  integer,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pro_payments_shop ON platform.pro_payments (shop_id, created_at DESC);
`;

// The fake-order learning shared by every seller (« le réseau Pilotix », platform/reputation.ts): for each phone number
// and each device, the stores that ended badly with it (agent found it fake / a wrong number, parcel refused, device
// marked). Only a keyed hash of the number / the fingerprint is kept, never the number itself; owner_key is the business
// (one owner's several stores count once). Rebuilt store by store by the job « fraud-reputation ».
const P009 = `
CREATE TABLE IF NOT EXISTS platform.fraud_reputation (
  key         text        NOT NULL,
  shop_id     integer     NOT NULL REFERENCES platform.shops(id) ON DELETE CASCADE,
  owner_key   text        NOT NULL,
  bad_n       integer     NOT NULL DEFAULT 1,
  last_bad    timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, shop_id)
);
CREATE INDEX IF NOT EXISTS fraud_reputation_shop ON platform.fraud_reputation (shop_id);
`;

export const PLATFORM_MIGRATIONS: [string, string][] = [
  ['p001_platform', P001],
  ['p002_accounts_signup_domains', P002],
  ['p003_accounts_privacy', P003],
  ['p004_turnstile', P004],
  ['p005_agencies', P005],
  ['p006_marketers', P006],
  ['p007_account_phone', P007],
  ['p008_pro_marketers', P008],
  ['p009_fraud_reputation', P009],
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
