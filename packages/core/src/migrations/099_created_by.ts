// Who added each person (Utilisateurs): a person left without a pay plan is shown to the admins and to whoever added him.
export default `
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS created_by bigint REFERENCES profiles(id);
`;
