// The pictures of a sales guide's answers (Guide de vente › a question or a hesitation › its images): Dellal sends them
// to the customer when it gives that answer, and the agents see them when they read the guide. They are kept like the
// product's HD photos (product_photos: the file in Pilotix's bucket, a small copy here), under their own kind, never
// among the product's photos; the answer names them in the guide (photos: their ids).
export default `
ALTER TABLE product_photos DROP CONSTRAINT IF EXISTS product_photos_kind_check;
ALTER TABLE product_photos ADD CONSTRAINT product_photos_kind_check CHECK (kind IN ('photo', 'sizes', 'guide'));
`;
