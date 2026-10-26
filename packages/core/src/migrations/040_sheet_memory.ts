// Google Sheets channel: the lines already seen are remembered per Google sheet, not per channel. A channel deleted
// and added again with the same sheet (or two channels on one sheet) never brings back a line already made into an
// order, already skipped (« only new lines »), or whose order was deleted.
export default `
ALTER TABLE sheet_rows ADD COLUMN IF NOT EXISTS sheet_id text;
UPDATE sheet_rows r SET sheet_id = substring(c.config->>'url' from '/spreadsheets/d/(?:e/)?([A-Za-z0-9_-]+)')
  FROM sales_channels c WHERE c.id = r.channel_id AND r.sheet_id IS NULL;
UPDATE sheet_rows SET sheet_id = 'ch' || channel_id WHERE sheet_id IS NULL;
ALTER TABLE sheet_rows ALTER COLUMN sheet_id SET NOT NULL;
ALTER TABLE sheet_rows DROP CONSTRAINT IF EXISTS sheet_rows_pkey;
ALTER TABLE sheet_rows DROP CONSTRAINT IF EXISTS sheet_rows_channel_id_fkey;
ALTER TABLE sheet_rows ALTER COLUMN channel_id DROP NOT NULL;
ALTER TABLE sheet_rows ADD CONSTRAINT sheet_rows_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES sales_channels(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sheet_rows_sheet_key ON sheet_rows (sheet_id, row_key);
`;
