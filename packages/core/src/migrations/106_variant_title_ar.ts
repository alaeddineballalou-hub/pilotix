// A variant's name in Arabic for the landing pages (Produits › variants): the customer sees it in the colour list;
// empty: the page translates the colour words by itself (Rose → وردي). Only a new column with a default: nothing else
// changes, every shop's database takes it the same way.
export default `
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS title_ar text NOT NULL DEFAULT '';
`;
