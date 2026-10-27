// Landing pages › Réglages › Pixels: the shop's Meta and TikTok pixels, by name. Each landing page (and group page)
// picks one of each: NULL = the default one of that platform, 0 = none. A pixel's token (Conversions API / TikTok
// Events API) is a secret setting (secret_pixel_<id>), never sent to the app.
// meta_events is the outbox of both platforms now (platform). TikTok's browser cookie (_ttp) is kept with the submit.
export default `
CREATE TABLE IF NOT EXISTS tracking_pixels (
  id          bigserial   PRIMARY KEY,
  platform    text        NOT NULL,                -- meta | tiktok
  name        text        NOT NULL DEFAULT '',
  pixel_id    text        NOT NULL,
  test_code   text        NOT NULL DEFAULT '',      -- TikTok's test event code (Meta's is in the settings)
  is_default  boolean     NOT NULL DEFAULT false,
  created_by  bigint,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, pixel_id)
);
ALTER TABLE landing_pages ADD COLUMN IF NOT EXISTS meta_pixel_ref bigint;
ALTER TABLE landing_pages ADD COLUMN IF NOT EXISTS tiktok_pixel_ref bigint;
ALTER TABLE landing_groups ADD COLUMN IF NOT EXISTS meta_pixel_ref bigint;
ALTER TABLE landing_groups ADD COLUMN IF NOT EXISTS tiktok_pixel_ref bigint;
ALTER TABLE meta_events ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'meta';
ALTER TABLE landing_submits ADD COLUMN IF NOT EXISTS ttp text;
ALTER TABLE landing_leads ADD COLUMN IF NOT EXISTS ttp text;
-- the pixel of Réglages becomes the default Meta pixel; the ones typed on pages until now become named pixels,
-- chosen by those pages (a page that had the default one keeps following the default)
INSERT INTO tracking_pixels (platform, name, pixel_id, is_default)
  SELECT 'meta', 'Pixel principal', value->>'pixelId', true FROM settings WHERE key = 'landing' AND coalesce(value->>'pixelId', '') ~ '^[0-9]{5,20}$'
  ON CONFLICT (platform, pixel_id) DO UPDATE SET is_default = true;
INSERT INTO tracking_pixels (platform, name, pixel_id)
  SELECT DISTINCT 'meta', 'Pixel ' || pixel_id, pixel_id FROM landing_pages WHERE coalesce(pixel_id, '') ~ '^[0-9]{5,20}$'
  ON CONFLICT (platform, pixel_id) DO NOTHING;
UPDATE landing_pages l SET meta_pixel_ref = p.id FROM tracking_pixels p WHERE p.platform = 'meta' AND p.pixel_id = l.pixel_id AND NOT p.is_default AND l.meta_pixel_ref IS NULL;
UPDATE landing_groups g SET meta_pixel_ref = p.id FROM tracking_pixels p WHERE p.platform = 'meta' AND p.pixel_id = g.pixel_id AND NOT p.is_default AND g.meta_pixel_ref IS NULL;
`;
