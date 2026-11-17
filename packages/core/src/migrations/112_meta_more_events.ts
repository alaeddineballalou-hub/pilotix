// Landing pages › Meta: « Lead » (the form of a clean order), « FakeOrder » and « Competitor » (an order an agent marked
// fake, a blocked order nobody restored in a day) join Purchase and InitiateCheckout in the outbox (meta_events).
// A blocked order has no order row: its event names it (blocked_id). landing_blocked.meta_at says its fake event was
// decided (queued, or nothing to tell Meta): each blocked order is looked at once.
export default `
ALTER TABLE meta_events ADD COLUMN IF NOT EXISTS blocked_id bigint;
ALTER TABLE landing_blocked ADD COLUMN IF NOT EXISTS meta_at timestamptz;
CREATE INDEX IF NOT EXISTS landing_blocked_meta ON landing_blocked (at) WHERE meta_at IS NULL;
`;
