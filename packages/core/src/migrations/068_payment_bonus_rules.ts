// Independent, effective-dated bonus rules. Old plan snapshots remain untouched.
export default `
CREATE TABLE IF NOT EXISTS management_bonus_rules (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('billing','agent')),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  trigger text NOT NULL CHECK (trigger IN ('confirmed','delivered')),
  threshold integer NOT NULL CHECK (threshold > 0 AND threshold <= 1000000),
  amount integer NOT NULL CHECK (amount >= 0 AND amount <= 10000000),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS management_bonus_assignments (
  target_kind text NOT NULL CHECK (target_kind IN ('seller','agent')),
  target_id bigint NOT NULL,
  bonus_id bigint NOT NULL REFERENCES management_bonus_rules(id) ON DELETE RESTRICT,
  PRIMARY KEY(target_kind,target_id,bonus_id)
);
CREATE INDEX IF NOT EXISTS management_bonus_assignments_bonus ON management_bonus_assignments(bonus_id);
CREATE TABLE IF NOT EXISTS management_bonus_terms (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_kind text NOT NULL CHECK (target_kind IN ('seller','agent')),
  target_id bigint NOT NULL,
  bonus_id bigint NOT NULL REFERENCES management_bonus_rules(id) ON DELETE RESTRICT,
  name text NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('confirmed','delivered')),
  threshold integer NOT NULL CHECK (threshold > 0),
  amount integer NOT NULL CHECK (amount >= 0),
  enabled boolean NOT NULL,
  effective_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS management_bonus_terms_history ON management_bonus_terms(target_kind,target_id,bonus_id,effective_at,id);
`;