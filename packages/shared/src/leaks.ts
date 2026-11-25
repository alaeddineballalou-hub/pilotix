// Contrôle (the owner's ask, 25 Nov 2026): the depot, Pilotix and each delivery company kept in agreement, parcel by
// parcel and dinar by dinar — each company checked alone, with its own words and its own delays. A « fuite » is one
// place where two of them disagree for longer than that company's delay: Pilotix finds it by itself every 30 minutes
// (with the courier sync), tells who must act, does what it can alone, and closes it as soon as they agree again.
// The rules: @pilotix/core leaks/rules.ts; the page: apps/web/src/pages/controle.

/** The page's tabs after « Aperçu »: where the disagreement is. */
export const LEAK_AREAS = ['argent', 'retours', 'dispatch', 'statuts'] as const;
export type LeakArea = (typeof LEAK_AREAS)[number];
/** Who acts: the depot (a scan), the suivi (a call, a claim), the owner (money, a company's words or keys). */
export const LEAK_WHO = ['depot', 'suivi', 'owner'] as const;
export type LeakWho = (typeof LEAK_WHO)[number];

interface LeakKindInfo {
  area: LeakArea;
  who: LeakWho;
  /** counted and shown, never a notification (the team already works them in their own page: Suivi › Alertes) */
  quiet?: true;
}

export const LEAK_KINDS = {
  // ---- dispatch: the depot ⇄ the company
  /** packed for a company with an API, still without its tracking number */
  no_tracking: { area: 'dispatch', who: 'depot' },
  /** scanned out by the depot, the company never said it has it */
  out_not_taken: { area: 'dispatch', who: 'depot' },
  /** the company has it, the depot never scanned it out (nobody can prove what left) */
  taken_not_scanned: { area: 'dispatch', who: 'depot' },
  /** cancelled after it left the depot, and not back */
  cancelled_but_out: { area: 'dispatch', who: 'suivi' },
  // ---- statuses: Pilotix ⇄ the company
  /** the company says cancelled / refused / « ne répond pas 3 » / return, Pilotix still says on its way (24 Nov 2026) */
  stop_words: { area: 'statuts', who: 'suivi' },
  /** words Pilotix does not know: the parcel does not move in Pilotix */
  unknown_words: { area: 'statuts', who: 'owner' },
  /** delivered at the company, not in Pilotix */
  delivered_not_in_pilotix: { area: 'statuts', who: 'suivi' },
  /** delivered in Pilotix, the company says it is coming back */
  delivered_but_returning: { area: 'statuts', who: 'suivi' },
  /** lost at the company, not in Pilotix */
  lost_at_company: { area: 'statuts', who: 'suivi' },
  /** an alert nobody treated in time */
  alert_late: { area: 'statuts', who: 'suivi', quiet: true },
  /** the company does not answer Pilotix any more (keys, its site down): its parcels do not move */
  sync_down: { area: 'statuts', who: 'owner' },
  // ---- returns: the company ⇄ the depot
  /** the company says it gave the parcel back, the depot never scanned it */
  return_not_scanned: { area: 'retours', who: 'depot' },
  /** coming back for too long */
  return_stalled: { area: 'retours', who: 'suivi' },
  /** the depot scanned it back, the company says delivered */
  return_but_delivered: { area: 'retours', who: 'suivi' },
  // ---- money: the company ⇄ the caisse
  /** delivered, its money never came */
  not_paid: { area: 'argent', who: 'owner' },
  /** a payment ready at the company, not picked up */
  payout_waiting: { area: 'argent', who: 'owner' },
  /** a payment the company handed over, not in a caisse */
  payout_not_in_caisse: { area: 'argent', who: 'owner' },
  /** a payment line for a parcel Pilotix does not have */
  paid_unknown: { area: 'argent', who: 'owner' },
  /** a parcel paid with another amount than its price */
  paid_wrong_amount: { area: 'argent', who: 'owner' },
  /** a parcel paid twice */
  paid_twice: { area: 'argent', who: 'owner' },
  /** paid, and the parcel is back at the depot (or never left) */
  paid_but_back: { area: 'argent', who: 'owner' },
} as const satisfies Record<string, LeakKindInfo>;
export type LeakKind = keyof typeof LEAK_KINDS;
export const LEAK_KIND_LIST = Object.keys(LEAK_KINDS) as LeakKind[];
export const leakArea = (k: LeakKind): LeakArea => LEAK_KINDS[k].area;
export const leakWho = (k: LeakKind): LeakWho => LEAK_KINDS[k].who;
export const leakQuiet = (k: LeakKind): boolean => 'quiet' in LEAK_KINDS[k];
