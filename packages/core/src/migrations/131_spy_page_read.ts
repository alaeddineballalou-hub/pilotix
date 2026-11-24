// AI Spy (22 Nov 2026): what a person's Chrome read on a competitor's page beyond its price (the Pilotix extension's
// « Lire la page »): its offers, its delivery price and what it promises (« why buy here »), with the time it was read.
// Kept apart from the server's reading (spy_ads.site) and from the price given by a person (spy_ads.manual).
export default `
ALTER TABLE spy_ads ADD COLUMN IF NOT EXISTS page_read jsonb;
`;
