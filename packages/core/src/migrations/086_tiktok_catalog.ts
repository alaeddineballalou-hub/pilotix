// Marketing › Catalogue on TikTok too: the same lists go to the shop's TikTok catalog (in its TikTok Business Center),
// each as a TikTok product set. The catalog's lines (one per colour / size, the last data sent and TikTok's answer) and
// the uploads waiting for TikTok's answer are kept apart from Meta's; a list keeps its TikTok set and when it was sent.
export default `
ALTER TABLE meta_catalog_lists ADD COLUMN IF NOT EXISTS tt_set_id text;
ALTER TABLE meta_catalog_lists ADD COLUMN IF NOT EXISTS tt_sent_at timestamptz;
CREATE TABLE IF NOT EXISTS tiktok_catalog_items (
  sku_id      text        PRIMARY KEY,
  product_id  bigint      NOT NULL,
  variant_id  bigint,
  hash        text,
  status      text        NOT NULL DEFAULT 'pending',
  error       text,
  sent_at     timestamptz,
  checked_at  timestamptz
);
CREATE INDEX IF NOT EXISTS tiktok_catalog_items_product ON tiktok_catalog_items (product_id);
CREATE TABLE IF NOT EXISTS tiktok_catalog_batches (
  id      bigserial   PRIMARY KEY,
  log_id  text        NOT NULL,
  ids     text[]      NOT NULL DEFAULT '{}',
  sent_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz
);
`;
