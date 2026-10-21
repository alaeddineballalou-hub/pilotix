// Schema changes for the admin feature. Runs once, after 001.
// Payslips read delivered / prepared orders by month: index the milestones they use.
export default `
CREATE INDEX IF NOT EXISTS orders_delivered_at ON orders (delivered_at) WHERE delivered_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_agent_delivered ON orders (agent_id, delivered_at) WHERE delivered_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_livreur_delivered ON orders (livreur_id, delivered_at) WHERE livreur_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sales_channels_kind ON sales_channels (kind);
`;
