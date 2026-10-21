// Schema changes for the orders feature. Runs once, after 001.
export default `
CREATE INDEX IF NOT EXISTS orders_delivered_at ON orders (delivered_at) WHERE follow_status = 'delivered';
CREATE INDEX IF NOT EXISTS orders_returned_at ON orders (returned_at) WHERE returned_at IS NOT NULL;
`;
