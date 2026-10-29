// Communes written another way: « Bab Ezzouar » on an order is the official « Bab Azzouar » — corrected once in Pilot
// Auto Assign › « À corriger », then recognized everywhere (Pilot's rules, the checks).
export default `
CREATE TABLE IF NOT EXISTS commune_aliases (
  wilaya_id   smallint    NOT NULL,
  alias       text        NOT NULL,
  commune     text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wilaya_id, alias)
);
`;
