// Stock cassé (broken stock): a product that came back broken waits apart in its depot and is never sold — the old
// product of an SAV exchange for « Produit défectueux », or a return the depot finds broken (« Cassé » after the scan).
// The depot repairs it (back on sale) or throws it away. stock_movements.broken_delta: what a movement changed there
// (its delta stays what changed in the stock that is sold).
export default `
ALTER TABLE stock ADD COLUMN IF NOT EXISTS broken integer NOT NULL DEFAULT 0;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS broken_delta integer NOT NULL DEFAULT 0;
`;
