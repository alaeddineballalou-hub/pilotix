// Lancer une pub › Campaign › Ad set › Ad (modules/adstree.ts, 20 Nov 2026): which campaigns are the life ad circle's
// TEST and SCALE (made empty from Pilotix; one made in Meta is known by its name), and when one ad was last turned on
// or off from Pilotix.
export default `
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE ads ADD COLUMN IF NOT EXISTS changed_at timestamptz;
`;
