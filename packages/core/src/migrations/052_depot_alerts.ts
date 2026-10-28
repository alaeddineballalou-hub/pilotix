// Dépôt alerts: an order still in the depot (à préparer / préparée) was changed or cancelled by someone outside the
// depot — the depot agents get a red alert that blocks the app until they say the parcel is fixed.
export default `
CREATE TABLE IF NOT EXISTS depot_alerts (
  id          bigserial PRIMARY KEY,
  order_id    bigint      NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind        text        NOT NULL CHECK (kind IN ('edit', 'cancel')),
  stage       text,
  changes     jsonb       NOT NULL DEFAULT '[]',
  created_by  bigint REFERENCES profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by bigint REFERENCES profiles(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS depot_alerts_open ON depot_alerts (created_at) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS depot_alerts_order ON depot_alerts (order_id);
`;
