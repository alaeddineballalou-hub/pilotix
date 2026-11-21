// Landing pages › visits (21 Nov 2026): a page's visit is counted when the page says it is in front of a person (not
// when it is asked for: Facebook loads an ad's page before the tap), and the server sends Meta that visit too
// (PageView + ViewContent, with the browser pixel's ids). The outbox row keeps what the event needs until it leaves (the
// browser's address and user agent, its Meta cookies, the page's address), then it is wiped. Visits are many: an index
// to forget the old ones (modules/landing.ts pruneVisitEvents).
export default `
ALTER TABLE meta_events ADD COLUMN IF NOT EXISTS payload jsonb;
CREATE INDEX IF NOT EXISTS meta_events_visits ON meta_events (at) WHERE event_name = 'PageView';
`;
