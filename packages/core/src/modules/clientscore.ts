// The customer's score out of 100: everything the protection knows about this phone number in the store, in one number
// an agent reads before calling. What really happened counts most (parcels delivered and paid, refused at the door,
// orders the agent found fake); then what the protection saw (orders it blocked or sent to be checked, the devices
// agents marked), and what the other sellers of the Pilotix network say (only when 2 different sellers agree, and never
// against a customer who already received and paid here without refusing). Each point comes with its reason.
//
//   a new customer starts at 60 · +12 per parcel delivered (up to +36) · −18 per parcel refused · −30 per fake order /
//   wrong number · −4 per order cancelled · −10 per order the protection blocked · −4 per order sent to be checked ·
//   a device marked « fausse commande » −25, « concurrent » −45 · flagged by the network −20 (2 sellers), −5 per more
//   seller · blacklisted: 10 at most (5 when a person put them there) · stop-desk only: 30 at most · from 0 to 100.
//   80 and more: très fiable · 55–79: fiable · 35–54: à surveiller · under 35: risqué (« nouveau »: nothing known yet).
import { num } from '../db';
import type { Ctx } from '../rpc';
import { sharedSellersMany } from '../platform/reputation';

export type ClientLevel = 'new' | 'top' | 'good' | 'watch' | 'risk';
export type ClientReasonCode = 'delivered' | 'returned' | 'fake' | 'cancelled' | 'blocked' | 'review' | 'markFake' | 'markCompetitor' | 'network' | 'blacklist' | 'stopdesk' | 'new';

export interface ClientScore {
  /** 0–100 */
  score: number;
  level: ClientLevel;
  /** what made the score, the biggest first; points: what it added or took off (0 for a cap or « new ») */
  reasons: { code: ClientReasonCode; points: number; n: number }[];
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

export const CLIENT_BASE = 60;
const NETWORK_MIN = 2;

/** The score from the facts (no database: the same facts, the same score). */
export function scoreClient(f: ClientFacts): ClientScore {
  const reasons: ClientScore['reasons'] = [];
  const add = (code: ClientReasonCode, n: number, each: number, max?: number) => {
    if (!n) return;
    const p = max === undefined ? n * each : Math.sign(each) * Math.min(Math.abs(n * each), max);
    reasons.push({ code, points: p, n });
  };
  add('delivered', f.delivered, 12, 36);
  add('returned', f.returned, -18);
  add('fake', f.fake, -30);
  add('cancelled', f.cancelled, -4, 12);
  add('blocked', f.blocked, -10, 30);
  add('review', f.review, -4, 12);
  if (f.markCompetitor) reasons.push({ code: 'markCompetitor', points: -45, n: f.markCompetitor });
  else if (f.markFake) reasons.push({ code: 'markFake', points: -25, n: f.markFake });
  // the network: 2 sellers at least, and never against a customer who received and paid here without refusing
  const trusted = f.delivered >= 1 && f.returned === 0 && f.fake === 0;
  if (f.network !== null && f.network >= NETWORK_MIN && !trusted) reasons.push({ code: 'network', points: -Math.min(35, 20 + 5 * (f.network - NETWORK_MIN)), n: f.network });
  let score = CLIENT_BASE + reasons.reduce((a, r) => a + r.points, 0);
  if (f.blacklisted) {
    const cap = f.blacklistAuto ? 10 : 5;
    reasons.push({ code: 'blacklist', points: Math.min(0, cap - score), n: 1 });
    score = Math.min(score, cap);
  } else if (f.stopdeskOnly) {
    reasons.push({ code: 'stopdesk', points: Math.min(0, 30 - score), n: 1 });
    score = Math.min(score, 30);
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  const known = reasons.length > 0;
  if (!known) reasons.push({ code: 'new', points: 0, n: 0 });
  reasons.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  const level: ClientLevel = !known ? 'new' : score >= 80 ? 'top' : score >= 55 ? 'good' : score >= 35 ? 'watch' : 'risk';
  return { score, level, reasons };
}

/** The facts of a customer row, as SQL columns on `customers c` (its orders, its landing orders of the last 180 days,
 *  the marks on its devices). */
export const CLIENT_FACT_COLS = `
  (SELECT count(*)::int FROM sales o WHERE o.customer_id = c.id AND o.follow_status IN ('delivered','exchanged')) AS f_delivered,
  (SELECT count(*)::int FROM sales o WHERE o.customer_id = c.id AND o.follow_status IN ('returning','returned')) AS f_returned,
  (SELECT count(*)::int FROM sales o WHERE o.customer_id = c.id AND o.conf_status IN ('fake','wrong_number')) AS f_fake,
  (SELECT count(*)::int FROM sales o WHERE o.customer_id = c.id AND o.conf_status = 'cancelled') AS f_cancelled,
  (SELECT count(*)::int FROM landing_submits s WHERE s.phone = c.phone AND s.verdict = 'block' AND s.at > now() - interval '180 days') AS f_blocked,
  (SELECT count(*)::int FROM landing_submits s WHERE s.phone = c.phone AND s.verdict = 'review' AND NOT s.merged AND s.at > now() - interval '180 days') AS f_review,
  (SELECT count(*)::int FROM fraud_marks m WHERE m.phone = c.phone AND NOT m.lifted AND m.reason = 'fake') AS f_mark_fake,
  (SELECT count(*)::int FROM fraud_marks m WHERE m.phone = c.phone AND NOT m.lifted AND m.reason = 'competitor') AS f_mark_comp`;

const factsOf = (r: any, network: number | null): ClientFacts => ({
  delivered: num(r.f_delivered),
  returned: num(r.f_returned),
  fake: num(r.f_fake),
  cancelled: num(r.f_cancelled),
  blocked: num(r.f_blocked),
  review: num(r.f_review),
  markFake: num(r.f_mark_fake),
  markCompetitor: num(r.f_mark_comp),
  network,
  blacklisted: !!r.blacklisted,
  blacklistAuto: !!r.blacklist_auto,
  stopdeskOnly: !!r.stopdesk_only,
});

/** The score of each customer row (read with CLIENT_FACT_COLS); the network asked once for all of them. */
export async function scoresOf(ctx: Ctx, rows: any[]): Promise<ClientScore[]> {
  const network = await sharedSellersMany(ctx, rows.map((r) => String(r.phone ?? '')).filter(Boolean));
  return rows.map((r) => scoreClient(factsOf(r, network ? (network.get(String(r.phone)) ?? 0) : null)));
}
