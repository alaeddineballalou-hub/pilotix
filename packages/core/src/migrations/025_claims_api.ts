// Réclamations created at the courier through its API (ZR Express): the courier's claim id and number, its last state
// and the last refusal, so a claim can be sent again or followed from Pilotix.
export default `
ALTER TABLE claims ADD COLUMN IF NOT EXISTS ext_id        text;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS ext_ref       text;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS ext_status    text;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS ext_error     text;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS ext_answer    text;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS ext_synced_at timestamptz;
CREATE INDEX IF NOT EXISTS claims_ext ON claims (company_id) WHERE ext_id IS NOT NULL AND status <> 'resolved';
`;
