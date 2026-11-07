// Names that change keep working.
//  - landing_old_slugs: a landing page's or a group page's former addresses. The ads and links already out keep opening
//    it, and an order sent from a page opened before the change still arrives. A former address belongs to its page
//    (another page or group cannot take it); it goes away with the page.
//  - old_names / old_skus / old_titles: a product's former names and codes, a size's former names and codes. A Google
//    Sheet, the website (API), a Meta lead form or an Excel import that still writes them finds the same product and
//    size.
export default `
CREATE TABLE IF NOT EXISTS landing_old_slugs (
  slug       text        PRIMARY KEY,
  page_id    bigint      REFERENCES landing_pages(id) ON DELETE CASCADE,
  group_id   bigint      REFERENCES landing_groups(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((page_id IS NULL) <> (group_id IS NULL))
);
CREATE INDEX IF NOT EXISTS landing_old_slugs_page ON landing_old_slugs (page_id);
CREATE INDEX IF NOT EXISTS landing_old_slugs_group ON landing_old_slugs (group_id);

ALTER TABLE products ADD COLUMN IF NOT EXISTS old_names text[] NOT NULL DEFAULT '{}';
ALTER TABLE products ADD COLUMN IF NOT EXISTS old_skus text[] NOT NULL DEFAULT '{}';
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS old_titles text[] NOT NULL DEFAULT '{}';
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS old_skus text[] NOT NULL DEFAULT '{}';
`;
