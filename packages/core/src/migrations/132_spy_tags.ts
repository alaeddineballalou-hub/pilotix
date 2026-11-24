// AI Spy (22 Nov 2026): a tag on each competitor's ad, to sort them: « Identique » (the same product), « Ressemble »
// (a product close to it), « Pas le même » (another product: out of the list), or one of the shop's own tags. The AI
// gives the first three from its reading (relevant, same); a person's choice (AI Spy, or the buttons the Pilotix
// extension adds to Facebook's ad library) is kept here and the AI never changes it.
export default `
ALTER TABLE spy_ads ADD COLUMN IF NOT EXISTS tag text;
`;
