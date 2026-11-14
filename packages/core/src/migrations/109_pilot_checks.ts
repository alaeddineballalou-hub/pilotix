// Pilot Automations › Pilot Checks (modules/pilotchecks.ts): the owner's own rules for the cases of the « Pilotix Judge »
// (packages/shared/src/pilotchecks.ts). A row holds only what he changed for a case — its limit(s), its helper (off,
// doctor, bell, door), how much data it waits for, his own words for the action and the other part to fix; an empty
// column means « the starting value ». Every change writes a line in pilot_check_log (who, when, old, new): nothing he
// typed is lost. Two new tables only: nothing else changes, every shop's database takes it the same way.
export default `
CREATE TABLE IF NOT EXISTS pilot_checks (
  id         text        PRIMARY KEY,
  v          numeric,
  v2         numeric,
  level      text,
  wait       numeric,
  action     text,
  other      text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint
);

CREATE TABLE IF NOT EXISTS pilot_check_log (
  id       bigserial   PRIMARY KEY,
  check_id text        NOT NULL,
  field    text        NOT NULL,
  old      text,
  new      text,
  user_id  bigint,
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pilot_check_log_at ON pilot_check_log (at DESC, id DESC);
CREATE INDEX IF NOT EXISTS pilot_check_log_check ON pilot_check_log (check_id, at DESC);
`;
