export default `
ALTER TABLE agency_routes DROP CONSTRAINT IF EXISTS agency_routes_task_check;
ALTER TABLE agency_routes ADD CONSTRAINT agency_routes_task_check CHECK (task IN ('confirmation', 'suivi', 'sav'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sav_agency_override integer;
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS sav_agency_id integer;
CREATE OR REPLACE VIEW sales WITH (security_invoker = on) AS SELECT * FROM orders WHERE NOT is_exchange;
CREATE OR REPLACE VIEW ticket_parcels WITH (security_invoker = on) AS SELECT * FROM orders WHERE is_exchange;
CREATE INDEX IF NOT EXISTS complaints_sav_agency ON complaints (sav_agency_id, created_at DESC) WHERE sav_agency_id IS NOT NULL;
`;
