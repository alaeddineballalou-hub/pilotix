// Bureaus (stop desks) a delivery company closed (22 Nov 2026): the import only added and updated them, so a bureau ZR
// closed stayed in every list — an agent could confirm an order there, and the depot's sending was refused (« Bureau ZR
// introuvable »). A bureau the company no longer gives is now marked closed: hidden from the choices, still named on the
// orders that went there.
export default `
ALTER TABLE stopdesks ADD COLUMN IF NOT EXISTS gone_at timestamptz;
`;
