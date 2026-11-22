// The red screen asked to scan a parcel's old Pilotix label even when it was never printed (own livreurs: the label is
// printed in « En dispatch »; an order changed before that had no label — the only way out was typing the code). The
// depot's printing now writes the code it printed (label_code). Orders from before that record (label_known false)
// may still carry one: they are asked as before.
export default `
ALTER TABLE orders ADD COLUMN IF NOT EXISTS label_code text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS label_known boolean NOT NULL DEFAULT false;
ALTER TABLE orders ALTER COLUMN label_known SET DEFAULT true;
`;
