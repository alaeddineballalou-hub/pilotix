// Schema changes for the customers feature. Runs once, after 001.
export default `
CREATE INDEX IF NOT EXISTS customers_blacklisted ON customers (id) WHERE blacklisted;
CREATE INDEX IF NOT EXISTS customers_last_order ON customers (last_order_at DESC NULLS LAST);
`;
