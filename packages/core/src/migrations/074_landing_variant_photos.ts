// Landing pages made before: each photo of a variant (colour) remembers it (picking the colour on the page shows it),
// and the product's photos missing from the page are added once: its main photo first, each variant's photo after
// (up to the page's 12). Pages keep their own photos, in their order.
export default `
UPDATE landing_pages l SET images = x.imgs
FROM (
  SELECT l2.id, (
    SELECT COALESCE(jsonb_agg(CASE WHEN e ? 'url' AND (e->>'v') IS NULL AND vv.id IS NOT NULL THEN e || jsonb_build_object('v', vv.id) ELSE e END ORDER BY o), '[]'::jsonb)
    FROM jsonb_array_elements(l2.images) WITH ORDINALITY AS t(e, o)
    LEFT JOIN LATERAL (
      SELECT v.id FROM product_variants v
      WHERE v.product_id = l2.product_id AND v.active AND v.title <> '' AND v.photo = e->>'url' ORDER BY v.id LIMIT 1
    ) vv ON true
  ) AS imgs
  FROM landing_pages l2 WHERE jsonb_typeof(l2.images) = 'array'
) x
WHERE x.id = l.id AND x.imgs <> l.images;

UPDATE landing_pages l SET images = x.imgs
FROM (
  SELECT l2.id, (
    SELECT COALESCE(jsonb_agg(u.e ORDER BY u.k), '[]'::jsonb) FROM (
      SELECT s.e, s.k FROM (
        SELECT jsonb_build_object('url', p.photo, 'w', 960, 'h', 1200) AS e, 0::bigint AS k
          FROM products p
         WHERE p.id = l2.product_id AND p.photo ~ '^(https?:|data:image/)'
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(l2.images) a WHERE a->>'url' = p.photo)
        UNION ALL
        SELECT t.e, t.o AS k FROM jsonb_array_elements(l2.images) WITH ORDINALITY AS t(e, o)
        UNION ALL
        SELECT jsonb_build_object('url', v.photo, 'w', 960, 'h', 1200, 'v', v.id), 100000 + v.id
          FROM (SELECT DISTINCT ON (photo) id, photo FROM product_variants
                 WHERE product_id = l2.product_id AND active AND title <> '' AND photo ~ '^(https?:|data:image/)'
                 ORDER BY photo, id) v
         WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(l2.images) a WHERE a->>'url' = v.photo OR a->>'v' = v.id::text)
           AND v.photo IS DISTINCT FROM (SELECT photo FROM products WHERE id = l2.product_id)
      ) s ORDER BY s.k LIMIT 12
    ) u
  ) AS imgs
  FROM landing_pages l2 WHERE jsonb_typeof(l2.images) = 'array'
) x
WHERE x.id = l.id AND x.imgs <> l.images;
`;
