// SAV tickets are their own business: their exchange parcels live in `orders` (so the depot, scanner, livreurs and couriers handle them
// like any parcel) but every order statistic, list and count reads `sales`, which leaves them out. `ticket_parcels` is the other half.
// Whenever a migration adds a column to orders, it must re-create both views (a test checks they match the table).
export default `
CREATE OR REPLACE VIEW sales AS SELECT * FROM orders WHERE NOT is_exchange;
CREATE OR REPLACE VIEW ticket_parcels AS SELECT * FROM orders WHERE is_exchange;
CREATE INDEX IF NOT EXISTS orders_exchange ON orders (is_exchange) WHERE is_exchange;
`;
