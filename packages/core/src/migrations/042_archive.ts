// Management › Archives: accounts, products and depots that are not needed any more leave the lists (archived_at) but
// stay in the history; only what is archived and was never used can be deleted for good. Depots get their creation
// date (the old ones: their first stock movement, else unknown).
export default `
ALTER TABLE profiles   ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE products   ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS created_at  timestamptz;
UPDATE warehouses w SET created_at = (SELECT min(m.created_at) FROM stock_movements m WHERE m.warehouse_id = w.id) WHERE created_at IS NULL;
ALTER TABLE warehouses ALTER COLUMN created_at SET DEFAULT now();
-- a product's last order (Archives sorts and filters by last activity)
CREATE INDEX IF NOT EXISTS order_items_product ON order_items (product_id);
-- one default depot (an old demo seed could leave two): the first one stays, as the orders already used it
UPDATE warehouses SET is_default = false WHERE is_default AND id <> (SELECT min(id) FROM warehouses WHERE is_default);
`;
