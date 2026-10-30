// Immutable unit purchase price for each stock-receipt movement.
// Purchase lines already store historic batch prices. This also covers quick Add Stock.
export default `
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS unit_cost integer CHECK (unit_cost >= 0);
`;
