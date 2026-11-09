// « Envoyer des photos » (Confirmation): the products' photos a confirmation agent sends a customer from his own
// WhatsApp. One page per send (its link in the message: WhatsApp shows its first photo, the customer opens it to see
// them all): the products and colours chosen, their photos (Pilotix's public JPEG copies). A random key keeps it
// unguessable; no customer's data on it. Pages older than 90 days are removed.
export default `
CREATE TABLE IF NOT EXISTS photo_pages (
  id bigserial PRIMARY KEY,
  key text NOT NULL,
  order_id bigint REFERENCES orders(id) ON DELETE SET NULL,
  items jsonb NOT NULL DEFAULT '[]',
  created_by bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS photo_pages_created ON photo_pages (created_at);
`;
