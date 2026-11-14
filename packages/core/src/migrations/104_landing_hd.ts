// Landing pages follow their product's HD photos (Produits › Photos HD): the server makes light copies of each one for
// the pages (WebP, 160 / 480 / 720 / 960 px wide) the first time a page asks, and keeps them here. A photo removed:
// its copies go with it.
export default `
CREATE TABLE IF NOT EXISTS landing_hd (
  photo_id   bigint NOT NULL REFERENCES product_photos(id) ON DELETE CASCADE,
  width      smallint NOT NULL CHECK (width IN (160, 480, 720, 960)),
  webp       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (photo_id, width)
);
`;
