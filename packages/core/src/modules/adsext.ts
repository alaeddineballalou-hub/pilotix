// The Pilotix Chrome extension in Meta's Ads Manager: next to each ad, Pilotix's own numbers for it over the last days
// — its orders, the ones confirmed and delivered, what one confirmed order cost, and where that cost stands against
// the product's bid limit (the one typed in « Lancer une pub »): under it, above it, past the alert limit (× 1.33) or
// past the stop limit (× 1.58), the owner's levels (Pilot Checks reads the same).
// An order belongs to an ad by the ad's id in its link (orders.utm ad_id: Pilotix's URL parameters, or Meta's own).
// A marketer sees only the ads of their own ad sets, the owner every ad. The spend is Meta's (ads' daily spend, read
// every 15 minutes), turned into dinars with the month's rate for a dollar account.
import { z } from 'zod';
import { num } from '../db';
import { Ctx, proc } from '../rpc';
import { getRaw } from './admin';
import { addDays, dayStart, daySpend, fxTable, visibleAdsets } from './ads';
import { BID_LIMITS_KEY } from './adslaunch';

const algDay = (ms: number) => new Date(ms + 3_600_000).toISOString().slice(0, 10);

/** Where an ad's cost per confirmed order stands against its product's bid limit. */
export type BidLevel = 'good' | 'over' | 'alert' | 'stop';
/** The owner's lines: the bid limit, the alert limit (× 1.33) and the stop limit (× 1.58). */
export const ALERT_X = 1.33;
export const STOP_X = 1.58;

/** A cost against a bid limit (spend with no confirmed order counts as its whole spend). */
export function bidLevel(spendDzd: number | null, confirmed: number, bidLimit: number | null): BidLevel | null {
  if (spendDzd === null || !bidLimit || bidLimit <= 0 || spendDzd <= 0) return null;
  const cost = confirmed > 0 ? spendDzd / confirmed : spendDzd;
  // no confirmed order yet: judged only once it spent more than the bid limit
  if (confirmed === 0 && cost <= bidLimit) return null;
  if (cost <= bidLimit) return 'good';
  if (cost <= bidLimit * ALERT_X) return 'over';
  if (cost <= bidLimit * STOP_X) return 'alert';
  return 'stop';
}

export interface ExtAdNumbers {
  id: string;
  name: string;
  adsetId: string;
  productId: number | null;
  product: string | null;
  orders: number;
  confirmed: number;
  delivered: number;
  /** its spend over these days, in dinars (null: a dollar account with no rate yet) */
  spendDzd: number | null;
  /** what one confirmed order cost (null: none confirmed, or no spend known) */
  costConfirmed: number | null;
  /** its product's bid limit in dinars (null: not typed yet) */
  bidLimit: number | null;
  level: BidLevel | null;
}

/**
 * The numbers of the ads this person sees, over the last `days` days (today included): the ads asked by id or name, and
 * every other one that spent or brought an order (or every one of them: `all`), the ones that spent most first.
 */
async function extNumbers(ctx: Ctx, i: { adIds: string[]; names: string[]; days: number; all: boolean }) {
  const today = algDay(ctx.now());
  const from = addDays(today, -(i.days - 1));
  const sets = await visibleAdsets(ctx);
  const setIds = sets.map((s) => s.id);
  if (!setIds.length) return { days: i.days, from, ads: [] as ExtAdNumbers[] };
  const product = new Map(sets.map((s) => [s.id, s.productIds[0] ?? null]));
  const ads = await ctx.db.query(`SELECT id, adset_id, name FROM ads WHERE adset_id = ANY($1) AND coalesce(status, '') NOT IN ('DELETED', 'ARCHIVED')`, [setIds]);
  const ids = ads.map((a: any) => String(a.id));
  const orders = new Map<string, { n: number; c: number; d: number }>();
  if (ids.length)
    for (const r of await ctx.db.query(
      `SELECT o.utm->>'ad_id' AS ad, count(*)::int AS n,
              count(*) FILTER (WHERE o.conf_status IN ('confirmed', 'no_stock'))::int AS c,
              count(*) FILTER (WHERE o.follow_status IN ('delivered', 'exchanged'))::int AS d
         FROM sales o WHERE o.utm->>'ad_id' = ANY($1) AND o.conf_status <> 'duplicate' AND o.created_at >= $2 GROUP BY 1`,
      [ids, dayStart(from)],
    ))
      orders.set(String(r.ad), { n: num(r.n), c: num(r.c), d: num(r.d) });
  const fx = await fxTable(ctx.db);
  const spend = new Map<string, number | null>();
  if (ids.length)
    for (const r of await ctx.db.query(
      `SELECT to_char(d.day, 'YYYY-MM-DD') AS day, d.ad_id, d.spend_cents, s.currency FROM ad_daily d LEFT JOIN adsets s ON s.id = d.adset_id WHERE d.ad_id = ANY($1) AND d.day >= $2`,
      [ids, from],
    )) {
      const day = String(r.day);
      const x = daySpend(fx, day, num(r.spend_cents), r.currency);
      const rate = fx(day.slice(0, 7));
      const dzd = x.dzdCents !== null ? x.dzdCents / 100 : rate ? (x.spendCents / 100) * rate : null;
      const prev = spend.has(String(r.ad_id)) ? spend.get(String(r.ad_id))! : 0;
      spend.set(String(r.ad_id), prev === null || dzd === null ? null : prev + dzd);
    }
  const limits = await getRaw<Record<string, number>>(ctx.db, BID_LIMITS_KEY, {});
  const pids = [...new Set([...product.values()].filter((p): p is number => p !== null))];
  const names = new Map<number, string>(pids.length ? (await ctx.db.query(`SELECT id, name FROM products WHERE id = ANY($1)`, [pids])).map((r: any) => [num(r.id), String(r.name)]) : []);
  const askedIds = new Set(i.adIds);
  const askedNames = new Set(i.names.map((n) => n.trim().toLowerCase()));
  const out: ExtAdNumbers[] = [];
  for (const a of ads) {
    const id = String(a.id);
    const o = orders.get(id) ?? { n: 0, c: 0, d: 0 };
    const sp = spend.has(id) ? spend.get(id)! : 0;
    if (!i.all && !askedIds.has(id) && !askedNames.has(String(a.name).trim().toLowerCase()) && !o.n && !sp) continue;
    const pid = product.get(String(a.adset_id)) ?? null;
    const bid = pid !== null && Number(limits[String(pid)]) > 0 ? Math.round(Number(limits[String(pid)])) : null;
    const spendDzd = sp === null ? null : Math.round(sp);
    out.push({
      id,
      name: String(a.name),
      adsetId: String(a.adset_id),
      productId: pid,
      product: pid !== null ? (names.get(pid) ?? null) : null,
      orders: o.n,
      confirmed: o.c,
      delivered: o.d,
      spendDzd,
      costConfirmed: spendDzd !== null && o.c > 0 ? Math.round(spendDzd / o.c) : null,
      bidLimit: bid,
      level: bidLevel(spendDzd, o.c, bid),
    });
  }
  out.sort((a, b) => (b.spendDzd ?? 0) - (a.spendDzd ?? 0) || b.orders - a.orders);
  return { days: i.days, from, ads: out.slice(0, 300) };
}

export const adsExtProcs = {
  /** The Pilotix extension in Meta's Ads Manager: each ad's orders, confirmed, delivered, cost per confirmed, bid limit. */
  'ads.extNumbers': proc(
    ['marketer'],
    z.object({
      adIds: z.array(z.string().regex(/^\d{6,25}$/)).max(300).default([]),
      names: z.array(z.string().max(300)).max(300).default([]),
      days: z.number().int().min(1).max(90).default(7),
      // every ad of theirs, even one that did nothing these days (Ads Manager lists them all)
      all: z.boolean().default(false),
    }),
    (ctx, i) => extNumbers(ctx, i),
  ),
};
