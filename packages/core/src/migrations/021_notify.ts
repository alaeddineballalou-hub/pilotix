// Delivery AI agent: the messages sent to customers about their order (received, confirmed, shipped, with the livreur,
// at the desk, failed attempt, cancelled by the livreur, delivered). WhatsApp first; SMS when the customer has no
// WhatsApp; a list to send by hand when no SMS sender is set. Settings live in `settings` (key 'notify').
export default `
CREATE TABLE IF NOT EXISTS notifications (
  id           bigserial PRIMARY KEY,
  order_id     bigint      NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind         text        NOT NULL,                 -- created | confirmed | shipped | out_for_delivery | stopdesk | failed | returning | delivered
  status       text        NOT NULL DEFAULT 'queued',-- queued | sending | whatsapp | sms | manual | done | failed | skipped
  channel      text,                                 -- whatsapp | sms | manual
  phone        text        NOT NULL,
  lang         text        NOT NULL DEFAULT 'dz',
  body         text        NOT NULL,                 -- the message as the customer reads it
  wa_id        text,                                 -- WhatsApp message id (delivery statuses come back with it)
  wa_status    text,                                 -- sent | delivered | read | failed
  sms_id       text,
  sms_status   text,                                 -- queued | sent | delivered | failed
  error        text,
  attempts     integer     NOT NULL DEFAULT 0,
  send_after   timestamptz NOT NULL DEFAULT now(),   -- held during the night
  sent_at      timestamptz,
  delivered_at timestamptz,
  read_at      timestamptz,
  replied_at   timestamptz,
  reply        text,                                 -- the customer's answer (WhatsApp or SMS)
  sent_by      bigint,                               -- a person who sent it by hand
  claimed_at   timestamptz,                          -- taken by a sending run (a run that died leaves it: see the lease)
  sending_at   timestamptz,                          -- handed to WhatsApp / the SMS sender (never sent twice blindly)
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_queue ON notifications (status, send_after);
CREATE INDEX IF NOT EXISTS notifications_order ON notifications (order_id, id DESC);
CREATE INDEX IF NOT EXISTS notifications_recent ON notifications (created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_phone ON notifications (phone, id DESC);
CREATE INDEX IF NOT EXISTS notifications_wa ON notifications (wa_id) WHERE wa_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notifications_sms ON notifications (sms_id) WHERE sms_id IS NOT NULL;
-- a WhatsApp status that arrives before its message id is stored (applied as soon as it is)
CREATE TABLE IF NOT EXISTS notification_early_statuses (
  wa_id  text        PRIMARY KEY,
  status text        NOT NULL,
  code   integer,
  title  text,
  at     timestamptz NOT NULL DEFAULT now()
);
`;
