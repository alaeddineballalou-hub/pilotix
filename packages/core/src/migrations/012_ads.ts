// Schema changes for the ads feature (Publicité). Runs once, after 001.
// ad_insights (001) holds Meta results per ad set and day; we add reach, landing page views and thruplays,
// and keep the same results per ad (ad_daily) for "Pubs de cet ad set", plus monthly closes.
export default `
ALTER TABLE ad_insights ADD COLUMN IF NOT EXISTS reach integer NOT NULL DEFAULT 0;
ALTER TABLE ad_insights ADD COLUMN IF NOT EXISTS lpv integer NOT NULL DEFAULT 0;
ALTER TABLE ad_insights ADD COLUMN IF NOT EXISTS thruplays integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS ad_insights_adset ON ad_insights (adset_id, day);

CREATE TABLE IF NOT EXISTS ads (
  id         text PRIMARY KEY,          -- Meta ad id
  adset_id   text        NOT NULL,
  name       text        NOT NULL,
  status     text,
  is_video   boolean     NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ads_adset ON ads (adset_id);

CREATE TABLE IF NOT EXISTS ad_daily (
  day         date    NOT NULL,
  ad_id       text    NOT NULL,
  adset_id    text    NOT NULL,
  spend_cents integer NOT NULL DEFAULT 0,
  impressions integer NOT NULL DEFAULT 0,
  reach       integer NOT NULL DEFAULT 0,
  clicks      integer NOT NULL DEFAULT 0,
  lpv         integer NOT NULL DEFAULT 0,
  purchases   integer NOT NULL DEFAULT 0,
  video_3s    integer NOT NULL DEFAULT 0,
  thruplays   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, ad_id)
);
CREATE INDEX IF NOT EXISTS ad_daily_adset ON ad_daily (adset_id, day);

-- A month "closed" by the marketer / owner: the figures are frozen as they were (scope 'all' or 'm<marketer id>').
CREATE TABLE IF NOT EXISTS ad_month_closes (
  ym        text        NOT NULL,
  scope     text        NOT NULL,
  data      jsonb       NOT NULL,
  closed_by bigint,
  closed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ym, scope)
);
`;
