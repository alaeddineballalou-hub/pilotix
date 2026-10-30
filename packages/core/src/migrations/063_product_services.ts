// Optional paid product add-ons (Montage, installation, etc.).
export default `
ALTER TABLE products ADD COLUMN IF NOT EXISTS services jsonb NOT NULL DEFAULT '[]';
`;
