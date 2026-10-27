// Marketers: the chief (or a manager) of a marketer working for the store sees every ad set of the marketer's people
// here, the others only their own ad sets. Set by the marketer's own space (agencies.ts), never by the store.
export default `
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS agency_lead boolean NOT NULL DEFAULT false;
`;
