// Seller-owned plan configuration. No invoices or payroll are recalculated by this migration.
export default `
CREATE TABLE IF NOT EXISTS management_payment_plans (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('billing','agent')),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  configuration jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS management_plan_assignments (
  target_kind text NOT NULL CHECK (target_kind IN ('product','agent')),
  target_id bigint NOT NULL,
  plan_id bigint NOT NULL REFERENCES management_payment_plans(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (target_kind,target_id)
);
CREATE INDEX IF NOT EXISTS management_plan_assignments_plan_idx ON management_plan_assignments(plan_id);
`;
