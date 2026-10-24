// Caisses the owner creates himself (a safe, the depot's cash box, a BaridiMob account…), next to the main caisse, the bank
// and the employees' caisses. Key 'c<id>'. A removed caisse keeps its history (removed_at) and takes no more money.
export default `
CREATE TABLE IF NOT EXISTS caisses (
  id         bigserial PRIMARY KEY,
  name       text        NOT NULL,
  kind       text        NOT NULL DEFAULT 'cash',   -- cash, bank, mobile
  created_by bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz
);
`;
