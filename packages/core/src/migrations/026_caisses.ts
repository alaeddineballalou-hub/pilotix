// Caisses: the owner's main caisse, the bank, and one caisse per employee. Money received from a company or a livreur
// goes into the caisse of whoever received it (cash_handovers.received_into; NULL = main, as before). Expenses, manual
// entries and transfers between caisses are cash_moves (a transfer is two moves sharing pair_id).
export default `
ALTER TABLE cash_handovers ADD COLUMN IF NOT EXISTS received_into text;

CREATE TABLE IF NOT EXISTS cash_moves (
  id           bigserial PRIMARY KEY,
  caisse       text        NOT NULL,
  amount       bigint      NOT NULL,
  kind         text        NOT NULL CHECK (kind IN ('expense', 'income', 'transfer')),
  category     text,
  note         text,
  pair_id      bigint,
  created_by   bigint      REFERENCES profiles(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz
);
CREATE INDEX IF NOT EXISTS cash_moves_caisse ON cash_moves (caisse, created_at DESC);
CREATE INDEX IF NOT EXISTS cash_handovers_into ON cash_handovers (received_into);
`;
