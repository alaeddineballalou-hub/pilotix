// Safety net found by the October 2026 audit:
// - action_locks: a short "in progress" mark so a double click / a retry / the 30-minute job running at the same
//   moment never sends a parcel, a claim, an exchange, a payment import or a caisse transfer twice;
// - orders.ext_order_id: the store's own order id ('site:1001', 'ch3:1001'), so a webhook sent again does not create a second order;
// - orders.returning_at: when the parcel started coming back (the « Retours » stats count on that day, not on the
//   last edit);
// - profiles.token_version: changing the password logs out every other session.
export default `
CREATE TABLE IF NOT EXISTS action_locks (
  key        text        PRIMARY KEY,
  user_id    bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ext_order_id text;
CREATE UNIQUE INDEX IF NOT EXISTS orders_ext_order ON orders (ext_order_id) WHERE ext_order_id IS NOT NULL;  -- '<store>:<its order n°>'
ALTER TABLE orders ADD COLUMN IF NOT EXISTS returning_at timestamptz;
UPDATE orders SET returning_at = COALESCE(returned_at, updated_at) WHERE returning_at IS NULL AND follow_status IN ('returning','returned');
CREATE OR REPLACE VIEW sales AS SELECT * FROM orders WHERE NOT is_exchange;
CREATE OR REPLACE VIEW ticket_parcels AS SELECT * FROM orders WHERE is_exchange;
-- what an SAV exchange brings back to the depot (the swapped lines only; nothing for parts)
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS exchange_back jsonb;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;
`;
