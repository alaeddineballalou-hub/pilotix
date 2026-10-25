// Landing page pictures, made smaller by the editor's compressor:
// - w720: a 720 px width (what most phones need: 360 px wide screens at 2× density), between 480 and 960
// - lqip: a tiny blurred copy (about 24 px wide, a few hundred bytes) shown inside the page at once, until the photo arrives
// - info: what the compressor did (original size, each width's size and quality score), shown in the editor
// Pictures stored before keep working: no 720 (phones take the 960), no placeholder.
export default `
ALTER TABLE landing_images ADD COLUMN IF NOT EXISTS w720 text;
ALTER TABLE landing_images ADD COLUMN IF NOT EXISTS lqip text;
ALTER TABLE landing_images ADD COLUMN IF NOT EXISTS info jsonb;
`;
