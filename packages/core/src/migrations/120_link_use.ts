// Landing pages › a page or a group › « Où vit cette page » (21 Nov 2026): the address its links use. NULL = as the
// boutique chose (Réglages › « Liens des pages »), 'own' = the boutique's own domain, 'pilotix' = the platform's address.
// Both addresses keep serving every page whatever is chosen: only the links Pilotix shows and sends change.
export default `
ALTER TABLE landing_pages ADD COLUMN IF NOT EXISTS link_use text;
ALTER TABLE landing_groups ADD COLUMN IF NOT EXISTS link_use text;
`;
