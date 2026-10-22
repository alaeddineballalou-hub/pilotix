// Dellal, the AI sales agent: one conversation per customer per channel (WhatsApp, Messenger, Instagram, TikTok,
// or "test" for the Tester Dellal box) and every message in it. Settings live in `settings` (key 'dellal'),
// the channel and AI secrets under their own secret_* keys, never returned to the app.
export default `
CREATE TABLE IF NOT EXISTS conversations (
  id               bigserial PRIMARY KEY,
  channel          text        NOT NULL,                 -- whatsapp | messenger | instagram | tiktok | test
  external_id      text        NOT NULL,                 -- the customer's id on that channel (WhatsApp: phone)
  account_id       text,                                 -- our page / number / account that received it
  customer_name    text,
  phone            text,
  customer_id      bigint,
  mode             text        NOT NULL DEFAULT 'ai',    -- ai (Dellal answers) | human (a person took over) | handoff (waiting for a person)
  handoff_reason   text,
  assigned_to      bigint,
  order_id         bigint,
  orders_count     integer     NOT NULL DEFAULT 0,
  source           text,                                 -- ad / post that started it, when the channel says
  last_message_at  timestamptz NOT NULL DEFAULT now(),
  last_customer_at timestamptz,
  last_preview     text,
  unread           integer     NOT NULL DEFAULT 0,
  followed_up      boolean     NOT NULL DEFAULT false,
  created_by       bigint,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_id)
);
CREATE INDEX IF NOT EXISTS conversations_last ON conversations (last_message_at DESC);
CREATE INDEX IF NOT EXISTS conversations_mode ON conversations (mode, last_message_at DESC);

CREATE TABLE IF NOT EXISTS conv_messages (
  id              bigserial PRIMARY KEY,
  conversation_id bigint      NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text        NOT NULL,                  -- customer | agent | staff | tool
  body            text        NOT NULL,
  user_id         bigint,                                -- staff author
  external_id     text,                                  -- message id on the channel (dedupe)
  meta            jsonb,                                 -- tool name/input/result, AI usage
  send_error      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conv_messages_conv ON conv_messages (conversation_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS conv_messages_ext ON conv_messages (conversation_id, external_id) WHERE external_id IS NOT NULL;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS conversation_id bigint;
CREATE OR REPLACE VIEW sales AS SELECT * FROM orders WHERE NOT is_exchange;
CREATE OR REPLACE VIEW ticket_parcels AS SELECT * FROM orders WHERE is_exchange;
`;
