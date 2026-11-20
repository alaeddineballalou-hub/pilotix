// Landing pages › Réglages › « Team et fournisseurs » (20 Nov 2026, modules/landinglists.ts): the numbers added by hand
// to each list (the team's own Pilotix accounts and Stock › Fournisseurs count by themselves), and the team's test
// orders, which never become real orders (Protection › « Tests de l'équipe »).
export default `
CREATE TABLE IF NOT EXISTS landing_lists (
  kind      text        NOT NULL,
  phone     text        NOT NULL,
  name      text        NOT NULL DEFAULT '',
  added_by  bigint,
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, phone)
);

CREATE TABLE IF NOT EXISTS landing_tests (
  id            bigserial   PRIMARY KEY,
  landing_id    bigint,
  product_id    bigint,
  variant_id    bigint,
  qty           integer     NOT NULL DEFAULT 1,
  unit_price    integer     NOT NULL DEFAULT 0,
  customer_name text        NOT NULL DEFAULT '',
  phone         text        NOT NULL,
  wilaya_id     smallint,
  commune       text        NOT NULL DEFAULT '',
  from_ad       boolean     NOT NULL DEFAULT false,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS landing_tests_at ON landing_tests (at DESC);
`;
