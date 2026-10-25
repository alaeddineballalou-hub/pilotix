// Landing pages, linked to the rest of Pilotix:
// - orders.landing_id: the page an order came from (its channel is 'landing'); sales/ticket_parcels re-created (013).
// - landing_leads: what a customer typed on a page (phone first) before ordering: with no order after a while, it is
//   added to Commandes as « Nouvelle » (an abandoned order the agents call).
// - meta_events: the Meta Conversions API outbox (Purchase only for real orders, InitiateCheckout for leads).
// - pages: their own Meta pixel (optional) and what to do with sold-out variants; submits keep what Meta needs later.
export default `
ALTER TABLE orders ADD COLUMN IF NOT EXISTS landing_id bigint;
CREATE INDEX IF NOT EXISTS orders_landing ON orders (landing_id, created_at DESC) WHERE landing_id IS NOT NULL;
UPDATE orders o SET landing_id = s.landing_id, channel = 'landing' FROM landing_submits s WHERE s.order_id = o.id AND o.landing_id IS NULL;
CREATE OR REPLACE VIEW sales AS SELECT * FROM orders WHERE NOT is_exchange;
CREATE OR REPLACE VIEW ticket_parcels AS SELECT * FROM orders WHERE is_exchange;

ALTER TABLE landing_pages ADD COLUMN IF NOT EXISTS pixel_id text NOT NULL DEFAULT '';
ALTER TABLE landing_pages ADD COLUMN IF NOT EXISTS stock_mode text NOT NULL DEFAULT 'off';   -- off | hide

ALTER TABLE landing_submits ADD COLUMN IF NOT EXISTS ua text;
ALTER TABLE landing_submits ADD COLUMN IF NOT EXISTS fbp text;
ALTER TABLE landing_submits ADD COLUMN IF NOT EXISTS fbc text;
ALTER TABLE landing_submits ADD COLUMN IF NOT EXISTS url text;
ALTER TABLE landing_submits ADD COLUMN IF NOT EXISTS utm jsonb;
CREATE INDEX IF NOT EXISTS landing_submits_order ON landing_submits (order_id) WHERE order_id IS NOT NULL;
ALTER TABLE landing_blocked ADD COLUMN IF NOT EXISTS utm jsonb;

CREATE TABLE IF NOT EXISTS landing_leads (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),   -- first time the phone was typed
  last_at       timestamptz NOT NULL DEFAULT now(),   -- last change on the form
  landing_id    bigint REFERENCES landing_pages(id) ON DELETE SET NULL,
  product_id    bigint,
  variant_id    bigint,
  qty           integer     NOT NULL DEFAULT 1,
  unit_price    integer     NOT NULL DEFAULT 0,
  customer_name text        NOT NULL DEFAULT '',
  phone         text        NOT NULL,
  wilaya_id     smallint,
  commune       text        NOT NULL DEFAULT '',
  device        text,
  ip            text,
  ua            text,
  fbp           text,
  fbc           text,
  url           text,
  utm           jsonb,
  view_id       text,                                 -- the page view (dedups InitiateCheckout with the browser pixel)
  status        text        NOT NULL DEFAULT 'open',  -- open | abandoned | converted | dismissed | blocked
  abandoned_at  timestamptz,                         -- became an abandoned order (a later order of it is « récupérée »)
  order_id      bigint,
  auto_order    boolean     NOT NULL DEFAULT false,   -- the order was added by Pilotix (abandoned → Commandes › Nouvelle)
  handled_by    bigint,
  handled_at    timestamptz
);
CREATE INDEX IF NOT EXISTS landing_leads_status ON landing_leads (status, last_at DESC);
CREATE INDEX IF NOT EXISTS landing_leads_phone ON landing_leads (phone, last_at DESC);

CREATE TABLE IF NOT EXISTS meta_events (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  send_after  timestamptz NOT NULL DEFAULT now(),
  pixel_id    text        NOT NULL,
  event_name  text        NOT NULL,                   -- Purchase | InitiateCheckout
  event_id    text        NOT NULL,                   -- the same id as the browser pixel's event: Meta counts it once
  order_id    bigint,
  lead_id     bigint,
  landing_id  bigint,
  status      text        NOT NULL DEFAULT 'queued',  -- queued | sending | sent | failed | skipped | simulated
  attempts    integer     NOT NULL DEFAULT 0,
  error       text,
  value       integer,
  sent_at     timestamptz,
  claimed_at  timestamptz,
  UNIQUE (pixel_id, event_name, event_id)
);
CREATE INDEX IF NOT EXISTS meta_events_queue ON meta_events (status, send_after);
CREATE INDEX IF NOT EXISTS meta_events_recent ON meta_events (at DESC);

`;
