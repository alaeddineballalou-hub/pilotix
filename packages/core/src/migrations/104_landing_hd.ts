// Landing pages follow their product's HD photos (Produits › Photos HD): the server makes light copies of each one for
// the pages (WebP, 160 / 480 / 720 / 960 px wide) the first time a page asks, and keeps them here. A photo removed:
// its copies go with it (cleaned by the code: on some live databases product_photos.id has no unique key, so no
// foreign key here — it stopped the server on 14 Nov 2026).
export default `
CREATE TABLE IF NOT EXISTS landing_hd (
  photo_id   bigint NOT NULL,
  width      smallint NOT NULL CHECK (width IN (160, 480, 720, 960)),
  webp       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (photo_id, width)
);
`;
