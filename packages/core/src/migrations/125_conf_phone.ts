// Confirmation › « Bloquer jusqu'à l'appel » (owner's ask, 22 Nov 2026): an agent's phone must ring before he can work.
// Each notification sent to a phone carries a one-time code its worker sends back when it arrives (sw.js): the phone is
// known to ring (ack_at), or not (asked_at long ago, no answer). heard_at: the agent heard the test ring at full volume.
export default `
ALTER TABLE push_subs ADD COLUMN IF NOT EXISTS ack_code text;
ALTER TABLE push_subs ADD COLUMN IF NOT EXISTS asked_at timestamptz;
ALTER TABLE push_subs ADD COLUMN IF NOT EXISTS ack_at timestamptz;
ALTER TABLE push_subs ADD COLUMN IF NOT EXISTS heard_at timestamptz;
CREATE INDEX IF NOT EXISTS push_subs_ack ON push_subs (ack_code) WHERE ack_code IS NOT NULL;
`;
