// Assignment revisions keep old operations on their old rules. No existing contract or pay is changed.
export default `
CREATE TABLE management_agent_terms (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  profile_id bigint NOT NULL REFERENCES profiles(id),
  plan_id bigint REFERENCES management_payment_plans(id),
  name text NOT NULL,
  configuration jsonb,
  effective_at timestamptz NOT NULL,
  CHECK ((plan_id IS NULL) = (configuration IS NULL))
);
INSERT INTO management_agent_terms(profile_id,plan_id,name,configuration,effective_at)
SELECT a.target_id,p.id,p.name,p.configuration,now() FROM management_plan_assignments a
JOIN management_payment_plans p ON p.id=a.plan_id JOIN profiles u ON u.id=a.target_id
WHERE a.target_kind='agent' AND p.kind='agent' AND p.active AND u.active AND u.agency_id IS NULL;
CREATE INDEX management_agent_terms_history ON management_agent_terms(profile_id, effective_at, id);
CREATE TABLE management_billing_terms (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  link_id integer NOT NULL,
  product_id bigint NOT NULL DEFAULT 0 CHECK(product_id >= 0),
  plan_id bigint REFERENCES management_payment_plans(id),
  name text NOT NULL,
  configuration jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
  proposed_at timestamptz NOT NULL,
  effective_at timestamptz,
  CHECK ((plan_id IS NULL) = (configuration IS NULL)),
  CHECK ((status = 'accepted') = (effective_at IS NOT NULL))
);
CREATE UNIQUE INDEX management_billing_terms_pending ON management_billing_terms(link_id, product_id) WHERE status='pending';
CREATE INDEX management_billing_terms_history ON management_billing_terms(link_id, effective_at, id);
CREATE TABLE management_payrolls (
  month text PRIMARY KEY CHECK(month ~ '^\\d{4}-(0[1-9]|1[0-2])$'),
  details jsonb NOT NULL,
  total bigint NOT NULL CHECK(total >= 0),
  closed_at timestamptz NOT NULL
);
`;
