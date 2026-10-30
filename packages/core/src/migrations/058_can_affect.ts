// Management › Affectation automatique: besides administrators, the people the administrator ticked
// (« Peut régler l’affectation ») open the page and change it.
export default `
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS can_affect boolean NOT NULL DEFAULT false;
`;
