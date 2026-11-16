// Produits › « Prêt » / « À faire »: a product that is not Ready (HD photo, prices, description, landing page, sales
// guide) is not sold. ready_off marks a product Pilotix switched off for that reason, so it goes back on sale by itself
// once it is Ready (a product the seller switched off himself has it false and stays off). See modules/readiness.ts.
export default `
ALTER TABLE products ADD COLUMN IF NOT EXISTS ready_off boolean NOT NULL DEFAULT false;
`;
