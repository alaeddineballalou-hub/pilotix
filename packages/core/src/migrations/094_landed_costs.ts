// Achats: the costs around a purchase (transport, customs…) spread on its products, so their purchase price is what they
// really cost. The purchase keeps the costs, how they were spread, and each line its share and its landed unit cost.
export default `
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS extras jsonb NOT NULL DEFAULT '[]';
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS extra_total integer NOT NULL DEFAULT 0;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS spread text;
ALTER TABLE purchase_lines ADD COLUMN IF NOT EXISTS extra_share integer NOT NULL DEFAULT 0;
ALTER TABLE purchase_lines ADD COLUMN IF NOT EXISTS landed_cost integer;
`;
