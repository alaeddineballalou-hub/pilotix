// Preserve product-level photos and allow individual images for each variant.
export default `
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS photo text;
`;
