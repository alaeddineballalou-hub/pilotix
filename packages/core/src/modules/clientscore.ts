// The customer's score out of 100: everything the protection knows about this phone number in the store, in one number
// an agent reads before calling. What really happened counts most (parcels delivered and paid, refused at the door,
// orders the agent found fake); then what the protection saw (orders it blocked or sent to be checked, the devices
// agents marked), and what the other sellers of the Pilotix network say (only when 2 different sellers agree, and never
// against a customer who already received and paid here without refusing). Each point comes with its reason.
//
// The rule itself (shared/clientscore.ts) is pure; here: the facts of each customer read from the store, the network
// asked once, and the shop's own points (Réglages › Score client; the recommended ones until the seller changes them).
import { DEFAULT_SCORE_RULES, normalizeScoreRules, scoreClient, type ClientFacts, type ClientLevel, type ClientScore, type ScoreRuleKey, type ScoreRules } from '@pilotix/shared';
import { z } from 'zod';
import { num, type Db } from '../db';
import { proc, type Ctx } from '../rpc';
import { andSql, queueSql } from './agencyscope';
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

/** The facts of many customers at once, counted once per table (not once per customer): joined on `customers c`
 *  (`cid`: the customer id column to join the orders on). Columns: so.d / so.r / so.fk / so.cc (delivered, returned,
 *  fake, cancelled), ls.b / ls.rv (blocked, to check), fm.mf / fm.mc (device marks). */
const factsJoins = (cid: string) => `
  LEFT JOIN (
    SELECT customer_id,
      count(*) FILTER (WHERE follow_status IN ('delivered','exchanged'))::int AS d,
      count(*) FILTER (WHERE follow_status IN ('returning','returned'))::int AS r,
      count(*) FILTER (WHERE conf_status IN ('fake','wrong_number'))::int AS fk,
      count(*) FILTER (WHERE conf_status = 'cancelled')::int AS cc
    FROM sales WHERE customer_id IS NOT NULL GROUP BY 1) so ON so.customer_id = ${cid}
  LEFT JOIN (
    SELECT phone, count(*) FILTER (WHERE verdict = 'block')::int AS b, count(*) FILTER (WHERE verdict = 'review' AND NOT merged)::int AS rv
    FROM landing_submits WHERE at > now() - interval '180 days' GROUP BY 1) ls ON ls.phone = c.phone
  LEFT JOIN (
    SELECT phone, count(*) FILTER (WHERE reason = 'fake')::int AS mf, count(*) FILTER (WHERE reason = 'competitor')::int AS mc
    FROM fraud_marks WHERE NOT lifted GROUP BY 1) fm ON fm.phone = c.phone`;

/** The same facts for many customers at once (a filter by level over the whole store). `where` filters `customers c`. */
const factsAllSql = (where: string) => `
  SELECT c.id, c.phone, c.blacklisted, c.blacklist_auto, c.stopdesk_only, c.last_order_at,
    coalesce(so.d, 0) AS f_delivered, coalesce(so.r, 0) AS f_returned, coalesce(so.fk, 0) AS f_fake, coalesce(so.cc, 0) AS f_cancelled,
    coalesce(ls.b, 0) AS f_blocked, coalesce(ls.rv, 0) AS f_review, coalesce(fm.mf, 0) AS f_mark_fake, coalesce(fm.mc, 0) AS f_mark_comp
  FROM customers c
  ${factsJoins('c.id')}
  ${where}`;

/**
 * « Meilleurs clients d'abord » in SQL, for a list sorted by the database (Commandes, every page): the customer's level
 * rank (très fiable 4, fiable 3, nouveau 2, à surveiller 1, risqué 0) × 1000 + the score — the same rule as scoreClient
 * (shared/clientscore.ts), the shop's points written in (whole numbers 0–100 only). Needs `customers c`, factsJoins and
 * the network `nw(phone, n)` joined.
 */
function rankSql(R: ScoreRules): string {
  const z = (x: string) => `coalesce(${x}, 0)`;
  const [d, r, fk, cc, b, rv, mf, mc] = ['so.d', 'so.r', 'so.fk', 'so.cc', 'ls.b', 'ls.rv', 'fm.mf', 'fm.mc'].map(z);
  const i = (v: number) => String(Math.max(0, Math.min(100, Math.round(v))));
  const part = (x: string, k: ScoreRuleKey) => (R[k].max === null ? `(${x} * ${i(R[k].each)})` : `LEAST(${x} * ${i(R[k].each)}, ${i(R[k].max)})`);
  const netOn = `coalesce(nw.n >= 2 AND NOT (${d} >= 1 AND ${r} = 0 AND ${fk} = 0), false)`;
  const net = `CASE WHEN ${netOn} THEN LEAST(${i(R.network.max)}, ${i(R.network.first)} + ${i(R.network.more)} * (nw.n - 2)) ELSE 0 END`;
  const marks = `CASE WHEN ${mc} > 0 THEN ${i(R.markCompetitor)} WHEN ${mf} > 0 THEN ${i(R.markFake)} ELSE 0 END`;
  const raw = `(${i(R.base)} + ${part(d, 'delivered')} - ${part(r, 'returned')} - ${part(fk, 'fake')} - ${part(cc, 'cancelled')} - ${part(b, 'blocked')} - ${part(rv, 'review')} - ${marks} - ${net})`;
  const bl = 'coalesce(c.blacklisted, false)';
  const sd = 'coalesce(c.stopdesk_only, false)';
  const capped = `CASE WHEN ${bl} THEN LEAST(${raw}, CASE WHEN coalesce(c.blacklist_auto, false) THEN ${i(R.caps.blacklistAuto)} ELSE ${i(R.caps.blacklistManual)} END) WHEN ${sd} THEN LEAST(${raw}, ${i(R.caps.stopdesk)}) ELSE ${raw} END`;
  const score = `GREATEST(0, LEAST(100, ${capped}))`;
  const known = `(${d} > 0 OR ${r} > 0 OR ${fk} > 0 OR ${cc} > 0 OR ${b} > 0 OR ${rv} > 0 OR ${mf} > 0 OR ${mc} > 0 OR ${bl} OR ${sd} OR ${netOn})`;
  const L = R.levels;
  return `((CASE WHEN NOT ${known} THEN 2 WHEN ${score} >= ${i(L.top)} THEN 4 WHEN ${score} >= ${i(L.good)} THEN 3 WHEN ${score} >= ${i(L.watch)} THEN 1 ELSE 0 END) * 1000 + ${score})`;
}

/**
 * The ids of one page of orders matching `where` (on `orders o`, params $1…), sorted by their customer's score — the
 * best first (desc) or the riskiest first (asc), the newest first between equals. The network is asked once for the
 * phones of the whole list.
 */
export async function orderIdsByScore(ctx: Ctx, where: string, params: unknown[], dir: 'asc' | 'desc', limit: number, offset: number): Promise<number[]> {
  const R = await scoreRules(ctx.db);
  const phones = (await ctx.db.query(`SELECT DISTINCT c.phone FROM orders o JOIN customers c ON c.id = o.customer_id ${where}`, params)).map((x: any) => String(x.phone));
  const net = phones.length ? await sharedSellersMany(ctx, phones) : null;
  const flagged = net ? [...net.entries()].filter(([, n]) => n > 0) : [];
  const P = [...params, flagged.map(([p]) => p), flagged.map(([, n]) => n), limit, offset];
  const k = params.length;
  const rows = await ctx.db.query(
    `SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id
       ${factsJoins('o.customer_id')}
       LEFT JOIN unnest($${k + 1}::text[], $${k + 2}::int[]) AS nw(phone, n) ON nw.phone = c.phone
     ${where}
     ORDER BY ${rankSql(R)} ${dir === 'asc' ? 'ASC' : 'DESC'}, o.created_at DESC, o.id DESC
     LIMIT $${k + 3} OFFSET $${k + 4}`,
    P,
  );
  return rows.map((x: any) => num(x.id));
}

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

// ---------------------------------------------------------------- « Confirmer quand même »
/**
 * Orders just confirmed (or confirmed « sans stock »): those whose customer was « Risqué » at that moment are kept with
 * who confirmed them and the score's reasons (once per order). Never stops a confirmation: a failure here is ignored.
 */
export async function recordRiskConfirms(ctx: Ctx, orderIds: number[], userId: number | null, db: Db = ctx.db): Promise<number> {
  if (!orderIds.length) return 0;
  try {
    const rows = await db.query(
      `SELECT o.id AS order_id, c.id, c.phone, c.blacklisted, c.blacklist_auto, c.stopdesk_only, ${CLIENT_FACT_COLS}
         FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE o.id = ANY($1::bigint[]) AND NOT o.is_exchange AND NOT EXISTS (SELECT 1 FROM risk_confirms r WHERE r.order_id = o.id)`,
      [orderIds],
    );
    const scores = await scoresOf(ctx, rows);
    let n = 0;
    for (let k = 0; k < rows.length; k++) {
      const s = scores[k];
      if (s.level !== 'risk') continue;
      await db.query('INSERT INTO risk_confirms (order_id, user_id, score, reasons, at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (order_id) DO NOTHING', [
        num(rows[k].order_id),
        userId,
        s.score,
        JSON.stringify(s.reasons),
        new Date(ctx.now()).toISOString(),
      ]);
      n++;
    }
    return n;
  } catch {
    return 0;
  }
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

  /**
   * Dashboard › Confirmation: each agent's orders confirmed while the customer was « Risqué » in the period, and what
   * became of them — next to the returns of every parcel confirmed in the same period (the baseline).
   */
  'confirmation.riskStats': proc(['agent_manager', 'vendeur'], z.object({ from: z.string().max(40), to: z.string().max(40) }), async (ctx, i) => {
    const scope = andSql(queueSql(ctx, 'conf'));
    const rows = await ctx.db.query(
      `SELECT r.user_id, max(p.name) AS name, count(*)::int AS n,
          count(*) FILTER (WHERE o.follow_status IN ('delivered','exchanged'))::int AS delivered,
          count(*) FILTER (WHERE o.follow_status IN ('returning','returned'))::int AS returned,
          count(*) FILTER (WHERE (o.conf_status IN ('cancelled','fake','wrong_number','duplicate') OR o.follow_status IN ('cancelled','lost'))
                             AND coalesce(o.follow_status, '') NOT IN ('delivered','exchanged','returning','returned'))::int AS cancelled,
          round(avg(r.score))::int AS score
         FROM risk_confirms r JOIN orders o ON o.id = r.order_id LEFT JOIN profiles p ON p.id = r.user_id
        WHERE r.at >= $1::timestamptz AND r.at < $2::timestamptz${scope}
        GROUP BY 1 ORDER BY n DESC, name`,
      [i.from, i.to],
    );
    const b = (
      await ctx.db.query(
        `SELECT count(*) FILTER (WHERE o.follow_status IN ('delivered','exchanged'))::int AS d, count(*) FILTER (WHERE o.follow_status IN ('returning','returned'))::int AS r
           FROM sales o WHERE o.confirmed_at >= $1::timestamptz AND o.confirmed_at < $2::timestamptz${scope}`,
        [i.from, i.to],
      )
    )[0];
    const agents = rows.map((r: any) => {
      const n = num(r.n), delivered = num(r.delivered), returned = num(r.returned), cancelled = num(r.cancelled);
      return { id: r.user_id === null ? null : num(r.user_id), name: r.name ? String(r.name) : null, n, delivered, returned, cancelled, open: Math.max(0, n - delivered - returned - cancelled), score: num(r.score) };
    });
    const sum = (k: 'n' | 'delivered' | 'returned' | 'cancelled' | 'open') => agents.reduce((a: number, x: any) => a + x[k], 0);
    return {
      agents,
      total: { n: sum('n'), delivered: sum('delivered'), returned: sum('returned'), cancelled: sum('cancelled'), open: sum('open') },
      /** every parcel confirmed in the period: delivered and returned (the usual return rate, to compare) */
      baseline: { delivered: num(b?.d), returned: num(b?.r) },
    };
  }),

  /** Admin only: save every point at once (the scores everywhere follow at once). */
  'clientscore.setRules': proc([], rulesIn, async (ctx, i) => {
    await setSetting(ctx.db, 'clientScore', normalizeScoreRules(i), ctx.session.profile.id);
    ctx.emit({ type: 'orders' });
    return { ok: true };
  }),
};
