// Products & stock: suppliers and purchases (a purchase brings stock in at a purchase price), inventories (a full count
// of a depot validated in one go), and the link from a stock movement to the purchase or inventory that made it.
export default `
CREATE TABLE IF NOT EXISTS suppliers (
  id         bigserial PRIMARY KEY,
  name       text        NOT NULL,
  phone      text        NOT NULL DEFAULT '',
  address    text        NOT NULL DEFAULT '',
  note       text        NOT NULL DEFAULT '',
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purchases (
  id           bigserial PRIMARY KEY,
  ref          text        NOT NULL UNIQUE,              -- ACH-0001
  supplier_id  bigint      REFERENCES suppliers(id),
  warehouse_id bigint      NOT NULL REFERENCES warehouses(id),
  total        integer     NOT NULL DEFAULT 0,           -- sum of qty × unit cost (DA)
  paid         integer     NOT NULL DEFAULT 0,           -- paid to the supplier so far (DA)
  paid_at      timestamptz,
  note         text        NOT NULL DEFAULT '',
  created_by   bigint,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS purchases_supplier ON purchases (supplier_id, created_at DESC);
CREATE INDEX IF NOT EXISTS purchases_created ON purchases (created_at DESC);

CREATE TABLE IF NOT EXISTS purchase_lines (
  id          bigserial PRIMARY KEY,
  purchase_id bigint  NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  variant_id  bigint  NOT NULL REFERENCES product_variants(id),
  qty         integer NOT NULL CHECK (qty > 0),
  unit_cost   integer NOT NULL CHECK (unit_cost >= 0)
);
CREATE INDEX IF NOT EXISTS purchase_lines_purchase ON purchase_lines (purchase_id);

CREATE TABLE IF NOT EXISTS inventories (
  id           bigserial PRIMARY KEY,
  ref          text        NOT NULL UNIQUE,              -- INV-0001
  warehouse_id bigint      NOT NULL REFERENCES warehouses(id),
  counted      integer     NOT NULL DEFAULT 0,           -- products counted
  changed      integer     NOT NULL DEFAULT 0,           -- products whose stock changed
  found        integer     NOT NULL DEFAULT 0,           -- pieces more than expected
  missing      integer     NOT NULL DEFAULT 0,           -- pieces less than expected
  value        integer     NOT NULL DEFAULT 0,           -- the difference at purchase price (DA, can be negative)
  note         text        NOT NULL DEFAULT '',
  created_by   bigint,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inventories_created ON inventories (created_at DESC);

ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS purchase_id bigint REFERENCES purchases(id) ON DELETE SET NULL;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS inventory_id bigint REFERENCES inventories(id) ON DELETE SET NULL;
`;
