// SERVER ONLY. Contrôle: the rules that find where the depot, Pilotix and a delivery company disagree (« fuites »).
// Pure: the facts come in (modules/leaks.ts reads them from the database), the disagreements go out. Nothing is read or
// written here, so every rule is checked with made-up parcels (test/leakrules.test.ts: 1000 cases, each company alone).
// Each company is checked with its own profile (its delays, whether its API gives statuses or payments): a ZR rule never
// uses Yalidine's delays, and a company that fails never makes another one look wrong.
import { COURIER_KINDS, type CourierKind, type FollowStatus, type LeakKind } from '@pilotix/shared';
import { KINDS } from '../couriers/kinds';

const H = 3_600_000;
const D = 24 * H;

/** One company's delays: each company is checked with its own, never another's. */
export interface LeakProfile {
  kind: CourierKind;
  /** its statuses come through its API (it says when it has the parcel, and its words) */
  api: boolean;
  /** its payments come through its API, parcel by parcel (ZR) */
  pay: boolean;
  /** it says two lines: the status, then the reason (« Sortie en livraison · Commande annulée ») */
  twoLines: boolean;
  /** hours between the depot's scan out and the company saying it has the parcel */
  takeHours: number;
  /** hours the depot has to scan a parcel the company took first (« En dispatch » keeps it 24 h) */
  scanHours: number;
  /** days between the company saying it gave a return back and the depot's scan */
  scanDays: number;
  /** days a parcel may take coming back */
  returnDays: number;
  /** days between delivered and its money in a caisse */
  payDays: number;
  /** days a payment may wait at the company before someone picks it up */
  pickupDays: number;
  /** hours an alert may wait untreated */
  alertHours: number;
  /** hours the company may fail to answer before it is a problem */
  syncHours: number;
  /** hours Pilotix may take to follow the company's « livré » or « perdu » */
  catchHours: number;
  /** hours a packed parcel may wait for its tracking number */
  labelHours: number;
  /** days a cancelled parcel that had left may take to come back */
  cancelDays: number;
}

/** What says « this parcel will not be delivered » in any company's words (French, Arabic, English): cancelled, refused,
 *  the third « ne répond pas », a return asked. « Ne répond pas » alone (a first try) is a normal failed attempt. */
export const STOP_WORDS =
  /annul|refus|rejet|renvoi|retour|ne\s*r[ée]pond\s*pas\s*\(?\s*3|3\s*(?:e|è|ème|eme)?\s*(?:tentative|appel|essai)|injoignable\s*\(?\s*3|faux\s*num|num[ée]ro\s*(?:faux|erron|incorrect)|cancel|refused|return|ملغ|الغاء|إلغاء|رفض|مرتجع|ارجاع|إرجاع/i;

const TWO_LINES: readonly CourierKind[] = ['zr', 'ecotrack', 'maystro', 'ecom'];
const BASE = { takeHours: 36, scanHours: 24, scanDays: 3, returnDays: 12, payDays: 10, pickupDays: 3, alertHours: 24, syncHours: 1, catchHours: 6, labelHours: 3, cancelDays: 7 };
/** A company's own delays where they differ (ZR pays on a request Pilotix makes by itself; our livreurs bring the cash the
 *  same day; a company without API is paid by hand). */
const OWN: Partial<Record<CourierKind, Partial<LeakProfile>>> = {
  zr: { payDays: 8, returnDays: 10 },
  zr_legacy: { payDays: 10 },
  yalidine: { payDays: 10, returnDays: 12 },
  own: { payDays: 2, alertHours: 12 },
  manual: { payDays: 14 },
};
export const PROFILES: Record<CourierKind, LeakProfile> = Object.fromEntries(
  COURIER_KINDS.map((k) => [k, { kind: k, api: !!KINDS[k]?.api, pay: !!KINDS[k]?.payments, twoLines: TWO_LINES.includes(k), ...BASE, ...OWN[k] }]),
) as Record<CourierKind, LeakProfile>;

// ---------------------------------------------------------------- the facts
export interface LeakCompany {
  id: number;
  name: string;
  kind: CourierKind;
  active: boolean;
}
/** How the company answered the last syncs (modules/leaks.ts keeps it from each sync). */
export interface LeakHealth {
  companyId: number;
  okAt: string | null;
  error: string | null;
  /** since when it fails without a good answer in between */
  errorSince: string | null;
}
export interface LeakParcel {
  id: number;
  ref: string;
  tracking: string | null;
  companyId: number;
  conf: string;
  follow: FollowStatus | null;
  sub: string | null;
  total: number;
  /** what the company takes on it (its price), 0 = not known */
  cost: number;
  isExchange: boolean;
  preparedAt: string | null;
  takenAt: string | null;
  deliveredAt: string | null;
  returningAt: string | null;
  cashed: boolean;
  sendError: string | null;
  updatedAt: string | null;
  /** the company's last words (« Sortie en livraison · Commande annulée ») and when */
  words: string | null;
  wordsAt: string | null;
  /** what the sync made of these words: a delivery status, '' (known, changes nothing), '?' (unknown), with the words it
   *  was read for (an older reading of other words is not trusted) */
  meaning: string | null;
  meaningWords: string | null;
  /** the depot's scan out (« scan dispatch ») */
  depotOutAt: string | null;
  /** « Retourné » by a person (the depot's scan, « Reçu au dépôt »), by the company's words */
  depotBackAt: string | null;
  courierBackAt: string | null;
  /** the last time it became an alert */
  alertAt: string | null;
  /** came from a swap (the other parcel's tracking): it never passed the depot */
  swapped: boolean;
}
export interface LeakPayLine {
  tracking: string | null;
  amount: number;
  costs: number;
  /** the company's delivery price on it, when it says it */
  delivery: number | null;
}
export interface LeakPayout {
  id: number;
  companyId: number;
  ref: string | null;
  amount: number;
  /** handed over by the company */
  done: boolean;
  at: string | null;
  doneAt: string | null;
  importedAt: string | null;
  /** its money is in a caisse (its versement not cancelled) */
  inCaisse: boolean;
  lines: LeakPayLine[] | null;
}
/** An order a payment line names, when it is not among the parcels being followed (delivered and paid long ago…). */
export interface LeakKnown {
  id: number;
  ref: string;
  companyId: number;
  tracking: string;
  follow: FollowStatus | null;
  total: number;
  cost: number;
  depotBack: boolean;
  /** cancelled before the company ever had it */
  neverLeft: boolean;
  isExchange: boolean;
  swapped: boolean;
}
export interface LeakFacts {
  now: number;
  companies: LeakCompany[];
  parcels: LeakParcel[];
  payouts: LeakPayout[];
  health: LeakHealth[];
  known?: LeakKnown[];
}
export interface LeakFinding {
  /** the same disagreement keeps the same key from one check to the next (so it is one case, closed once agreed) */
  key: string;
  kind: LeakKind;
  companyId: number;
  orderId: number | null;
  paymentId: number | null;
  /** the money at stake (the parcel's price, the payment, the difference), DA */
  amount: number;
  since: string | null;
  details: Record<string, unknown>;
}

const ROAD: (FollowStatus | null)[] = ['shipped', 'out_for_delivery', 'failed', 'alert', 'in_exchange'];
const MOVING: (FollowStatus | null)[] = ['shipped', 'out_for_delivery', 'failed'];
const CANCELLED_CONF = ['cancelled', 'duplicate', 'wrong_number', 'fake'];
/** within this many DA, two amounts are the same (rounding, a coin) */
export const AMOUNT_SLACK = 50;

/** What the company's last words mean, if the sync read these exact words (else null: not known yet). */
export function meaningOf(p: Pick<LeakParcel, 'words' | 'meaning' | 'meaningWords'>): string | null {
  if (p.meaning === null || p.meaningWords === null || !p.words) return null;
  return p.meaningWords === p.words.slice(0, 200) ? p.meaning : null;
}

/** Do these words say the parcel will not be delivered? (the reason line of a two-line company, or its only line) */
export const stopWords = (words: string | null | undefined): boolean => !!words && STOP_WORDS.test(words);

/** Is a payment line's amount one of the ways a company writes this parcel's money? Its price, its price less the
 *  company's delivery price, less its other costs too. Unknown delivery price and cost: not judged (true). */
export function amountFits(line: Pick<LeakPayLine, 'amount' | 'costs' | 'delivery'>, total: number, cost: number): boolean {
  const fee = line.delivery ?? (cost > 0 ? cost : null);
  if (fee === null) return true;
  const ways = [total, total - fee, total - fee - line.costs, total - line.costs];
  return ways.some((w) => Math.abs(w - line.amount) <= AMOUNT_SLACK);
}

export function findLeaks(f: LeakFacts, profiles: Record<CourierKind, LeakProfile> = PROFILES): LeakFinding[] {
  const out: LeakFinding[] = [];
  const company = new Map(f.companies.map((c) => [c.id, c]));
  const age = (t: string | null | undefined) => (t ? f.now - Date.parse(t) : -Infinity);
  const keys = new Set<string>();
  const add = (kind: LeakKind, companyId: number, key: string, x: Partial<Omit<LeakFinding, 'key' | 'kind' | 'companyId'>> = {}) => {
    const k = `${kind}:${key}`;
    if (keys.has(k)) return;
    keys.add(k);
    out.push({ key: k, kind, companyId, orderId: null, paymentId: null, amount: 0, since: null, details: {}, ...x });
  };

  // ---- the payments: which parcel each one pays (a company's tracking numbers are its own: never mixed)
  const tk = (companyId: number, tracking: string) => `${companyId}:${tracking.trim().toUpperCase()}`;
  const paid = new Map<string, { pay: LeakPayout; line: LeakPayLine }[]>();
  for (const pay of f.payouts)
    for (const line of pay.lines ?? [])
      if (line.tracking && line.amount > 0) {
        const k = tk(pay.companyId, line.tracking);
        paid.set(k, [...(paid.get(k) ?? []), { pay, line }]);
      }
  const known = new Map<string, LeakKnown>();
  for (const k of f.known ?? []) known.set(tk(k.companyId, k.tracking), k);
  for (const p of f.parcels)
    if (p.tracking)
      known.set(tk(p.companyId, p.tracking), {
        id: p.id,
        ref: p.ref,
        companyId: p.companyId,
        tracking: p.tracking,
        follow: p.follow,
        total: p.total,
        cost: p.cost,
        depotBack: !!p.depotBackAt,
        neverLeft: (p.follow === 'cancelled' || CANCELLED_CONF.includes(p.conf)) && !p.takenAt && !p.depotOutAt,
        isExchange: p.isExchange,
        swapped: p.swapped,
      });

  // ---- each parcel, with its own company's profile
  for (const p of f.parcels) {
    const c = company.get(p.companyId);
    if (!c) continue;
    const P = profiles[c.kind] ?? profiles.manual;
    const id = String(p.id);
    const base = { orderId: p.id, amount: p.total };
    const means = meaningOf(p);
    const pays = p.tracking ? (paid.get(tk(p.companyId, p.tracking)) ?? []) : [];
    const cancelled = p.follow === 'cancelled';

    if (P.api) {
      // dispatch: packed, still without the company's number (it refused it, or the sending failed)
      if (p.follow === 'prepared' && !p.tracking && age(p.preparedAt ?? p.updatedAt) > P.labelHours * H)
        add('no_tracking', c.id, id, { ...base, since: p.preparedAt ?? p.updatedAt, details: { error: p.sendError } });
      // scanned out by the depot, the company never took it
      if (p.follow === 'shipped' && p.depotOutAt && !p.takenAt && !p.swapped && age(p.depotOutAt) > P.takeHours * H)
        add('out_not_taken', c.id, id, { ...base, since: p.depotOutAt });
      // the company took it without the depot's scan: until it is delivered and paid (or back and scanned), nobody can
      // prove what left the depot
      const settled = ((p.follow === 'delivered' || p.follow === 'exchanged') && p.cashed) || (p.follow === 'returned' && !!p.depotBackAt);
      if (p.takenAt && !p.depotOutAt && !p.swapped && !cancelled && p.follow !== 'to_prepare' && !settled && age(p.takenAt) > P.scanHours * H)
        add('taken_not_scanned', c.id, id, { orderId: p.id, since: p.takenAt });

      // statuses: the company's words say it stops, Pilotix still says it is on its way (PX1254, PX1276 on 24 Nov 2026)
      if (MOVING.includes(p.follow) && p.sub !== 'alert_traitee' && stopWords(p.words))
        add('stop_words', c.id, id, { ...base, since: p.wordsAt, details: { words: p.words } });
      // words Pilotix does not know: the parcel stays where it is in Pilotix
      if (means === '?' && (ROAD.includes(p.follow) || p.follow === 'prepared'))
        add('unknown_words', c.id, id, { orderId: p.id, since: p.wordsAt, details: { words: p.words } });
      // the company says delivered / lost, Pilotix did not follow
      if (means === 'delivered' && !p.isExchange && [...MOVING, 'alert', 'returning'].includes(p.follow) && age(p.wordsAt) > P.catchHours * H)
        add('delivered_not_in_pilotix', c.id, id, { ...base, since: p.wordsAt, details: { words: p.words } });
      if (means === 'lost' && ROAD.includes(p.follow) && age(p.wordsAt) > P.catchHours * H)
        add('lost_at_company', c.id, id, { ...base, since: p.wordsAt, details: { words: p.words } });
      // delivered in Pilotix while the company's last words were a return (and it never paid it)
      if (p.follow === 'delivered' && !p.isExchange && !p.cashed && !pays.length && (means === 'returning' || means === 'returned'))
        add('delivered_but_returning', c.id, id, { ...base, since: p.deliveredAt ?? p.wordsAt, details: { words: p.words } });

      // returns: the company says it gave it back, the depot has no scan
      if (p.follow === 'returning' && means === 'returned' && !p.depotBackAt && age(p.wordsAt) > P.scanDays * D)
        add('return_not_scanned', c.id, id, { ...base, since: p.wordsAt, details: { words: p.words } });
      else if (p.follow === 'returned' && p.courierBackAt && !p.depotBackAt && age(p.courierBackAt) > P.scanDays * D)
        add('return_not_scanned', c.id, id, { ...base, since: p.courierBackAt, details: { words: p.words, stock: true } });
      // coming back for too long
      if (p.follow === 'returning' && means !== 'returned' && age(p.returningAt) > P.returnDays * D)
        add('return_stalled', c.id, id, { ...base, since: p.returningAt });
      // back at the depot, the company says delivered
      if (p.follow === 'returned' && p.depotBackAt && means === 'delivered')
        add('return_but_delivered', c.id, id, { ...base, since: p.depotBackAt, details: { words: p.words } });
    }
    // cancelled after it left, and never scanned back (any company: our livreurs too)
    if (cancelled && (p.takenAt || p.depotOutAt) && !p.depotBackAt && p.sub !== 'annule_swappe' && !p.swapped && age(p.updatedAt) > P.cancelDays * D)
      add('cancelled_but_out', c.id, id, { ...base, since: p.updatedAt });
    // an alert waiting too long
    if (p.follow === 'alert' && p.sub !== 'alert_traitee' && age(p.alertAt) > P.alertHours * H) add('alert_late', c.id, id, { orderId: p.id, since: p.alertAt });
    // money: delivered, never received (a payment of the company still waiting at its office counts as « à récupérer »)
    if ((p.follow === 'delivered' || p.follow === 'exchanged') && !p.cashed && p.total > 0 && age(p.deliveredAt) > P.payDays * D && !pays.some((x) => !x.pay.done))
      add('not_paid', c.id, id, { orderId: p.id, amount: p.cost > 0 && p.cost < p.total ? p.total - p.cost : p.total, since: p.deliveredAt, details: { livreur: c.kind === 'own' } });
  }

  // ---- each payment
  const seen = new Map<string, { pay: LeakPayout; line: LeakPayLine }>();
  for (const pay of f.payouts) {
    const c = company.get(pay.companyId);
    if (!c) continue;
    const P = profiles[c.kind] ?? profiles.manual;
    const pid = String(pay.id);
    const pbase = { paymentId: pay.id, amount: pay.amount };
    if (!pay.done && pay.amount > 0 && age(pay.at) > P.pickupDays * D) add('payout_waiting', c.id, pid, { ...pbase, since: pay.at, details: { ref: pay.ref } });
    if (pay.done && pay.amount > 0 && (pay.importedAt ? !pay.inCaisse : age(pay.doneAt ?? pay.at) > 2 * H))
      add('payout_not_in_caisse', c.id, pid, { ...pbase, since: pay.doneAt ?? pay.at, details: { ref: pay.ref, removed: !!pay.importedAt } });
    (pay.lines ?? []).forEach((line, i) => {
      if (!(line.amount > 0)) return;
      if (!line.tracking) {
        add('paid_unknown', c.id, `${pid}:#${i}`, { paymentId: pay.id, amount: line.amount, since: pay.at, details: { ref: pay.ref } });
        return;
      }
      const k = tk(pay.companyId, line.tracking);
      const o = known.get(k);
      if (!o) {
        add('paid_unknown', c.id, `${pid}:${line.tracking}`, { paymentId: pay.id, amount: line.amount, since: pay.at, details: { ref: pay.ref, tracking: line.tracking } });
        return;
      }
      const first = seen.get(k);
      if (first && first.pay.id !== pay.id)
        add('paid_twice', c.id, `${pay.companyId}:${line.tracking}`, { orderId: o.id, paymentId: pay.id, amount: Math.min(line.amount, first.line.amount), since: pay.at, details: { ref: pay.ref, first: first.pay.ref } });
      else if (!first) seen.set(k, { pay, line });
      if (o.depotBack || o.neverLeft)
        add('paid_but_back', c.id, `${pid}:${o.id}`, { orderId: o.id, paymentId: pay.id, amount: line.amount, since: pay.at, details: { ref: pay.ref, follow: o.follow } });
      else if (!o.isExchange && !o.swapped && o.total > 0 && !amountFits(line, o.total, o.cost))
        add('paid_wrong_amount', c.id, `${pid}:${o.id}`, {
          orderId: o.id,
          paymentId: pay.id,
          amount: Math.abs(o.total - (line.delivery ?? o.cost) - line.amount),
          since: pay.at,
          details: { ref: pay.ref, paid: line.amount, total: o.total, fee: line.delivery ?? o.cost },
        });
    });
  }

  // ---- each company's link: one case for the company, not one per parcel
  for (const h of f.health) {
    const c = company.get(h.companyId);
    if (!c?.active || !(profiles[c.kind] ?? profiles.manual).api) continue;
    if (h.error && h.errorSince && age(h.errorSince) > (profiles[c.kind]?.syncHours ?? 1) * H) add('sync_down', c.id, String(c.id), { since: h.errorSince, details: { error: h.error, okAt: h.okAt } });
  }
  return out;
}
