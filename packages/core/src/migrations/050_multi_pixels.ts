// A landing page (or group) sends to several pixels of a platform: meta_pixels / tiktok_pixels (jsonb arrays of
// tracking_pixels ids). NULL = the platform's default pixel, [] = none. The one-pixel choice of 049 is carried over.
// A page can also have its own WhatsApp button on the thank-you screen: whatsapp (NULL = as in Réglages,
// { on: false } = none, { on: true, number, label, message } = its own).
export default `
ALTER TABLE landing_pages ADD COLUMN IF NOT EXISTS meta_pixels jsonb;
ALTER TABLE landing_pages ADD COLUMN IF NOT EXISTS tiktok_pixels jsonb;
ALTER TABLE landing_groups ADD COLUMN IF NOT EXISTS meta_pixels jsonb;
ALTER TABLE landing_groups ADD COLUMN IF NOT EXISTS tiktok_pixels jsonb;
UPDATE landing_pages SET meta_pixels = CASE WHEN meta_pixel_ref = 0 THEN '[]'::jsonb ELSE jsonb_build_array(meta_pixel_ref) END WHERE meta_pixel_ref IS NOT NULL AND meta_pixels IS NULL;
UPDATE landing_pages SET tiktok_pixels = CASE WHEN tiktok_pixel_ref = 0 THEN '[]'::jsonb ELSE jsonb_build_array(tiktok_pixel_ref) END WHERE tiktok_pixel_ref IS NOT NULL AND tiktok_pixels IS NULL;
UPDATE landing_groups SET meta_pixels = CASE WHEN meta_pixel_ref = 0 THEN '[]'::jsonb ELSE jsonb_build_array(meta_pixel_ref) END WHERE meta_pixel_ref IS NOT NULL AND meta_pixels IS NULL;
UPDATE landing_groups SET tiktok_pixels = CASE WHEN tiktok_pixel_ref = 0 THEN '[]'::jsonb ELSE jsonb_build_array(tiktok_pixel_ref) END WHERE tiktok_pixel_ref IS NOT NULL AND tiktok_pixels IS NULL;
ALTER TABLE landing_pages ADD COLUMN IF NOT EXISTS whatsapp jsonb;
`;
