// Pilot Automations › Pilot Checks (modules/pilotchecks.ts): the list became the owner's 83 KPI checks (18 Nov 2026).
// A check can now have a « good » line (g) and a second line worse than « bad » (s: stop or urgent), and the shop has
// general settings that belong to no single check (how long before an ad is judged, how sure before a stop, the budget
// steps…): pilot_check_settings keeps only the ones the owner changed (key, value).
//
// The rows he saved for the first list (71 cases) stay in pilot_checks, marked list = 'v1': the app no longer reads
// them (several ids changed meaning), and a check he edits again takes list = 'v3'. The same for the change list:
// the lines written for the first list stay in pilot_check_log, marked list = 'v1' and no longer shown (« O2 : 30 →
// 45 » would read as a change of the new O2). Nothing he typed is deleted. A general setting is logged with
// check_id '*' and field = its key.
export default `
ALTER TABLE pilot_checks ADD COLUMN IF NOT EXISTS g numeric;
ALTER TABLE pilot_checks ADD COLUMN IF NOT EXISTS s numeric;
ALTER TABLE pilot_checks ADD COLUMN IF NOT EXISTS list text NOT NULL DEFAULT 'v1';
ALTER TABLE pilot_check_log ADD COLUMN IF NOT EXISTS list text NOT NULL DEFAULT 'v1';

CREATE TABLE IF NOT EXISTS pilot_check_settings (
  key        text        PRIMARY KEY,
  v          numeric     NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint
);
`;
