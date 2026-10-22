// My profile: a picture, a referral code per user, and the referrals (friends invited to Pilotix) with their rules.
export default `
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS referral_code text UNIQUE;
UPDATE profiles SET referral_code = upper(substr(md5(id::text || email), 1, 6)) WHERE referral_code IS NULL;
CREATE TABLE IF NOT EXISTS referrals (
  id            bigserial PRIMARY KEY,
  referrer_id   bigint      NOT NULL,
  friend_name   text        NOT NULL,
  friend_email  text,
  shop_name     text,
  status        text        NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'signed_up', 'subscribed')),
  cash_amount   integer     NOT NULL DEFAULT 0,
  free_months   integer     NOT NULL DEFAULT 0,
  paid          boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  subscribed_at timestamptz
);
CREATE INDEX IF NOT EXISTS referrals_referrer ON referrals (referrer_id, created_at DESC);
INSERT INTO settings (key, value) VALUES ('referral', '{"cash":2000,"months":1}') ON CONFLICT (key) DO NOTHING;
`;
