// Schema changes for the stats feature: indexes for the period counters (Accueil, Dashboard). Runs once, after 001.
export default `
CREATE INDEX IF NOT EXISTS orders_confirmed_at ON orders (confirmed_at) WHERE confirmed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_shipped_at   ON orders (shipped_at)   WHERE shipped_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_delivered_at ON orders (delivered_at) WHERE delivered_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_returned_at  ON orders (returned_at)  WHERE returned_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_events_kind_user ON order_events (kind, user_id, at);
CREATE INDEX IF NOT EXISTS complaints_assigned ON complaints (assigned_to, status);
`;
