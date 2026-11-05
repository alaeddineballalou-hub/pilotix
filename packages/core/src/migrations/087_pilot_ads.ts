// Pilot Ads: what Pilotix knows of the shop's Meta campaigns (read at each sync: budgets, states, goals), every change
// it makes or is asked to make (one row each, with what it was before, so it can be undone and the owner can say yes),
// the ads it launches, Pilote auto's suggestions, and the audiences it builds from the shop's own customers.
export default `
ALTER TABLE adsets ADD COLUMN IF NOT EXISTS campaign_id text;
ALTER TABLE adsets ADD COLUMN IF NOT EXISTS account_id text;
ALTER TABLE adsets ADD COLUMN IF NOT EXISTS daily_budget_cents integer;
ALTER TABLE adsets ADD COLUMN IF NOT EXISTS goal text;
ALTER TABLE adsets ADD COLUMN IF NOT EXISTS launch_id bigint;
ALTER TABLE adsets ADD COLUMN IF NOT EXISTS changed_at timestamptz;
-- the shop's photos and videos used by its ads: the Planner's clean-up leaves them alone
ALTER TABLE cm_media ADD COLUMN IF NOT EXISTS for_ads boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS ad_campaigns (
  id                 text        PRIMARY KEY,
  account_id         text        NOT NULL DEFAULT '',
  name               text        NOT NULL DEFAULT '',
  objective          text,
  status             text,
  daily_budget_cents integer,
  bid_strategy       text,
  launch_id          bigint,
  changed_at         timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ad_actions (
  id           bigserial   PRIMARY KEY,
  client_id    text        UNIQUE,
  level        text        NOT NULL DEFAULT 'adset',
  object_id    text        NOT NULL,
  object_name  text        NOT NULL DEFAULT '',
  op           text        NOT NULL,
  before       jsonb,
  after        jsonb,
  source       text        NOT NULL DEFAULT 'person',
  rule_key     text,
  status       text        NOT NULL DEFAULT 'done',
  why          text,
  error        text,
  by_user      bigint,
  approved_by  bigint,
  undo_of      bigint,
  created_at   timestamptz NOT NULL DEFAULT now(),
  done_at      timestamptz
);
CREATE INDEX IF NOT EXISTS ad_actions_object ON ad_actions (object_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ad_actions_waiting ON ad_actions (created_at) WHERE status = 'waiting_yes';

CREATE TABLE IF NOT EXISTS ad_launches (
  id           bigserial   PRIMARY KEY,
  client_id    text        UNIQUE,
  mode         text        NOT NULL DEFAULT 'simple',
  goal         text        NOT NULL,
  product_id   bigint,
  name         text        NOT NULL DEFAULT '',
  spec         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  budget_cents integer     NOT NULL DEFAULT 0,
  status       text        NOT NULL DEFAULT 'draft',
  step         text,
  campaign_id  text,
  adset_ids    text[]      NOT NULL DEFAULT '{}',
  ad_ids       text[]      NOT NULL DEFAULT '{}',
  meta_ids     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  error        text,
  by_user      bigint,
  approved_by  bigint,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  live_at      timestamptz
);
CREATE INDEX IF NOT EXISTS ad_launches_recent ON ad_launches (created_at DESC);

CREATE TABLE IF NOT EXISTS ad_suggestions (
  id           bigserial   PRIMARY KEY,
  rule_key     text        NOT NULL,
  object_id    text        NOT NULL,
  object_name  text        NOT NULL DEFAULT '',
  op           text        NOT NULL,
  value        numeric(10,2),
  why          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status       text        NOT NULL DEFAULT 'open',
  action_id    bigint,
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  decided_by   bigint
);
CREATE UNIQUE INDEX IF NOT EXISTS ad_suggestions_one_open ON ad_suggestions (rule_key, object_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS ad_audiences (
  kind       text        PRIMARY KEY,
  is_on      boolean     NOT NULL DEFAULT true,
  meta_id    text,
  size       integer     NOT NULL DEFAULT 0,
  status     text        NOT NULL DEFAULT 'waiting',
  error      text,
  synced_at  timestamptz
);
`;
