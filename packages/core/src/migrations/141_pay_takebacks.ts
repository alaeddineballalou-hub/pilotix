// A delivery taken back (the owner, 27 Nov 2026: « Take it from next pay »): each time an order stops being « Livrée »
// (a company's correction, our livreur's tap by mistake, a person's change), one line here, in the store that holds the
// order: when it had been delivered (`delivered_at`), who was paid its suivi for that delivery (`suivi_by`: the follow-up
// agent, else whoever set « Livré », else the one who pressed « Relivrer » on its alert) and when it stopped (`at`). The
// pay (modules/pay.ts) reads it: a person already paid for that delivery gets it back as a minus line in the period of
// `at`; nobody paid yet: nothing here counts (the order simply leaves the pay).
// On the live server (shared tables), tenantization adds shop_id to this table and to its keys, like every other (no
// link to orders: there its key is (shop_id, id)).
export default `
CREATE TABLE IF NOT EXISTS pay_takebacks (
  id           bigserial   PRIMARY KEY,
  order_id     bigint      NOT NULL,
  delivered_at timestamptz NOT NULL,
  suivi_by     bigint,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pay_takebacks_at ON pay_takebacks (at);
CREATE INDEX IF NOT EXISTS pay_takebacks_order ON pay_takebacks (order_id, at);
`;
