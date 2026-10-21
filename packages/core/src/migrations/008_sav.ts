// Schema changes for the SAV feature: the wish can stay undecided, tickets remember when they were settled.
export default `
ALTER TABLE complaints ALTER COLUMN wish DROP NOT NULL;
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS resolved_at   timestamptz;
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS exchange_kind text;
CREATE INDEX IF NOT EXISTS complaints_order    ON complaints (order_id);
CREATE INDEX IF NOT EXISTS complaints_exchange ON complaints (exchange_order_id) WHERE exchange_order_id IS NOT NULL;
`;
