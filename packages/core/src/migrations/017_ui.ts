// What each user chose on screen (column choices, the column preset in use…), saved with the account
// so it stays the same after a reload and on every device: a small JSON object of keys.
export default `
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS ui jsonb NOT NULL DEFAULT '{}'::jsonb;
`;
