// Dépôt › Dispatchées (22 Nov 2026): a parcel leaves the list as soon as its delivery company says it has it — any of
// its words after « handed over » (ZR: « Confirmé au bureau », « Dispatch », « Vers wilaya »… anything after « Prêt à
// expédier »), with or without a pickup bag. taken_at: when the company first said so (set by the courier sync, emptied
// when the parcel is sent to a company again). The owner's rule.
export default `
ALTER TABLE orders ADD COLUMN IF NOT EXISTS taken_at timestamptz;
-- the two views keep exactly the columns of orders
CREATE OR REPLACE VIEW sales AS SELECT * FROM orders WHERE NOT is_exchange;
CREATE OR REPLACE VIEW ticket_parcels AS SELECT * FROM orders WHERE is_exchange;
`;
