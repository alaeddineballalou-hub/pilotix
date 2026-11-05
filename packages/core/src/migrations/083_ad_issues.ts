// Co-Pilot › Publicités: what Meta's ad account webhooks said about the shop's ads (an ad, ad set or campaign rejected or
// with a problem). One line per ad object; « resolved_at » once Meta says it runs again (or the problem is gone).
export default `
CREATE TABLE IF NOT EXISTS ad_issues (
  object_id    text        PRIMARY KEY,
  account_id   text        NOT NULL DEFAULT '',
  level        text        NOT NULL DEFAULT 'AD',
  kind         text        NOT NULL DEFAULT 'issue',
  code         text,
  summary      text,
  message      text,
  at           timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);
CREATE INDEX IF NOT EXISTS ad_issues_open ON ad_issues (at) WHERE resolved_at IS NULL;
`;
