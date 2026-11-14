// Montage: one « Montage » service for the whole shop instead of one hidden service product per product. A product
// says whether it can be mounted, at what price and cost, and in which wilayas (null: the shop's list, Réglages ›
// Montage; an empty shop list: every wilaya). An order's montage line points at the shared service and keeps the
// product it mounts (for_product_id).
//
// The montage services made the old way (one per product, named « Montage… ») move onto their product: its montage
// price and cost; the old service products are switched off and leave the product's linked list (old orders keep
// their lines, which still point at them).
// Every step is safe on odd rows (services not a list, a price or id that is not a number): it must never stop the
// server. Each product reads only its own services; the old service products are matched in the same shop.
export default `
ALTER TABLE products ADD COLUMN IF NOT EXISTS montage jsonb;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS for_product_id bigint;

CREATE OR REPLACE FUNCTION pg_temp.px_montage_old(sv jsonb) RETURNS SETOF jsonb LANGUAGE sql IMMUTABLE AS $f$
  SELECT s FROM jsonb_array_elements(CASE WHEN jsonb_typeof(sv) = 'array' THEN sv ELSE '[]'::jsonb END) s
   WHERE jsonb_typeof(s) = 'object' AND lower(trim(coalesce(s->>'name', ''))) LIKE 'montage%'
$f$;
CREATE OR REPLACE FUNCTION pg_temp.px_int(v text) RETURNS int LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN v ~ '^[0-9]{1,9}(\\.[0-9]+)?$' THEN round(v::numeric)::int ELSE 0 END
$f$;
CREATE OR REPLACE FUNCTION pg_temp.px_id(v text) RETURNS bigint LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN v ~ '^[0-9]{1,18}$' THEN v::bigint END
$f$;

UPDATE products p SET montage = (
    SELECT jsonb_build_object('price', pg_temp.px_int(s->>'price'), 'cost', pg_temp.px_int(s->>'cost'), 'wilayas', NULL)
      FROM pg_temp.px_montage_old(p.services) s LIMIT 1)
 WHERE p.montage IS NULL AND EXISTS (SELECT 1 FROM pg_temp.px_montage_old(p.services));

DO $px$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'shop_id' AND table_schema = current_schema()) THEN
    EXECUTE $q$UPDATE products sp SET active = false FROM products p, pg_temp.px_montage_old(p.services) s
               WHERE sp.is_service AND sp.shop_id = p.shop_id AND sp.id = pg_temp.px_id(s->>'id')$q$;
  ELSE
    UPDATE products sp SET active = false FROM products p, pg_temp.px_montage_old(p.services) s
     WHERE sp.is_service AND sp.id = pg_temp.px_id(s->>'id');
  END IF;
END $px$;

UPDATE products p SET
  linked = coalesce(ARRAY(SELECT l FROM unnest(coalesce(p.linked, '{}')) l
                           WHERE l NOT IN (SELECT coalesce(pg_temp.px_id(s->>'id'), -1) FROM pg_temp.px_montage_old(p.services) s)), '{}'),
  services = coalesce((SELECT jsonb_agg(s) FROM jsonb_array_elements(p.services) s
                        WHERE NOT (jsonb_typeof(s) = 'object' AND lower(trim(coalesce(s->>'name', ''))) LIKE 'montage%')), '[]'::jsonb)
 WHERE jsonb_typeof(p.services) = 'array' AND EXISTS (SELECT 1 FROM pg_temp.px_montage_old(p.services));
`;
