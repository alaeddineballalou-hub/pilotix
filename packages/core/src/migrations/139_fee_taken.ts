// The courier's fee on a parcel that did not reach its customer — a return (« En retour », « Retourné ») or a parcel
// given to another customer (« Annulé · swappé », its swap fee) — comes out of the money the company pays once, never
// twice (the owner's request, 26 Nov 2026: the ZR card in Caisse must show what ZR shows). `fee_taken_at`: when it came
// out; `fee_taken`: how much a « Argent reçu » took by hand (null when the company's own payment took it);
// `fee_handover_id`: the versement that took it (cancelling it puts the fee back to take); `fee_payment_id`: the
// company's payment whose lines held it (ZR).
// The returns and swaps from before: taken already when a payment of their company held the parcel, or when their
// company paid a versement after them (its statements took them). The others wait for the next money received.
export default `
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fee_taken_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fee_taken integer;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fee_handover_id bigint;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fee_payment_id bigint;
-- the two views keep exactly the columns of orders
CREATE OR REPLACE VIEW sales AS SELECT * FROM orders WHERE NOT is_exchange;
CREATE OR REPLACE VIEW ticket_parcels AS SELECT * FROM orders WHERE is_exchange;

UPDATE orders o SET fee_taken_at = now(),
       fee_payment_id = (SELECT p.id FROM courier_payments p
                          WHERE p.company_id = o.company_id AND jsonb_typeof(p.lines) = 'array'
                            AND EXISTS (SELECT 1 FROM jsonb_array_elements(p.lines) l WHERE l->>'tracking' = o.tracking)
                          ORDER BY p.id LIMIT 1)
 WHERE o.fee_taken_at IS NULL AND o.company_id IS NOT NULL AND o.follow_status IN ('returning', 'returned')
   AND (EXISTS (SELECT 1 FROM courier_payments p
                 WHERE p.company_id = o.company_id AND jsonb_typeof(p.lines) = 'array'
                   AND EXISTS (SELECT 1 FROM jsonb_array_elements(p.lines) l WHERE l->>'tracking' = o.tracking))
        OR COALESCE(o.returned_at, o.returning_at, o.updated_at)
           < (SELECT max(h.created_at) FROM cash_handovers h WHERE h.company_id = o.company_id AND h.cancelled_at IS NULL));

UPDATE orders o SET fee_taken_at = now()
 WHERE o.fee_taken_at IS NULL AND o.company_id IS NOT NULL AND o.follow_status = 'cancelled' AND o.sub_status = 'annule_swappe'
   AND EXISTS (SELECT 1 FROM order_events e
                WHERE e.order_id = o.id AND e.kind = 'follow_status' AND e.data->>'swap_to' IS NOT NULL
                  AND (e.at < (SELECT max(h.created_at) FROM cash_handovers h WHERE h.company_id = o.company_id AND h.cancelled_at IS NULL)
                       OR EXISTS (SELECT 1 FROM courier_payments p
                                   WHERE p.company_id = o.company_id AND jsonb_typeof(p.lines) = 'array'
                                     AND EXISTS (SELECT 1 FROM jsonb_array_elements(p.lines) l
                                                  WHERE l->>'tracking' = e.data->>'tracking'
                                                     OR l->>'tracking' = (SELECT b.tracking FROM orders b WHERE b.id = (e.data->>'swap_to')::bigint)))));

CREATE INDEX IF NOT EXISTS orders_fee_wait ON orders (company_id) WHERE fee_taken_at IS NULL AND follow_status IN ('returning', 'returned', 'cancelled');
CREATE INDEX IF NOT EXISTS orders_fee_handover ON orders (fee_handover_id) WHERE fee_handover_id IS NOT NULL;
`;
