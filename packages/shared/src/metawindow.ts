// Meta's answer window on Messenger and Instagram: within 24 hours of the customer's last message the shop answers
// freely (Dellal or a person). A chat that started from a « send message » ad (Click-to-Messenger, Click-to-Direct) stays
// open up to 7 days after the customer's first message that followed the click (Meta's policy, read 20 Nov 2026).
// After the window, Dellal never writes. A real person of the team still can, for 7 days after the customer's last
// message, with Meta's « human agent » label, once Meta gave Pilotix's app that permission (the control room says so).
// Other channels have rules of their own (WhatsApp's 24 hours needs templates): « open » here.
export type ReplyWindow = 'open' | 'closed';
/** What a person of the team may do: answer freely, answer with the « human agent » label, or nothing. */
export type StaffWindow = 'open' | 'human' | 'closed';

const HOUR = 3_600_000;
/** Meta's limit, in hours after the customer's last message. */
export const META_WINDOW_HOURS = 24;
/** A chat that came from a « send message » ad: Meta's limit, in days after the first message that followed the click. */
export const META_AD_WINDOW_DAYS = 7;
/** Meta's « human agent » label: days after the customer's last message a real person may still answer. */
export const META_HUMAN_DAYS = 7;

const isMeta = (channel: string) => channel === 'messenger' || channel === 'instagram';
const ms = (v: string | null | undefined) => (v ? Date.parse(v) : NaN);

/** When the free window ends (ms), the later of « 24 h after the last message » and the ad's 7 days. Null: no limit. */
export function windowEnd(channel: string, lastCustomerAt: string | null | undefined, adWindowUntil?: string | null): number | null {
  if (!isMeta(channel) || !lastCustomerAt) return null;
  const day = ms(lastCustomerAt) + META_WINDOW_HOURS * HOUR;
  const ad = ms(adWindowUntil);
  return Number.isFinite(ad) && ad > day ? ad : day;
}

/** Dellal's window (and a person's free one). `adWindowUntil`: the end of an ad chat's 7 days, when it has one. */
export function replyWindow(channel: string, lastCustomerAt: string | null | undefined, now: number, adWindowUntil?: string | null): ReplyWindow {
  const end = windowEnd(channel, lastCustomerAt, adWindowUntil);
  return end !== null && now > end ? 'closed' : 'open';
}

/** Is this chat inside an ad's 7 days right now (past the plain 24 hours)? What the Messages screen says. */
export function inAdWindow(channel: string, lastCustomerAt: string | null | undefined, now: number, adWindowUntil?: string | null): boolean {
  if (!isMeta(channel) || !lastCustomerAt) return false;
  const ad = ms(adWindowUntil);
  return Number.isFinite(ad) && now <= ad && now > ms(lastCustomerAt) + META_WINDOW_HOURS * HOUR;
}

/** A person of the team: free inside the window, then « human agent » for 7 days when Meta allowed it, then nothing. */
export function staffWindow(channel: string, lastCustomerAt: string | null | undefined, now: number, adWindowUntil: string | null | undefined, humanAgent: boolean): StaffWindow {
  if (replyWindow(channel, lastCustomerAt, now, adWindowUntil) === 'open') return 'open';
  return humanAgent && now - ms(lastCustomerAt) <= META_HUMAN_DAYS * 24 * HOUR ? 'human' : 'closed';
}
