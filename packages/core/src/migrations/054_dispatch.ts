// Dépôt « À attribuer » / « En dispatch »:
//  - orders.send_error: why the courier refused the parcel (shown in « En dispatch » with « Renvoyer » / « Autre société »);
//  - orders.cancel_by_hand: an order cancelled while its parcel was at a courier whose system could not cancel it — the
//    depot cancels it in the courier's space, then presses « C'est fait »;
//  - profiles.can_assign: the people (besides admins) who give orders a company or a livreur in « À attribuer ».
export default `
ALTER TABLE orders ADD COLUMN IF NOT EXISTS send_error text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS send_error_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_by_hand boolean NOT NULL DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS can_assign boolean NOT NULL DEFAULT false;
-- the views keep exactly the columns of orders
CREATE OR REPLACE VIEW sales AS SELECT * FROM orders WHERE NOT is_exchange;
CREATE OR REPLACE VIEW ticket_parcels AS SELECT * FROM orders WHERE is_exchange;
`;
