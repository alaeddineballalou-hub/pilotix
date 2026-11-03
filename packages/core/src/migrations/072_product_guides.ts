// The sales guide of a product (Produits & stock › a product › Guide de vente, modules/guide.ts): what the agents read during
// a call and what Dellal and CM AI answer with. One row per product that has one; it goes with the product.
export default `
CREATE TABLE IF NOT EXISTS product_guides (
  product_id bigint      PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  guide      jsonb       NOT NULL DEFAULT '{}',
  updated_by bigint,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;
