// Marketing › Stratégies: what kind of product it is for the ads — 1 the shop's own (nobody else sells it), 2 like a
// competitor's (similar, not the same), 3 exactly a competitor's. Null: not chosen yet.
export default `
ALTER TABLE products ADD COLUMN IF NOT EXISTS product_type smallint CHECK (product_type IS NULL OR product_type IN (1, 2, 3));
`;
