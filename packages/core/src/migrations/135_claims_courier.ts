// Réclamations that match the courier's (owner, 25 Nov 2026: « réclamation should match ZR réclamation »): the ones made
// in ZR's own app on a Pilotix parcel come into Pilotix too, each shows ZR's own category, and Pilotix keeps whether ZR's
// work on it is over, even after it was closed here.
// `ext_origin`: 'courier' = made in the courier's own app (ZR), brought in by Pilotix; null = made in Pilotix.
// `ext_category`: the courier's category it is in, in the courier's words (« Relancer un colis »).
// `ext_closed`: the courier closed it (ZR: « Traitée »); a réclamation closed here while still open there shows it.
export default `
ALTER TABLE claims ADD COLUMN IF NOT EXISTS ext_origin   text;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS ext_category text;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS ext_closed   boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS claims_ext_id ON claims (company_id, ext_id) WHERE ext_id IS NOT NULL;
`;
