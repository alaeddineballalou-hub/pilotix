// AI Spy: competitors' Facebook ads for the shop's own products (Algeria), kept by Pilotix with their history
// (Facebook drops an Algerian ad from its library as soon as it stops, and its picture links expire after a few days).
export default `
-- per product: the keywords searched (with the number of ads Facebook found), in the daily scan or not, the AI brief
CREATE TABLE IF NOT EXISTS spy_watch (
  product_id bigint PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  keywords   jsonb       NOT NULL DEFAULT '[]',
  watch      boolean     NOT NULL DEFAULT true,
  brief      jsonb,
  brief_at   timestamptz,
  scanned_at timestamptz
);

-- one row per creative of a competitor (same page + same text = one creative; its copies are added up)
CREATE TABLE IF NOT EXISTS spy_ads (
  product_id bigint      NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  gkey       text        NOT NULL,
  ad_id      text        NOT NULL,
  ad_ids     text[]      NOT NULL DEFAULT '{}',
  source     text        NOT NULL,
  page_id    text,
  page_name  text        NOT NULL DEFAULT '',
  page_url   text,
  body       text        NOT NULL DEFAULT '',
  title      text,
  link_url   text,
  link_type  text        NOT NULL DEFAULT 'none',
  platform   text,
  cta        text,
  platforms  text[]      NOT NULL DEFAULT '{}',
  is_video   boolean     NOT NULL DEFAULT false,
  media      text,
  media_url  text,
  copies     integer     NOT NULL DEFAULT 1,
  started_at timestamptz,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now(),
  active     boolean     NOT NULL DEFAULT true,
  own        boolean     NOT NULL DEFAULT false,
  keyword    text,
  price      integer,
  old_price  integer,
  relevant   boolean,
  same       boolean,
  ai         jsonb,
  site       jsonb,
  PRIMARY KEY (product_id, gkey)
);
CREATE INDEX IF NOT EXISTS spy_ads_seen ON spy_ads (product_id, last_seen DESC);

-- competitors' pages the shop follows (alerts: new ads, ads stopped, price changes)
CREATE TABLE IF NOT EXISTS spy_follow (
  page_key   text        PRIMARY KEY,
  page_name  text        NOT NULL,
  product_id bigint      REFERENCES products(id) ON DELETE SET NULL,
  created_by bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS spy_events (
  id         bigserial   PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  kind       text        NOT NULL,
  page_name  text        NOT NULL,
  product_id bigint,
  gkey       text,
  data       jsonb
);
CREATE INDEX IF NOT EXISTS spy_events_at ON spy_events (at DESC);
`;
