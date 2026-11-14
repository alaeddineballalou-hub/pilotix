// Landing pages' unique visitors, for the conversion rate (orders ÷ unique visitors, Landing pages › Pages): one row
// per page, day (in Algeria) and device (the anonymous cookie the server gives a browser: no name, no number). Robots
// are not counted. No foreign key (as landing_hd): a page removed leaves its rows, cleaned by the code.
export default `
CREATE TABLE IF NOT EXISTS landing_visits (
  landing_id bigint NOT NULL,
  day        date NOT NULL,
  visitor    text NOT NULL,
  PRIMARY KEY (landing_id, day, visitor)
);
`;
