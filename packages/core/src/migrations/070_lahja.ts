// Darija (lahja) lessons of this shop: a team member writes how Dellal should have said one of its messages; the words they
// changed become a lesson, used at once by this shop's Dellal and Pilot Comments (modules/lahja.ts). The message that was
// sent never changes.
export default `
CREATE TABLE IF NOT EXISTS dellal_lahja (
  id bigserial PRIMARY KEY,
  words jsonb NOT NULL DEFAULT '[]',
  before text NOT NULL DEFAULT '',
  after text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  conversation_id bigint,
  message_id bigint,
  created_by bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;
