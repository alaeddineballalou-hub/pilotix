// Per-variant logistics overrides; NULL inherits the product-level value.
export default `
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS weight_kg numeric(10,3) CHECK (weight_kg >= 0 AND weight_kg <= 1000);
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS alert_qty integer CHECK (alert_qty >= 0);
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS fee_grid text;
`;
