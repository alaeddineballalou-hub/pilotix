// Marketing › Catalogue › Résultats: what the catalog ads bring, and the low-stock guard. A catalog ad's link carries
// ?px_cat=meta|tiktok: its visits are counted by day, product and network (its orders keep it in their utm); a product
// may have its own « stock bas » level (none: the shop's), and each line sent to Meta / TikTok remembers whether it went
// as in stock, so a colour / size that runs low leaves the ads by itself (and comes back with the stock).
export default `
CREATE TABLE IF NOT EXISTS catalog_visits (
  day        date    NOT NULL,
  product_id bigint  NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  net        text    NOT NULL,
  n          integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, product_id, net)
);
CREATE TABLE IF NOT EXISTS catalog_guard (
  product_id bigint  PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  min_left   integer NOT NULL
);
ALTER TABLE meta_catalog_items ADD COLUMN IF NOT EXISTS in_stock boolean;
ALTER TABLE tiktok_catalog_items ADD COLUMN IF NOT EXISTS in_stock boolean;
CREATE INDEX IF NOT EXISTS orders_px_cat ON orders ((utm->>'px_cat')) WHERE utm->>'px_cat' IS NOT NULL;
`;
