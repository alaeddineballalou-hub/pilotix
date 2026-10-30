// Optional per-variant pricing. NULL inherits the product's corresponding value.
export default `
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS cost integer CHECK (cost >= 0);
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS max_discount integer CHECK (max_discount >= 0);
`;
