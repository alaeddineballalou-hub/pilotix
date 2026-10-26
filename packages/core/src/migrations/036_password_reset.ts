// "Mot de passe oublié": one-time links sent by e-mail. Only a SHA-256 of the link's secret is stored, so a copy of
// the database cannot be used to change anyone's password. A link works once, for 30 minutes, and a newer link
// cancels the older ones.
export default `
CREATE TABLE IF NOT EXISTS password_resets (
  id          bigserial   PRIMARY KEY,
  profile_id  bigint      NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  token_hash  text        NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_resets_profile ON password_resets (profile_id, created_at);
`;
