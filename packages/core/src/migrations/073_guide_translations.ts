// The sales guide in the other reading languages (modules/guide.ts): for French, Arabic and English, other than the
// guide's own language, each line of the guide → its translation. Pilot AI writes them after a save; the team corrects
// them (its corrections stay).
export default `
ALTER TABLE product_guides ADD COLUMN IF NOT EXISTS tr jsonb NOT NULL DEFAULT '{}';
`;
