// Lots et dates d'expiration (Management › Stock, off by default): a product can be ticked « a des lots »; its purchases
// then say each lot and its expiry date, and the stock leaving takes the lot that expires first (FEFO). A lot's qty is
// what is left of it; what a depot holds outside any lot (before the switch, a return, a transfer) has no lot.
export default `
ALTER TABLE products ADD COLUMN IF NOT EXISTS has_batches boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS stock_batches (
  id bigserial PRIMARY KEY,
  variant_id bigint NOT NULL REFERENCES product_variants(id),
  warehouse_id bigint NOT NULL REFERENCES warehouses(id),
  lot text NOT NULL DEFAULT '',
  expires_on date,
  qty integer NOT NULL CHECK (qty >= 0),
  received integer NOT NULL DEFAULT 0,
  purchase_id bigint REFERENCES purchases(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_batches_vw ON stock_batches (variant_id, warehouse_id) WHERE qty > 0;
CREATE INDEX IF NOT EXISTS stock_batches_exp ON stock_batches (expires_on) WHERE qty > 0;
`;
