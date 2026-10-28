// Phone / computer notifications (Web Push): the devices of each account that accepted them, and the shop's keys.
// The dépôt alerts ring there again every minute until the person opens the app.
export default `
CREATE TABLE IF NOT EXISTS push_subs (
  id          bigserial PRIMARY KEY,
  profile_id  bigint      NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  endpoint    text        NOT NULL UNIQUE,
  p256dh      text        NOT NULL,
  auth        text        NOT NULL,
  ua          text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_ok_at  timestamptz
);
CREATE INDEX IF NOT EXISTS push_subs_profile ON push_subs (profile_id);
CREATE TABLE IF NOT EXISTS push_keys (
  id          smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  public_key  text NOT NULL,
  private_key text NOT NULL
);
ALTER TABLE depot_alerts ADD COLUMN IF NOT EXISTS pushed_at timestamptz;
ALTER TABLE depot_alerts ADD COLUMN IF NOT EXISTS pushes integer NOT NULL DEFAULT 0;
`;
