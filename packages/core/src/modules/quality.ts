// The buyers' quality: of the orders received from the landing pages (a customer sending the same order again counts
// once), how many came from real buyers — confirmed by an agent, or delivered — and how many were fake — blocked, or
// « fausse » / « faux numéro » for the agent. The rest: waiting, cancelled, unreachable. One definition for the control
// room, a seller's Protection page, each ad and the alert.

/** the last days are not finished: agents are still confirming their orders (today, yesterday, the day before) */
export const QUALITY_OPEN_DAYS = 3;

/** an Algeria day ('YYYY-MM-DD'): Algeria is UTC+1 all year */
export const algeriaDay = (ms: number) => new Date(ms + 3_600_000).toISOString().slice(0, 10);

/** a real buyer, on `orders o` joined to `landing_submits s` (as a store's own Protection page counts it) */
export const REAL_SQL = `(o.conf_status IN ('confirmed', 'no_stock') OR o.follow_status IN ('delivered', 'exchanged'))`;

/** buyers, good (real), bad (fake): the three counts, on `landing_submits s LEFT JOIN orders o ON o.id = s.order_id` */
export const QUALITY_SQL = `count(*) FILTER (WHERE NOT s.merged)::int AS buyers,
            count(DISTINCT s.order_id) FILTER (WHERE s.verdict <> 'block' AND NOT s.merged AND ${REAL_SQL})::int AS good,
            count(*) FILTER (WHERE NOT s.merged AND (s.verdict = 'block' OR o.conf_status IN ('fake', 'wrong_number')) AND NOT coalesce(${REAL_SQL}, false))::int AS bad`;

/** the ad an order came from (its ad set, else its ad, else the campaign name of the link), on the submit or its order */
export const AD_KEY_SQL = `COALESCE(NULLIF(s.utm->>'adset_id', ''), NULLIF(o.utm->>'adset_id', ''), NULLIF(s.utm->>'ad_id', ''), NULLIF(o.utm->>'ad_id', ''),
            NULLIF(s.utm->>'utm_campaign', ''), NULLIF(o.utm->>'utm_campaign', ''))`;

export interface QualityCount {
  buyers: number;
  good: number;
  bad: number;
}

/** real buyers out of 100 (0–1), null without buyers */
export const qualityOf = (c: QualityCount | null | undefined): number | null => (c && c.buyers ? c.good / c.buyers : null);
