// Pilot Comments › Tester: each test keeps what the agent would answer, so a team member can teach it from there
// (« Leçon de darija », as in Pilot Message › Tester). Kept 30 days. A lesson remembers the test it came from.
export default `
CREATE TABLE IF NOT EXISTS cm_tests (
  id            bigserial   PRIMARY KEY,
  body          text        NOT NULL DEFAULT '',
  public_reply  text,
  private_reply text,
  created_by    bigint,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE dellal_lahja ADD COLUMN IF NOT EXISTS cm_test_id bigint;
`;
