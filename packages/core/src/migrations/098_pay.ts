// Agent pay (Caisse › Paie, Ma caisse): one plan per job for each person (a copy kept with its date: editing a plan never
// changes past pay), what the shop paid them (from a caisse) and whether they say they got it, and the acomptes they ask.
/**
 * The plans already given to agents in Management › Plans (« Agent Pay ») carry over to their job, for active people of
 * the shop who still do that job (owners and vendeurs are not paid here). Each counts from the start of the current pay
 * period: the shop's pay days start monthly (the 1st, 00:00 in Algiers = UTC+1) until the owner changes them, and what
 * came before was paid the old way.
 */
export const PAY_CARRY_OVER = [
  `INSERT INTO pay_plan_slots (profile_id, task, plan_id)
   SELECT a.target_id, COALESCE(p.configuration->>'agentTask', 'confirmation'), a.plan_id
     FROM management_plan_assignments a
     JOIN management_payment_plans p ON p.id = a.plan_id AND p.kind = 'agent'
     JOIN profiles f ON f.id = a.target_id AND f.active AND f.archived_at IS NULL AND f.agency_id IS NULL
    WHERE a.target_kind = 'agent'
      AND NOT (f.roles && ARRAY['admin','vendeur']::text[])
      AND CASE COALESCE(p.configuration->>'agentTask', 'confirmation')
            WHEN 'confirmation' THEN f.roles && ARRAY['confirmation','agent_manager']::text[]
            WHEN 'superviseur' THEN 'agent_manager' = ANY (f.roles)
            WHEN 'suivi' THEN 'suivi' = ANY (f.roles)
            WHEN 'depot' THEN 'depot' = ANY (f.roles)
            ELSE false
          END
   ON CONFLICT (profile_id, task) DO NOTHING`,
  `INSERT INTO pay_plan_terms (profile_id, task, plan_id, name, configuration, effective_at)
   SELECT s.profile_id, s.task, s.plan_id, p.name, p.configuration || jsonb_build_object('agentTask', s.task),
          (date_trunc('month', (now() AT TIME ZONE 'UTC') + interval '1 hour') - interval '1 hour') AT TIME ZONE 'UTC'
     FROM pay_plan_slots s
     JOIN management_payment_plans p ON p.id = s.plan_id
    WHERE NOT EXISTS (SELECT 1 FROM pay_plan_terms t WHERE t.profile_id = s.profile_id AND t.task = s.task)`,
];

export default `
CREATE TABLE IF NOT EXISTS pay_plan_slots (
  profile_id bigint      NOT NULL REFERENCES profiles(id),
  task       text        NOT NULL CHECK (task IN ('confirmation','suivi','superviseur','depot')),
  plan_id    bigint      NOT NULL REFERENCES management_payment_plans(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, task)
);
CREATE TABLE IF NOT EXISTS pay_plan_terms (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  profile_id    bigint      NOT NULL REFERENCES profiles(id),
  task          text        NOT NULL CHECK (task IN ('confirmation','suivi','superviseur','depot')),
  plan_id       bigint      REFERENCES management_payment_plans(id),
  name          text        NOT NULL,
  configuration jsonb,
  effective_at  timestamptz NOT NULL,
  created_by    bigint      REFERENCES profiles(id),
  CHECK ((plan_id IS NULL) = (configuration IS NULL))
);
CREATE INDEX IF NOT EXISTS pay_plan_terms_history ON pay_plan_terms (profile_id, task, effective_at, id);
CREATE TABLE IF NOT EXISTS pay_requests (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  profile_id  bigint      NOT NULL REFERENCES profiles(id),
  amount      integer     NOT NULL CHECK (amount > 0),
  note        text,
  status      text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','refused','cancelled')),
  asked_at    timestamptz NOT NULL DEFAULT now(),
  decided_by  bigint      REFERENCES profiles(id),
  decided_at  timestamptz,
  reason      text
);
CREATE UNIQUE INDEX IF NOT EXISTS pay_requests_one_pending ON pay_requests (profile_id) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS pay_payments (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  profile_id   bigint      NOT NULL REFERENCES profiles(id),
  kind         text        NOT NULL CHECK (kind IN ('pay','acompte')),
  period_from  timestamptz,
  period_to    timestamptz,
  amount       integer     NOT NULL CHECK (amount > 0),
  details      jsonb,
  caisse       text        NOT NULL,
  cash_move_id bigint      REFERENCES cash_moves(id),
  request_id   bigint      REFERENCES pay_requests(id),
  paid_by      bigint      REFERENCES profiles(id),
  paid_at      timestamptz NOT NULL DEFAULT now(),
  status       text        NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','received','not_received','cancelled')),
  answered_at  timestamptz,
  note         text,
  cancelled_by bigint      REFERENCES profiles(id),
  cancelled_at timestamptz,
  CHECK ((kind = 'pay') = (period_from IS NOT NULL AND period_to IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS pay_payments_person ON pay_payments (profile_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS pay_payments_waiting ON pay_payments (status) WHERE status IN ('paid','not_received');
${PAY_CARRY_OVER.join(';\n')};
`;
