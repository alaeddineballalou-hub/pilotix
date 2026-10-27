// The stores' partners: confirmation agencies and marketers. Each has its own space (its team, its sellers, its
// prices, its bills). Their prices (set by the partner only), the numbers Pilotix counts for each store they work for,
// and the bill those numbers make. Shared by the server (bills, scores) and the app (what each side sees).

/** A partner of the stores: a confirmation agency (confirmation, suivi), or a marketer (the stores' ads). */
export type PartnerKind = 'agency' | 'marketer';
/** What a shop of the platform is: a store, or a partner's own space. */
export type ShopKind = 'store' | PartnerKind;
export const PARTNER_KINDS: PartnerKind[] = ['agency', 'marketer'];
export const isPartnerKind = (k: unknown): k is PartnerKind => k === 'agency' || k === 'marketer';

/**
 * The pieces a partner's price is made of (DA). 0 = this piece is not used. An agency uses the confirmation pieces, a
 * marketer the ads pieces; both can ask a fixed amount each month and a price per delivered order.
 */
export interface AgencyPrices {
  /** per order the agency confirmed */
  perConfirmed: number;
  /** per order delivered (the agency confirmed it, or followed it) */
  perDelivered: number;
  /** per upsell on a delivered order */
  perUpsell: number;
  /** a fixed amount each month (salary) */
  monthly: number;
  /** bonus: + amount per delivered order when the delivery rate reaches `min` % */
  bonusRate: { min: number; amount: number };
  /** bonus: + amount per delivered order above `above` orders in the month */
  bonusVolume: { above: number; amount: number };
  /** marketers: per ad set judged « réussi » (Marketing › Marketer), in the month it stopped spending */
  perSuccess: number;
  /** marketers: % (0–100) of the net profit of their ad sets in the month, when it is positive */
  profitRate: number;
}

export const NO_AGENCY_PRICES: AgencyPrices = { perConfirmed: 0, perDelivered: 0, perUpsell: 0, monthly: 0, bonusRate: { min: 0, amount: 0 }, bonusVolume: { above: 0, amount: 0 }, perSuccess: 0, profitRate: 0 };

/** What a partner does for a store: an agency confirms and / or follows its orders, a marketer runs its ads. */
export type AgencyTask = 'confirmation' | 'suivi' | 'marketing';
export const AGENCY_TASKS: AgencyTask[] = ['confirmation', 'suivi'];
export const MARKETER_TASKS: AgencyTask[] = ['marketing'];
/** The tasks a partner of this kind can do. */
export const tasksOfKind = (k: PartnerKind): AgencyTask[] => (k === 'marketer' ? MARKETER_TASKS : AGENCY_TASKS);

/** What Pilotix counts for one partner in one store, over a period (an agency: its orders; a marketer: its ad sets). */
export interface AgencyCounts {
  /** orders the agency received (routed to it) */
  received: number;
  /** orders the agency confirmed */
  confirmed: number;
  /** delivered (or exchanged) orders */
  delivered: number;
  /** returned orders (for the delivery rate) */
  returned: number;
  /** delivered orders with an upsell */
  upsells: number;
  /** marketers: their ad sets that spent this month */
  adsets: number;
  /** marketers: their ad spend (DA) */
  spend: number;
  /** marketers: their share of the orders the month's ads brought (delivered: of those, the ones delivered) */
  orders: number;
  /** marketers: the net profit of their ad sets (DA): their share of the profit, less their ad spend */
  net: number;
  /** marketers: their ad sets judged « réussi » that stopped spending this month */
  successes: number;
}

export const NO_COUNTS: AgencyCounts = { received: 0, confirmed: 0, delivered: 0, returned: 0, upsells: 0, adsets: 0, spend: 0, orders: 0, net: 0, successes: 0 };

export type BillLineKey = 'perConfirmed' | 'perDelivered' | 'perUpsell' | 'monthly' | 'bonusRate' | 'bonusVolume' | 'perSuccess' | 'profitRate';
/** One line of a bill: qty × price (profitRate: qty is the net profit in DA, price the %). */
export interface BillLine {
  key: BillLineKey;
  qty: number;
  price: number;
  amount: number;
}

/** Delivery rate in % (delivered / (delivered + returned)), null before any outcome. */
export const deliveryRate = (c: AgencyCounts): number | null => (c.delivered + c.returned > 0 ? Math.round((c.delivered / (c.delivered + c.returned)) * 1000) / 10 : null);

/** Confirmation rate in % (confirmed / received), null before any order. */
export const confirmRate = (c: AgencyCounts): number | null => (c.received > 0 ? Math.round((c.confirmed / c.received) * 1000) / 10 : null);

/** The bill of a month: one line per price piece used. `monthly`: the fixed amount counts (a whole month). */
export function agencyBill(p: AgencyPrices, c: AgencyCounts, opts: { monthly?: boolean } = {}): { lines: BillLine[]; total: number } {
  const lines: BillLine[] = [];
  const add = (key: BillLineKey, qty: number, price: number) => {
    if (price > 0 && qty > 0) lines.push({ key, qty, price, amount: Math.round(qty * price) });
  };
  add('perConfirmed', c.confirmed, p.perConfirmed);
  add('perDelivered', c.delivered, p.perDelivered);
  add('perUpsell', c.upsells, p.perUpsell);
  if (opts.monthly !== false) add('monthly', 1, p.monthly);
  const rate = deliveryRate(c);
  if (p.bonusRate.amount > 0 && rate !== null && rate >= p.bonusRate.min) add('bonusRate', c.delivered, p.bonusRate.amount);
  if (p.bonusVolume.amount > 0) add('bonusVolume', Math.max(0, c.delivered - p.bonusVolume.above), p.bonusVolume.amount);
  return { lines, total: lines.reduce((s, l) => s + l.amount, 0) };
}

/**
 * A marketer's bill of a month: its delivered orders, its ad sets « réussis », its part of the net profit, the fixed
 * amount (`monthly`: the link worked that month).
 */
export function marketerBill(p: AgencyPrices, c: AgencyCounts, opts: { monthly?: boolean } = {}): { lines: BillLine[]; total: number } {
  const lines: BillLine[] = [];
  const add = (key: BillLineKey, qty: number, price: number) => {
    if (price > 0 && qty > 0) lines.push({ key, qty, price, amount: Math.round(qty * price) });
  };
  add('perDelivered', c.delivered, p.perDelivered);
  add('perSuccess', c.successes, p.perSuccess);
  if (p.profitRate > 0 && c.net > 0) lines.push({ key: 'profitRate', qty: c.net, price: p.profitRate, amount: Math.round((c.net * p.profitRate) / 100) });
  if (opts.monthly !== false) add('monthly', 1, p.monthly);
  return { lines, total: lines.reduce((s, l) => s + l.amount, 0) };
}

/** The bill of a month, for a partner of this kind. */
export const partnerBill = (kind: PartnerKind, p: AgencyPrices, c: AgencyCounts, opts: { monthly?: boolean } = {}) => (kind === 'marketer' ? marketerBill(p, c, opts) : agencyBill(p, c, opts));

/** The price pieces a partner of this kind uses (the others stay 0). */
export function pricesOfKind(kind: PartnerKind, p: AgencyPrices): AgencyPrices {
  if (kind === 'marketer') return { ...NO_AGENCY_PRICES, perDelivered: p.perDelivered, monthly: p.monthly, perSuccess: p.perSuccess, profitRate: p.profitRate };
  return { ...p, perSuccess: 0, profitRate: 0 };
}

/** Is at least one price piece set? (a partner must have a price before it works) */
export const hasPrice = (p: AgencyPrices) =>
  p.perConfirmed > 0 || p.perDelivered > 0 || p.perUpsell > 0 || p.monthly > 0 || p.bonusRate.amount > 0 || p.bonusVolume.amount > 0 || p.perSuccess > 0 || p.profitRate > 0;

// ---------------------------------------------------------------- a store and an agency working together
export type AgencyLinkStatus = 'pending' | 'active' | 'refused' | 'cancelled' | 'ended';

/** One link between a partner (an agency or a marketer: `agency` below) and a store, as both sides see it. */
export interface AgencyLinkInfo {
  id: number;
  /** what the partner is */
  kind: PartnerKind;
  status: AgencyLinkStatus;
  /** who asked first (the other side accepts or refuses) */
  requestedBy: 'agency' | 'store';
  agency: { id: number; name: string; code: string | null; verified: boolean; suspended: boolean };
  store: { id: number; name: string; code: string | null };
  /** what the partner does for the store (a marketer: its ads) */
  tasks: AgencyTask[];
  /** the prices in force (set by the agency) */
  prices: AgencyPrices;
  /** new prices from the agency, waiting for the store's yes (the old ones stay until then) */
  pricesNew: AgencyPrices | null;
  /** the store's products given to the agency (null: every product, also new ones) */
  products: number[] | null;
  /** the agency's people working for the store (their profile in the agency's space), with their products there */
  agents: { profileId: number; name: string; products: number[] | null }[];
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  /** who ended it: the agency, the store, or Pilotix */
  endedBy: 'agency' | 'store' | 'pilotix' | null;
}

/** One seller (store) an agency's person works for, and on which of its products (null: all the agency has there). */
export interface AgencySellerWork {
  store: number;
  products: number[] | null;
}

/** A seller an agency works for, as its space lists them (the seller picker at the top). */
export interface AgencySeller {
  /** the store's id: the seller chosen in the picker */
  id: number;
  name: string;
  code: string | null;
  linkId: number;
  tasks: AgencyTask[];
}

/** An agency's payment request for one month (its numbers kept as they were counted). */
export interface AgencyBillInfo {
  id: number;
  linkId: number;
  /** YYYY-MM */
  month: string;
  amount: number;
  lines: BillLine[];
  counts: AgencyCounts;
  /** requested by the agency → paid (the store says so) → received (the agency confirms) */
  status: 'requested' | 'paid' | 'received';
  requestedAt: string;
  paidAt: string | null;
  receivedAt: string | null;
}

/** The two letters before a partner's code: AG-7K2Q (an agency), MK-7K2Q (a marketer). */
export const CODE_PREFIX: Record<PartnerKind, string> = { agency: 'AG', marketer: 'MK' };

/**
 * A code as people type it, written the right way: a store K7Q-29X, an agency AG-7K2Q, a marketer MK-7K2Q (spaces,
 * dashes and case do not matter).
 */
export function cleanCode(v: string, kind: ShopKind): string {
  const s = String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (kind !== 'store') {
    const pre = CODE_PREFIX[kind];
    return new RegExp(`^${pre}[A-Z0-9]{4}$`).test(s) ? `${pre}-${s.slice(2)}` : /^[A-Z0-9]{4}$/.test(s) ? `${pre}-${s}` : s;
  }
  return /^[A-Z0-9]{6}$/.test(s) ? `${s.slice(0, 3)}-${s.slice(3)}` : s;
}
