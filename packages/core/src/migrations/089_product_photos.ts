// HD product photos for Dellal: one or more for each colour or size (variant), or for the whole product, and the size
// chart (kind 'sizes'). The photo itself is in Pilotix's Cloudflare R2 bucket (key); the shop keeps its small copy
// (thumb, 320 px) for the screens and for the AI. In the browser preview (no server) the photo stays here (data).
// A photo removed, or its product deleted: its file's name waits in product_photo_trash until the server removes it
// from the bucket.
export default `
CREATE TABLE IF NOT EXISTS product_photos (
  id         bigserial PRIMARY KEY,
  product_id bigint NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id bigint REFERENCES product_variants(id) ON DELETE SET NULL,
  kind       text NOT NULL DEFAULT 'photo' CHECK (kind IN ('photo', 'sizes')),
  store      text NOT NULL CHECK (store IN ('r2', 'local')),
  key        text,
  data       text,
  w          integer NOT NULL DEFAULT 0,
  h          integer NOT NULL DEFAULT 0,
  bytes      integer NOT NULL DEFAULT 0,
  thumb      text NOT NULL,
  position   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_photos_product ON product_photos (product_id, position, id);

CREATE TABLE IF NOT EXISTS product_photo_trash (
  key text PRIMARY KEY,
  at  timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION product_photo_gone() RETURNS trigger AS $f$
BEGIN
  IF OLD.store = 'r2' AND OLD.key IS NOT NULL THEN
    EXECUTE format('INSERT INTO %I.product_photo_trash (key) VALUES ($1) ON CONFLICT DO NOTHING', TG_TABLE_SCHEMA) USING OLD.key;
  END IF;
  RETURN OLD;
END $f$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS product_photos_gone ON product_photos;
CREATE TRIGGER product_photos_gone AFTER DELETE ON product_photos FOR EACH ROW EXECUTE FUNCTION product_photo_gone();
`;
