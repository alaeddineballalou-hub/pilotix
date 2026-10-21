// Schema changes for the catalog feature. Runs once, after 001.
// The depot scanner looks orders up by reference or tracking number whatever the case.
export default `
CREATE INDEX IF NOT EXISTS orders_ref_upper ON orders (upper(ref));
CREATE INDEX IF NOT EXISTS orders_tracking_upper ON orders (upper(tracking)) WHERE tracking IS NOT NULL;
CREATE INDEX IF NOT EXISTS stock_movements_note ON stock_movements (note) WHERE note IS NOT NULL;
`;
