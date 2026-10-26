// Google Sheets sales channel: each sheet line already turned into an order (or skipped on purpose) is remembered,
// so a line becomes an order once, whatever the number of syncs. row_key: the order number column when the sheet has
// one, otherwise a fingerprint of the line.
export default `
CREATE TABLE IF NOT EXISTS sheet_rows (
  channel_id  bigint      NOT NULL REFERENCES sales_channels(id) ON DELETE CASCADE,
  row_key     text        NOT NULL,
  order_id    bigint,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, row_key)
);
`;
