// « Liste noire partagée »: a number one of the seller's boutiques blacklists by hand is blacklisted in all their
// boutiques. customers.blacklist_shop: the boutique (platform id) whose decision put the number on this list; NULL: this
// boutique's own decision (a person here, or the automatic list). Taking a number off the list in a boutique takes it
// off the others only where it came from that boutique: another boutique's own decision stays.
export default `
ALTER TABLE customers ADD COLUMN IF NOT EXISTS blacklist_shop bigint;
`;
