// The customer's score out of 100, from what is known about their phone number (core: modules/clientscore.ts reads the
// facts). Pure: the same facts and the same points give the same score — on the server, and in Réglages where the seller
// tries his own points on examples before saving them.
//
// The points are the shop's own (Réglages › Score client), these are the recommended ones:
//   a new customer starts at 60 · +12 per parcel delivered (up to +36) · −18 per parcel refused · −30 per fake order /
//   wrong number · −4 per order cancelled (up to −12) · −10 per order the protection blocked (up to −30) · −4 per order
//   sent to be checked (up to −12) · a device marked « fausse commande » −25, « concurrent » −45 · flagged by the network
//   −20 (2 sellers), −5 per more seller, up to −35 (never against a customer who received and paid without refusing) ·
//   blacklisted: 10 at most (5 when a person put them there) · stop-desk only: 30 at most · from 0 to 100.
//   80 and more: très fiable · 55–79: fiable · 35–54: à surveiller · under 35: risqué (« nouveau »: nothing known yet).

export const CLIENT_LEVELS = ['top', 'good', 'watch', 'risk', 'new'] as const;
export type ClientLevel = (typeof CLIENT_LEVELS)[number];
export type ClientReasonCode = 'delivered' | 'returned' | 'fake' | 'cancelled' | 'blocked' | 'review' | 'markFake' | 'markCompetitor' | 'network' | 'blacklist' | 'stopdesk' | 'new';

export interface ClientReason {
  code: ClientReasonCode;
  /** what it added or took off (0 for a cap or « new ») */
  points: number;
  n: number;
}

export interface ClientScore {
  /** 0–100 */
  score: number;
  level: ClientLevel;
  /** what made the score, the biggest first */
  reasons: ClientReason[];
}

export interface ClientFacts {
  delivered: number;
  returned: number;
  fake: number;
  cancelled: number;
  blocked: number;
  review: number;
  markFake: number;
  markCompetitor: number;
  /** other sellers of the network who ended badly with this number (null: no network here) */
  network: number | null;
  blacklisted: boolean;
  blacklistAuto: boolean;
  stopdeskOnly: boolean;
}

/** points for each time it happened, and the most it can add / take off in all (null: no limit) */
export interface ScoreRule {
  each: number;
  max: number | null;
}

/** The shop's points. Every number is a size (0–100): delivered adds it, everything else takes it off. */
export interface ScoreRules {
  /** where a customer starts */
  base: number;
  delivered: ScoreRule;
  returned: ScoreRule;
  fake: ScoreRule;
  cancelled: ScoreRule;
  blocked: ScoreRule;
  review: ScoreRule;
  /** a device marked « fausse commande » / « concurrent » (once, the bigger of the two) */
  markFake: number;
  markCompetitor: number;
  /** flagged by 2 other sellers: first; each more seller: more; at most: max */
  network: { first: number; more: number; max: number };
  /** the highest score of a blacklisted customer (put there by the protection / by a person), and of a stop-desk-only one */
  caps: { blacklistAuto: number; blacklistManual: number; stopdesk: number };
  /** from this score: très fiable / fiable / à surveiller (under watch: risqué) */
  levels: { top: number; good: number; watch: number };
}

export const DEFAULT_SCORE_RULES: ScoreRules = {
  base: 60,
  delivered: { each: 12, max: 36 },
  returned: { each: 18, max: null },
  fake: { each: 30, max: null },
  cancelled: { each: 4, max: 12 },
  blocked: { each: 10, max: 30 },
  review: { each: 4, max: 12 },
  markFake: 25,
  markCompetitor: 45,
  network: { first: 20, more: 5, max: 35 },
  caps: { blacklistAuto: 10, blacklistManual: 5, stopdesk: 30 },
  levels: { top: 80, good: 55, watch: 35 },
};

/** the counted things, in the order Réglages shows them */
export const SCORE_RULE_KEYS = ['delivered', 'returned', 'fake', 'cancelled', 'blocked', 'review'] as const;
export type ScoreRuleKey = (typeof SCORE_RULE_KEYS)[number];

/** best first, for « meilleurs clients d'abord »: a customer we know is good comes before one we know nothing about */
export const LEVEL_RANK: Record<ClientLevel, number> = { top: 4, good: 3, new: 2, watch: 1, risk: 0 };

const NETWORK_MIN = 2;
const pts = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : d);

/** Saved points made whole and safe: a missing or broken value takes the recommended one; levels must go down. */
export function normalizeScoreRules(v: unknown): ScoreRules {
  const d = DEFAULT_SCORE_RULES;
  const o = (v && typeof v === 'object' ? v : {}) as Partial<Record<keyof ScoreRules, any>>;
  const rule = (x: any, r: ScoreRule): ScoreRule => ({ each: pts(x?.each, r.each), max: x && 'max' in x ? (x.max === null ? null : pts(x.max, r.max ?? 0)) : r.max });
  const levels = { top: pts(o.levels?.top, d.levels.top), good: pts(o.levels?.good, d.levels.good), watch: pts(o.levels?.watch, d.levels.watch) };
  return {
    base: pts(o.base, d.base),
    delivered: rule(o.delivered, d.delivered),
    returned: rule(o.returned, d.returned),
    fake: rule(o.fake, d.fake),
    cancelled: rule(o.cancelled, d.cancelled),
    blocked: rule(o.blocked, d.blocked),
    review: rule(o.review, d.review),
    markFake: pts(o.markFake, d.markFake),
    markCompetitor: pts(o.markCompetitor, d.markCompetitor),
    network: { first: pts(o.network?.first, d.network.first), more: pts(o.network?.more, d.network.more), max: pts(o.network?.max, d.network.max) },
    caps: { blacklistAuto: pts(o.caps?.blacklistAuto, d.caps.blacklistAuto), blacklistManual: pts(o.caps?.blacklistManual, d.caps.blacklistManual), stopdesk: pts(o.caps?.stopdesk, d.caps.stopdesk) },
    levels: levels.top > levels.good && levels.good > levels.watch && levels.watch > 0 ? levels : { ...d.levels },
  };
}

/** The level of a score (« new » when nothing is known). */
export const levelOf = (score: number, known: boolean, L: ScoreRules['levels'] = DEFAULT_SCORE_RULES.levels): ClientLevel =>
  !known ? 'new' : score >= L.top ? 'top' : score >= L.good ? 'good' : score >= L.watch ? 'watch' : 'risk';

/** The score from the facts and the shop's points (no database). */
export function scoreClient(f: ClientFacts, R: ScoreRules = DEFAULT_SCORE_RULES): ClientScore {
  const reasons: ClientReason[] = [];
  const add = (code: ClientReasonCode, n: number, r: ScoreRule, sign: 1 | -1) => {
    if (!n) return;
    const p = n * r.each;
    reasons.push({ code, points: sign * (r.max === null ? p : Math.min(p, r.max)), n });
  };
  add('delivered', f.delivered, R.delivered, 1);
  add('returned', f.returned, R.returned, -1);
  add('fake', f.fake, R.fake, -1);
  add('cancelled', f.cancelled, R.cancelled, -1);
  add('blocked', f.blocked, R.blocked, -1);
  add('review', f.review, R.review, -1);
  if (f.markCompetitor) reasons.push({ code: 'markCompetitor', points: -R.markCompetitor, n: f.markCompetitor });
  else if (f.markFake) reasons.push({ code: 'markFake', points: -R.markFake, n: f.markFake });
  // the network: 2 sellers at least, and never against a customer who received and paid here without refusing
  const trusted = f.delivered >= 1 && f.returned === 0 && f.fake === 0;
  if (f.network !== null && f.network >= NETWORK_MIN && !trusted)
    reasons.push({ code: 'network', points: -Math.min(R.network.max, R.network.first + R.network.more * (f.network - NETWORK_MIN)), n: f.network });
  let score = R.base + reasons.reduce((a, r) => a + r.points, 0);
  if (f.blacklisted) {
    const cap = f.blacklistAuto ? R.caps.blacklistAuto : R.caps.blacklistManual;
    reasons.push({ code: 'blacklist', points: Math.min(0, cap - score), n: 1 });
    score = Math.min(score, cap);
  } else if (f.stopdeskOnly) {
    reasons.push({ code: 'stopdesk', points: Math.min(0, R.caps.stopdesk - score), n: 1 });
    score = Math.min(score, R.caps.stopdesk);
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  const known = reasons.length > 0;
  if (!known) reasons.push({ code: 'new', points: 0, n: 0 });
  reasons.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  return { score, level: levelOf(score, known, R.levels), reasons };
}
