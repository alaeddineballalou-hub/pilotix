// Confirmation agencies working for this store (the links themselves live on the platform: platform.agency_links).
// - profiles.agency_id: an agent of an agency, working here (the agency manages the account; the store never edits it);
// - orders.conf_agency_id / follow_agency_id: the agency that confirms / follows this order (null: the store's own team),
//   chosen when the order arrives from its first product;
// - agency_routes: which agency gets which product for each task (product_id null: every product, also future ones;
//   a product named for another agency goes to that agency);
// - profiles.agency_products: the products such an agent works on here (null: all the agency's);
// - orders.route_product_id: the product the order went to agencies by (its first product when it arrived);
// - in an agency's own space, profiles.agency_sellers: the sellers (stores) a person works for and, for each, the
//   products (null: every seller, also new ones).
export default `
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS agency_id integer;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS agency_products bigint[];
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS agency_sellers jsonb;
CREATE INDEX IF NOT EXISTS profiles_agency ON profiles (agency_id) WHERE agency_id IS NOT NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS conf_agency_id integer;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS follow_agency_id integer;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS route_product_id bigint;
CREATE INDEX IF NOT EXISTS orders_conf_agency ON orders (conf_agency_id, created_at DESC) WHERE conf_agency_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_follow_agency ON orders (follow_agency_id, created_at DESC) WHERE follow_agency_id IS NOT NULL;
CREATE OR REPLACE VIEW sales AS SELECT * FROM orders WHERE NOT is_exchange;
CREATE OR REPLACE VIEW ticket_parcels AS SELECT * FROM orders WHERE is_exchange;
CREATE TABLE IF NOT EXISTS agency_routes (
  agency_id  integer NOT NULL,
  task       text    NOT NULL CHECK (task IN ('confirmation', 'suivi')),
  product_id bigint
);
CREATE UNIQUE INDEX IF NOT EXISTS agency_routes_one ON agency_routes (task, COALESCE(product_id, 0));
CREATE INDEX IF NOT EXISTS agency_routes_agency ON agency_routes (agency_id);
`;
