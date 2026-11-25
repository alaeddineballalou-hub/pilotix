// The cancel message's short link (Confirmation › the customer who does not answer, owner's rule, 25 Nov 2026):
// https://<the shop's own domain>/r/<code>, 10 letters and digits, instead of /api/s/<store>/reorder/<order>/<64 hex>.
// One line per link made (each cancel message the agent opens): its code's sha256 (the code itself is never kept: whoever
// reads the table cannot use a link) and its order. The link's page reads it to show the product's main photo (WhatsApp
// reads the page for its preview before the order is cancelled). The cancellation still keeps the link it went with
// (order_events › reorderHash): only that one restores the order. `sent_at`: the message went with this link; a link
// never sent is removed after 2 days.
// On the live server (shared tables), orders' key is already (shop_id, id): the link to the order is made with shop_id
// there (like 123_inbox). A fresh or older database still has the original key, which tenantization converts later.
export default `
CREATE TABLE IF NOT EXISTS reorder_links (
  hash text PRIMARY KEY,
  order_id bigint NOT NULL,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
DO $reorder$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'reorder_links'::regclass AND conname = 'reorder_links_order_id_fkey'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = 'orders'::regclass AND attname = 'shop_id' AND NOT attisdropped
    ) THEN
      ALTER TABLE reorder_links ADD COLUMN IF NOT EXISTS shop_id integer NOT NULL DEFAULT public.px_shop_id();
      ALTER TABLE reorder_links ADD CONSTRAINT reorder_links_order_id_fkey
        FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id) ON DELETE CASCADE;
    ELSE
      ALTER TABLE reorder_links ADD CONSTRAINT reorder_links_order_id_fkey
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
    END IF;
  END IF;
END $reorder$;
CREATE INDEX IF NOT EXISTS reorder_links_created ON reorder_links (created_at);
`;
