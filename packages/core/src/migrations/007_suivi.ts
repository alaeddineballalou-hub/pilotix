// Schema changes for the suivi feature: claims (réclamations) keep a history and know when they were sent.
export default `
ALTER TABLE claims ADD COLUMN IF NOT EXISTS details     text        NOT NULL DEFAULT '';
ALTER TABLE claims ADD COLUMN IF NOT EXISTS notes       jsonb       NOT NULL DEFAULT '[]';
ALTER TABLE claims ADD COLUMN IF NOT EXISTS sent_at     timestamptz;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS updated_at  timestamptz NOT NULL DEFAULT now();
ALTER TABLE claims ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
CREATE INDEX IF NOT EXISTS claims_order  ON claims (order_id);
CREATE INDEX IF NOT EXISTS claims_status ON claims (status, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_sub    ON orders (sub_status) WHERE sub_status IS NOT NULL;
`;
