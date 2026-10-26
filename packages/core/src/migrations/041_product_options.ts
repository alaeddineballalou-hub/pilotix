// Product options (Taille, Couleur, Genre…) and their values, as chosen in the product form. The variants stay the
// source of truth (orders and stock point to them); a variant made from the options is named « 12P / ROSE / Fille ».
export default `
ALTER TABLE products ADD COLUMN IF NOT EXISTS options jsonb NOT NULL DEFAULT '[]';
`;
