// Who is responsible for a problem: a parcel that came back, a customer who cancels at the door, a problem after
// delivery. The agent says WHAT happened (a reason); Pilotix decides WHO from it and from the order's history (the
// owner's rules, 25 Nov 2026: packages/core/src/modules/faults.ts). Statistics only: it never touches the pay.
// Who sees it: the admins, the seller and an agency's chiefs every name; a team's manager his team's names only (the
// other teams: their name, no one in them); an agent his own errors only.

export const FAULT_TEAMS = ['confirmation', 'depot', 'suivi', 'pub', 'livreur', 'societe', 'produit', 'pilotix', 'client', 'unknown'] as const;
export type FaultTeam = (typeof FAULT_TEAMS)[number];

/** our own teams (to put right ourselves) · outside (to claim from the courier or the supplier) · the customer (nobody's
 *  fault) · not known yet (« À préciser »: an agent says what happened) */
export const FAULT_FAMILY: Record<FaultTeam, 'nous' | 'dehors' | 'client' | 'unknown'> = {
  confirmation: 'nous',
  depot: 'nous',
  suivi: 'nous',
  pub: 'nous',
  pilotix: 'nous',
  livreur: 'dehors',
  societe: 'dehors',
  produit: 'dehors',
  client: 'client',
  unknown: 'unknown',
};

/** when it happened: the parcel came back (return), the Suivi gave it to another customer (swap), after delivery (SAV) */
export const FAULT_MOMENTS = ['return', 'swap', 'sav'] as const;
export type FaultMoment = (typeof FAULT_MOMENTS)[number];

/** What an agent picks, by subject (never by team: who is responsible is Pilotix's job). */
export const FAULT_GROUPS = [
  { key: 'client', icon: 'user', reasons: ['changed_mind', 'no_money', 'elsewhere', 'fake', 'absent', 'refuses_fee'] },
  { key: 'address', icon: 'map-pin', reasons: ['wrong_commune', 'wrong_address', 'wrong_phone', 'home_desk'] },
  { key: 'article', icon: 'package', reasons: ['wrong_variant', 'wrong_qty', 'wrong_item', 'missing_part', 'broken'] },
  { key: 'price', icon: 'wallet', reasons: ['price_ad', 'price_call'] },
  { key: 'delivery', icon: 'truck', reasons: ['livreur_no_call', 'fake_absent', 'too_late', 'lost', 'stuck_hub'] },
  { key: 'product', icon: 'tag', reasons: ['not_working', 'bad_quality', 'size_wrong'] },
] as const;

/** Reasons Pilotix sets by itself (from the courier's words, the Suivi's motif, the order's history), plus « Autre ». */
export const FAULT_AUTO_REASONS = ['unreachable', 'bad_number', 'refused', 'client_cancelled', 'alert_ignored', 'not_matching', 'pilotix_bug', 'other'] as const;

export type FaultPickReason = (typeof FAULT_GROUPS)[number]['reasons'][number];
export type FaultReason = FaultPickReason | (typeof FAULT_AUTO_REASONS)[number];
export const FAULT_REASONS = [...FAULT_GROUPS.flatMap((g) => g.reasons as readonly FaultReason[]), ...FAULT_AUTO_REASONS] as FaultReason[];

/** The question a reason needs (asked right after it). */
export type FaultAsk = 'variant' | 'qty' | 'sealed' | 'packed';
export const FAULT_ASK: Partial<Record<FaultReason, FaultAsk>> = { wrong_variant: 'variant', wrong_qty: 'qty', missing_part: 'sealed', broken: 'packed' };

/** The reasons whose team never depends on the order: the rest follow a rule (core/modules/faults.ts › decide). */
export const FAULT_FIXED: Partial<Record<FaultReason, FaultTeam>> = {
  changed_mind: 'client',
  no_money: 'client',
  elsewhere: 'client',
  fake: 'client',
  absent: 'client',
  refuses_fee: 'client',
  refused: 'client',
  client_cancelled: 'client',
  wrong_item: 'depot',
  price_ad: 'pub',
  price_call: 'confirmation',
  livreur_no_call: 'livreur',
  fake_absent: 'livreur',
  lost: 'societe',
  stuck_hub: 'societe',
  not_working: 'produit',
  bad_quality: 'produit',
  size_wrong: 'produit',
  alert_ignored: 'suivi',
  pilotix_bug: 'pilotix',
  not_matching: 'unknown',
  other: 'unknown',
};

/** The reasons that need the product in the customer's hands: after delivery (SAV) they need a photo; before it (Suivi:
 *  the parcel was only opened at the door) no photo, the depot checks the parcel when it comes back. */
export const FAULT_SEEN = new Set<FaultReason>(['wrong_variant', 'wrong_qty', 'wrong_item', 'missing_part', 'broken', 'not_working', 'bad_quality', 'size_wrong']);

/** The reasons agents pick most, shown first: a parcel not taken (Suivi, a return)… */
export const FAULT_FREQUENT: FaultPickReason[] = ['changed_mind', 'no_money', 'wrong_commune', 'wrong_variant', 'fake_absent', 'elsewhere'];
/** …and after delivery (SAV): the parcel is in the customer's hands */
export const FAULT_FREQUENT_SAV: FaultPickReason[] = ['wrong_variant', 'missing_part', 'broken', 'bad_quality', 'not_working', 'wrong_qty'];

/** A shop's Suivi « Perdu » motifs (Réglages › Motifs) as a reason. A motif of its own: « Autre ». */
export const FAULT_OF_SUIVI_MOTIF: Record<string, FaultReason> = {
  refused: 'refused',
  unreachable: 'unreachable',
  price: 'refuses_fee',
  elsewhere: 'elsewhere',
  not_ordered: 'fake',
  other: 'other',
};

/** What the courier wrote when the parcel came back, as a reason (ZR, Yalidine… and our livreurs' words). */
export function faultOfCourierWords(words: string | null | undefined): FaultReason {
  const w = (words ?? '').toLowerCase();
  if (!w.trim()) return 'other';
  if (/commune|wilaya|non desservi/.test(w)) return 'wrong_commune';
  if (/bureau|stop ?desk/.test(w)) return 'home_desk';
  if (/adresse/.test(w)) return 'wrong_address';
  if (/num[ée]ro|t[ée]l[ée]phone/.test(w)) return 'bad_number';
  if (/injoignable|ne r[ée]pond|pas de r[ée]ponse|absent|ferm[ée]/.test(w)) return 'unreachable';
  if (/ne correspond|mauvais (produit|article)|erreur de produit|diff[ée]rent/.test(w)) return 'not_matching';
  if (/cass|endommag|ab[iî]m/.test(w)) return 'broken';
  if (/perdu|introuvable/.test(w)) return 'lost';
  if (/retard|d[ée]lai|trop long/.test(w)) return 'too_late';
  if (/refus/.test(w)) return 'refused';
  if (/annul|report/.test(w)) return 'client_cancelled';
  return 'other';
}
