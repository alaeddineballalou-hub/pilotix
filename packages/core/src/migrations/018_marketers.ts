// Marketing › Marketer: paying marketers per ad set. The marketer of an ad set is adsets.marketer_id (012);
// here: each marketer's price per successful ad set, a result chosen by hand, and the payments made.
// The rules (threshold, × price) live in settings under 'mk_rules'.
export default `
CREATE TABLE IF NOT EXISTS marketer_prices (
  profile_id bigint PRIMARY KEY,
  price      integer     NOT NULL DEFAULT 0,      -- DA per successful ad set
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Result set by hand by the owner (wins over the calculation): ok = réussi, ko = raté, run = en cours.
CREATE TABLE IF NOT EXISTS mk_results (
  adset_id text PRIMARY KEY,
  st       text        NOT NULL CHECK (st IN ('ok', 'ko', 'run')),
  set_by   bigint,
  set_at   timestamptz NOT NULL DEFAULT now()
);

-- One payment per ad set, with the figures it was paid on.
CREATE TABLE IF NOT EXISTS mk_payments (
  adset_id    text PRIMARY KEY,
  marketer_id bigint      NOT NULL,
  amount      integer     NOT NULL,
  net         integer,
  marge       integer,
  paid_by     bigint,
  paid_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mk_payments_marketer ON mk_payments (marketer_id);
`;
