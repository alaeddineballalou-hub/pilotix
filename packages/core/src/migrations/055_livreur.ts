// « Ma tournée »: « Je travaille aujourd'hui » — the livreurs who said they work today (« À attribuer » shows it).
export default `
CREATE TABLE IF NOT EXISTS livreur_checkins (
  profile_id  bigint      NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  day         date        NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, day)
);
`;
