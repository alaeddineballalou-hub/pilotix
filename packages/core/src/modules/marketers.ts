// Marketing › Marketer: paying marketers per ad set (ported from the BabyJoy DZ "Marketeurs" tab).
//
// Each ad set is made by a marketer (adsets.marketer_id). It is judged on its WHOLE life (from its first day of results):
//  - its share of a product's orders, each month = its Meta purchases on that product ÷ the purchases of every ad set
//    selling that product that month (spend when nobody has a purchase). An ad set selling several products counts
//    1 / (number of products) of its purchases on each;
//  - its money = that share of the product's real profit (moneyOf: delivered sales − purchase − delivery − confirmation − returns)
//    minus its own ad spend, each month at that month's dollar rate;
//  - marge produit = delivered sales − delivery − purchase price (what the product leaves before ads and team);
//  - notre part = net profit ÷ marge produit.
// Réussi when notre part ≥ the threshold (30 % by default), or when net profit ≥ N × the marketer's price (3 by default:
// small margin but many sales). It is judged once stopped (paused / archived) and its parcels have arrived (at most 5 %
// of its orders still open). Réussi → the marketer's price is owed; raté → 0. The owner can set the result by hand,
// and a payment, once made, counts as a success.
//  - An order still in confirmation (new, no answer, call back…) more than STALE_DAYS after it came in no longer counts
//    as open: forgotten orders must not keep an ad set "en cours" forever.
//  - A month with ad spend but no dollar rate of its own: the ad set is not judged and cannot be paid until that month's
//    rate is entered (Publicité › Taux 1 $), since its spend in DA would be a guess.
//  - A marketer partner (a marketer's own space working for the store, Partenaires › Marketers): its people get an
//    account in the store (profiles.agency_id = the marketer); the store gives them ad sets as to its own marketers.
//    Their price per ad set is the marketer's own (copied by agencies.ts), and they are paid by the marketer's
//    monthly bill, never ad set by ad set here.
import { AgencyCounts, NO_COUNTS } from '@pilotix/shared';
import { z } from 'zod';
import { Db, isoOrNull, num } from '../db';
import { bad, Ctx, forbidden, notFound, proc } from '../rpc';
import { getRaw, setRaw } from './admin';
import { addDays, adsetDiagnostic, adsetInScope, adsProcs, DayRow, fxTable, insights, isOwner, moneyOf, ordersOf, partnerLead, sumDays } from './ads';

const RULES_KEY = 'mk_rules';
export interface MkRules {
  /** notre part au moins (fraction of the product margin) */
  seuil: number;
  /** or net profit ≥ mult × the marketer's price (0 = off) */
  mult: number;
}
const DEFAULT_RULES: MkRules = { seuil: 0.3, mult: 3 };
export const getRules = async (ctx: { db: Db }) => ({ ...DEFAULT_RULES, ...(await getRaw<Partial<MkRules>>(ctx.db, RULES_KEY, {})) });

/** "BID CAP" / "COST CAP" copies of an ad set are tagged in the list. */
const BID = /\b(bid|cost)\s*c[au]p\b/i;
const CONF_CLOSED = ['cancelled', 'duplicate', 'wrong_number', 'fake'];
const FOLLOW_CLOSED = ['delivered', 'exchanged', 'returned', 'lost', 'cancelled'];
const CONF_DONE = ['confirmed', 'no_stock'];
export const STALE_DAYS = 15;
/** Still open: not delivered / returned / cancelled yet, and not a confirmation forgotten for more than STALE_DAYS. */
export const isOpen = (o: any, now: number) => {
  if (CONF_CLOSED.includes(o.conf_status) || FOLLOW_CLOSED.includes(o.follow_status ?? '')) return false;
  if (!CONF_DONE.includes(o.conf_status) && now - new Date(o.created_at).getTime() > STALE_DAYS * 86_400_000) return false;
  return true;
};
/** Algiers day / month of a timestamp. */
const algDay = (t: number) => new Date(t + 3_600_000).toISOString().slice(0, 10);
const ymOf = (iso: string | Date) => algDay(new Date(iso).getTime()).slice(0, 7);

export type MkResult = 'ok' | 'ko' | 'run';
export interface MkRow {
  id: string;
  name: string;
  campaign: string | null;
  status: string | null;
  productIds: number[];
  /** product label (several products joined with +) */
  prod: string;
  marketerId: number | null;
  marketerName: string | null;
  /** its marketer works for a marketer partner (this partner's id): paid by the partner's monthly bill */
  partnerId: number | null;
  price: number;
  bid: boolean;
  /** not linked to a product yet: can't be judged */
  unlinked: boolean;
  months: string[];
  sp: number; // ad spend (USD)
  spDa: number; // ad spend (DZD, each month at its rate)
  pu: number; // Meta purchases
  n: number; // its share of orders
  d: number; // delivered
  open: number; // still open (not delivered / returned / cancelled yet)
  rev: number;
  marge: number;
  avant: number;
  net: number;
  ratio: number | null;
  stopped: boolean;
  finalAuto: boolean;
  okShare: boolean;
  okBig: boolean;
  okAuto: boolean;
  manual: MkResult | null;
  final: boolean;
  ok: boolean;
  paid: { amount: number; at: string | null; marketerId: number } | null;
  /** amount owed now (null while not judged or without marketer) */
  owe: number | null;
  /** months with ad spend and no dollar rate of their own: not judged, not payable */
  fxMissing: string[];
}

/** One ad set's numbers in one month (its months: those with results). */
export interface MkMonth {
  sp: number; // ad spend (USD)
  spDa: number; // ad spend (DZD, at the month's rate)
  n: number; // its share of the month's orders
  d: number; // of those, delivered
  r: number; // of those, returned
  avant: number; // its share of the profit before ads (DZD)
}

interface SetRow {
  id: string;
  name: string;
  campaign: string | null;
  status: string | null;
  productIds: number[];
  marketerId: number | null;
  marketerName: string | null;
  partnerId: number | null;
}

/** Every ad set (the owner) or the marketer's own, with its lifetime money and result. */
export async function mkRows(ctx: Ctx, onlyMine = !isOwner(ctx)): Promise<{ rows: MkRow[]; rules: MkRules; fxMissing: string[]; from: string; to: string }> {
  const me = ctx.session.profile.id;
  // a marketer partner's chief: the ad sets of every person of the partner here
  const lead = onlyMine ? partnerLead(ctx) : null;
  // a marketer partner's person: only the products the store gives (one taken back takes its ad sets with it)
  const given = adsetInScope(ctx);
  const r = await mkCompute(ctx.db, ctx.now(), onlyMine ? (lead ? (s) => s.partnerId === lead && given(s) : (s) => s.marketerId === me && given(s)) : undefined);
  return { rows: r.rows, rules: r.rules, fxMissing: r.fxMissing, from: r.from, to: r.to };
}

/**
 * The ad sets' lifetime money and result on a store's database, and each one's numbers month by month. Every ad set
 * counts in the shares; `keep` chooses the rows given back (a marketer's own, a marketer partner's people's).
 */
export async function mkCompute(db: Db, now: number, keep?: (s: SetRow) => boolean) {
  const rules = await getRules({ db });
  const today = algDay(now);
  // the whole life of every ad set: from the first day of Meta results
  const first = (await db.query('SELECT min(day)::text AS d FROM ad_insights'))[0]?.d as string | null | undefined;
  const start = first && first < today ? String(first).slice(0, 10) : today;
  const fx = await fxTable(db);
  const ownRate = new Set((await db.query('SELECT ym FROM fx_rates')).map((r: any) => String(r.ym)));

  const sets: SetRow[] = (await db.query(`SELECT a.*, p.name AS marketer_name, p.agency_id AS partner_id FROM adsets a LEFT JOIN profiles p ON p.id = a.marketer_id ORDER BY a.name`)).map((r: any) => ({
    id: String(r.id),
    name: r.name as string,
    campaign: r.campaign as string | null,
    status: r.status as string | null,
    productIds: ((r.product_ids ?? []) as unknown[]).map(num),
    marketerId: r.marketer_id === null ? null : num(r.marketer_id),
    marketerName: (r.marketer_name ?? null) as string | null,
    partnerId: r.partner_id === null || r.partner_id === undefined ? null : num(r.partner_id),
  }));
  const rows = await insights(db, sets.map((s) => s.id), start, today);
  const products = new Map((await db.query('SELECT id, name FROM products')).map((p: any) => [num(p.id), p.name as string]));
  const prices = new Map((await db.query('SELECT profile_id, price FROM marketer_prices')).map((r: any) => [num(r.profile_id), num(r.price)]));
  const forced = new Map((await db.query('SELECT adset_id, st FROM mk_results')).map((r: any) => [String(r.adset_id), r.st as MkResult]));
  const pays = new Map((await db.query('SELECT adset_id, marketer_id, amount, paid_at FROM mk_payments')).map((r: any) => [String(r.adset_id), { amount: num(r.amount), at: isoOrNull(r.paid_at), marketerId: num(r.marketer_id) }]));

  // orders of every linked product, by product and month
  const pids = [...new Set(sets.flatMap((s) => s.productIds))];
  const orders = await ordersOf(db, pids, start, today);
  const ordersBy = new Map<string, any[]>(); // `${pid}|${ym}`
  for (const o of orders) {
    const k = `${num(o.product_id)}|${ymOf(o.created_at)}`;
    (ordersBy.get(k) ?? ordersBy.set(k, []).get(k)!).push(o);
  }

  // Meta results by ad set and month
  const S = new Map(sets.map((s) => [s.id, s]));
  const byMonth = new Map<string, Map<string, DayRow[]>>(); // ym → adset → days
  for (const r of rows) {
    const ym = r.day.slice(0, 7);
    const m = byMonth.get(ym) ?? byMonth.set(ym, new Map()).get(ym)!;
    (m.get(r.adsetId) ?? m.set(r.adsetId, []).get(r.adsetId)!).push(r);
  }

  type Acc = { sp: number; spDa: number; pu: number; n: number; d: number; open: number; rev: number; marge: number; avant: number; months: Set<string>; noFx: Set<string> };
  const acc = new Map<string, Acc>();
  const get = (id: string) => acc.get(id) ?? acc.set(id, { sp: 0, spDa: 0, pu: 0, n: 0, d: 0, open: 0, rev: 0, marge: 0, avant: 0, months: new Set(), noFx: new Set() }).get(id)!;
  // each ad set's numbers month by month (a marketer partner's bill counts one month)
  const perMonth = new Map<string, Map<string, MkMonth>>();
  const getM = (id: string, ym: string) => {
    const m = perMonth.get(id) ?? perMonth.set(id, new Map()).get(id)!;
    return m.get(ym) ?? m.set(ym, { sp: 0, spDa: 0, n: 0, d: 0, r: 0, avant: 0 }).get(ym)!;
  };
  for (const [ym, m] of [...byMonth.entries()].sort()) {
    const rate = fx(ym);
    // spend and purchases of each ad set that month
    const tot = new Map<string, { usd: number; pur: number }>();
    for (const [id, days] of m) {
      const t = sumDays(days);
      tot.set(id, { usd: t.spend, pur: t.pur });
      const a = get(id);
      a.sp += t.spend;
      a.pu += t.pur;
      if (t.spend > 0) a.months.add(ym);
      if (t.spend > 0 && !ownRate.has(ym)) a.noFx.add(ym);
      if (rate !== null) a.spDa += t.spend * rate;
      const mm = getM(id, ym);
      mm.sp += t.spend;
      if (rate !== null) mm.spDa += t.spend * rate;
    }
    // each product's orders that month, shared between the ad sets that sold it
    const prodSets = new Map<number, string[]>();
    for (const id of m.keys()) for (const pid of S.get(id)?.productIds ?? []) (prodSets.get(pid) ?? prodSets.set(pid, []).get(pid)!).push(id);
    for (const [pid, ids] of prodSets) {
      const w = (id: string) => (tot.get(id)?.pur ?? 0) / (S.get(id)!.productIds.length || 1);
      const ws = (id: string) => (tot.get(id)?.usd ?? 0) / (S.get(id)!.productIds.length || 1);
      const P = ids.reduce((s, id) => s + w(id), 0);
      const SP = ids.reduce((s, id) => s + ws(id), 0);
      const list = ordersBy.get(`${pid}|${ym}`) ?? [];
      if (!list.length) continue;
      const R = await moneyOf(db, list, 0, 1);
      const open = list.filter((o) => isOpen(o, now)).length;
      for (const id of ids) {
        const sh = P ? w(id) / P : SP ? ws(id) / SP : 0;
        if (!sh) continue;
        const a = get(id);
        a.n += R.n * sh;
        a.d += R.d * sh;
        a.open += open * sh;
        a.rev += R.rev * sh;
        a.marge += (R.rev - R.liv - R.achat) * sh;
        a.avant += R.avant * sh;
        const mm = getM(id, ym);
        mm.n += R.n * sh;
        mm.d += R.d * sh;
        mm.r += R.r * sh;
        mm.avant += R.avant * sh;
      }
    }
  }

  const out: MkRow[] = [];
  for (const s of sets) {
    const a = acc.get(s.id);
    if (!a || a.sp <= 0) continue; // never spent
    if (keep && !keep(s)) continue;
    const price = s.marketerId ? prices.get(s.marketerId) ?? 0 : 0;
    const net = a.avant - a.spDa;
    const ratio = a.marge > 0 ? net / a.marge : null;
    const unlinked = !s.productIds.length;
    const stopped = s.status !== 'ACTIVE';
    const fxMissing = [...a.noFx].sort();
    const finalAuto = !unlinked && !fxMissing.length && stopped && (a.open < 0.5 || a.open <= 0.05 * a.n);
    const okShare = a.marge > 0 && ratio !== null && ratio >= rules.seuil;
    const okBig = price > 0 && rules.mult > 0 && net >= rules.mult * price;
    const okAuto = okShare || okBig;
    const manual = forced.get(s.id) ?? null;
    const paid = pays.get(s.id) ?? null;
    let final = finalAuto;
    let ok = okAuto;
    if (manual === 'ok' || (!manual && paid)) (final = true), (ok = true);
    else if (manual === 'ko') (final = true), (ok = false);
    else if (manual === 'run') final = false;
    // nothing can be paid while a month's dollar rate is missing (its spend in DA is unknown); a marketer partner's
    // people are paid by the partner's monthly bill, not here
    const owe = !s.marketerId || s.partnerId !== null || !final || (fxMissing.length && !paid) ? null : ok ? price : 0;
    out.push({
      id: s.id,
      name: s.name,
      campaign: s.campaign,
      status: s.status,
      productIds: s.productIds,
      prod: s.productIds.map((p) => products.get(p) ?? `#${p}`).join(' + '),
      marketerId: s.marketerId,
      marketerName: s.marketerName,
      partnerId: s.partnerId,
      price,
      bid: BID.test(s.name),
      unlinked,
      months: [...a.months].sort(),
      sp: a.sp,
      spDa: Math.round(a.spDa),
      pu: a.pu,
      n: a.n,
      d: a.d,
      open: a.open,
      rev: Math.round(a.rev),
      marge: Math.round(a.marge),
      avant: Math.round(a.avant),
      net: Math.round(net),
      ratio,
      stopped,
      finalAuto,
      okShare,
      okBig,
      okAuto,
      manual,
      final,
      ok,
      paid,
      owe,
      fxMissing,
    });
  }
  out.sort((x, y) => y.sp - x.sp);
  const months = new Map(out.map((r) => [r.id, perMonth.get(r.id) ?? new Map<string, MkMonth>()]));
  return { rows: out, months, rules, fxMissing: [...new Set(out.flatMap((r) => r.fxMissing))].sort(), from: start, to: today };
}

/**
 * A marketer partner's month in a store: its people's ad sets that spent that month (their spend, their share of the
 * orders and of the profit), and those judged « réussi » whose last month with spend is this one.
 */
export async function marketerMonth(db: Db, partnerId: number, ym: string, now: number, products: number[] | null = null): Promise<AgencyCounts> {
  const people = new Set((await db.query('SELECT id FROM profiles WHERE agency_id = $1', [partnerId])).map((r: any) => num(r.id)));
  if (!people.size) return { ...NO_COUNTS };
  // the bill counts what the marketer sees: ad sets on the products the store gives (null: all of them)
  const given = products ? new Set(products) : null;
  const r = await mkCompute(db, now, (s) => s.marketerId !== null && people.has(s.marketerId) && (!given || s.productIds.every((p) => given.has(p))));
  const c = { adsets: 0, spend: 0, orders: 0, delivered: 0, returned: 0, net: 0, successes: 0 };
  for (const row of r.rows) {
    const m = r.months.get(row.id)?.get(ym);
    if (m) {
      if (m.sp > 0) c.adsets++;
      c.spend += m.spDa;
      c.orders += m.n;
      c.delivered += m.d;
      c.returned += m.r;
      c.net += m.avant - m.spDa;
    }
    if (row.final && row.ok && row.months[row.months.length - 1] === ym) c.successes++;
  }
  return { ...NO_COUNTS, adsets: c.adsets, spend: Math.round(c.spend), orders: Math.round(c.orders), delivered: Math.round(c.delivered), returned: Math.round(c.returned), net: Math.round(c.net), successes: c.successes };
}

/** A marketer partner's person (their price and payments come from the partner): not changed here. */
async function partnerOf(db: Db, profileId: number): Promise<number | null> {
  const r = (await db.query('SELECT agency_id FROM profiles WHERE id = $1', [profileId]))[0];
  return r && r.agency_id !== null && r.agency_id !== undefined ? num(r.agency_id) : null;
}

const Ids = z.array(z.string().min(1).max(40)).min(1).max(500);

export const marketersProcs = {
  /** The page: every ad set's lifetime result, the marketers and their price, the rules. */
  'mk.overview': proc(['marketer'], z.object({}), async (ctx) => {
    const owner = isOwner(ctx);
    const r = await mkRows(ctx);
    const people = owner
      ? await ctx.db.query(`SELECT p.id, p.name, p.active, p.agency_id, mp.price FROM profiles p LEFT JOIN marketer_prices mp ON mp.profile_id = p.id
           WHERE (('marketer' = ANY(p.roles) OR 'vendeur' = ANY(p.roles)) AND p.active) OR p.id IN (SELECT marketer_id FROM adsets WHERE marketer_id IS NOT NULL) ORDER BY p.name`)
      : partnerLead(ctx)
        ? await ctx.db.query(`SELECT p.id, p.name, p.active, p.agency_id, mp.price FROM profiles p LEFT JOIN marketer_prices mp ON mp.profile_id = p.id WHERE p.agency_id = $1 ORDER BY p.name`, [partnerLead(ctx)])
        : await ctx.db.query(`SELECT p.id, p.name, p.active, p.agency_id, mp.price FROM profiles p LEFT JOIN marketer_prices mp ON mp.profile_id = p.id WHERE p.id = $1`, [ctx.session.profile.id]);
    // the marketer partners (Partenaires › Marketers) whose people are here: their name, to tell them apart
    const pids = [...new Set(people.map((p: any) => p.agency_id).filter((x: unknown) => x !== null && x !== undefined).map(num))];
    const partners = new Map<number, string>();
    if (pids.length && ctx.t) for (const row of await ctx.t.platform.query('SELECT id, name FROM platform.shops WHERE id = ANY($1)', [pids])) partners.set(num(row.id), row.name as string);
    return {
      owner,
      admin: ctx.session.isAdmin,
      demo: !ctx.server,
      from: r.from,
      to: r.to,
      fxMissing: r.fxMissing,
      rules: r.rules,
      marketers: people.map((p: any) => {
        const partnerId = p.agency_id === null || p.agency_id === undefined ? null : num(p.agency_id);
        return { id: num(p.id), name: p.name as string, active: !!p.active, price: p.price === null || p.price === undefined ? 0 : num(p.price), partner: partnerId === null ? null : { id: partnerId, name: partners.get(partnerId) ?? '' } };
      }),
      rows: r.rows,
    };
  }),

  /** One ad set: its result, Meta day by day, its ads (copies) with their rates, 7 days against the week before, and 30 days of orders. */
  'mk.adset': proc(['marketer'], z.object({ id: z.string().min(1).max(40) }), async (ctx, i) => {
    const { rows, from, to } = await mkRows(ctx);
    const row = rows.find((x) => x.id === i.id);
    if (!row) throw notFound('Ad set introuvable');
    const detail = await adsProcs['ads.adset'].run({ ...ctx, session: { ...ctx.session, isAdmin: true } } as Ctx, { id: i.id, from, to });
    const recent = await insights(ctx.db, [i.id], addDays(to, -13), to);
    const last = recent.filter((r) => r.day > addDays(to, -7));
    const prev = recent.filter((r) => r.day <= addDays(to, -7));
    const diag = adsetDiagnostic(last, prev, null, null);
    const w0 = sumDays(last);
    const w1 = sumDays(prev);
    const wk = (t: ReturnType<typeof sumDays>) => ({ spend: t.spend, pur: t.pur, cpa: t.pur ? t.spend / t.pur : null, freq: t.reach ? t.imp / t.reach : null, hook: t.imp && t.v3 ? t.v3 / t.imp : null, ctr: t.imp ? t.clicks / t.imp : null, cpm: t.imp ? (t.spend / t.imp) * 1000 : null });
    // last 30 days of orders for its product(s), every ad set together
    const d30 = addDays(to, -29);
    const list = row.productIds.length ? await ordersOf(ctx.db, row.productIds, d30, to) : [];
    const days: { day: string; n: number; d: number }[] = [];
    for (let d = d30; d <= to; d = addDays(d, 1)) days.push({ day: d, n: 0, d: 0 });
    const at = new Map(days.map((x) => [x.day, x]));
    for (const o of list) {
      const x = at.get(algDay(new Date(o.created_at).getTime()));
      if (!x) continue;
      x.n++;
      if (o.follow_status === 'delivered' || o.follow_status === 'exchanged') x.d++;
    }
    return { row, days: detail.days, ads: detail.ads, diag, week: { now: wk(w0), before: wk(w1) }, orders30: days };
  }),

  /** Gives ad sets to a marketer (null = takes them back). */
  'mk.assign': proc(['vendeur'], z.object({ ids: Ids, marketerId: z.number().int().positive().nullable() }), async (ctx, i) => {
    if (i.marketerId) {
      const p = (await ctx.db.query('SELECT roles FROM profiles WHERE id = $1', [i.marketerId]))[0];
      if (!p || !(p.roles as string[]).some((r) => ['marketer', 'vendeur', 'admin'].includes(r))) throw bad('Cette personne n’a pas le rôle Marketeur');
    }
    const r = await ctx.db.query('UPDATE adsets SET marketer_id = $2, updated_at = now() WHERE id = ANY($1) RETURNING id', [i.ids, i.marketerId]);
    return { ok: true, n: r.length };
  }),

  /** A marketer's price for one successful ad set (DA). */
  'mk.price': proc(['vendeur'], z.object({ marketerId: z.number().int().positive(), price: z.number().int().min(0).max(10_000_000) }), async (ctx, i) => {
    const p = (await ctx.db.query('SELECT id FROM profiles WHERE id = $1', [i.marketerId]))[0];
    if (!p) throw notFound('Marketeur introuvable');
    if ((await partnerOf(ctx.db, i.marketerId)) !== null) throw forbidden('Ce marketer fixe lui-même ses prix (Partenaires › Marketers)');
    await ctx.db.query(
      'INSERT INTO marketer_prices (profile_id, price, updated_at) VALUES ($1,$2,now()) ON CONFLICT (profile_id) DO UPDATE SET price = EXCLUDED.price, updated_at = now()',
      [i.marketerId, i.price],
    );
    return { ok: true };
  }),

  /** Payment rules: threshold (% of the product margin) and the "× the price" rule. */
  'mk.rules': proc(['vendeur'], z.object({ seuil: z.number().min(0.01).max(1), mult: z.number().min(0).max(100) }), async (ctx, i) => {
    await setRaw(ctx.db, RULES_KEY, { seuil: i.seuil, mult: i.mult }, ctx.session.profile.id);
    return { ok: true };
  }),

  /** Result set by hand (null = back to the calculation). */
  'mk.force': proc(['vendeur'], z.object({ ids: Ids, st: z.enum(['ok', 'ko', 'run']).nullable() }), async (ctx, i) => {
    if (i.st === null) await ctx.db.query('DELETE FROM mk_results WHERE adset_id = ANY($1)', [i.ids]);
    else
      for (const id of i.ids)
        await ctx.db.query(
          'INSERT INTO mk_results (adset_id, st, set_by, set_at) VALUES ($1,$2,$3,now()) ON CONFLICT (adset_id) DO UPDATE SET st = EXCLUDED.st, set_by = EXCLUDED.set_by, set_at = now()',
          [id, i.st, ctx.session.profile.id],
        );
    return { ok: true, n: i.ids.length };
  }),

  /** Marks ad sets paid: each one at what is owed now (its marketer's price). Ad sets with nothing owed are skipped. */
  'mk.pay': proc(['vendeur'], z.object({ ids: Ids }), async (ctx, i) => {
    const { rows } = await mkRows(ctx, false);
    let n = 0;
    let total = 0;
    for (const id of new Set(i.ids)) {
      const a = rows.find((x) => x.id === id);
      if (!a || a.paid || !a.owe || !a.marketerId || a.fxMissing.length) continue;
      await ctx.db.query(
        'INSERT INTO mk_payments (adset_id, marketer_id, amount, net, marge, paid_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (adset_id) DO NOTHING',
        [a.id, a.marketerId, a.owe, a.net, a.marge, ctx.session.profile.id],
      );
      n++;
      total += a.owe;
    }
    if (!n && [...new Set(i.ids)].every((id) => rows.find((x) => x.id === id)?.partnerId != null)) throw bad('Ces ad sets sont payés par la facture mensuelle de leur marketer (Partenaires › Marketers)');
    if (!n) throw bad('Rien à payer pour ces ad sets');
    return { ok: true, n, total };
  }),

  /** Cancels a payment (made by mistake). */
  'mk.unpay': proc(['vendeur'], z.object({ id: z.string().min(1).max(40) }), async (ctx, i) => {
    const r = await ctx.db.query('DELETE FROM mk_payments WHERE adset_id = $1 RETURNING adset_id', [i.id]);
    if (!r.length) throw notFound('Aucun paiement pour cet ad set');
    return { ok: true };
  }),
};
