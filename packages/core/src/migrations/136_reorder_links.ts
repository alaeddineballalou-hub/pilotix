// The cancel message's short link (Confirmation › the customer who does not answer, owner's rule, 25 Nov 2026):
// https://<the shop's own domain>/r/<code>, 10 letters and digits, instead of /api/s/<store>/reorder/<order>/<64 hex>.
// One line per link made (each cancel message the agent opens): its code's sha256 (the code itself is never kept: whoever
// reads the table cannot use a link) and its order. The link's page reads it to show the product's main photo (WhatsApp
// reads the page for its preview before the order is cancelled). The cancellation still keeps the link it went with
// (order_events › reorderHash): only that one restores the order. `sent_at`: the message went with this link; a link
// never sent is removed after 2 days.
export default `
CREATE TABLE IF NOT EXISTS reorder_links (
  hash text PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reorder_links_created ON reorder_links (created_at);
`;
