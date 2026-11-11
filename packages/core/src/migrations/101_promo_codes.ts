// Referral › Code promo: welcome codes for the people who come from an « Awareness 🎁 » post or ad (a comment under a
// marked Facebook / Instagram post, or a Messenger / Instagram chat started from a marked ad). One code per account,
// ever; sent by a fixed rule before Dellal (never by the AI); used once, on one order (landing page, Dellal, by phone).
// Settings live in `settings` (key 'promo').
export default `
CREATE TABLE IF NOT EXISTS promo_codes (
  id              bigserial PRIMARY KEY,
  code            text        NOT NULL,                -- BJ-7K3P
  channel         text        NOT NULL,                -- messenger | instagram
  external_id     text        NOT NULL,                -- the person's PSID / IGSID (or, before their first message, the commenter's id)
  author_id       text,                                -- the commenter's id when the code came from a comment
  name            text,
  conversation_id bigint,
  source_kind     text        NOT NULL,                -- post | ad | ref
  source_id       text        NOT NULL,                -- the post / ad id (or the m.me ?ref= value)
  source_label    text,
  status          text        NOT NULL DEFAULT 'sent', -- waiting_follow | sent | used
  order_id        bigint,
  pct             integer,                             -- the discount when it was sent: a %…
  amount          integer,                             -- …or an amount in DA
  min_order       integer     NOT NULL DEFAULT 0,      -- the products' total needed (before the discount)
  discount        integer,                             -- what it took off its order
  sends           integer     NOT NULL DEFAULT 0,      -- how many times it was sent (asked again: the same code)
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  expires_at      timestamptz,
  used_at         timestamptz,
  UNIQUE (code),
  UNIQUE (channel, external_id)
);
CREATE INDEX IF NOT EXISTS promo_codes_conv ON promo_codes (conversation_id);
CREATE INDEX IF NOT EXISTS promo_codes_author ON promo_codes (channel, author_id);
CREATE INDEX IF NOT EXISTS promo_codes_sent ON promo_codes (sent_at DESC);

-- the ads (and m.me ?ref= links) the seller marked « Awareness 🎁 »: a chat started from one gets the code
CREATE TABLE IF NOT EXISTS promo_marks (
  kind       text        NOT NULL,                     -- ad | ref
  ref_id     text        NOT NULL,
  label      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, ref_id)
);

-- a post marked « Awareness 🎁 » (Pilot Comments › Publications)
ALTER TABLE cm_posts ADD COLUMN IF NOT EXISTS awareness boolean NOT NULL DEFAULT false;

-- the code an order used, what it took off, and the « Awareness » tag
ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_code text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_discount integer NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS awareness boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS orders_awareness ON orders (created_at DESC) WHERE awareness;
-- the two views keep exactly the columns of orders
CREATE OR REPLACE VIEW sales AS SELECT * FROM orders WHERE NOT is_exchange;
CREATE OR REPLACE VIEW ticket_parcels AS SELECT * FROM orders WHERE is_exchange;
`;
