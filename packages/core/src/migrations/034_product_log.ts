// Who changed a product's sale price, purchase price or maximum discount, when, from what to what. The purchase price
// changes the profit of every new order (and so the marketers' pay): its history must never be lost.
export default `
CREATE TABLE IF NOT EXISTS product_changes (
  id         bigserial   PRIMARY KEY,
  product_id bigint      NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id    bigint,
  field      text        NOT NULL,   -- price | cost | max_discount
  from_value integer,
  to_value   integer,
  why        text,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_changes_product ON product_changes (product_id, at DESC);
`;
