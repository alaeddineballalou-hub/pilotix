// Publicité › Audiences: phone numbers the owner adds to a list himself (the returns and fake numbers of the shop's
// former tool, a file from his courier): a start for a shop whose orders are not yet in Pilotix. They join the numbers
// Pilotix finds in the shop's own orders, and leave the list a year after they were added (as an order does).
export default `
CREATE TABLE IF NOT EXISTS ad_audience_phones (
  kind      text        NOT NULL,
  phone     text        NOT NULL,
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, phone)
);
`;
