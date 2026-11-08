// Fabrication (Management › Stock, off by default): a product's recipe (the parts one piece uses, e.g. 1 bottle +
// 1 box) and each making: « Fabriquer 20 » takes the parts out of the depot and puts 20 finished pieces in, at the cost
// of their parts.
export default `
CREATE TABLE IF NOT EXISTS product_recipes (
  product_id bigint NOT NULL REFERENCES products(id),
  part_variant_id bigint NOT NULL REFERENCES product_variants(id),
  qty integer NOT NULL CHECK (qty > 0 AND qty <= 10000),
  PRIMARY KEY (product_id, part_variant_id)
);
CREATE TABLE IF NOT EXISTS productions (
  id bigserial PRIMARY KEY,
  ref text NOT NULL,
  variant_id bigint NOT NULL REFERENCES product_variants(id),
  warehouse_id bigint NOT NULL REFERENCES warehouses(id),
  qty integer NOT NULL CHECK (qty > 0),
  unit_cost integer NOT NULL DEFAULT 0,
  parts jsonb NOT NULL DEFAULT '[]',
  note text NOT NULL DEFAULT '',
  created_by bigint REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
`;
