// SAV on phones: a ticket ends either "réglé au téléphone" (no parcel) or by an exchange delivered to the customer.
// Either way the customer's satisfaction is asked: at the end of the call, or by calling back after the exchange.
// Pas content / Moyen always come with the reason. "Pas répondu" is counted; after 3 tries the ticket stops asking.
export default `
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS resolution        text;
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS settle_reason     text;
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS satisfaction      smallint CHECK (satisfaction BETWEEN 1 AND 4);
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS satisfaction_note text;
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS satisfaction_at   timestamptz;
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS satisfaction_by   bigint REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS sat_tries         integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS complaints_satisfaction ON complaints (satisfaction_at) WHERE satisfaction IS NOT NULL;
`;
