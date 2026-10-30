// The customer's score out of 100: everything the protection knows about this phone number in the store, in one number
// an agent reads before calling. What really happened counts most (parcels delivered and paid, refused at the door,
// orders the agent found fake); then what the protection saw (orders it blocked or sent to be checked, the devices
// agents marked), and what the other sellers of the Pilotix network say (only when 2 different sellers agree, and never
// against a customer who already received and paid here without refusing). Each point comes with its reason.
//
// The rule itself (shared/clientscore.ts) is pure; here: the facts of each customer read from the store, the network
// asked once, and the shop's own points (Réglages › Score client; the recommended ones until the seller changes them).
import { DEFAULT_SCORE_RULES, normalizeScoreRules, scoreClient, type ClientFacts, type ClientLevel, type ClientScore, type ScoreRules } from '@pilotix/shared';
import { z } from 'zod';
import { num, type Db } from '../db';
import { proc, type Ctx } from '../rpc';
import { getSetting, setSetting } from '../settings';
import { sharedSellersMany } from '../platform/reputation';

export type { ClientFacts, ClientLevel, ClientReasonCode, ClientScore, ScoreRules } from '@pilotix/shared';
export { scoreClient } from '@pilotix/shared';

/** where a customer starts (the recommended points) */
export const CLIENT_BASE = DEFAULT_SCORE_RULES.base;

/** The shop's points, whole (a missing one is the recommended one). */
export async function scoreRules(db: Db): Promise<ScoreRules> {
  return normalizeScoreRules(await getSetting(db, 'clientScore'));
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

/** The same facts for many customers at once (a filter by level over the whole store): counted once per table instead
 *  of once per customer. `where` filters `customers c`. */
const factsAllSql = (where: string) => `
  SELECT c.id, c.phone, c.blacklisted, c.blacklist_auto, c.stopdesk_only, c.last_order_at,
    coalesce(o.d, 0) AS f_delivered, coalesce(o.r, 0) AS f_returned, coalesce(o.fk, 0) AS f_fake, coalesce(o.cc, 0) AS f_cancelled,
    coalesce(s.b, 0) AS f_blocked, coalesce(s.rv, 0) AS f_review, coalesce(m.mf, 0) AS f_mark_fake, coalesce(m.mc, 0) AS f_mark_comp
  FROM customers c
  LEFT JOIN (
    SELECT customer_id,
      count(*) FILTER (WHERE follow_status IN ('delivered','exchanged'))::int AS d,
      count(*) FILTER (WHERE follow_status IN ('returning','returned'))::int AS r,
      count(*) FILTER (WHERE conf_status IN ('fake','wrong_number'))::int AS fk,
      count(*) FILTER (WHERE conf_status = 'cancelled')::int AS cc
    FROM sales WHERE customer_id IS NOT NULL GROUP BY 1) o ON o.customer_id = c.id
  LEFT JOIN (
    SELECT phone, count(*) FILTER (WHERE verdict = 'block')::int AS b, count(*) FILTER (WHERE verdict = 'review' AND NOT merged)::int AS rv
    FROM landing_submits WHERE at > now() - interval '180 days' GROUP BY 1) s ON s.phone = c.phone
  LEFT JOIN (
    SELECT phone, count(*) FILTER (WHERE reason = 'fake')::int AS mf, count(*) FILTER (WHERE reason = 'competitor')::int AS mc
    FROM fraud_marks WHERE NOT lifted GROUP BY 1) m ON m.phone = c.phone
  ${where}`;

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
  if (!rows.length) return [];
  const [network, R] = await Promise.all([sharedSellersMany(ctx, rows.map((r) => String(r.phone ?? '')).filter(Boolean)), scoreRules(ctx.db)]);
  return rows.map((r) => scoreClient(factsOf(r, network ? (network.get(String(r.phone)) ?? 0) : null), R));
}

/** Every customer matching `where` (on `customers c`, params $1…) with their score — for a filter by level. */
export async function scoresAll(ctx: Ctx, where: string, params: unknown[]): Promise<{ id: number; lastOrderAt: number; score: ClientScore }[]> {
  const rows = await ctx.db.query(factsAllSql(where), params);
  const scores = await scoresOf(ctx, rows);
  return rows.map((r: any, k: number) => ({ id: num(r.id), lastOrderAt: r.last_order_at ? new Date(r.last_order_at).getTime() : 0, score: scores[k] }));
}

// ---------------------------------------------------------------- Réglages › Score client
const pts = z.number().int().min(0).max(100);
const rule = z.object({ each: pts, max: pts.nullable() });
const rulesIn = z
  .object({
    base: pts,
    delivered: rule,
    returned: rule,
    fake: rule,
    cancelled: rule,
    blocked: rule,
    review: rule,
    markFake: pts,
    markCompetitor: pts,
    network: z.object({ first: pts, more: pts, max: pts }),
    caps: z.object({ blacklistAuto: pts, blacklistManual: pts, stopdesk: pts }),
    levels: z.object({ top: pts.min(1), good: pts.min(1), watch: pts.min(1) }),
  })
  .refine((r) => r.levels.top > r.levels.good && r.levels.good > r.levels.watch, { message: 'Les niveaux doivent descendre : « Très fiable » au-dessus de « Fiable », au-dessus de « À surveiller ».' });

export const clientScoreProcs = {
  /** The shop's points and the recommended ones (« Remettre les points conseillés »). Everyone reads them. */
  'clientscore.rules': proc(null, z.object({}), async (ctx) => ({ rules: await scoreRules(ctx.db), recommended: DEFAULT_SCORE_RULES })),

  /** Admin only: save every point at once (the scores everywhere follow at once). */
  'clientscore.setRules': proc([], rulesIn, async (ctx, i) => {
    await setSetting(ctx.db, 'clientScore', normalizeScoreRules(i), ctx.session.profile.id);
    ctx.emit({ type: 'orders' });
    return { ok: true };
  }),
};
