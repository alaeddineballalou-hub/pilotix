// Upsell counted by Pilotix itself: each order keeps a copy of what the customer first ordered (orig_items, orig_discount);
// the upsell (upsell_value, has_upsell, order_items.is_upsell) is worked out against it on every change (shared upsellOf).

/** Orders without the copy (made before it was kept, or written straight into the database): their lines not marked upsell. */
export const UPSELL_BACKFILL: string[] = [
  `UPDATE orders o SET
     orig_items = COALESCE((SELECT jsonb_agg(jsonb_build_object('productId', i.product_id, 'variantId', i.variant_id, 'qty', i.qty, 'unitPrice', i.unit_price) ORDER BY i.id)
                            FROM order_items i WHERE i.order_id = o.id AND NOT i.is_upsell), '[]'::jsonb),
     orig_discount = o.discount,
     upsell_value = CASE WHEN o.is_exchange THEN 0
                         ELSE COALESCE((SELECT sum(i.qty * i.unit_price) FROM order_items i WHERE i.order_id = o.id AND i.is_upsell), 0) END
   WHERE o.orig_items IS NULL`,
  `UPDATE orders SET has_upsell = (upsell_value > 0) WHERE has_upsell <> (upsell_value > 0)`,
];

export default `
ALTER TABLE orders ADD COLUMN IF NOT EXISTS orig_items jsonb;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS orig_discount integer NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS upsell_value integer NOT NULL DEFAULT 0;
${UPSELL_BACKFILL.join(';\n')};
CREATE OR REPLACE VIEW sales AS SELECT * FROM orders WHERE NOT is_exchange;
CREATE OR REPLACE VIEW ticket_parcels AS SELECT * FROM orders WHERE is_exchange;
`;
