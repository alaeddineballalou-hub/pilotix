// Montage: one « Montage » service for the whole shop instead of one hidden service product per product. A product
// says whether it can be mounted, at what price and cost, and in which wilayas (null: the shop's list, Réglages ›
// Montage; an empty shop list: every wilaya). An order's montage line points at the shared service and keeps the
// product it mounts (for_product_id).
//
// The montage services made the old way (one per product, named « Montage… ») move onto their product: its montage
// price and cost; the old service products are switched off and leave the product's linked list (old orders keep
// their lines, which still point at them).
export default `
ALTER TABLE products ADD COLUMN IF NOT EXISTS montage jsonb;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS for_product_id bigint;

UPDATE products p SET montage = jsonb_build_object('price', coalesce((x.s->>'price')::int, 0), 'cost', coalesce((x.s->>'cost')::int, 0), 'wilayas', NULL)
  FROM (SELECT DISTINCT ON (q.id) q.id, s FROM products q, jsonb_array_elements(q.services) s
         WHERE lower(trim(s->>'name')) LIKE 'montage%' ORDER BY q.id) x
 WHERE x.id = p.id AND p.montage IS NULL;

UPDATE products SET active = false
 WHERE is_service AND id IN (SELECT (s->>'id')::bigint FROM products q, jsonb_array_elements(q.services) s
                              WHERE lower(trim(s->>'name')) LIKE 'montage%' AND (s->>'id') ~ '^[0-9]+$');

UPDATE products p SET
  linked = coalesce(ARRAY(SELECT l FROM unnest(p.linked) l
                           WHERE l NOT IN (SELECT (s->>'id')::bigint FROM jsonb_array_elements(p.services) s
                                            WHERE lower(trim(s->>'name')) LIKE 'montage%' AND (s->>'id') ~ '^[0-9]+$')), '{}'),
  services = coalesce((SELECT jsonb_agg(s) FROM jsonb_array_elements(p.services) s WHERE lower(trim(s->>'name')) NOT LIKE 'montage%'), '[]'::jsonb)
 WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(p.services) s WHERE lower(trim(s->>'name')) LIKE 'montage%');
`;
