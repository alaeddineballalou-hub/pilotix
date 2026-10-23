// Courier payments (ZR treasury): what the company holds for us, the payment requests Pilotix sends, and each payment
// the company made — imported with its details and parcels, as a versement into a caisse.
export default `
CREATE TABLE IF NOT EXISTS courier_payments (
  id          bigserial PRIMARY KEY,
  company_id  bigint      NOT NULL REFERENCES delivery_companies(id) ON DELETE CASCADE,
  ext_id      text        NOT NULL,
  ref         text,
  amount      bigint      NOT NULL DEFAULT 0,
  status      text        NOT NULL DEFAULT '',
  done        boolean     NOT NULL DEFAULT false,
  at          timestamptz,
  done_at     timestamptz,
  place       text,
  request_id  text,
  details     jsonb       NOT NULL DEFAULT '{}',
  lines       jsonb,
  handover_id bigint,
  move_id     bigint,
  caisse      text,
  matched     integer     NOT NULL DEFAULT 0,
  unmatched   integer     NOT NULL DEFAULT 0,
  imported_at timestamptz,
  imported_by bigint REFERENCES profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, ext_id)
);
CREATE INDEX IF NOT EXISTS courier_payments_company ON courier_payments (company_id, at DESC);
CREATE TABLE IF NOT EXISTS courier_pay_requests (
  id         bigserial PRIMARY KEY,
  company_id bigint      NOT NULL REFERENCES delivery_companies(id) ON DELETE CASCADE,
  ext_id     text        NOT NULL,
  date       date,
  approved   boolean,
  comment    text,
  at         timestamptz,
  auto       boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, ext_id)
);
CREATE TABLE IF NOT EXISTS courier_balances (
  company_id bigint PRIMARY KEY REFERENCES delivery_companies(id) ON DELETE CASCADE,
  paid       bigint NOT NULL DEFAULT 0,
  ready      bigint NOT NULL DEFAULT 0,
  delivered  bigint NOT NULL DEFAULT 0,
  not_ready  bigint NOT NULL DEFAULT 0,
  error      text,
  at         timestamptz NOT NULL DEFAULT now()
);
`;
