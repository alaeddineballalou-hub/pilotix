// Who is responsible for a problem (the owner's request, 25 Nov 2026): one line per order — the parcel that came back,
// the one the Suivi gave to another customer, the problem after delivery (SAV). The agent says what happened (`reason`,
// the answer to its question in `answers`, a photo after delivery); Pilotix decides the team (`team`) and the person
// (`person_id`, or `person_label`: the courier, the product) with its rules (modules/faults.ts). `cost`: what the return
// cost in DA (the courier's return fee). « Pas moi »: `contest_*`, until an admin or the seller decides (`decided_*`).
// Statistics only: nothing here touches the pay.
// On the live server (shared tables), tenantization adds shop_id to this table and to its keys, like every other.
export default `
CREATE TABLE IF NOT EXISTS order_faults (
  id           bigserial PRIMARY KEY,
  order_id     bigint      NOT NULL UNIQUE,
  moment       text        NOT NULL,
  reason       text        NOT NULL,
  team         text        NOT NULL,
  person_id    bigint,
  person_label text,
  reported_by  bigint,
  answers      jsonb,
  note         text,
  photo        text,
  ticket_id    bigint,
  cost         integer     NOT NULL DEFAULT 0,
  contest_by   bigint,
  contest_note text,
  contest_at   timestamptz,
  decided_by   bigint,
  decided_at   timestamptz,
  at           timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_faults_team ON order_faults (team, at);
CREATE INDEX IF NOT EXISTS order_faults_person ON order_faults (person_id, at);
CREATE INDEX IF NOT EXISTS order_faults_contest ON order_faults (contest_at) WHERE contest_at IS NOT NULL AND decided_at IS NULL;
`;
