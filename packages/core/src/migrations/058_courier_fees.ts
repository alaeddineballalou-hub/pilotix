// What the courier itself charges for a parcel, read from its API (ZR first): { delivery, ret, kg, weight, at, src } —
// its delivery price, its return price, the weight it counts (it may weigh the parcel again), its weight fee (exact once
// it pays: « weightCost »), when and from where (« send », « track », « pay »). Wherever Pilotix counts what the company
// takes (Bilan des livraisons, « Frais société », the caisse), these come first, before the price list.
export default `
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_fees jsonb;
-- the views keep exactly the columns of orders
CREATE OR REPLACE VIEW sales AS SELECT * FROM orders WHERE NOT is_exchange;
CREATE OR REPLACE VIEW ticket_parcels AS SELECT * FROM orders WHERE is_exchange;
`;
