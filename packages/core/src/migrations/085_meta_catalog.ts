// Marketing › Catalogue: the shop's own lists of products (« Promo de la semaine », « Bébé 0-6 mois »), each sent to its
// Meta catalog as a product set the seller picks for a catalog ad. The catalog holds one line per colour / size of the
// products that are in a list (the last data sent, to send only what changed, and Meta's answer); each picture Meta takes
// gets a JPEG copy, made by the browser (Meta takes no WebP).
export default `
CREATE TABLE IF NOT EXISTS meta_catalog_lists (
  id          bigserial   PRIMARY KEY,
  name        text        NOT NULL DEFAULT '',
  position    integer     NOT NULL DEFAULT 0,
  auto_update boolean     NOT NULL DEFAULT true,
  set_id      text,
  sent_at     timestamptz,
  changed_at  timestamptz,
  created_by  bigint,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS meta_catalog_list_products (
  list_id    bigint      NOT NULL REFERENCES meta_catalog_lists(id) ON DELETE CASCADE,
  product_id bigint      NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  position   integer     NOT NULL DEFAULT 0,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, product_id)
);
CREATE INDEX IF NOT EXISTS meta_catalog_list_products_product ON meta_catalog_list_products (product_id);
CREATE TABLE IF NOT EXISTS meta_catalog_items (
  retailer_id text        PRIMARY KEY,
  product_id  bigint      NOT NULL,
  variant_id  bigint,
  hash        text,
  status      text        NOT NULL DEFAULT 'pending',
  error       text,
  sent_at     timestamptz,
  checked_at  timestamptz
);
CREATE INDEX IF NOT EXISTS meta_catalog_items_product ON meta_catalog_items (product_id);
CREATE TABLE IF NOT EXISTS meta_catalog_batches (
  id      bigserial   PRIMARY KEY,
  handle  text        NOT NULL,
  ids     text[]      NOT NULL DEFAULT '{}',
  sent_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz
);
ALTER TABLE landing_images ADD COLUMN IF NOT EXISTS jpg text;
`;
