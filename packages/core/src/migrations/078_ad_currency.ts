// Publicité: the currency of each ad set's ad account, as Meta gives it (USD, DZD…; empty = USD). Spend stays stored in
// that currency: a DZD account's spend counts in dinars as it is, and in dollars with the dollar rate of its month.
export default `
ALTER TABLE adsets ADD COLUMN IF NOT EXISTS currency text;
`;
