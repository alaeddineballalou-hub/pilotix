// « J'ai pris » can be undone for a few seconds (a wrong number, a double tap): each pick keeps what it changed — the
// order lines it served (and their quantity before), the pool and the « À ramener » line before — until it is done.
export default `
CREATE TABLE IF NOT EXISTS depot_pick_log (
  id             bigserial PRIMARY KEY,
  user_id        bigint,
  product_id     bigint NOT NULL,
  variant_id     bigint,
  qty            integer NOT NULL,
  served         jsonb NOT NULL DEFAULT '[]',
  pool_before    integer NOT NULL DEFAULT 0,
  restock_before integer,
  created_at     timestamptz NOT NULL DEFAULT now(),
  done_at        timestamptz,
  undone_at      timestamptz
);
CREATE INDEX IF NOT EXISTS depot_pick_log_open ON depot_pick_log (created_at) WHERE done_at IS NULL AND undone_at IS NULL;
`;
