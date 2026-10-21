-- Pilotix — initial schema (PostgreSQL 15+)
-- Money is stored as whole dinars (integer). Times are timestamptz (UTC).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ------------------------------------------------------------------ users and roles
CREATE TABLE users (
  id            bigserial PRIMARY KEY,
  name          text        NOT NULL,
  email         text        NOT NULL UNIQUE,
  password_hash text        NOT NULL,
  roles         text[]      NOT NULL DEFAULT '{agent}',
  language      text        NOT NULL DEFAULT 'fr' CHECK (language IN ('fr', 'en', 'ar')),
  active        boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz
);

-- ------------------------------------------------------------------ products and stock
CREATE TABLE products (
  id         bigserial PRIMARY KEY,
  name       text        NOT NULL,
  sku        text        NOT NULL UNIQUE,
  price      integer     NOT NULL CHECK (price >= 0),
  cost       integer     NOT NULL DEFAULT 0 CHECK (cost >= 0),
  variants   text[]      NOT NULL DEFAULT '{}',
  stock      integer     NOT NULL DEFAULT 0,
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_name_trgm ON products USING gin (name gin_trgm_ops);

CREATE TABLE stock_movements (
  id         bigserial PRIMARY KEY,
  product_id bigint      NOT NULL REFERENCES products(id),
  variant    text,
  delta      integer     NOT NULL,
  reason     text        NOT NULL,
  order_id   bigint,
  user_id    bigint      REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_product ON stock_movements (product_id, created_at DESC);

-- ------------------------------------------------------------------ customers
CREATE TABLE customers (
  id         bigserial PRIMARY KEY,
  phone      text        NOT NULL UNIQUE,      -- normalized 0XXXXXXXXX
  name       text        NOT NULL,
  blocked    boolean     NOT NULL DEFAULT false,
  orders     integer     NOT NULL DEFAULT 0,
  delivered  integer     NOT NULL DEFAULT 0,
  returned   integer     NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customers_phone_trgm ON customers USING gin (phone gin_trgm_ops);
CREATE INDEX customers_name_trgm  ON customers USING gin (name gin_trgm_ops);

-- ------------------------------------------------------------------ orders (partitioned by month)
CREATE TABLE orders (
  id            bigserial,
  reference     text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  status        text        NOT NULL DEFAULT 'new',
  customer_id   bigint      NOT NULL REFERENCES customers(id),
  customer_name text        NOT NULL,
  phone         text        NOT NULL,
  wilaya        smallint    NOT NULL CHECK (wilaya BETWEEN 1 AND 69),
  commune       text        NOT NULL DEFAULT '',
  address       text        NOT NULL DEFAULT '',
  items         jsonb       NOT NULL DEFAULT '[]',
  delivery_fee  integer     NOT NULL DEFAULT 0,
  discount      integer     NOT NULL DEFAULT 0,
  total         integer     NOT NULL DEFAULT 0,
  note          text,
  agent_id      bigint,
  livreur_id    bigint,
  callback_at   timestamptz,
  tracking      text,
  attempts      integer     NOT NULL DEFAULT 0,
  version       integer     NOT NULL DEFAULT 1,      -- optimistic locking for offline edits
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX orders_status_created ON orders (status, created_at DESC);
CREATE INDEX orders_agent_status   ON orders (agent_id, status);
CREATE INDEX orders_livreur_status ON orders (livreur_id, status);
CREATE INDEX orders_phone          ON orders (phone);
CREATE INDEX orders_callback       ON orders (callback_at) WHERE callback_at IS NOT NULL;
CREATE INDEX orders_reference      ON orders (reference);
CREATE INDEX orders_tracking       ON orders (tracking) WHERE tracking IS NOT NULL;
CREATE INDEX orders_name_trgm      ON orders USING gin (customer_name gin_trgm_ops);

-- Creates the monthly partition that holds a given date (idempotent).
CREATE OR REPLACE FUNCTION ensure_orders_partition(d date) RETURNS void AS $$
DECLARE
  start_d date := date_trunc('month', d)::date;
  end_d   date := (date_trunc('month', d) + interval '1 month')::date;
  part    text := 'orders_' || to_char(start_d, 'YYYY_MM');
BEGIN
  IF to_regclass(part) IS NULL THEN
    EXECUTE format('CREATE TABLE %I PARTITION OF orders FOR VALUES FROM (%L) TO (%L)', part, start_d, end_d);
  END IF;
END $$ LANGUAGE plpgsql;

-- Partitions from 12 months ago to 12 months ahead; a daily job keeps adding future ones.
DO $$
DECLARE i int;
BEGIN
  FOR i IN -12..12 LOOP
    PERFORM ensure_orders_partition((date_trunc('month', now()) + make_interval(months => i))::date);
  END LOOP;
END $$;

-- Every status change and edit, for "who changed what".
CREATE TABLE order_events (
  id         bigserial PRIMARY KEY,
  order_id   bigint      NOT NULL,
  user_id    bigint      REFERENCES users(id),
  type       text        NOT NULL,           -- status, edit, call, note, assign
  from_value text,
  to_value   text,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order ON order_events (order_id, created_at);
CREATE INDEX order_events_user  ON order_events (user_id, created_at DESC);

-- Offline actions already applied (so a retried action never runs twice).
CREATE TABLE applied_actions (
  client_id  text        PRIMARY KEY,
  user_id    bigint      NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE order_reference_seq START 1000;
