// Meta's answer window on Messenger and Instagram. Within 24 hours of the customer's last message the shop answers freely
// (Dellal or a person). From 24 hours to 7 days only a person may, and the message carries Meta's « human agent » tag
// (the Human Agent feature). After 7 days nobody can, until the customer writes again. Other channels have rules of their
// own (WhatsApp's 24 hours needs templates): « open » here.
export type ReplyWindow = 'open' | 'human' | 'closed';

const HOUR = 3_600_000;
/** Meta's two limits, in hours after the customer's last message. */
export const META_WINDOW_HOURS = { standard: 24, humanAgent: 7 * 24 } as const;

export function replyWindow(channel: string, lastCustomerAt: string | null | undefined, now: number): ReplyWindow {
  if ((channel !== 'messenger' && channel !== 'instagram') || !lastCustomerAt) return 'open';
  const age = now - Date.parse(lastCustomerAt);
  if (!(age > META_WINDOW_HOURS.standard * HOUR)) return 'open';
  return age <= META_WINDOW_HOURS.humanAgent * HOUR ? 'human' : 'closed';
}

/** Until when a person can still answer: the customer's last message + 7 days. */
export const humanReplyUntil = (lastCustomerAt: string): string => new Date(Date.parse(lastCustomerAt) + META_WINDOW_HOURS.humanAgent * HOUR).toISOString();
