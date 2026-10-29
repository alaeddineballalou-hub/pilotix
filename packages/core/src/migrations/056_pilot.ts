// « Pilot Auto Assign » (Sociétés de livraison): who delivers each order.
//  - orders.pilot_by: how its company was chosen — 'rule' / 'strict' (a rule), 'default' (the shop's default company),
//    'bureau' (the chosen bureau's company), 'hand' (a person), 'backup' (« Livraison privée » waited too long),
//    'none' (it waits for a person in « À attribuer »);
//  - orders.pilot_rule: the rule that chose it; orders.pilot_why: why it waits for a person ('conflict:2,4', 'nobody',
//    'manual');
//  - orders.assign_wait_since: when it started waiting in « À attribuer » (the backup company takes « Livraison
//    privée » orders that wait too long).
export default `
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pilot_by text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pilot_rule text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pilot_why text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS assign_wait_since timestamptz;
-- the views keep exactly the columns of orders
CREATE OR REPLACE VIEW sales AS SELECT * FROM orders WHERE NOT is_exchange;
CREATE OR REPLACE VIEW ticket_parcels AS SELECT * FROM orders WHERE is_exchange;
`;
