// Marketing › Influenceurs (partnership ads) and Publicité › Demander (Pilot AI answers about the ads through Meta's
// ads MCP server).
//  - ad_partners: the creators the shop works with: an Instagram account asked for the right to run ads in both names
//    (pending until the creator says yes in the Instagram app), or a creator's Facebook Page (Meta asks the creator at
//    the first ad); the shop's own note (the price agreed…).
//  - ad_partner_content: their posts that tag the shop, as Meta's Advertisable Content API lists them (Instagram and
//    Facebook together): ready for an ad or not, and how they did on their own.
//  - ad_launches.partner_id / partner_content_id: a launch in both names (a new ad of the shop, or a creator's post
//    boosted); its ads' ids then count the orders each influencer brought.
//  - ads_asks: the questions asked to Pilot AI about the ads, its answer, what it read, and a change it proposes (it
//    waits for the owner's yes: nothing changes on Meta before).
export default `
CREATE TABLE IF NOT EXISTS ad_partners (
  id            bigserial   PRIMARY KEY,
  ig_username   text,
  ig_id         text,
  fb_page_id    text,
  name          text        NOT NULL DEFAULT '',
  picture       text,
  status        text        NOT NULL DEFAULT 'pending',
  permission_id text,
  note          text        NOT NULL DEFAULT '',
  error         text,
  requested_by  bigint,
  requested_at  timestamptz,
  checked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ad_partners_ig ON ad_partners (lower(ig_username)) WHERE ig_username IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ad_partners_page ON ad_partners (fb_page_id) WHERE fb_page_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ad_partner_content (
  content_id   text        PRIMARY KEY,
  partner_id   bigint      REFERENCES ad_partners(id) ON DELETE SET NULL,
  platform     text        NOT NULL,
  media_type   text,
  post_type    text,
  caption      text        NOT NULL DEFAULT '',
  permalink    text,
  author       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  posted_on    date,
  eligibility  text,
  permission   text,
  ad_code      text,
  errors       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  ad_usage     text,
  insights     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  thumb        text,
  seen_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ad_partner_content_partner ON ad_partner_content (partner_id, posted_on DESC);

ALTER TABLE ad_launches ADD COLUMN IF NOT EXISTS partner_id bigint;
ALTER TABLE ad_launches ADD COLUMN IF NOT EXISTS partner_content_id text;
CREATE INDEX IF NOT EXISTS ad_launches_partner ON ad_launches (partner_id) WHERE partner_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ads_asks (
  id          bigserial   PRIMARY KEY,
  thread_id   bigint,
  by_user     bigint,
  question    text        NOT NULL,
  answer      text        NOT NULL DEFAULT '',
  lang        text        NOT NULL DEFAULT 'fr',
  reads       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  pending     jsonb,
  status      text        NOT NULL DEFAULT 'done',
  result      text,
  error       text,
  by_ai       boolean     NOT NULL DEFAULT false,
  decided_by  bigint,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ads_asks_thread ON ads_asks (thread_id, id);
CREATE INDEX IF NOT EXISTS ads_asks_waiting ON ads_asks (created_at) WHERE status = 'waiting_yes';
`;
