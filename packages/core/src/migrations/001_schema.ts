// Pilotix schema (PostgreSQL 15+; also runs in PGlite for the in-browser preview).
// Money is whole dinars (integer). Times are timestamptz.
export default `
DO $$ BEGIN CREATE EXTENSION IF NOT EXISTS pg_trgm; EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- ------------------------------------------------------------------ people
CREATE TABLE profiles (
  id                 bigserial PRIMARY KEY,
  name               text        NOT NULL,
  email              text        NOT NULL UNIQUE,
  phone              text,
  password_hash      text        NOT NULL,
  roles              text[]      NOT NULL DEFAULT '{confirmation}',
  language           text        NOT NULL DEFAULT 'fr' CHECK (language IN ('fr','en','ar')),
  active             boolean     NOT NULL DEFAULT true,
  livreur_company_id bigint,
  last_seen_at       timestamptz,
  presence           text        NOT NULL DEFAULT 'offline',
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint
);

-- ------------------------------------------------------------------ catalog and stock
CREATE TABLE warehouses (
  id         bigserial PRIMARY KEY,
  name       text     NOT NULL,
  wilaya_id  smallint NOT NULL CHECK (wilaya_id BETWEEN 1 AND 69),
  commune    text     NOT NULL DEFAULT '',
  address    text     NOT NULL DEFAULT '',
  is_default boolean  NOT NULL DEFAULT false,
  active     boolean  NOT NULL DEFAULT true
);

CREATE TABLE products (
  id           bigserial PRIMARY KEY,
  name         text        NOT NULL,
  sku          text        NOT NULL UNIQUE,
  price        integer     NOT NULL CHECK (price >= 0),
  cost         integer     NOT NULL DEFAULT 0 CHECK (cost >= 0),
  weight_kg    numeric(6,2) NOT NULL DEFAULT 0.5,
  photo        text,
  is_service   boolean     NOT NULL DEFAULT false,
  active       boolean     NOT NULL DEFAULT true,
  fixed_price  boolean     NOT NULL DEFAULT false,
  max_discount integer,
  packs        jsonb       NOT NULL DEFAULT '[]',
  linked       bigint[]    NOT NULL DEFAULT '{}',
  parts        jsonb       NOT NULL DEFAULT '[]',
  fee_grid     text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE product_variants (
  id         bigserial PRIMARY KEY,
  product_id bigint  NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  title      text    NOT NULL DEFAULT '',
  sku        text    NOT NULL,
  price      integer,
  active     boolean NOT NULL DEFAULT true
);
CREATE INDEX product_variants_product ON product_variants (product_id);
CREATE UNIQUE INDEX product_variants_sku ON product_variants (sku);

CREATE TABLE stock (
  variant_id   bigint  NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  warehouse_id bigint  NOT NULL REFERENCES warehouses(id),
  qty          integer NOT NULL DEFAULT 0,
  alert_qty    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (variant_id, warehouse_id)
);

CREATE TABLE stock_movements (
  id           bigserial PRIMARY KEY,
  variant_id   bigint      NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  warehouse_id bigint      NOT NULL REFERENCES warehouses(id),
  delta        integer     NOT NULL,
  reason       text        NOT NULL,   -- entry, count, loss, transfer_in, transfer_out, shipped, returned
  order_id     bigint,
  user_id      bigint,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_variant ON stock_movements (variant_id, created_at DESC);
CREATE INDEX stock_movements_created ON stock_movements (created_at DESC);

-- ------------------------------------------------------------------ couriers
CREATE TABLE delivery_companies (
  id          bigserial PRIMARY KEY,
  name        text        NOT NULL,
  kind        text        NOT NULL DEFAULT 'manual',
  active      boolean     NOT NULL DEFAULT true,
  credentials jsonb       NOT NULL DEFAULT '{}',   -- API keys: server only, never sent to the app
  config      jsonb       NOT NULL DEFAULT '{}',   -- status mapping, custom API template, sender info
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- What each courier charges Pilotix per wilaya.
CREATE TABLE delivery_fees (
  company_id bigint   NOT NULL REFERENCES delivery_companies(id) ON DELETE CASCADE,
  wilaya_id  smallint NOT NULL,
  home       integer  NOT NULL DEFAULT 0,
  desk       integer  NOT NULL DEFAULT 0,
  return_fee integer  NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, wilaya_id)
);

CREATE TABLE stopdesks (
  id         bigserial PRIMARY KEY,
  company_id bigint   NOT NULL REFERENCES delivery_companies(id) ON DELETE CASCADE,
  wilaya_id  smallint NOT NULL,
  commune    text     NOT NULL DEFAULT '',
  name       text     NOT NULL,
  address    text     NOT NULL DEFAULT '',
  ext_id     text
);
CREATE INDEX stopdesks_company_wilaya ON stopdesks (company_id, wilaya_id);

-- ------------------------------------------------------------------ customers
CREATE TABLE customers (
  id               bigserial PRIMARY KEY,
  phone            text        NOT NULL UNIQUE,
  name             text        NOT NULL,
  wilaya_id        smallint,
  blacklisted      boolean     NOT NULL DEFAULT false,
  blacklist_reason text,
  orders           integer     NOT NULL DEFAULT 0,
  delivered        integer     NOT NULL DEFAULT 0,
  returned         integer     NOT NULL DEFAULT 0,
  last_order_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ orders
CREATE SEQUENCE order_ref_seq START 1001;

CREATE TABLE orders (
  id                bigserial PRIMARY KEY,
  ref               text        NOT NULL UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        bigint,
  customer_id       bigint      NOT NULL REFERENCES customers(id),
  customer_name     text        NOT NULL,
  phone             text        NOT NULL,
  phone2            text,
  wilaya_id         smallint    NOT NULL CHECK (wilaya_id BETWEEN 1 AND 69),
  commune           text        NOT NULL DEFAULT '',
  address           text        NOT NULL DEFAULT '',
  is_stopdesk       boolean     NOT NULL DEFAULT false,
  stopdesk_id       bigint,
  channel           text        NOT NULL DEFAULT 'site',
  source            text,
  utm               jsonb,
  adset_id          text,
  -- confirmation
  conf_status       text        NOT NULL DEFAULT 'new',
  agent_id          bigint,
  attempts          integer     NOT NULL DEFAULT 0,
  last_call_at      timestamptz,
  next_call_at      timestamptz,
  assigned_at       timestamptz,
  confirmed_at      timestamptz,
  locked_by         bigint,
  locked_until      timestamptz,
  -- delivery
  follow_status     text,
  sub_status        text,
  follow_agent_id   bigint,
  company_id        bigint REFERENCES delivery_companies(id),
  warehouse_id      bigint REFERENCES warehouses(id),
  livreur_id        bigint,
  tracking          text,
  ext_id            text,
  label_url         text,
  ext_status        text,
  ext_status_at     timestamptz,
  delivery_attempts integer     NOT NULL DEFAULT 0,
  -- money (whole dinars)
  subtotal          integer     NOT NULL DEFAULT 0,
  delivery_fee      integer     NOT NULL DEFAULT 0,
  discount          integer     NOT NULL DEFAULT 0,
  total             integer     NOT NULL DEFAULT 0,
  delivery_cost     integer     NOT NULL DEFAULT 0,
  cashed            boolean     NOT NULL DEFAULT false,
  cashed_at         timestamptz,
  handover_id       bigint,
  -- notes
  customer_note     text,
  delivery_note     text,
  internal_note     text,
  -- flags
  is_exchange       boolean     NOT NULL DEFAULT false,
  original_order_id bigint,
  has_upsell        boolean     NOT NULL DEFAULT false,
  -- milestones
  prepared_at       timestamptz,
  shipped_at        timestamptz,
  delivered_at      timestamptz,
  returned_at       timestamptz,
  version           integer     NOT NULL DEFAULT 1
);
CREATE INDEX orders_conf        ON orders (conf_status, created_at DESC);
CREATE INDEX orders_conf_agent  ON orders (agent_id, conf_status);
CREATE INDEX orders_next_call   ON orders (next_call_at) WHERE next_call_at IS NOT NULL;
CREATE INDEX orders_follow      ON orders (follow_status, updated_at DESC) WHERE follow_status IS NOT NULL;
CREATE INDEX orders_company     ON orders (company_id, follow_status);
CREATE INDEX orders_livreur     ON orders (livreur_id, follow_status) WHERE livreur_id IS NOT NULL;
CREATE INDEX orders_phone       ON orders (phone);
CREATE INDEX orders_customer    ON orders (customer_id, created_at DESC);
CREATE INDEX orders_tracking    ON orders (tracking) WHERE tracking IS NOT NULL;
CREATE INDEX orders_created     ON orders (created_at DESC);
CREATE INDEX orders_cash        ON orders (cashed, delivered_at) WHERE follow_status = 'delivered';
CREATE INDEX orders_wilaya      ON orders (wilaya_id);

CREATE TABLE order_items (
  id             bigserial PRIMARY KEY,
  order_id       bigint  NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id     bigint  NOT NULL REFERENCES products(id),
  variant_id     bigint  REFERENCES product_variants(id),
  name           text    NOT NULL,
  variant_title  text    NOT NULL DEFAULT '',
  qty            integer NOT NULL CHECK (qty > 0),
  unit_price     integer NOT NULL CHECK (unit_price >= 0),
  purchase_price integer NOT NULL DEFAULT 0,
  is_upsell      boolean NOT NULL DEFAULT false
);
CREATE INDEX order_items_order   ON order_items (order_id);
CREATE INDEX order_items_variant ON order_items (variant_id);

-- Every change, partitioned by month (the biggest table over time).
CREATE TABLE order_events (
  id         bigserial,
  order_id   bigint      NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  user_id    bigint,
  kind       text        NOT NULL,
  from_value text,
  to_value   text,
  note       text,
  data       jsonb,
  PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);
CREATE INDEX order_events_order ON order_events (order_id, at);
CREATE INDEX order_events_kind  ON order_events (kind, to_value, at DESC);
CREATE INDEX order_events_user  ON order_events (user_id, at DESC);

CREATE OR REPLACE FUNCTION ensure_events_partition(d date) RETURNS void AS $f$
DECLARE
  s date := date_trunc('month', d)::date;
  e date := (date_trunc('month', d) + interval '1 month')::date;
  p text := 'order_events_' || to_char(s, 'YYYY_MM');
BEGIN
  IF to_regclass(p) IS NULL THEN
    EXECUTE format('CREATE TABLE %I PARTITION OF order_events FOR VALUES FROM (%L) TO (%L)', p, s, e);
  END IF;
END $f$ LANGUAGE plpgsql;

DO $$ DECLARE i int; BEGIN
  FOR i IN -14..12 LOOP PERFORM ensure_events_partition((date_trunc('month', now()) + make_interval(months => i))::date); END LOOP;
END $$;

-- ------------------------------------------------------------------ after-sales (SAV)
CREATE SEQUENCE complaint_ref_seq START 1;
CREATE TABLE complaints (
  id                bigserial PRIMARY KEY,
  ref               text        NOT NULL UNIQUE,
  order_id          bigint REFERENCES orders(id),
  customer_name     text,
  phone             text,
  type              text        NOT NULL,
  wish              text        NOT NULL,
  details           text        NOT NULL DEFAULT '',
  status            text        NOT NULL DEFAULT 'open',
  assigned_to       bigint,
  exchange_order_id bigint,
  notes             jsonb       NOT NULL DEFAULT '[]',
  created_by        bigint,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX complaints_status ON complaints (status, created_at DESC);

-- Claims sent to couriers / livreurs (réclamations).
CREATE TABLE claims (
  id         bigserial PRIMARY KEY,
  order_id   bigint REFERENCES orders(id),
  company_id bigint,
  livreur_id bigint,
  reason     text        NOT NULL,
  message    text        NOT NULL,
  channel    text        NOT NULL DEFAULT 'whatsapp',
  status     text        NOT NULL DEFAULT 'waiting',
  created_by bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ livreurs: chat and cash
CREATE TABLE chat_messages (
  id         bigserial PRIMARY KEY,
  livreur_id bigint      NOT NULL,
  user_id    bigint      NOT NULL,
  order_id   bigint,
  body       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz
);
CREATE INDEX chat_messages_livreur ON chat_messages (livreur_id, created_at DESC);

-- Money handed over by a courier or a livreur (versements).
CREATE TABLE cash_handovers (
  id            bigserial PRIMARY KEY,
  company_id    bigint,
  livreur_id    bigint,
  orders        bigint[]    NOT NULL DEFAULT '{}',
  collected     integer     NOT NULL DEFAULT 0,   -- paid by customers
  fees          integer     NOT NULL DEFAULT 0,   -- courier fees / livreur share
  return_fees   integer     NOT NULL DEFAULT 0,
  net           integer     NOT NULL DEFAULT 0,
  note          text,
  created_by    bigint,
  created_at    timestamptz NOT NULL DEFAULT now(),
  cancelled_at  timestamptz
);

-- ------------------------------------------------------------------ sales channels and ads
CREATE TABLE sales_channels (
  id           bigserial PRIMARY KEY,
  kind         text        NOT NULL,
  name         text        NOT NULL,
  creator_id   bigint,
  sku_required boolean     NOT NULL DEFAULT false,
  active       boolean     NOT NULL DEFAULT true,
  config       jsonb       NOT NULL DEFAULT '{}',
  webhook_key  text        NOT NULL,
  last_sync_at timestamptz
);

CREATE TABLE adsets (
  id          text PRIMARY KEY,           -- Meta ad set id
  name        text        NOT NULL,
  campaign    text,
  product_ids bigint[]    NOT NULL DEFAULT '{}',
  marketer_id bigint,
  status      text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ad_insights (
  day         date    NOT NULL,
  adset_id    text    NOT NULL,
  spend_cents integer NOT NULL DEFAULT 0,  -- in the ad account currency (USD cents)
  impressions integer NOT NULL DEFAULT 0,
  clicks      integer NOT NULL DEFAULT 0,
  purchases   integer NOT NULL DEFAULT 0,
  video_3s    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, adset_id)
);

CREATE TABLE fx_rates (
  ym   text PRIMARY KEY,   -- 2026-10
  rate numeric(10,2) NOT NULL  -- DZD per USD
);

-- Offline actions already applied (a retry never runs twice).
CREATE TABLE applied_actions (
  client_id  text PRIMARY KEY,
  user_id    bigint      NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Fast search on names and phones when pg_trgm is available (server); plain indexes otherwise. A shop's schema sees it
-- through its search path (the extension lives in the "ext" schema on a multi-shop server).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_opclass WHERE opcname = 'gin_trgm_ops' AND pg_opclass_is_visible(oid)) THEN
    EXECUTE 'CREATE INDEX orders_name_trgm ON orders USING gin (customer_name gin_trgm_ops)';
    EXECUTE 'CREATE INDEX orders_phone_trgm ON orders USING gin (phone gin_trgm_ops)';
    EXECUTE 'CREATE INDEX customers_name_trgm ON customers USING gin (name gin_trgm_ops)';
    EXECUTE 'CREATE INDEX products_name_trgm ON products USING gin (name gin_trgm_ops)';
  END IF;
END $$;
`;
