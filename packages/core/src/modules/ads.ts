// Publicité (marketer): Meta spend face to the shop's real orders, with Pilotix's own Meta connection.
// On the server, results come from Meta through ctx.server.meta('insights') (see ../meta.ts) and are stored in
// adsets / ads / ad_insights / ad_daily; in the browser demo (no ctx.server) the seeded tables are used as they are.
//
// Attribution rules (documented here, shown in the page notes):
//  - An order belongs to a product by its FIRST product line (non-upsell first), as in the original
//    ("comptées pour le produit commandé au départ"). Duplicates are not counted as orders.
//  - Ad sets are linked to products by the marketer ("Quel produit vend cet ad set ?"). An ad set linked to several
//    products splits its spend equally between them.
//  - Admins / vendeurs see every ad set. A marketer only sees the ad sets assigned to him (adsets.marketer_id); his share of a
//    product's orders is his share of that product's ad spend over the period.
//  - Spend is in the ad account currency (USD cents); each day is converted with the rate of its month (fx_rates),
//    or the latest earlier rate when the month has none.
import { z } from 'zod';
import { Db, isoOrNull, num } from '../db';
import { bad, Ctx, forbidden, hasRole, notFound, proc } from '../rpc';
import { getSetting } from '../settings';
import { getRaw, setRaw } from './admin';

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Ym = z.string().regex(/^\d{4}-\d{2}$/);
const SYNC_KEY = 'ads_last_sync';
const SYNC_EVERY_MS = 30 * 60_000;

export const isOwner = (ctx: Ctx) => hasRole(ctx.session, 'vendeur');
/** A marketer partner's person given some products only (the store chose them): those products, else null. */
const givenProducts = (ctx: Ctx): Set<number> | null => (ctx.session.profile.agencyId && ctx.session.profile.agencyProducts ? new Set(ctx.session.profile.agencyProducts) : null);
/**
 * May this person see this ad set's numbers? A marketer partner's person: only ad sets on the products the store gives
 * (all of them; one not linked to a product yet too, to link it). A product the store takes back takes its ad sets'
 * numbers with it, even if they are still in the person's name.
 */
export function adsetInScope(ctx: Ctx): (s: { productIds: number[] }) => boolean {
  const g = givenProducts(ctx);
  return (s) => !g || s.productIds.every((p) => g.has(p));
}
/**
 * A marketer partner's chief (or manager) inside the store: the partner's id — they see the ad sets of every person of
 * their team here, not only their own. null for anyone else.
 */
export function partnerLead(ctx: Ctx): number | null {
  const p = ctx.session.profile;
  if (p.agencyId === null || p.agencyId === undefined || !p.agencyLead || !p.roles.includes('marketer')) return null;
  const n = Number(p.agencyId);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
/** Algiers midnight of a YYYY-MM-DD day, as ISO (UTC+1). */
export const dayStart = (d: string) => new Date(Date.parse(d + 'T00:00:00Z') - 3_600_000).toISOString();
export const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
/** Dates are selected as text (day::text) so no time zone can shift them. */
const dayStr = (v: unknown) => String(v).slice(0, 10);
const div = (a: number, b: number) => (b ? a / b : null);

// ---------------------------------------------------------------- Meta sync (server only)
/** Pulls daily results from Meta into the tables. Returns null when there is no server (demo) or no connection. */
export async function syncMeta(ctx: Ctx, from: string, to: string, force = false): Promise<{ at: string; adsets: number; days: number } | null> {
  if (!ctx.server) return null;
  const meta = await getSetting(ctx.db, 'meta');
  if (!meta.adAccountId || !meta.hasToken) return null;
  const last = await getRaw<{ at: string; from: string; to: string } | null>(ctx.db, SYNC_KEY, null);
  if (!force && last && last.from <= from && last.to >= to && ctx.now() - Date.parse(last.at) < SYNC_EVERY_MS) return null;
  const r = (await ctx.server.meta('insights', { from, to }, ctx)) as {
    adsets: { id: string; name: string; campaign: string; status: string | null }[];
    ads: { id: string; adsetId: string; name: string; status: string | null; isVideo: boolean }[];
    adsetDays: any[];
    adDays: any[];
  };
  await ctx.db.tx(async (tx) => {
    for (const s of r.adsets)
      await tx.query(
        `INSERT INTO adsets (id, name, campaign, status, updated_at) VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, campaign = EXCLUDED.campaign, status = EXCLUDED.status, updated_at = now()`,
        [s.id, s.name, s.campaign, s.status],
      );
    for (const a of r.ads)
      await tx.query(
        `INSERT INTO ads (id, adset_id, name, status, is_video, updated_at) VALUES ($1,$2,$3,$4,$5,now())
         ON CONFLICT (id) DO UPDATE SET adset_id = EXCLUDED.adset_id, name = EXCLUDED.name, status = EXCLUDED.status, is_video = EXCLUDED.is_video, updated_at = now()`,
        [a.id, a.adsetId, a.name, a.status, a.isVideo],
      );
    await tx.query('DELETE FROM ad_insights WHERE day BETWEEN $1 AND $2', [from, to]);
    await tx.query('DELETE FROM ad_daily WHERE day BETWEEN $1 AND $2', [from, to]);
    for (const d of r.adsetDays)
      await tx.query(
        `INSERT INTO adsets (id, name, campaign) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
        [d.adsetId, d.adsetName || d.adsetId, d.campaign || null],
      );
    for (const d of r.adsetDays)
      await tx.query(
        `INSERT INTO ad_insights (day, adset_id, spend_cents, impressions, reach, clicks, lpv, purchases, video_3s, thruplays) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (day, adset_id) DO UPDATE SET spend_cents = EXCLUDED.spend_cents, impressions = EXCLUDED.impressions, reach = EXCLUDED.reach, clicks = EXCLUDED.clicks,
           lpv = EXCLUDED.lpv, purchases = EXCLUDED.purchases, video_3s = EXCLUDED.video_3s, thruplays = EXCLUDED.thruplays`,
        [d.day, d.adsetId, d.spendCents, d.impressions, d.reach, d.clicks, d.lpv, d.purchases, d.video3s, d.thruplays],
      );
    for (const d of r.adDays)
      await tx.query(
        `INSERT INTO ad_daily (day, ad_id, adset_id, spend_cents, impressions, reach, clicks, lpv, purchases, video_3s, thruplays) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (day, ad_id) DO UPDATE SET spend_cents = EXCLUDED.spend_cents, impressions = EXCLUDED.impressions, reach = EXCLUDED.reach, clicks = EXCLUDED.clicks,
           lpv = EXCLUDED.lpv, purchases = EXCLUDED.purchases, video_3s = EXCLUDED.video_3s, thruplays = EXCLUDED.thruplays`,
        [d.day, d.adId, d.adsetId, d.spendCents, d.impressions, d.reach, d.clicks, d.lpv, d.purchases, d.video3s, d.thruplays],
      );
  });
  const at = new Date(ctx.now()).toISOString();
  const span = last ? { from: last.from < from ? last.from : from, to: last.to > to ? last.to : to } : { from, to };
  await setRaw(ctx.db, SYNC_KEY, { at, ...span });
  return { at, adsets: r.adsets.length, days: r.adsetDays.length };
}

// ---------------------------------------------------------------- data access
export interface AdsetRow {
  id: string;
  name: string;
  campaign: string | null;
  status: string | null;
  productIds: number[];
  marketerId: number | null;
  marketerName: string | null;
}

async function visibleAdsets(ctx: Ctx, marketerId?: number | null): Promise<AdsetRow[]> {
  const mine = !isOwner(ctx);
  // a marketer partner's chief: every ad set of the partner's people
  const lead = mine ? partnerLead(ctx) : null;
  const who = mine ? (lead ? null : ctx.session.profile.id) : marketerId ?? null;
  const rows = await ctx.db.query(
    `SELECT a.*, p.name AS marketer_name FROM adsets a LEFT JOIN profiles p ON p.id = a.marketer_id
     WHERE ($1::bigint IS NULL OR a.marketer_id = $1) AND ($2::bigint IS NULL OR p.agency_id = $2) ORDER BY a.name`,
    [who, lead],
  );
  return rows
    .map((r: any) => ({
      id: String(r.id),
      name: r.name,
      campaign: r.campaign,
      status: r.status,
      productIds: (r.product_ids ?? []).map(num),
      marketerId: r.marketer_id === null ? null : num(r.marketer_id),
      marketerName: r.marketer_name ?? null,
    }))
    .filter(mine ? adsetInScope(ctx) : () => true);
}

/** DZD per USD for each month (latest earlier rate when a month has none). */
export async function fxTable(db: Db): Promise<(ym: string) => number | null> {
  const rows = (await db.query('SELECT ym, rate FROM fx_rates ORDER BY ym')).map((r: any) => ({ ym: String(r.ym), rate: Number(r.rate) }));
  return (ym: string) => {
    let best: number | null = null;
    for (const r of rows) if (r.ym <= ym) best = r.rate;
    return best ?? rows[0]?.rate ?? null;
  };
}

export interface DayRow {
  day: string;
  adsetId: string;
  spendCents: number;
  impressions: number;
  reach: number;
  clicks: number;
  lpv: number;
  purchases: number;
  video3s: number;
  thruplays: number;
}
export async function insights(db: Db, ids: string[], from: string, to: string): Promise<DayRow[]> {
  if (!ids.length) return [];
  const rows = await db.query('SELECT *, day::text AS dtext FROM ad_insights WHERE adset_id = ANY($1) AND day BETWEEN $2 AND $3 ORDER BY day', [ids, from, to]);
  return rows.map((r: any) => ({
    day: dayStr(r.dtext),
    adsetId: String(r.adset_id),
    spendCents: num(r.spend_cents),
    impressions: num(r.impressions),
    reach: num(r.reach),
    clicks: num(r.clicks),
    lpv: num(r.lpv),
    purchases: num(r.purchases),
    video3s: num(r.video_3s),
    thruplays: num(r.thruplays),
  }));
}

/** Orders by their first product, for some products, created in [from, to] (Algiers days). */
export async function ordersOf(db: Db, productIds: number[], from: string, to: string) {
  if (!productIds.length) return [];
  return db.query(
    `WITH firsts AS (
       SELECT DISTINCT ON (i.order_id) i.order_id, i.product_id FROM order_items i ORDER BY i.order_id, i.is_upsell, i.id
     )
     SELECT o.id, o.created_at, o.conf_status, o.follow_status, o.total, o.delivery_cost, o.has_upsell, o.company_id, o.wilaya_id, f.product_id,
            (SELECT COALESCE(sum(i.qty * i.purchase_price), 0) FROM order_items i WHERE i.order_id = o.id) AS achat,
            (SELECT COALESCE(sum(i.qty), 0) FROM order_items i WHERE i.order_id = o.id) AS qty,
            -- the return fee the company itself counted (its API: price + weight fee), else its price list
            COALESCE(
              CASE WHEN o.courier_fees->>'ret' IS NOT NULL
                   THEN (o.courier_fees->>'ret')::numeric + COALESCE((o.courier_fees->>'weight')::numeric, (o.courier_fees->>'estRet')::numeric, 0) END,
              (SELECT df.return_fee FROM delivery_fees df WHERE df.company_id = o.company_id AND df.wilaya_id = o.wilaya_id), 0) AS return_fee
     FROM sales o JOIN firsts f ON f.order_id = o.id
     WHERE f.product_id = ANY($1) AND o.created_at >= $2 AND o.created_at < $3 AND o.conf_status <> 'duplicate'`,
    [productIds, dayStart(from), dayStart(addDays(to, 1))],
  );
}

// ---------------------------------------------------------------- money
export interface Money {
  n: number; // orders received
  d: number; // delivered
  r: number; // returned
  enRoute: number; // still on the road (not counted yet)
  x?: number; // cancelled (by the customer or as fake / wrong number)
  qty: number;
  rev: number;
  achat: number;
  liv: number;
  conf: number;
  ret: number;
  avant: number; // profit before ads
  pub: number; // ads (DZD)
  net: number;
}

/** Profit of a set of orders, line by line (the original "Bénéfice réel · ligne par ligne"). share = fraction counted (marketer share). */
export async function moneyOf(db: Db, orders: any[], pubDzd: number, share = 1): Promise<Money> {
  const plans = await getSetting(db, 'payPlans');
  let n = 0, d = 0, r = 0, x = 0, enRoute = 0, qty = 0, rev = 0, achat = 0, liv = 0, conf = 0, ret = 0;
  for (const o of orders) {
    n++;
    const fs = o.follow_status as string | null;
    if (fs === 'delivered' || fs === 'exchanged') {
      d++;
      qty += num(o.qty);
      rev += num(o.total);
      achat += num(o.achat);
      liv += num(o.delivery_cost);
      conf += (num(o.total) >= plans.agent.threshold ? plans.agent.above : plans.agent.below) + (o.has_upsell ? plans.agent.upsellBonus : 0);
    } else if (fs === 'returned' || fs === 'lost') {
      r++;
      ret += num(o.return_fee);
    } else if (fs === 'cancelled' || ['cancelled', 'fake', 'wrong_number'].includes(o.conf_status)) {
      x++;
    } else if (fs && ['shipped', 'out_for_delivery', 'failed', 'alert', 'in_exchange', 'returning'].includes(fs)) enRoute++;
  }
  const k = (v: number) => Math.round(v * share);
  const m = { n: k(n), d: k(d), r: k(r), x: k(x), enRoute: k(enRoute), qty: k(qty), rev: k(rev), achat: k(achat), liv: k(liv), conf: k(conf), ret: k(ret) };
  const avant = m.rev - m.achat - m.liv - m.conf - m.ret;
  const pub = Math.round(pubDzd);
  return { ...m, avant, pub, net: avant - pub };
}

// ---------------------------------------------------------------- advice and diagnostics (simple rules)
export type Advice = { k: 'scale' | 'keep' | 'price' | 'cutdel' | 'cut' | 'loss' | 'wait'; tone: 'ok' | 'mid' | 'bad' | 'off' };
/**
 * Product advice, same rule as the original "Que faire ?":
 *  - fewer than 15 orders or 5 delivered → wait (not enough data);
 *  - profit before ads <= 0 → loss (cut: the product loses money even without ads);
 *  - ratio = cost per order ÷ profit before ads per order: <= 0.7 → scale ("Augmenter le budget"); <= 1 → keep;
 *  - above 1: delivery rate < 35 % → cut (too few delivered); price rise needed <= 15 % of the price → raise the price; else cut.
 */
export function productAdvice(m: Money, unitPrice: number | null): Advice & { ratio: number | null; rise: number | null } {
  const { n, d } = m;
  if (n < 15 || d < 5) return { k: 'wait', tone: 'off', ratio: null, rise: null };
  if (m.avant <= 0) return { k: 'loss', tone: 'bad', ratio: null, rise: null };
  const cpo = m.pub / n;
  const cap = m.avant / n;
  const ratio = cpo / cap;
  const piecesPerDelivered = m.qty && d ? Math.max(1, m.qty / d) : 1;
  const rise = cpo > cap ? Math.ceil((((cpo - cap) * n) / d / piecesPerDelivered) / 100) * 100 : 0;
  if (ratio <= 0.7) return { k: 'scale', tone: 'ok', ratio, rise };
  if (ratio <= 1) return { k: 'keep', tone: 'mid', ratio, rise };
  if (d / n < 0.35) return { k: 'cutdel', tone: 'bad', ratio, rise };
  if (unitPrice && rise / unitPrice <= 0.15) return { k: 'price', tone: 'mid', ratio, rise };
  return { k: 'cut', tone: 'bad', ratio, rise };
}

export type DiagKey = 'scale' | 'cut' | 'hook' | 'fatigue' | 'audience' | 'page' | 'wait' | 'ok';
export interface Diag {
  k: DiagKey;
  tone: 'ok' | 'mid' | 'bad' | 'off';
  /** measured values used by the rule (for the explanation shown in the page) */
  v: Record<string, number | null>;
}
export const sumDays = (rows: DayRow[]) =>
  rows.reduce(
    (s, r) => ({ spend: s.spend + r.spendCents / 100, imp: s.imp + r.impressions, reach: s.reach + r.reach, clicks: s.clicks + r.clicks, lpv: s.lpv + r.lpv, pur: s.pur + r.purchases, v3: s.v3 + r.video3s, tp: s.tp + r.thruplays }),
    { spend: 0, imp: 0, reach: 0, clicks: 0, lpv: 0, pur: 0, v3: 0, tp: 0 },
  );

/**
 * Ad set diagnostics. Compares the last 7 days with the 7 days before (ending at `to`). Rules, first match wins:
 *  1. Couper — spent >= 3× the target cost per purchase (or $25 without target) with no purchase, or the product advice says cut / loss.
 *  2. Audience épuisée — frequency >= 2.5, CPM up >= 20 %, while hook and CTR held (dropped < 20 %): always the same people.
 *  3. Fatigue des vidéos — hook rate dropped >= 30 %, or CTR dropped >= 25 %, or frequency >= 2.2 with cost per purchase up >= 40 %.
 *  4. Hook faible — video ads with < 20 % of impressions watching 3 s.
 *  5. La page ne convertit pas — >= 100 landing page views and < 1.5 % of them buy (or < 60 % of clicks reach the page).
 *  6. Augmenter le budget — cost per purchase down >= 15 % (or product advice "scale"), frequency < 2.2.
 *  7. otherwise: ok (stable), or wait when < $5 spent.
 */
export function adsetDiagnostic(last: DayRow[], prev: DayRow[], product: Advice['k'] | null, targetCpa: number | null): Diag {
  const a = sumDays(last);
  const b = sumDays(prev);
  const cpa = div(a.spend, a.pur);
  const cpaPrev = div(b.spend, b.pur);
  const freq = div(a.imp, a.reach);
  const hook = a.v3 ? div(a.v3, a.imp) : null;
  const hookPrev = b.v3 ? div(b.v3, b.imp) : null;
  const ctr = div(a.clicks, a.imp);
  const ctrPrev = div(b.clicks, b.imp);
  const cpm = a.imp ? (a.spend / a.imp) * 1000 : null;
  const cpmPrev = b.imp ? (b.spend / b.imp) * 1000 : null;
  const drop = (x: number | null, y: number | null) => (x !== null && y ? (y - x) / y : 0);
  const rise = (x: number | null, y: number | null) => (x !== null && y ? (x - y) / y : 0);
  const conv = div(a.pur, a.lpv);
  const lpvRate = div(a.lpv, a.clicks);
  const v = { spend: a.spend, cpa, cpaPrev, freq, hook, hookPrev, ctr, ctrPrev, cpm, cpmPrev, conv, lpvRate };
  if (a.spend < 5 && b.spend < 5) return { k: 'wait', tone: 'off', v };
  const limit = targetCpa ? 3 * targetCpa : 25;
  if ((a.pur === 0 && a.spend >= limit) || product === 'cut' || product === 'loss' || product === 'cutdel') return { k: 'cut', tone: 'bad', v };
  if ((freq ?? 0) >= 2.5 && rise(cpm, cpmPrev) >= 0.2 && drop(hook, hookPrev) < 0.2 && drop(ctr, ctrPrev) < 0.2) return { k: 'audience', tone: 'bad', v };
  if (drop(hook, hookPrev) >= 0.3 || drop(ctr, ctrPrev) >= 0.25 || ((freq ?? 0) >= 2.2 && rise(cpa, cpaPrev) >= 0.4)) return { k: 'fatigue', tone: 'bad', v };
  if (hook !== null && hook < 0.2) return { k: 'hook', tone: 'mid', v };
  if ((a.lpv >= 100 && (conv ?? 0) < 0.015) || (a.clicks >= 50 && lpvRate !== null && a.lpv > 0 && lpvRate < 0.6)) return { k: 'page', tone: 'mid', v };
  if (((cpa !== null && cpaPrev !== null && cpa <= cpaPrev * 0.85) || product === 'scale') && (freq ?? 0) < 2.2) return { k: 'scale', tone: 'ok', v };
  return { k: 'ok', tone: 'ok', v };
}

/**
 * One ad ("Pubs de cet ad set"), rules from the original: fatigue (7-day cost per purchase >= 1.4× its lifetime one with frequency >= 2.2),
 * weak hook (< 20 % watch 3 s), weak presentation (< 15 % of them stay), clicks lost before the page (< 60 % arrive),
 * page does not convert (< 1.5 % of visitors buy), good ad (cost per purchase <= ad set average × 1.05), else to watch.
 */
export function adAdvice(life: ReturnType<typeof sumDays>, week: ReturnType<typeof sumDays>, isVideo: boolean, adsetCpa: number | null) {
  const cpa = div(life.spend, life.pur);
  const cpa7 = div(week.spend, week.pur);
  const freq = div(life.imp, life.reach);
  const hook = isVideo && life.v3 ? div(life.v3, life.imp) : null;
  const hold = isVideo && life.v3 ? div(life.tp, life.v3) : null;
  const lpvRate = div(life.lpv, life.clicks);
  const conv = div(life.pur, life.lpv);
  if (life.spend < 3 && life.pur < 3) return { k: 'nodata', tone: 'off' as const };
  if (cpa && week.spend >= 2 && (cpa7 === null || cpa7 >= 1.4 * cpa) && (freq ?? 0) >= 2.2) return { k: 'fatigue', tone: 'bad' as const };
  if (hook !== null && hook < 0.2) return { k: 'hook', tone: 'bad' as const };
  if (hold !== null && hold < 0.15) return { k: 'hold', tone: 'bad' as const };
  if (lpvRate !== null && life.clicks >= 50 && life.lpv > 0 && lpvRate < 0.6) return { k: 'lpv', tone: 'mid' as const };
  if (conv !== null && life.lpv >= 100 && conv < 0.015) return { k: 'page', tone: 'mid' as const };
  if (cpa && adsetCpa && cpa <= adsetCpa * 1.05) return { k: 'good', tone: 'ok' as const };
  return { k: 'watch', tone: 'mid' as const };
}

// ---------------------------------------------------------------- the overview
const Period = z.object({ from: Day, to: Day, productId: z.number().int().positive().nullable().optional(), marketerId: z.number().int().positive().nullable().optional() });

async function overview(ctx: Ctx, i: z.infer<typeof Period>) {
  if (i.to < i.from) throw bad('La date de fin est avant la date de début');
  if (Date.parse(i.to) - Date.parse(i.from) > 400 * 86_400_000) throw bad('Période trop longue (400 jours au plus)');
  let syncWarning: string | null = null;
  try {
    await syncMeta(ctx, i.from, i.to);
  } catch (e: any) {
    syncWarning = e?.message ?? 'Meta indisponible';
  }
  const owner = isOwner(ctx);
  const fx = await fxTable(ctx.db);
  const sets = await visibleAdsets(ctx, i.marketerId);
  const all = owner && !i.marketerId ? sets : await visibleAdsets({ ...ctx, session: { ...ctx.session, isAdmin: true } } as Ctx);
  const ids = sets.map((s) => s.id);
  const prevFrom = addDays(i.to, -13);
  const rows = await insights(ctx.db, all.map((s) => s.id), i.from < prevFrom ? i.from : prevFrom, i.to);
  const inPeriod = rows.filter((r) => r.day >= i.from && r.day <= i.to);
  const dzd = (r: DayRow) => {
    const rate = fx(r.day.slice(0, 7));
    return rate === null ? null : (r.spendCents / 100) * rate;
  };
  const fxMissing = inPeriod.some((r) => r.spendCents > 0 && fx(r.day.slice(0, 7)) === null);

  const products = (await ctx.db.query('SELECT id, name, sku, price, active FROM products ORDER BY name')).map((p: any) => ({ id: num(p.id), name: p.name as string, sku: p.sku as string, price: num(p.price), active: !!p.active }));
  const P = new Map(products.map((p) => [p.id, p]));

  // spend per product (all ad sets, to share orders between marketers) and mine
  const spendBy = (filter: (s: AdsetRow) => boolean) => {
    const out = new Map<number, { usd: number; dzd: number }>();
    const S = new Map(all.map((s) => [s.id, s]));
    for (const r of inPeriod) {
      const s = S.get(r.adsetId);
      if (!s || !filter(s) || !s.productIds.length) continue;
      const k = 1 / s.productIds.length;
      for (const pid of s.productIds) {
        const o = out.get(pid) ?? { usd: 0, dzd: 0 };
        o.usd += (r.spendCents / 100) * k;
        o.dzd += (dzd(r) ?? 0) * k;
        out.set(pid, o);
      }
    }
    return out;
  };
  const visible = new Set(ids);
  const mySpend = spendBy((s) => visible.has(s.id));
  const allSpend = spendBy(() => true);
  const myProducts = [...new Set(sets.flatMap((s) => s.productIds))].filter((p) => !i.productId || p === i.productId);
  const orders = await ordersOf(ctx.db, myProducts, i.from, i.to);
  const byProduct = new Map<number, any[]>();
  for (const o of orders) {
    const pid = num(o.product_id);
    (byProduct.get(pid) ?? byProduct.set(pid, []).get(pid)!).push(o);
  }
  const shareOf = (pid: number) => {
    if (owner && !i.marketerId) return 1;
    const a = allSpend.get(pid)?.usd ?? 0;
    return a ? (mySpend.get(pid)?.usd ?? 0) / a : 0;
  };

  const productRows: { productId: number; name: string; spendUsd: number; spendDzd: number; money: Money; advice: ReturnType<typeof productAdvice> }[] = [];
  for (const pid of myProducts) {
    const sp = mySpend.get(pid) ?? { usd: 0, dzd: 0 };
    const m = await moneyOf(ctx.db, byProduct.get(pid) ?? [], sp.dzd, shareOf(pid));
    const adv = productAdvice(m, P.get(pid)?.price ?? null);
    productRows.push({ productId: pid, name: P.get(pid)?.name ?? `#${pid}`, spendUsd: sp.usd, spendDzd: Math.round(sp.dzd), money: m, advice: adv });
  }
  productRows.sort((a, b) => b.spendUsd - a.spendUsd);

  // totals
  const scopeOrders = i.productId ? byProduct.get(i.productId) ?? [] : orders;
  const tot = productRows.filter((p) => !i.productId || p.productId === i.productId);
  const totalUsd = inPeriod.filter((r) => visible.has(r.adsetId) && (!i.productId || all.find((s) => s.id === r.adsetId)?.productIds.includes(i.productId))).reduce((s, r) => s + r.spendCents / 100, 0);
  const money: Money = tot.reduce(
    (s, p) => {
      const m = p.money;
      return { n: s.n + m.n, d: s.d + m.d, r: s.r + m.r, x: (s.x ?? 0) + (m.x ?? 0), enRoute: s.enRoute + m.enRoute, qty: s.qty + m.qty, rev: s.rev + m.rev, achat: s.achat + m.achat, liv: s.liv + m.liv, conf: s.conf + m.conf, ret: s.ret + m.ret, avant: s.avant + m.avant, pub: s.pub + m.pub, net: s.net + m.net };
    },
    { n: 0, d: 0, r: 0, x: 0, enRoute: 0, qty: 0, rev: 0, achat: 0, liv: 0, conf: 0, ret: 0, avant: 0, pub: 0, net: 0 },
  );
  // spend of unlinked ad sets still counts as ads spend for the shop total
  const unlinked = inPeriod.filter((r) => visible.has(r.adsetId) && !all.find((s) => s.id === r.adsetId)?.productIds.length);
  const unlinkedDzd = i.productId ? 0 : Math.round(unlinked.reduce((s, r) => s + (dzd(r) ?? 0), 0));
  money.pub += unlinkedDzd;
  money.net -= unlinkedDzd;
  void scopeOrders;

  // ad sets
  const advByProduct = new Map(productRows.map((p) => [p.productId, p.advice.k]));
  const adsetRows = sets
    .filter((s) => !i.productId || s.productIds.includes(i.productId))
    .map((s) => {
      const mine = inPeriod.filter((r) => r.adsetId === s.id);
      const t = sumDays(mine);
      const last = rows.filter((r) => r.adsetId === s.id && r.day > addDays(i.to, -7));
      const prev = rows.filter((r) => r.adsetId === s.id && r.day <= addDays(i.to, -7) && r.day > addDays(i.to, -14));
      const pAdv = s.productIds.map((p) => advByProduct.get(p)).find((k) => !!k) ?? null;
      // target cost per purchase (USD): what one order can pay for ads (profit before ads per order ÷ rate)
      const pr = productRows.find((p) => s.productIds.includes(p.productId));
      const rate = fx(i.to.slice(0, 7));
      const target = pr && pr.money.n && rate ? pr.money.avant / pr.money.n / rate : null;
      return {
        ...s,
        spendUsd: t.spend,
        spendDzd: Math.round(mine.reduce((x, r) => x + (dzd(r) ?? 0), 0)),
        purchases: t.pur,
        cpa: div(t.spend, t.pur),
        ctr: div(t.clicks, t.imp),
        cpm: t.imp ? (t.spend / t.imp) * 1000 : null,
        impressions: t.imp,
        diag: adsetDiagnostic(last, prev, pAdv, target && target > 0 ? target : null),
      };
    })
    .sort((a, b) => b.spendUsd - a.spendUsd);

  // day by day
  const days: { day: string; spendUsd: number; spendDzd: number | null; impressions: number; clicks: number; purchases: number; orders: number }[] = [];
  const shownSets = new Set(adsetRows.map((s) => s.id));
  for (let d = i.from; d <= i.to; d = addDays(d, 1)) {
    const rs = inPeriod.filter((r) => r.day === d && shownSets.has(r.adsetId));
    const t = sumDays(rs);
    const dz = rs.reduce((x, r) => x + (dzd(r) ?? 0), 0);
    const o = orders.filter((x: any) => (!i.productId || num(x.product_id) === i.productId) && new Date(new Date(x.created_at).getTime() + 3_600_000).toISOString().slice(0, 10) === d);
    const sh = o.length ? o.reduce((s: number, x: any) => s + shareOf(num(x.product_id)), 0) : 0;
    days.push({ day: d, spendUsd: t.spend, spendDzd: fxMissing ? null : Math.round(dz), impressions: t.imp, clicks: t.clicks, purchases: t.pur, orders: Math.round(sh) });
    if (days.length > 400) break;
  }

  const lastSync = await getRaw<{ at: string } | null>(ctx.db, SYNC_KEY, null);
  const meta = await getSetting(ctx.db, 'meta');
  return {
    from: i.from,
    to: i.to,
    owner,
    connected: meta.hasToken && !!meta.adAccountId,
    demo: !ctx.server,
    lastSync: isoOrNull(lastSync?.at ?? null),
    syncWarning,
    fx: { rate: fx(i.to.slice(0, 7)), month: i.to.slice(0, 7), missing: fxMissing },
    totals: { spendUsd: totalUsd, ...money, unlinkedDzd, toScale: productRows.filter((p) => p.advice.k === 'scale').length },
    products: productRows,
    adsets: adsetRows,
    days,
    // a marketer partner's person: only the products the store gave the marketer
    catalog: givenProducts(ctx) ? products.filter((p) => givenProducts(ctx)!.has(p.id)) : products,
    marketers: owner ? (await ctx.db.query(`SELECT id, name FROM profiles WHERE ('marketer' = ANY(roles) OR 'vendeur' = ANY(roles)) AND active ORDER BY name`)).map((r: any) => ({ id: num(r.id), name: r.name as string })) : [],
  };
}

/** Month-by-month table (6 months ending with `to`'s month), with closed months frozen. */
async function months(ctx: Ctx, to: string, marketerId: number | null) {
  const scope = isOwner(ctx) && !marketerId ? 'all' : `m${isOwner(ctx) ? marketerId : ctx.session.profile.id}`;
  const closes = new Map((await ctx.db.query('SELECT ym, data, closed_at FROM ad_month_closes WHERE scope = $1', [scope])).map((r: any) => [String(r.ym), { data: r.data, at: isoOrNull(r.closed_at) }]));
  const out = [];
  const end = new Date(Date.parse(to.slice(0, 7) + '-01T00:00:00Z'));
  for (let k = 5; k >= 0; k--) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - k, 1));
    const ym = d.toISOString().slice(0, 7);
    const closed = closes.get(ym);
    if (closed) {
      out.push({ ym, closed: true, closedAt: closed.at, ...(closed.data as object) });
      continue;
    }
    const from = `${ym}-01`;
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const o = await overview(ctx, { from, to: last, marketerId });
    out.push({ ym, closed: false, closedAt: null, ...monthRow(o) });
  }
  return out.reverse();
}
const monthRow = (o: Awaited<ReturnType<typeof overview>>) => {
  const t = o.totals;
  const pur = o.adsets.reduce((s, a) => s + a.purchases, 0);
  return { spendUsd: t.spendUsd, spendDzd: t.pub, metaCpa: div(t.spendUsd, pur), orders: t.n, delivered: t.d, rate: div(t.d, t.n), cpo: div(t.pub, t.n), cpd: div(t.pub, t.d), profit: t.net, fx: o.fx.rate };
};

// ---------------------------------------------------------------- procedures
export const adsProcs = {
  'ads.overview': proc(['marketer'], Period, (ctx, i) => overview(ctx, i)),
  'ads.months': proc(['marketer'], z.object({ to: Day, marketerId: z.number().int().positive().nullable().optional() }), (ctx, i) => months(ctx, i.to, i.marketerId ?? null)),
  /** Freezes a month's figures as they are now ("clôturer"); reopening deletes the freeze. */
  'ads.closeMonth': proc(['marketer'], z.object({ ym: Ym, close: z.boolean().default(true), marketerId: z.number().int().positive().nullable().optional() }), async (ctx, i) => {
    const owner = isOwner(ctx);
    const scope = owner && !i.marketerId ? 'all' : `m${owner ? i.marketerId : ctx.session.profile.id}`;
    if (!i.close) {
      if (!owner) throw forbidden('Seul le propriétaire peut rouvrir un mois');
      await ctx.db.query('DELETE FROM ad_month_closes WHERE ym = $1 AND scope = $2', [i.ym, scope]);
      return { ok: true };
    }
    const now = new Date(ctx.now()).toISOString().slice(0, 7);
    if (i.ym >= now) throw bad('Un mois se clôture une fois terminé');
    const last = new Date(Date.UTC(Number(i.ym.slice(0, 4)), Number(i.ym.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const o = await overview(ctx, { from: `${i.ym}-01`, to: last, marketerId: i.marketerId ?? null });
    await ctx.db.query(
      `INSERT INTO ad_month_closes (ym, scope, data, closed_by) VALUES ($1,$2,$3,$4) ON CONFLICT (ym, scope) DO UPDATE SET data = EXCLUDED.data, closed_by = EXCLUDED.closed_by, closed_at = now()`,
      [i.ym, scope, JSON.stringify(monthRow(o)), ctx.session.profile.id],
    );
    return { ok: true };
  }),
  /** Ad set detail: Meta day by day and its ads (copies) with advice. */
  'ads.adset': proc(['marketer'], z.object({ id: z.string().min(1).max(40), from: Day, to: Day }), async (ctx, i) => {
    const s = (await visibleAdsets(ctx)).find((x) => x.id === i.id);
    if (!s) throw notFound('Ad set introuvable');
    const days = await insights(ctx.db, [i.id], i.from, i.to);
    const t = sumDays(days);
    const adsetCpa = div(t.spend, t.pur);
    const ads = await ctx.db.query('SELECT * FROM ads WHERE adset_id = $1 ORDER BY name', [i.id]);
    const daily = await ctx.db.query('SELECT *, day::text AS dtext FROM ad_daily WHERE adset_id = $1 AND day <= $2 ORDER BY day', [i.id, i.to]);
    const wk = addDays(i.to, -6);
    const toRow = (r: any): DayRow => ({ day: dayStr(r.dtext), adsetId: String(r.adset_id), spendCents: num(r.spend_cents), impressions: num(r.impressions), reach: num(r.reach), clicks: num(r.clicks), lpv: num(r.lpv), purchases: num(r.purchases), video3s: num(r.video_3s), thruplays: num(r.thruplays) });
    return {
      adset: s,
      days: days.map((d) => ({ day: d.day, spendUsd: d.spendCents / 100, impressions: d.impressions, clicks: d.clicks, purchases: d.purchases, hook: d.impressions && d.video3s ? d.video3s / d.impressions : null })),
      ads: ads.map((a: any) => {
        const mine = daily.filter((r: any) => String(r.ad_id) === String(a.id)).map(toRow);
        const life = sumDays(mine);
        const week = sumDays(mine.filter((r) => r.day >= wk));
        return {
          id: String(a.id),
          name: a.name as string,
          status: a.status as string | null,
          isVideo: !!a.is_video,
          spendUsd: life.spend,
          purchases: life.pur,
          cpa: div(life.spend, life.pur),
          cpa7: div(week.spend, week.pur),
          hook: a.is_video && life.v3 ? div(life.v3, life.imp) : null,
          hold: a.is_video && life.v3 ? div(life.tp, life.v3) : null,
          ctr: div(life.clicks, life.imp),
          lpvRate: div(life.lpv, life.clicks),
          conv: div(life.pur, life.lpv),
          advice: adAdvice(life, week, !!a.is_video, adsetCpa),
        };
      }),
    };
  }),
  /** "Quel produit vend cet ad set ?" — the marketer links his ad set to one or more products. */
  'ads.link': proc(['marketer'], z.object({ adsetId: z.string().min(1).max(40), productIds: z.array(z.number().int().positive()).max(20) }), async (ctx, i) => {
    const s = (await ctx.db.query('SELECT marketer_id, product_ids FROM adsets WHERE id = $1', [i.adsetId]))[0];
    if (!s) throw notFound('Ad set introuvable');
    if (!isOwner(ctx) && (s.marketer_id === null || num(s.marketer_id) !== ctx.session.profile.id)) {
      // a marketer partner's chief: also the ad sets of the partner's people
      const lead = partnerLead(ctx);
      const team = lead !== null && s.marketer_id !== null && (await ctx.db.query('SELECT 1 FROM profiles WHERE id = $1 AND agency_id = $2', [s.marketer_id, lead])).length > 0;
      if (!team) throw forbidden('Cet ad set n’est pas à vous');
    }
    // the products of an ad set decide the marketer's share of their profit: he says it once, then only the owner
    // changes it (no moving an ad set onto the best seller at the end of the month)
    if (!isOwner(ctx) && (s.product_ids ?? []).length) throw forbidden('Produits déjà choisis : demandez au propriétaire de les changer');
    if (i.productIds.length) {
      const n = num((await ctx.db.query('SELECT count(*) AS n FROM products WHERE id = ANY($1)', [i.productIds]))[0].n);
      if (n !== new Set(i.productIds).size) throw bad('Produit inconnu');
      // a marketer partner's person: only the products the store gave the marketer
      const given = givenProducts(ctx);
      if (given && i.productIds.some((p) => !given.has(p))) throw forbidden('Ce produit n’est pas confié à votre espace marketer');
    }
    await ctx.db.query('UPDATE adsets SET product_ids = $2, updated_at = now() WHERE id = $1', [i.adsetId, [...new Set(i.productIds)]]);
    return { ok: true };
  }),
  /** Owner gives an ad set to a marketer (or takes it back). */
  'ads.setMarketer': proc(['vendeur'], z.object({ adsetId: z.string().min(1).max(40), marketerId: z.number().int().positive().nullable() }), async (ctx, i) => {
    if (i.marketerId) {
      const p = (await ctx.db.query('SELECT roles FROM profiles WHERE id = $1', [i.marketerId]))[0];
      if (!p || !(p.roles as string[]).some((r) => ['marketer', 'vendeur', 'admin'].includes(r))) throw bad('Cette personne n’a pas le rôle Marketeur');
    }
    const r = await ctx.db.query('UPDATE adsets SET marketer_id = $2, updated_at = now() WHERE id = $1 RETURNING id', [i.adsetId, i.marketerId]);
    if (!r.length) throw notFound('Ad set introuvable');
    return { ok: true };
  }),
  /** Dollar rate (DZD for 1 USD) of a month. */
  // the dollar rate turns ad spend into dinars, and so the marketers' pay: set by the owner, never by a marketer
  'ads.setFx': proc(['vendeur'], z.object({ ym: Ym, rate: z.number().min(1).max(10_000) }), async (ctx, i) => {
    await ctx.db.query('INSERT INTO fx_rates (ym, rate) VALUES ($1,$2) ON CONFLICT (ym) DO UPDATE SET rate = EXCLUDED.rate', [i.ym, i.rate]);
    return { ok: true };
  }),
  /**
   * "Actualiser": pulls Meta now (server). In the demo there is nothing to pull. A marketer partner's person refreshes
   * no more often than the automatic refresh (every 30 minutes): the Meta connection, and its limits, are the store's.
   */
  'ads.sync': proc(['marketer'], z.object({ from: Day, to: Day }), async (ctx, i) => {
    if (!ctx.server) return { ok: true, demo: true, at: null as string | null };
    const partner = !!ctx.session.profile.agencyId;
    const meta = await getSetting(ctx.db, 'meta');
    if (!meta.adAccountId || !meta.hasToken)
      throw bad(partner ? 'Meta n’est pas connecté chez ce vendeur : il l’ajoute dans ses Réglages → Meta Ads.' : 'Meta n’est pas connecté : demandez à l’administrateur (Réglages → Meta Ads).');
    const r = await syncMeta(ctx, i.from, i.to, !partner);
    if (r) return { ok: true, demo: false, at: r.at };
    // a partner's person within the 30 minutes: the last refresh stands
    const last = await getRaw<{ at: string } | null>(ctx.db, SYNC_KEY, null);
    return { ok: true, demo: false, at: last?.at ?? null };
  }),
};
