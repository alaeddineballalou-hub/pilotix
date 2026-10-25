// The product form's « Informations de base » and « Stock & logistique »: barcode, brand, external id, page URL, seller,
// description, the alert level given to every depot of a new product, and the delivery company used by default.
export default `
ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS brand text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS external_id text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS page_url text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS seller_id bigint;
ALTER TABLE products ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS alert_qty integer NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS default_company_id bigint;
`;
