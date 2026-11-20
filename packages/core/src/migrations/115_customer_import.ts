// Clients › « Importer des clients » (20 Nov 2026): a shop coming to Pilotix brings its customers from its old database
// (another app, an Excel file…) WITH their history there, so their score and level show from the first day, not « Nouveau ».
//
// The old history is kept apart from Pilotix's own orders (imp_*), never mixed into them: the score adds both
// (modules/clientscore.ts), the Clients page shows both, and the shop's numbers (dashboard, stats, pay) never count it.
// Importing a file again REPLACES a customer's old history (it never adds up), so a wrong file is fixed by importing
// the right one. Nothing is deleted.
export default `
ALTER TABLE customers ADD COLUMN IF NOT EXISTS imp_orders    integer NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS imp_delivered integer NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS imp_returned  integer NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS imp_fake      integer NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS imp_cancelled integer NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS imp_last_at   timestamptz;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS imp_source    text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS imp_at        timestamptz;
`;
