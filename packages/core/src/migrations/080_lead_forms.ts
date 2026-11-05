// Marketing › Formulaires: the lead forms of the shop's Facebook and Instagram ads (Meta Lead Ads). Each form says what its
// leads become (its product, « Créer la commande » or « Garder à vérifier »); each lead keeps what the customer typed, what
// Pilotix understood (name, phone, wilaya…) and what became of it (an order, a wilaya or a number to fix, a duplicate…).
export default `
CREATE TABLE IF NOT EXISTS lead_forms (
  id            bigserial   PRIMARY KEY,
  form_id       text        NOT NULL UNIQUE,
  page_id       text        NOT NULL DEFAULT '',
  name          text        NOT NULL DEFAULT '',
  meta_status   text        NOT NULL DEFAULT 'ACTIVE',
  questions     jsonb       NOT NULL DEFAULT '[]',
  mapping       jsonb       NOT NULL DEFAULT '{}',
  product_id    bigint,
  variant_id    bigint,
  active        boolean     NOT NULL DEFAULT true,
  mode          text        NOT NULL DEFAULT 'order',
  dup_days      int         NOT NULL DEFAULT 7,
  last_lead_at  timestamptz,
  synced_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS leads (
  id             bigserial   PRIMARY KEY,
  leadgen_id     text        NOT NULL UNIQUE,
  form_id        text        NOT NULL DEFAULT '',
  page_id        text        NOT NULL DEFAULT '',
  platform       text        NOT NULL DEFAULT 'fb',
  ad_id          text,
  adset_id       text,
  campaign_id    text,
  ad_name        text,
  answers        jsonb       NOT NULL DEFAULT '[]',
  customer_name  text,
  phone          text,
  wilaya_id      int,
  commune        text,
  address        text,
  qty            int         NOT NULL DEFAULT 1,
  variant_text   text,
  variant_id     bigint,
  note           text,
  status         text        NOT NULL DEFAULT 'new',
  problem        text,
  wrote          text,
  candidates     jsonb,
  order_id       bigint,
  dup_order_id   bigint,
  is_test        boolean     NOT NULL DEFAULT false,
  error          text,
  received_at    timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  busy_at        timestamptz,
  handled_by     bigint,
  handled_at     timestamptz
);
CREATE INDEX IF NOT EXISTS leads_created ON leads (created_at DESC);
CREATE INDEX IF NOT EXISTS leads_status ON leads (status);
CREATE INDEX IF NOT EXISTS leads_phone ON leads (phone);
CREATE INDEX IF NOT EXISTS leads_form ON leads (form_id);
`;
