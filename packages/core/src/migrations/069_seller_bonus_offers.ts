// Seller-created bonus requests, agency decisions and traceable agent offers.
export default `
ALTER TABLE management_bonus_rules
  ADD COLUMN IF NOT EXISTS source_link_id bigint,
  ADD COLUMN IF NOT EXISTS source_bonus_id bigint REFERENCES management_bonus_rules(id) ON DELETE RESTRICT;
ALTER TABLE management_bonus_assignments DROP CONSTRAINT IF EXISTS management_bonus_assignments_status_check;
ALTER TABLE management_bonus_assignments ADD CONSTRAINT management_bonus_assignments_status_check
  CHECK (status IN ('pending','accepted','rejected'));
CREATE INDEX IF NOT EXISTS management_bonus_rules_seller_source
  ON management_bonus_rules(source_link_id) WHERE source_link_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS management_bonus_offers (
  seller_bonus_id bigint NOT NULL REFERENCES management_bonus_rules(id) ON DELETE RESTRICT,
  agent_id bigint NOT NULL REFERENCES profiles(id),
  agent_bonus_id bigint NOT NULL UNIQUE REFERENCES management_bonus_rules(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(seller_bonus_id,agent_id)
);
`;
