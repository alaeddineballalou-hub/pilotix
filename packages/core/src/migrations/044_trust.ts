// Delivery side of the fraud protection (trust of a customer from their parcels):
// - customers.refusals: parcels refused since their last delivered one (a driver problem the claim proved is not counted, once)
// - customers.stopdesk_only: refused 2 parcels → only delivered at the desk (stop-desk) until they receive and pay one
// - customers.blacklist_auto: blacklisted by Pilotix itself (3 refusals, or a look-alike who refused): lifted after a paid delivery
// - orders.looks_like_customer_id: a new number that looks like a refuser (same device, or same name + commune)
export default `
ALTER TABLE customers ADD COLUMN IF NOT EXISTS refusals integer NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS stopdesk_only boolean NOT NULL DEFAULT false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS blacklist_auto boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS looks_like_customer_id bigint;
-- the views keep exactly the columns of orders
CREATE OR REPLACE VIEW sales AS SELECT * FROM orders WHERE NOT is_exchange;
CREATE OR REPLACE VIEW ticket_parcels AS SELECT * FROM orders WHERE is_exchange;
-- the parcels already refused since each customer's last delivered one (Pilotix decides stop-desk / blacklist on the next one)
UPDATE customers c SET refusals = x.n FROM (
  SELECT o.customer_id, count(*)::int AS n FROM orders o
  WHERE NOT o.is_exchange AND o.delivered_at IS NULL AND (o.follow_status IN ('returning','returned') OR o.returned_at IS NOT NULL)
    AND coalesce(o.returning_at, o.returned_at, o.updated_at) > coalesce((SELECT max(d.delivered_at) FROM orders d WHERE d.customer_id = o.customer_id), '-infinity'::timestamptz)
  GROUP BY o.customer_id) x
WHERE x.customer_id = c.id;
CREATE INDEX IF NOT EXISTS orders_customer_name ON orders (lower(customer_name), wilaya_id);
`;
