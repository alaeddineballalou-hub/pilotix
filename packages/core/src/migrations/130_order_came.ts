// « Le chemin de la commande » (24 Nov 2026, the owner's choice 3): every order keeps how it was made — `came`, one of
// ORDER_CAME (packages/shared/src/origin.ts). New orders get it when they are made (createOrder); the orders already
// there get it here, once, from what Pilotix wrote on them, with the same rules as cameOf() plus what only the
// database knows (Landing pages › Bloquées, the unsent forms a person added, the sales channels). Nothing else of an
// order changes: its creator and its history stay as they are (the app shows « Pilotix » for what Pilotix did).

/**
 * Gives `came` to every order that has none yet. Kept apart so a test can run it on rows it wrote itself. The lists it
 * reads (Bloquées put back, the sales channels) are read once, not once per order: it runs on every order of the base.
 */
export const CAME_BACKFILL_SQL = `
UPDATE orders o SET came = CASE
  WHEN o.is_exchange THEN 'exchange'
  WHEN o.source ~ '·\\s*abandonnée$' THEN
    CASE WHEN EXISTS (SELECT 1 FROM landing_leads l WHERE l.order_id = o.id AND NOT l.auto_order AND l.handled_by IS NOT NULL)
      THEN 'recovered' ELSE 'abandoned' END
  WHEN o.id IN (SELECT b.order_id FROM landing_blocked b WHERE b.status = 'restored' AND b.order_id IS NOT NULL) THEN 'restored'
  WHEN o.source LIKE 'Formulaire «%' THEN 'meta_form'
  WHEN o.source ~ '·\\s*commande auto$' THEN 'chat_auto'
  WHEN o.source IN ('site (simulation)', 'Test Pilotix') OR o.internal_note = 'Colis de test du scanner' THEN 'test'
  WHEN o.channel = 'landing' OR o.landing_id IS NOT NULL THEN 'form'
  WHEN o.conversation_id IS NOT NULL OR o.source ~* '·\\s*(messenger|instagram|whatsapp|tiktok|test)(\\s*·|\\s*$)' THEN 'chat'
  WHEN o.source IN (SELECT c.name FROM sales_channels c WHERE c.kind = 'sheets') THEN 'sheet'
  WHEN o.source IN (SELECT c.name FROM sales_channels c WHERE c.kind <> 'sheets') THEN 'site'
  ELSE 'hand' END
WHERE o.came IS NULL;
`;

export default `
ALTER TABLE orders ADD COLUMN IF NOT EXISTS came text;
-- the two views keep exactly the columns of orders
CREATE OR REPLACE VIEW sales AS SELECT * FROM orders WHERE NOT is_exchange;
CREATE OR REPLACE VIEW ticket_parcels AS SELECT * FROM orders WHERE is_exchange;
${CAME_BACKFILL_SQL}
`;
