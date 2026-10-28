// Fraud fix: the stable browser fingerprint (i.fp: screen, timezone, language, hardware — survives clearing the browser
// or private mode), kept apart from the device key (landing_submits.fp, which is d:<storedId> or f:<fp>:<ip>). Lets the
// burst count and the « concurrent » mark follow a physical device even when its stored id changes every order.
export default `
ALTER TABLE landing_submits ADD COLUMN IF NOT EXISTS fphash text;
ALTER TABLE landing_leads ADD COLUMN IF NOT EXISTS fphash text;
ALTER TABLE fraud_marks ADD COLUMN IF NOT EXISTS fphash text;
CREATE INDEX IF NOT EXISTS landing_submits_fphash ON landing_submits (fphash, at DESC) WHERE fphash IS NOT NULL;
CREATE INDEX IF NOT EXISTS fraud_marks_fphash ON fraud_marks (fphash) WHERE NOT lifted AND fphash IS NOT NULL;
`;
