// Meta's answer window on Messenger and Instagram: within 24 hours of the customer's last message the shop answers
// freely (Dellal or a person). After 24 hours nobody can, until the customer writes again. Other channels have rules of their own (WhatsApp's 24 hours needs templates): « open » here.
export type ReplyWindow = 'open' | 'closed';

const HOUR = 3_600_000;
/** Meta's limit, in hours after the customer's last message. */
export const META_WINDOW_HOURS = 24;

export function replyWindow(channel: string, lastCustomerAt: string | null | undefined, now: number): ReplyWindow {
  if ((channel !== 'messenger' && channel !== 'instagram') || !lastCustomerAt) return 'open';
  return now - Date.parse(lastCustomerAt) > META_WINDOW_HOURS * HOUR ? 'closed' : 'open';
}
