// Team accounts handled by trusted people, not only the administrator:
// - profiles.can_manage_users: the administrator lets a manager / supervisor create accounts and set passwords
//   (never for administrators, never for other people who have this right).
// - password_resets.completed_at: "mot de passe oublié" by e-mail is limited to 2 changes a month per person
//   (administrators excepted); after that, the supervisor sets the password from the app.
export default `
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS can_manage_users boolean NOT NULL DEFAULT false;
ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS completed_at timestamptz;
`;
