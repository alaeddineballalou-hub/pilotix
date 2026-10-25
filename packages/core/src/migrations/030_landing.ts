// Landing pages: one public page per product (its own address, colour, pictures and text), the pictures in WebP
// (three widths, stored here so the server can send them with a long cache), every order sent from a page (for the
// rate limits), and the orders the fake-order check held back (« Commandes bloquées »).
export default `
CREATE TABLE IF NOT EXISTS landing_pages (
  id            bigserial PRIMARY KEY,
  product_id    bigint      NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  slug          text        NOT NULL UNIQUE,
  active        boolean     NOT NULL DEFAULT true,
  title         text        NOT NULL DEFAULT '',
  color         text        NOT NULL DEFAULT '#0f766e',
  price         integer,
  old_price     integer,
  description   text        NOT NULL DEFAULT '',
  variant_label text        NOT NULL DEFAULT 'اللون',
  images        jsonb       NOT NULL DEFAULT '[]',   -- [{ id } a stored picture | { url, w, h } a picture elsewhere]
  fraud_level   text        NOT NULL DEFAULT 'normal', -- relaxed, normal, strict
  views         integer     NOT NULL DEFAULT 0,
  created_by    bigint,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS landing_pages_product ON landing_pages (product_id);

CREATE TABLE IF NOT EXISTS landing_images (
  id         bigserial PRIMARY KEY,
  w          integer     NOT NULL,
  h          integer     NOT NULL,
  t160       text        NOT NULL,   -- base64 WebP, 160 px wide (thumbnails)
  w480       text        NOT NULL,   -- 480 px (phones)
  w960       text        NOT NULL,   -- 960 px (large screens)
  created_by bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS landing_submits (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  landing_id  bigint,
  product_id  bigint,
  phone       text,
  ip          text,
  fp          text,
  challenge   text,
  verdict     text        NOT NULL,   -- allow, review, block
  score       integer     NOT NULL DEFAULT 0,
  order_id    bigint,
  blocked_id  bigint
);
CREATE INDEX IF NOT EXISTS landing_submits_phone ON landing_submits (phone, at DESC);
CREATE INDEX IF NOT EXISTS landing_submits_ip ON landing_submits (ip, at DESC);
CREATE INDEX IF NOT EXISTS landing_submits_fp ON landing_submits (fp, at DESC);
CREATE INDEX IF NOT EXISTS landing_submits_challenge ON landing_submits (challenge);

CREATE TABLE IF NOT EXISTS landing_blocked (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  landing_id    bigint REFERENCES landing_pages(id) ON DELETE SET NULL,
  product_id    bigint,
  variant_id    bigint,
  qty           integer     NOT NULL DEFAULT 1,
  unit_price    integer     NOT NULL DEFAULT 0,
  customer_name text        NOT NULL DEFAULT '',
  phone         text        NOT NULL DEFAULT '',
  wilaya_id     smallint,
  commune       text        NOT NULL DEFAULT '',
  score         integer     NOT NULL DEFAULT 0,
  reasons       jsonb       NOT NULL DEFAULT '[]',
  ip            text,
  user_agent    text,
  fp            text,
  status        text        NOT NULL DEFAULT 'blocked',  -- blocked, restored, dismissed
  order_id      bigint,
  handled_by    bigint,
  handled_at    timestamptz
);
CREATE INDEX IF NOT EXISTS landing_blocked_status ON landing_blocked (status, at DESC);
`;
