// Ad sets › Produit, linked by Pilotix (the owner, 27 Nov 2026): where each ad sends people, as Meta has it on its
// créa (`link`), the boutique's page it is (`link_slug`) and that page's product or group; `link_from`: 'ad' (its link)
// or 'orders' (an ad made from a post: the page its orders came through). An ad set whose ads' pages are known follows
// them (`link_auto`): its products are its ads' products (modules/adlinks.ts), and Publicité counts each ad's spend for
// its own product.
export default `
ALTER TABLE ads ADD COLUMN IF NOT EXISTS link text;
ALTER TABLE ads ADD COLUMN IF NOT EXISTS link_slug text;
ALTER TABLE ads ADD COLUMN IF NOT EXISTS link_product_id bigint;
ALTER TABLE ads ADD COLUMN IF NOT EXISTS link_group_id bigint;
ALTER TABLE ads ADD COLUMN IF NOT EXISTS link_from text;
ALTER TABLE ads ADD COLUMN IF NOT EXISTS link_at timestamptz;
ALTER TABLE adsets ADD COLUMN IF NOT EXISTS link_auto boolean NOT NULL DEFAULT false;
`;
