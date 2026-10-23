// The courier's services used from Pilotix (ZR Express), so nobody needs the courier's website:
//  - pickup bags (sacs de ramassage): the parcels handed to the courier's driver in one bag, with the bag's label;
//  - modification requests: price, home / stop desk, address or phone of a parcel already sent, validated by the courier;
//  - exchanges: the courier's return parcel that brings the old product back (its own number, scanned at the depot).
export default `
CREATE TABLE IF NOT EXISTS pickup_bags (
  id          bigserial PRIMARY KEY,
  company_id  bigint      NOT NULL REFERENCES delivery_companies(id) ON DELETE CASCADE,
  ext_id      text,
  tracking    text,
  state       text,
  parcels     integer     NOT NULL DEFAULT 0,
  unprocessed integer,
  created_by  bigint REFERENCES profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  synced_at   timestamptz,
  deleted_at  timestamptz
);
CREATE INDEX IF NOT EXISTS pickup_bags_company ON pickup_bags (company_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS pickup_bag_parcels (
  bag_id   bigint      NOT NULL REFERENCES pickup_bags(id) ON DELETE CASCADE,
  order_id bigint      NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bag_id, order_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS pickup_bag_parcels_order ON pickup_bag_parcels (order_id);

CREATE TABLE IF NOT EXISTS parcel_changes (
  id          bigserial PRIMARY KEY,
  order_id    bigint      NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  company_id  bigint      NOT NULL REFERENCES delivery_companies(id) ON DELETE CASCADE,
  ext_id      text,
  kind        text        NOT NULL,
  old         jsonb       NOT NULL DEFAULT '{}',
  new         jsonb       NOT NULL DEFAULT '{}',
  status      text        NOT NULL DEFAULT 'pending',
  answer      text,
  error       text,
  note        text,
  created_by  bigint REFERENCES profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz,
  synced_at   timestamptz,
  applied_at  timestamptz
);
CREATE INDEX IF NOT EXISTS parcel_changes_order ON parcel_changes (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS parcel_changes_pending ON parcel_changes (company_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS parcel_returns (
  order_id   bigint      PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  company_id bigint      REFERENCES delivery_companies(id) ON DELETE SET NULL,
  tracking   text        NOT NULL,
  ext_id     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS parcel_returns_tracking ON parcel_returns (upper(tracking));
`;
