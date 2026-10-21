// Delivery: a phone for companies (réclamations), and where each own livreur ends his round
// ("Fin de tournée": sorts his route sheet, farthest first, coming back there).
export default `
ALTER TABLE delivery_companies ADD COLUMN IF NOT EXISTS phone text;
CREATE TABLE IF NOT EXISTS livreur_routes (
  profile_id    bigint PRIMARY KEY,
  end_wilaya_id smallint,
  end_commune   text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_company_tracking ON orders (company_id, follow_status) WHERE tracking IS NOT NULL;
`;
