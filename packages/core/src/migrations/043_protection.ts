// Landing pages › Protection: what agents said of a device (fraud_marks: « fausse commande », « concurrent »; lifted when
// an agent changes their mind), the reasons of every submit (not only the blocked ones: the reviewed ones too, for the
// Protection page), and the orders sent again (merged into the first one).
export default `
CREATE TABLE IF NOT EXISTS fraud_marks (
  id        bigserial   PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  kind      text        NOT NULL,              -- device
  value     text        NOT NULL,              -- the device key (landing_submits.fp)
  reason    text        NOT NULL,              -- fake | competitor
  device    text,
  phone     text,
  order_id  bigint,
  by_user   bigint,
  lifted    boolean     NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS fraud_marks_value ON fraud_marks (kind, value) WHERE NOT lifted;
CREATE INDEX IF NOT EXISTS fraud_marks_phone ON fraud_marks (phone) WHERE NOT lifted;
CREATE INDEX IF NOT EXISTS fraud_marks_order ON fraud_marks (order_id);
ALTER TABLE landing_submits ADD COLUMN IF NOT EXISTS reasons jsonb;
ALTER TABLE landing_submits ADD COLUMN IF NOT EXISTS merged boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS landing_submits_at ON landing_submits (at DESC);
CREATE INDEX IF NOT EXISTS landing_submits_product ON landing_submits (product_id, at DESC);
`;
