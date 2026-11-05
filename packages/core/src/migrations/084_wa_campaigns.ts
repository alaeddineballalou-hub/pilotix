// Marketing › Campagnes: WhatsApp messages to the shop's own customers (a new product, a promo), only to those who said
// yes (a box on the landing pages, the agent during the call, a list pasted by the shop) and never again after « Stop ».
// Each campaign is one WhatsApp template Meta approves, sent slowly (a number of messages a day, never at night); each
// message keeps what became of it (received, read, a reply, « Je commande », « Stop »).
export default `
ALTER TABLE customers ADD COLUMN IF NOT EXISTS wa_optin_at timestamptz;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS wa_optin_source text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS wa_optout_at timestamptz;
CREATE TABLE IF NOT EXISTS wa_campaigns (
  id               bigserial   PRIMARY KEY,
  name             text        NOT NULL DEFAULT '',
  status           text        NOT NULL DEFAULT 'draft',
  audience         jsonb       NOT NULL DEFAULT '{}',
  lang             text        NOT NULL DEFAULT 'dz',
  body             text        NOT NULL DEFAULT '',
  product_id       bigint,
  link             text,
  order_button     boolean     NOT NULL DEFAULT true,
  template_name    text,
  template_reason  text,
  send_at          timestamptz,
  started_at       timestamptz,
  finished_at      timestamptz,
  created_by       bigint,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS wa_campaign_sends (
  id            bigserial   PRIMARY KEY,
  campaign_id   bigint      NOT NULL REFERENCES wa_campaigns(id) ON DELETE CASCADE,
  customer_id   bigint,
  phone         text        NOT NULL,
  name          text,
  status        text        NOT NULL DEFAULT 'queued',
  wa_id         text,
  error         text,
  sent_at       timestamptz,
  delivered_at  timestamptz,
  read_at       timestamptz,
  replied_at    timestamptz,
  tapped        text,
  UNIQUE (campaign_id, phone)
);
CREATE INDEX IF NOT EXISTS wa_sends_status ON wa_campaign_sends (status, campaign_id);
CREATE INDEX IF NOT EXISTS wa_sends_wa ON wa_campaign_sends (wa_id);
CREATE INDEX IF NOT EXISTS wa_sends_phone ON wa_campaign_sends (phone, sent_at);
`;
