// Landing pages › Groupes: one page with several products (each opens its own landing page). Its address is
// site/<store>/<slug>, like a landing page's (the two never share an address). clicks: how many visitors opened each
// product from the group (its orders are counted from the order's utm « g »).
export default `
CREATE TABLE IF NOT EXISTS landing_groups (
  id         bigserial   PRIMARY KEY,
  slug       text        NOT NULL UNIQUE,
  active     boolean     NOT NULL DEFAULT true,
  title      text        NOT NULL DEFAULT '',
  subtitle   text        NOT NULL DEFAULT '',
  color      text        NOT NULL DEFAULT '#0f766e',
  theme      text        NOT NULL DEFAULT 'grid',   -- grid, big, best, list, tabs
  best_page_id bigint,
  items      jsonb       NOT NULL DEFAULT '[]',     -- [{ pageId, tab, note }] in the order shown
  pixel_id   text,
  views      integer     NOT NULL DEFAULT 0,
  created_by bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS landing_group_clicks (
  group_id bigint  NOT NULL REFERENCES landing_groups(id) ON DELETE CASCADE,
  page_id  bigint  NOT NULL,
  clicks   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, page_id)
);
CREATE INDEX IF NOT EXISTS orders_utm_group ON orders ((utm->>'g')) WHERE utm ? 'g';
`;
