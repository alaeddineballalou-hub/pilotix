// Pilot Automations (modules/automations.ts): what Pilotix does by itself writes one line per thing it did, shown on
// its card (an ad set paused for lack of stock and put back, the evening report and its numbers, a slow queue alert,
// the come-back offers queued); and the ad sets it paused for lack of stock, so it puts back only those, when one of
// their products has stock again. `hands_off`: a person started the ad set again while there was still no stock — it is
// left alone (not paused again) until the stock comes back.
export default `
CREATE TABLE IF NOT EXISTS auto_log (
  id    bigserial   PRIMARY KEY,
  kind  text        NOT NULL,
  at    timestamptz NOT NULL DEFAULT now(),
  data  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  n     integer     NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS auto_log_kind_at ON auto_log (kind, at DESC);

CREATE TABLE IF NOT EXISTS auto_paused (
  adset_id    text        PRIMARY KEY,
  product_ids bigint[]    NOT NULL DEFAULT '{}',
  at          timestamptz NOT NULL DEFAULT now(),
  hands_off   boolean     NOT NULL DEFAULT false
);
`;
