// Contrôle (the owner's ask, 25 Nov 2026): the depot, Pilotix and each delivery company kept in agreement.
// - orders.ext_meaning: what the sync made of the company's last words (a delivery status, '' known but changes nothing,
//   '?' unknown), kept with the words it was read for (ext_meaning_of): an older reading of other words is not trusted
// - leak_cases: each disagreement found (one key per disagreement), open until they agree again (closed by itself), or
//   set aside by a person (« C'est vu ») while it lasts
// - courier_health: how each company answered the syncs (since when it fails)
// No foreign key to the older tables: on a shared database they are already keyed by (shop_id, id), and a case whose
// order, payment or company is gone closes at the next check anyway.
export default `
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ext_meaning text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ext_meaning_of text;
-- the two views keep exactly the columns of orders
CREATE OR REPLACE VIEW sales AS SELECT * FROM orders WHERE NOT is_exchange;
CREATE OR REPLACE VIEW ticket_parcels AS SELECT * FROM orders WHERE is_exchange;
CREATE TABLE IF NOT EXISTS leak_cases (
  id           bigserial   PRIMARY KEY,
  key          text        NOT NULL,
  kind         text        NOT NULL,
  area         text        NOT NULL,
  company_id   bigint,
  order_id     bigint,
  payment_id   bigint,
  amount       bigint      NOT NULL DEFAULT 0,
  details      jsonb       NOT NULL DEFAULT '{}',
  since        timestamptz,
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  notified_at  timestamptz,
  action       text,
  dismissed_at timestamptz,
  dismissed_by text,
  closed_at    timestamptz,
  closed_by    text
);
CREATE UNIQUE INDEX IF NOT EXISTS leak_cases_live ON leak_cases (key) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS leak_cases_open ON leak_cases (company_id, area) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS leak_cases_order ON leak_cases (order_id);
CREATE INDEX IF NOT EXISTS leak_cases_closed ON leak_cases (closed_at DESC) WHERE closed_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS courier_health (
  company_id  bigint      PRIMARY KEY,
  ok_at       timestamptz,
  error       text,
  error_since timestamptz,
  checked_at  timestamptz NOT NULL DEFAULT now()
);
`;
