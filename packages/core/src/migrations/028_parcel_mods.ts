// Demandes de modification of a parcel already at the courier (ZR): new amount, home ↔ stop desk, right commune.
// The order keeps its values until the courier approves; then Pilotix applies the new ones.
export default `
CREATE TABLE IF NOT EXISTS parcel_mods (
  id          bigserial PRIMARY KEY,
  order_id    bigint      NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  company_id  bigint,
  kinds       text[]      NOT NULL DEFAULT '{}',            -- price, type, commune
  old_values  jsonb       NOT NULL DEFAULT '{}',
  new_values  jsonb       NOT NULL DEFAULT '{}',
  note        text        NOT NULL DEFAULT '',
  status      text        NOT NULL DEFAULT 'pending',       -- pending, approved, refused, error, cancelled
  ext_id      text,
  ext_error   text,
  ext_comment text,
  created_by  bigint,
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz,
  synced_at   timestamptz
);
CREATE INDEX IF NOT EXISTS parcel_mods_order ON parcel_mods (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS parcel_mods_pending ON parcel_mods (company_id) WHERE status = 'pending';
`;
