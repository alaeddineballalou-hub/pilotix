// Point de vente (modules/pos.ts): the boutique's counter, off until an administrator turns it on (Management › Modules).
//  - pos_sessions: a drawer, from its opening (the float put in it) to its clôture (the cash counted, the gap). One open
//    at a time.
//  - pos_sales / pos_lines: each paid sale (its number, its payment, the dépôt its products left, the caisse its money
//    went into) and its lines as they were priced. A cancelled sale keeps its row (cancelled_at).
export default `
CREATE TABLE IF NOT EXISTS pos_sessions (
  id          bigserial   PRIMARY KEY,
  opened_at   timestamptz NOT NULL DEFAULT now(),
  opened_by   bigint,
  opening     integer     NOT NULL DEFAULT 0,
  closed_at   timestamptz,
  closed_by   bigint,
  expected    integer,
  counted     integer,
  gap         integer,
  counts      jsonb,
  note        text,
  gap_move_id bigint
);
CREATE UNIQUE INDEX IF NOT EXISTS pos_sessions_open ON pos_sessions ((closed_at IS NULL)) WHERE closed_at IS NULL;

CREATE TABLE IF NOT EXISTS pos_sales (
  id           bigserial   PRIMARY KEY,
  ticket       integer     NOT NULL UNIQUE,
  at           timestamptz NOT NULL DEFAULT now(),
  session_id   bigint      NOT NULL REFERENCES pos_sessions(id),
  seller_id    bigint,
  customer_id  bigint,
  method       text        NOT NULL CHECK (method IN ('cash', 'baridimob', 'card')),
  total        integer     NOT NULL,
  saved        integer     NOT NULL DEFAULT 0,
  items        integer     NOT NULL,
  warehouse_id bigint      NOT NULL,
  caisse       text        NOT NULL,
  cash_move_id bigint,
  cancelled_at timestamptz,
  cancelled_by bigint
);
CREATE INDEX IF NOT EXISTS pos_sales_at ON pos_sales (at DESC);

CREATE TABLE IF NOT EXISTS pos_lines (
  id         bigserial PRIMARY KEY,
  sale_id    bigint    NOT NULL REFERENCES pos_sales(id) ON DELETE CASCADE,
  product_id bigint    NOT NULL,
  variant_id bigint    NOT NULL,
  name       text      NOT NULL,
  variant    text      NOT NULL DEFAULT '',
  sku        text      NOT NULL DEFAULT '',
  qty        integer   NOT NULL,
  unit       integer   NOT NULL,
  total      integer   NOT NULL
);
CREATE INDEX IF NOT EXISTS pos_lines_sale ON pos_lines (sale_id);
`;
