// Dellal: a chat where the customer gave his number, then went quiet, becomes an order by itself (Confirmation ›
// Nouvelles: the team calls him). auto_checked_at: when Pilotix last looked at the chat for it — looked at again only
// after the customer writes again.
// orders.wilaya_guess: the customer never said his wilaya, so that order got the shop's own for now — it cannot be
// confirmed while it is still that wilaya with no commune (or no bureau) chosen: someone has to ask him.
export default `
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS auto_checked_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS wilaya_guess smallint;
-- the two views keep exactly the columns of orders
CREATE OR REPLACE VIEW sales AS SELECT * FROM orders WHERE NOT is_exchange;
CREATE OR REPLACE VIEW ticket_parcels AS SELECT * FROM orders WHERE is_exchange;
`;
