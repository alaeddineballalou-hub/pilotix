// Dépôt on phones: products are picked first (how many were taken), whole order lines are served oldest order first;
// an order is ready to pack once every one of its products has been taken. What was missing is kept on a list
// "À ramener au dépôt" until it comes back. Units taken but not yet given to an order wait in a small pool.
export default `
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS picked_qty integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS depot_pick_pool (
  product_id bigint  NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id bigint  REFERENCES product_variants(id) ON DELETE CASCADE,
  qty        integer NOT NULL DEFAULT 0 CHECK (qty >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS depot_pick_pool_key ON depot_pick_pool (product_id, COALESCE(variant_id, 0));

CREATE TABLE IF NOT EXISTS depot_restock (
  product_id bigint  NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id bigint  REFERENCES product_variants(id) ON DELETE CASCADE,
  qty        integer NOT NULL CHECK (qty > 0),
  updated_by bigint,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS depot_restock_key ON depot_restock (product_id, COALESCE(variant_id, 0));
`;
