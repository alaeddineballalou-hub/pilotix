// Confirmation agencies: their prices (set by the agency only), the numbers Pilotix counts for each store they work
// for, and the bill those numbers make. Shared by the server (bills, scores) and the app (what each side sees).

/** The pieces an agency's price is made of (DA). 0 = this piece is not used. */
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
}

export const NO_AGENCY_PRICES: AgencyPrices = { perConfirmed: 0, perDelivered: 0, perUpsell: 0, monthly: 0, bonusRate: { min: 0, amount: 0 }, bonusVolume: { above: 0, amount: 0 } };

export type AgencyTask = 'confirmation' | 'suivi';
export const AGENCY_TASKS: AgencyTask[] = ['confirmation', 'suivi'];

/** What Pilotix counts for one agency in one store, over a period. */
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
}

export const NO_COUNTS: AgencyCounts = { received: 0, confirmed: 0, delivered: 0, returned: 0, upsells: 0 };

export type BillLineKey = 'perConfirmed' | 'perDelivered' | 'perUpsell' | 'monthly' | 'bonusRate' | 'bonusVolume';
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

/** Is at least one price piece set? (an agency must have a price before it works) */
export const hasPrice = (p: AgencyPrices) => p.perConfirmed > 0 || p.perDelivered > 0 || p.perUpsell > 0 || p.monthly > 0 || p.bonusRate.amount > 0 || p.bonusVolume.amount > 0;

// ---------------------------------------------------------------- a store and an agency working together
export type AgencyLinkStatus = 'pending' | 'active' | 'refused' | 'cancelled' | 'ended';

/** One link between an agency and a store, as both sides see it. */
export interface AgencyLinkInfo {
  id: number;
  status: AgencyLinkStatus;
  /** who asked first (the other side accepts or refuses) */
  requestedBy: 'agency' | 'store';
  agency: { id: number; name: string; code: string | null; verified: boolean; suspended: boolean };
  store: { id: number; name: string; code: string | null };
  /** what the agency does for the store */
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

/** A code as people type it, written the right way: a store K7Q-29X, an agency AG-7K2Q (spaces, dashes and case do not matter). */
export function cleanCode(v: string, kind: 'store' | 'agency'): string {
  const s = String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (kind === 'agency') return /^AG[A-Z0-9]{4}$/.test(s) ? `AG-${s.slice(2)}` : /^[A-Z0-9]{4}$/.test(s) ? `AG-${s}` : s;
  return /^[A-Z0-9]{6}$/.test(s) ? `${s.slice(0, 3)}-${s.slice(3)}` : s;
}
