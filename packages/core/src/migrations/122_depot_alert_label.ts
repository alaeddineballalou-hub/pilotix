// Dépôt alerts (22 Nov 2026): a parcel that never had a label has no « old label » to scan. Its company has an API
// and had not given it its tracking number yet (refused by the courier, or not sent), or it had no company: nothing
// could be printed (PX1226: ZR refused « Azzefoun », the red screen asked for a label that never existed).
export default `
ALTER TABLE depot_alerts ADD COLUMN IF NOT EXISTS no_label boolean NOT NULL DEFAULT false;
`;
