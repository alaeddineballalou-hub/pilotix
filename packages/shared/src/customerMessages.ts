// Confirmation › the customer who does not answer (the owner's rule, 24 Nov 2026). The agent sends two messages from his
// own WhatsApp or SMS, written by the shop in Management › Statuts › « Messages client »:
// - at the try the shop chose (« Message au client à la tentative », 3 at the start), before that call is saved;
// - before the order is cancelled at « Annuler après N appels sans réponse », with the link that lets the customer
//   reactivate it ({رابط_إعادة_التفعيل}: put where the text has it, else on a line of its own at the end).
// Written in Arabic for the customers. The values come from the order: {الاسم} the customer's first name, {المتجر} the
// shop, {رقم_الطلب} the order's number, {المنتجات} one line per product (quantity × name · option), {الكميات} the pieces
// in all, {التوصيل} the delivery price, {الإجمالي} the total to pay.

export const CUSTOMER_MESSAGE_VARS = ['الاسم', 'المتجر', 'رقم_الطلب', 'المنتجات', 'الكميات', 'التوصيل', 'الإجمالي', 'رابط_إعادة_التفعيل'] as const;
export type CustomerMessageVar = (typeof CUSTOMER_MESSAGE_VARS)[number];
/** The reactivation link (the cancel message only): the agent's screen puts the site's address there. */
export const REACTIVATION_VAR: CustomerMessageVar = 'رابط_إعادة_التفعيل';
/** The longest text a shop can save (a WhatsApp message, a few SMS). */
export const CUSTOMER_MESSAGE_MAX = 700;

export interface CustomerMessages {
  /** sent at the try the shop chose (« Message au client à la tentative ») */
  attempt: string;
  /** sent before the order is cancelled after the shop's number of unanswered calls */
  cancel: string;
}

export const DEFAULT_CUSTOMER_MESSAGES: CustomerMessages = {
  attempt: 'مرحبًا {الاسم}، حاولنا الاتصال بك لتأكيد طلبك رقم {رقم_الطلب} من {المتجر}.\n{المنتجات}\nالتوصيل: {التوصيل} · الإجمالي: {الإجمالي}\nما الوقت المناسب للاتصال بك؟',
  // the order at a glance (owner, 25 Nov 2026): its products, the delivery and the total, then the link
  cancel: 'مرحبًا {الاسم}، تم إلغاء طلبك رقم {رقم_الطلب} لعدم الرد.\n{المنتجات}\nالتوصيل: {التوصيل}\nالإجمالي: {الإجمالي}\nإذا أردت إعادة تفعيل طلبك، اضغط على الرابط التالي:\n{رابط_إعادة_التفعيل}',
};

export interface CustomerMessageOrder {
  /** the customer's first name (or a polite word when it has none) */
  name: string;
  shop: string;
  ref: string;
  /** option: the colour or size, in Arabic when the product has its Arabic name */
  items: { qty: number; name: string; option?: string }[];
  delivery: number;
  total: number;
}

/** Whole dinars, digits as the customers write them, never split (a space inside a number turns around in Arabic). */
const dinars = (n: number) => `${Math.max(0, Math.round(n))} دج`;

/** The order's value for every {…}, except the link (the agent's screen knows the site's address). */
export function customerMessageValues(o: CustomerMessageOrder): Partial<Record<CustomerMessageVar, string>> {
  return {
    'الاسم': o.name,
    'المتجر': o.shop,
    'رقم_الطلب': o.ref,
    'المنتجات': o.items.map((i) => `${i.qty} × ${i.name}${i.option ? ` · ${i.option}` : ''}`).join('\n'),
    'الكميات': String(o.items.reduce((s, i) => s + i.qty, 0)),
    'التوصيل': o.delivery > 0 ? dinars(o.delivery) : 'مجاني',
    'الإجمالي': dinars(o.total),
  };
}

/** The text with the order's values: a {…} the order does not know (the link, a typo) stays as it was written. */
export function fillCustomerMessage(text: string, values: Partial<Record<CustomerMessageVar, string>>): string {
  return text
    .replace(/\{([\p{L}\p{N}_]+)\}/gu, (m, k: string) => (Object.prototype.hasOwnProperty.call(values, k) ? String(values[k as CustomerMessageVar] ?? '') : m))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The cancel message with its link: where the text has {رابط_إعادة_التفعيل}, else on a line of its own at the end. */
export function withReactivationLink(text: string, url: string): string {
  const tag = `{${REACTIVATION_VAR}}`;
  if (text.includes(tag)) return text.split(tag).join(url);
  return text.includes(url) ? text : `${text.trim()}\n${url}`;
}

/** The pretend order of « Aperçu client » (the shop's own name goes with it). */
export const CUSTOMER_MESSAGE_SAMPLE: Omit<CustomerMessageOrder, 'shop'> = {
  name: 'لينا',
  ref: 'PX1234',
  items: [
    { qty: 1, name: 'مقعد أطفال على شكل دب', option: 'بيج' },
    { qty: 2, name: 'غطاء قابل للغسل', option: 'كريمي' },
  ],
  delivery: 500,
  total: 4350,
};

/** The try at which the first message is asked (a shop that never chose: 3). */
export const messageTry = (s: { messageAtTry?: number }) => Math.max(1, Math.round(Number(s.messageAtTry) || 3));
