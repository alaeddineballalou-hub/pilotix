// « Confirmer quand même »: each order confirmed while its customer was « Risqué » (the warning showed why and the agent
// went on): who confirmed it, the score and its reasons at that moment. Dashboard › Confirmation shows each agent's, and
// what became of those parcels.
export default `
CREATE TABLE IF NOT EXISTS risk_confirms (
  order_id bigint PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  user_id  bigint,
  score    smallint NOT NULL,
  reasons  jsonb NOT NULL DEFAULT '[]',
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS risk_confirms_at ON risk_confirms (at);
`;
