// Every order gets its own unique Pilotix tracking number the moment it is created (any way: form, site, webhook, import,
// duplicate, SAV exchange). The database makes it, so no path can skip it. `tracking` stays the delivery company's number
// (empty until the parcel is sent to a company); screens show `tracking` when there is one, else `own_tracking`.
// The number is the creation counter shuffled (×48271 mod 10⁸, a one-to-one mix), so it is unique without being sequential.
export default `
CREATE SEQUENCE IF NOT EXISTS order_track_seq;
CREATE OR REPLACE FUNCTION px_next_tracking() RETURNS text LANGUAGE sql AS $$
  SELECT 'PXT' || lpad(((nextval('order_track_seq') * 48271) % 100000000)::text, 8, '0')
$$;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS own_tracking text;
UPDATE orders SET own_tracking = px_next_tracking() WHERE own_tracking IS NULL;
ALTER TABLE orders ALTER COLUMN own_tracking SET DEFAULT px_next_tracking();
ALTER TABLE orders ALTER COLUMN own_tracking SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS orders_own_tracking ON orders (upper(own_tracking));
CREATE OR REPLACE VIEW sales AS SELECT * FROM orders WHERE NOT is_exchange;
CREATE OR REPLACE VIEW ticket_parcels AS SELECT * FROM orders WHERE is_exchange;
`;
