// Pilot Message, Meta's answer window (20 Nov 2026).
// ad_window_until: a Messenger / Instagram chat that started from a « send message » ad stays open up to 7 days after the
//   customer's first message that followed the click (Meta's policy); other chats keep 24 hours after the last message.
// ad_click_at: someone already in a conversation opened it again from an ad, without a message yet (Meta's referral):
//   their next message starts the 7 days.
// follow_ups: how many follow-ups Dellal sent since the customer's last message (up to 3, and 2 more in an ad's 7 days);
//   followed_up (one follow-up only) is kept for the old code until this is live.
export default `
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ad_window_until timestamptz;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ad_click_at timestamptz;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS follow_ups integer NOT NULL DEFAULT 0;
UPDATE conversations SET follow_ups = 1 WHERE followed_up AND follow_ups = 0;
`;
