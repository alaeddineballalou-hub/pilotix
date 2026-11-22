// AI Spy (22 Nov 2026): a competitor's price given by a person when Pilotix's server could not read the site (its
// « no robots » rule, a protection wall against robots, or the site did not answer): typed by hand in AI Spy, or read by
// the person's own Chrome on the page they had open (the Pilotix Spy extension's « Lire le prix de cette page »).
// Kept apart from the server's reading (spy_ads.site), which never overwrites it.
export default `
ALTER TABLE spy_ads ADD COLUMN IF NOT EXISTS manual jsonb;
`;
