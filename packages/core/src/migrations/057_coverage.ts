// Sociétés de livraison › « Couverture »: where each company (and « Livraison privée ») delivers.
//  - company_wilayas: the seller's own switch per company and wilaya (no row: the company's list decides — a price
//    there, or always for our own livreurs and companies without tariffs);
//  - commune_aliases: a commune written another way (« Bab Ezzouar ») and the official one it is (« Bab Azzouar »),
//    corrected once in « À corriger », then recognized everywhere (Pilot's rules, the checks).
export default `
CREATE TABLE IF NOT EXISTS company_wilayas (
  company_id  bigint      NOT NULL REFERENCES delivery_companies(id) ON DELETE CASCADE,
  wilaya_id   smallint    NOT NULL,
  on_         boolean     NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, wilaya_id)
);
CREATE TABLE IF NOT EXISTS commune_aliases (
  wilaya_id   smallint    NOT NULL,
  alias       text        NOT NULL,
  commune     text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wilaya_id, alias)
);
`;
