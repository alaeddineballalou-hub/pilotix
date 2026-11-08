// A confirmation agency's own numbers (its space), on its orders only — the orders a store gave it — in every store it
// works for, or the seller chosen at the top of the page:
// - « Dashboard » (everyone): what waits now, who is on line, the period's numbers and each agent's. An agent sees his own
//   orders and his own row only (with his rank, no one else's name); the chief and the agent managers see the team.
//   The leads also see each seller's numbers; the chief also the month's money (agency.money): what each seller owes
//   the agency, what its agents cost (their pay), and the profit.
// - « Analyse & statistiques » (the chief and the agent managers): the results over a period per seller, product,
//   wilaya and agent — confirmation (of the orders received in the period: confirmed, cancelled, refused, still to
//   call), delivery (delivered and back in the period), upsells and the value delivered.
import { CONF_TODO, FOLLOW_ON_ROAD, WILAYAS } from '@pilotix/shared';
import { z } from 'zod';
import { Db, num } from '../db';
import { bad, Ctx, forbidden, proc } from '../rpc';
import { agencyEarnings, LINK_SQL, monthBounds, monthNow, toLink } from './agencies';
import { ONLINE_MS } from './assign';
import { payRows, paySpace, termsOf } from './pay';
import { prevOf, Range } from './stats';

const CONFIRMED = ['confirmed', 'no_stock'];
const INVALID = ['fake', 'wrong_number', 'duplicate'];
const DONE = ['delivered', 'exchanged'];
const BACK = ['returning', 'returned'];
const DAY = 86_400_000;

type R = { from: string; to: string };

function needAgency(ctx: Ctx) {
  if (!ctx.t || ctx.shop?.kind !== 'agency') throw forbidden('Réservé aux agences de confirmation');
}
/** The chief (administrators) and the agent managers see the whole team. */
const isLead = (ctx: Ctx) => ctx.session.isAdmin || ctx.session.roles.includes('agent_manager');

/** The stores in view: the seller chosen at the top of the page, or every store the agency works (or worked) for. */
async function storesInView(ctx: Ctx): Promise<{ id: number; name: string; schema: string }[]> {
  const rows = await ctx.t!.platform.query(`${LINK_SQL} WHERE l.agency_id = $1 AND l.started_at IS NOT NULL ORDER BY s.name, l.id`, [ctx.shop!.id]);
  const seen = new Map<number, { id: number; name: string; schema: string }>();
  for (const L of rows.map(toLink)) {
    if (!L.storeOk || seen.has(L.info.store.id)) continue;
    seen.set(L.info.store.id, { id: L.info.store.id, name: L.info.store.name, schema: L.storeSchema });
  }
  const list = [...seen.values()];
  return typeof ctx.seller === 'number' ? list.filter((s) => s.id === ctx.seller) : list;
}

/** A line of numbers (the team, a seller, a product, a wilaya, an agent). */
interface Line {
  received: number;
  confirmed: number;
  cancelled: number;
  invalid: number;
  pending: number;
  delivered: number;
  returned: number;
  upsells: number;
  revenue: number;
}
const line = (): Line => ({ received: 0, confirmed: 0, cancelled: 0, invalid: 0, pending: 0, delivered: 0, returned: 0, upsells: 0, revenue: 0 });
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
/** The rates of a line: confirmation of what was decided, delivery of what came to an end. */
const withRates = (l: Line) => ({ ...l, confRate: ratio(l.confirmed, l.confirmed + l.cancelled), deliveryRate: ratio(l.delivered, l.delivered + l.returned), upsellRate: ratio(l.upsells, l.delivered) });
export type Rated = ReturnType<typeof withRates>;

const inR = (v: unknown, r: R) => {
  if (!v) return false;
  const t = Date.parse(new Date(v as string).toISOString());
  return t >= Date.parse(r.from) && t < Date.parse(r.to);
};
/** The Algiers day (YYYY-MM-DD) of a moment. */
const dayOf = (v: unknown) => new Date(Date.parse(new Date(v as string).toISOString()) + 3_600_000).toISOString().slice(0, 10);

/** The agency's people (its own space): name, roles, on line or not. */
async function team(ctx: Ctx, now: number) {
  const rows = await ctx.db.query(`SELECT id, name, lower(email) AS email, roles, presence, last_seen_at FROM profiles WHERE active ORDER BY name`);
  return rows.map((r: any) => {
    const seen = r.last_seen_at ? Date.parse(new Date(r.last_seen_at).toISOString()) : 0;
    const on = now - seen < ONLINE_MS;
    const presence: 'call' | 'online' | 'idle' | 'offline' = !on ? 'offline' : r.presence === 'call' ? 'call' : r.presence === 'idle' ? 'idle' : 'online';
    return { id: num(r.id), name: String(r.name), email: String(r.email ?? ''), roles: (r.roles ?? []) as string[], presence };
  });
}

/** One store: its accounts of the agency's people (store profile id → the person in the agency's space). */
async function accountsIn(db: Db, agencyId: number, people: { id: number; email: string }[]) {
  const byEmail = new Map(people.map((p) => [p.email, p.id]));
  const ids = new Set(people.map((p) => p.id));
  const rows = await db.query(`SELECT id, lower(email) AS email, agency_profile_id, name FROM profiles WHERE agency_id = $1`, [agencyId]);
  const out = new Map<number, { person: number | null; name: string }>();
  for (const r of rows as any[]) {
    const ap = r.agency_profile_id ? num(r.agency_profile_id) : null;
    const person = ap && ids.has(ap) ? ap : byEmail.get(String(r.email)) ?? null;
    out.set(num(r.id), { person, name: String(r.name ?? '') });
  }
  return out;
}

/**
 * The numbers of the agency's orders over [from, to) in the stores in view (`mine`: only the orders of these people,
 * for an agent's own Dashboard). Per seller, product, wilaya, confirmation agent, suivi agent and day.
 */
async function figures(ctx: Ctx, r: R, opts: { mine?: Set<number>; detail: boolean }) {
  const agencyId = ctx.shop!.id;
  const now = ctx.now();
  const people = await team(ctx, now);
  const stores = await storesInView(ctx);
  const total = line();
  const sellers = new Map<number, Line & { name: string }>();
  const products = new Map<string, Line & { name: string; seller: string }>();
  const wilayas = new Map<number, Line>();
  const confBy = new Map<number, Line>();
  const followBy = new Map<number, Line>();
  const calls = new Map<number, number>();
  const days = new Map<string, { received: number; confirmed: number; delivered: number }>();
  const names = new Map<number, string>(people.map((p) => [p.id, p.name]));
  const add = <K>(m: Map<K, Line>, k: K, f: (l: Line) => void, make: () => Line = line) => {
    let l = m.get(k);
    if (!l) m.set(k, (l = make()));
    f(l);
  };
  const dayAdd = (d: string, k: 'received' | 'confirmed' | 'delivered') => {
    const x = days.get(d) ?? { received: 0, confirmed: 0, delivered: 0 };
    x[k]++;
    days.set(d, x);
  };

  for (const s of stores) {
    const db = ctx.t!.shop(s.schema);
    let acc: Map<number, { person: number | null; name: string }>;
    let rows: any[];
    try {
      acc = await accountsIn(db, agencyId, people);
      rows = await db.query(
        `SELECT o.id, o.agent_id, o.follow_agent_id, o.route_product_id, o.wilaya_id, o.conf_agency_id = $1 AS by_conf,
                o.created_at, o.conf_status, o.follow_status, o.delivered_at, coalesce(o.returned_at, o.returning_at, o.updated_at) AS back_at,
                o.has_upsell, o.total
           FROM sales o
          WHERE (o.conf_agency_id = $1 OR o.follow_agency_id = $1)
            AND ((o.conf_agency_id = $1 AND o.created_at >= $2 AND o.created_at < $3)
              OR (o.follow_status = ANY($4) AND o.delivered_at >= $2 AND o.delivered_at < $3)
              OR (o.follow_status = ANY($5) AND coalesce(o.returned_at, o.returning_at, o.updated_at) >= $2 AND coalesce(o.returned_at, o.returning_at, o.updated_at) < $3))
          LIMIT 100000`,
        [agencyId, r.from, r.to, DONE, BACK],
      );
    } catch {
      // a store being moved or repaired: counted next time
      continue;
    }
    // the person in the agency's space behind a store account (an account the agency no longer has: by its name)
    const personOf = (sid: unknown): number | null => {
      if (sid === null || sid === undefined) return null;
      const a = acc.get(num(sid));
      if (!a) return null;
      if (a.person !== null) return a.person;
      const key = -num(sid) - s.id * 1_000_000;
      names.set(key, a.name);
      return key;
    };
    const keep = (row: any) => !opts.mine || opts.mine.has(personOf(row.agent_id) ?? 0) || opts.mine.has(personOf(row.follow_agent_id) ?? 0);
    const prodIds = new Set<number>();
    for (const o of rows) {
      if (!keep(o)) continue;
      const conf = personOf(o.agent_id);
      const follow = personOf(o.follow_agent_id);
      const pkey = `${s.id}:${o.route_product_id ?? 0}`;
      if (o.route_product_id) prodIds.add(num(o.route_product_id));
      const w = o.wilaya_id ? num(o.wilaya_id) : 0;
      const each = (f: (l: Line) => void, alsoConfAgent: boolean, alsoFollowAgent: boolean) => {
        f(total);
        add(sellers as Map<number, Line>, s.id, f, () => ({ ...line(), name: s.name }));
        add(products as Map<string, Line>, pkey, f, () => ({ ...line(), name: '', seller: s.name }));
        add(wilayas, w, f);
        if (alsoConfAgent && conf !== null && (!opts.mine || opts.mine.has(conf))) add(confBy, conf, f);
        if (alsoFollowAgent && follow !== null && (!opts.mine || opts.mine.has(follow))) add(followBy, follow, f);
      };
      // confirmation: the orders received in the period, as they stand now
      if (o.by_conf && inR(o.created_at, r)) {
        const st = String(o.conf_status);
        const k: keyof Line = CONFIRMED.includes(st) ? 'confirmed' : st === 'cancelled' ? 'cancelled' : INVALID.includes(st) ? 'invalid' : 'pending';
        each((l) => {
          l.received++;
          l[k]++;
        }, true, false);
        dayAdd(dayOf(o.created_at), 'received');
        if (k === 'confirmed') dayAdd(dayOf(o.created_at), 'confirmed');
      }
      // delivery: what was delivered or came back in the period (the agency confirmed it, or followed it)
      const st = String(o.follow_status);
      if (DONE.includes(st) && inR(o.delivered_at, r)) {
        each((l) => {
          l.delivered++;
          l.revenue += num(o.total);
          if (o.has_upsell) l.upsells++;
        }, true, true);
        dayAdd(dayOf(o.delivered_at), 'delivered');
      } else if (BACK.includes(st) && inR(o.back_at, r)) {
        each((l) => {
          l.returned++;
        }, true, true);
      }
    }
    if (opts.detail && prodIds.size) {
      const pr = await db.query('SELECT id, name FROM products WHERE id = ANY($1)', [[...prodIds]]).catch(() => []);
      for (const p of pr as any[]) {
        const l = products.get(`${s.id}:${num(p.id)}`);
        if (l) l.name = String(p.name);
      }
    }
    // the calls the agency's people made in the period (a status given to an order of the agency)
    const sids = [...acc.keys()].filter((sid) => !opts.mine || opts.mine.has(personOf(sid) ?? 0));
    if (sids.length) {
      const cr = await db
        .query(
          `SELECT e.user_id AS u, count(*)::int AS n FROM order_events e JOIN sales o ON o.id = e.order_id
            WHERE e.kind = 'conf_status' AND e.at >= $1 AND e.at < $2 AND e.user_id = ANY($3) AND o.conf_agency_id = $4 GROUP BY 1`,
          [r.from, r.to, sids, agencyId],
        )
        .catch(() => []);
      for (const c of cr as any[]) {
        const p = personOf(c.u);
        if (p !== null) calls.set(p, (calls.get(p) ?? 0) + num(c.n));
      }
    }
  }

  // every day of the period (Algiers), even the empty ones
  const dayList: { d: string; received: number; confirmed: number; delivered: number }[] = [];
  for (let t = Date.parse(r.from); t < Date.parse(r.to) && dayList.length < 400; t += DAY) {
    const d = dayOf(new Date(t).toISOString());
    if (!dayList.some((x) => x.d === d)) dayList.push({ d, ...(days.get(d) ?? { received: 0, confirmed: 0, delivered: 0 }) });
  }
  return { people, stores, total, sellers, products, wilayas, confBy, followBy, calls, names, days: dayList };
}

/** The same numbers for the period before (the team only). */
async function totalsOnly(ctx: Ctx, r: R, mine?: Set<number>) {
  return withRates((await figures(ctx, r, { mine, detail: false })).total);
}

/** What waits now in the stores in view (`mine`: given to these people). */
async function nowOf(ctx: Ctx, mine: Set<number> | null) {
  const agencyId = ctx.shop!.id;
  const people = await team(ctx, ctx.now());
  const out = { toCall: 0, fresh: 0, unassigned: 0, alerts: 0, onRoad: 0 };
  for (const s of await storesInView(ctx)) {
    const db = ctx.t!.shop(s.schema);
    try {
      let who: number[] | null = null;
      if (mine) {
        const acc = await accountsIn(db, agencyId, people);
        who = [...acc.entries()].filter(([, a]) => a.person !== null && mine.has(a.person)).map(([sid]) => sid);
        if (!who.length) continue;
      }
      const r = (
        await db.query(
          `SELECT
             count(*) FILTER (WHERE conf_agency_id = $1 AND conf_status = ANY($2) AND created_at > now() - interval '30 days' ${who ? 'AND agent_id = ANY($4)' : ''})::int AS to_call,
             count(*) FILTER (WHERE conf_agency_id = $1 AND conf_status = 'new' AND created_at > now() - interval '30 days' ${who ? 'AND agent_id = ANY($4)' : ''})::int AS fresh,
             count(*) FILTER (WHERE conf_agency_id = $1 AND conf_status = ANY($2) AND agent_id IS NULL AND created_at > now() - interval '30 days')::int AS unassigned,
             count(*) FILTER (WHERE follow_agency_id = $1 AND follow_status = 'alert' AND COALESCE(sub_status, '') <> 'alert_traitee' ${who ? 'AND follow_agent_id = ANY($4)' : ''})::int AS alerts,
             count(*) FILTER (WHERE (conf_agency_id = $1 OR follow_agency_id = $1) AND follow_status = ANY($3) ${who ? 'AND (agent_id = ANY($4) OR follow_agent_id = ANY($4))' : ''})::int AS on_road
           FROM sales`,
          who ? [agencyId, CONF_TODO, FOLLOW_ON_ROAD, who] : [agencyId, CONF_TODO, FOLLOW_ON_ROAD],
        )
      )[0];
      out.toCall += num(r?.to_call);
      out.fresh += num(r?.fresh);
      if (!mine) out.unassigned += num(r?.unassigned);
      out.alerts += num(r?.alerts);
      out.onRoad += num(r?.on_road);
    } catch {
      // a store being moved or repaired: counted next time
    }
  }
  return out;
}

/** An agent's line: his confirmation (the orders given to him) and his suivi (the parcels he followed). */
function agentLine(f: Awaited<ReturnType<typeof figures>>, id: number) {
  const c = withRates(f.confBy.get(id) ?? line());
  const s = f.followBy.get(id) ?? line();
  return {
    id,
    calls: f.calls.get(id) ?? 0,
    ...c,
    followDelivered: s.delivered,
    followReturned: s.returned,
    followRate: ratio(s.delivered, s.delivered + s.returned),
  };
}

const sortRows = <T extends { received: number; delivered: number }>(rows: T[]) => rows.sort((a, b) => b.received + b.delivered - (a.received + a.delivered));

/** The months (YYYY-MM, Algeria) a period touches (13 at most). */
function monthsOf(r: R): string[] {
  const out: string[] = [];
  let m = monthNow(Date.parse(r.from));
  const last = monthNow(Date.parse(r.to) - 1);
  while (out.length < 13) {
    out.push(m);
    if (m >= last) break;
    const y = Number(m.slice(0, 4));
    const mo = Number(m.slice(5, 7));
    m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  }
  return out;
}

/** What each seller owes the agency for each month of the period (the chief only): the same amounts as Facturation. */
async function earningsOf(ctx: Ctx, r: R) {
  const months = monthsOf(r);
  const rows = await agencyEarnings(ctx.t!, ctx.shop!.id, months, ctx.now(), typeof ctx.seller === 'number' ? ctx.seller : undefined);
  const by = new Map<number, { key: string; name: string; months: Record<string, { total: number; status: string | null }>; total: number }>();
  for (const x of rows) {
    const s = by.get(x.storeId) ?? { key: String(x.storeId), name: x.store, months: {}, total: 0 };
    const cur = s.months[x.month] ?? { total: 0, status: null };
    // one seller with two contracts in a month (one ended, a new one): added up
    s.months[x.month] = { total: cur.total + x.total, status: x.status ?? cur.status };
    s.total += x.total;
    by.set(x.storeId, s);
  }
  const sellers = [...by.values()].sort((a, b) => b.total - a.total);
  const perMonth = Object.fromEntries(months.map((m) => [m, sellers.reduce((n, s) => n + (s.months[m]?.total ?? 0), 0)]));
  return { months, sellers, perMonth, total: sellers.reduce((n, s) => n + s.total, 0), current: monthNow(ctx.now()) };
}

const MonthIn = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mois invalide (AAAA-MM)') });

/**
 * The agency's money for a month: what each seller owes it (the same amounts as Facturation: the bill asked for, else the
 * contract's bill on the month's numbers), what its agents earned on each seller's orders (the same amounts as Paie:
 * their plans' commissions, and the fixed monthly salaries, which belong to no seller), and what is left: the profit.
 * The current month: up to now. A seller chosen at the top of the page: his part only (no salaries).
 */
async function moneyOf(ctx: Ctx, month: string) {
  const now = ctx.now();
  const one = typeof ctx.seller === 'number' ? ctx.seller : null;
  const { from, to } = monthBounds(month);
  type Seller = { key: string; name: string; earned: number; status: string | null; cost: number };
  const sellers = new Map<number, Seller>();
  const sellerOf = (id: number, name: string) => {
    let s = sellers.get(id);
    if (!s) sellers.set(id, (s = { key: String(id), name, earned: 0, status: null, cost: 0 }));
    return s;
  };
  // a pay row names its seller: its store's id
  const idOf = new Map<string, number>();
  for (const s of await storesInView(ctx)) if (!idOf.has(s.name)) idOf.set(s.name, s.id);
  const bills = await agencyEarnings(ctx.t!, ctx.shop!.id, [month], now, one ?? undefined);
  for (const b of bills) {
    if (!idOf.has(b.store)) idOf.set(b.store, b.storeId);
    const s = sellerOf(b.storeId, b.store);
    s.earned += b.total;
    s.status = b.status ?? s.status;
  }
  // everyone who has (or had) a pay plan here, the ones who left this month too
  const people = (await ctx.db.query(`SELECT p.id, p.name FROM profiles p WHERE p.agency_id IS NULL AND EXISTS (SELECT 1 FROM pay_plan_terms t WHERE t.profile_id = p.id) ORDER BY p.name`)).map((r: any) => ({ id: num(r.id), name: String(r.name) }));
  const terms = await termsOf(ctx.db, people.map((p) => p.id));
  const agents: { id: number; name: string; orders: number; commissions: number; salary: number; total: number }[] = [];
  let commissions = 0;
  let salaries = 0;
  for (const p of people) {
    const rows = await payRows(ctx.db, p.id, terms.get(p.id) ?? [], Date.parse(from), Math.min(Date.parse(to), now));
    const orders = new Set<string>();
    let com = 0;
    let sal = 0;
    for (const r of rows) {
      if (r.kind === 'salary') {
        sal += r.amount;
        continue;
      }
      const sid = r.agent === null ? undefined : idOf.get(r.agent);
      if (one !== null && sid !== one) continue;
      com += r.amount;
      orders.add(`${r.agent}:${r.orderId}`);
      if (sid !== undefined) sellerOf(sid, r.agent!).cost += r.amount;
    }
    if (one !== null) sal = 0;
    commissions += com;
    salaries += sal;
    if (com || sal) agents.push({ id: p.id, name: p.name, orders: orders.size, commissions: com, salary: sal, total: com + sal });
  }
  const earned = bills.reduce((n, b) => n + b.total, 0);
  const cost = commissions + salaries;
  const margin = (a: number, b: number) => (a > 0 ? b / a : null);
  return {
    month,
    current: monthNow(now),
    earned,
    // what the sellers already paid (the agency said « reçu »), and what they say they paid (the agency has to confirm)
    received: bills.filter((b) => b.status === 'received').reduce((n, b) => n + b.total, 0),
    paid: bills.filter((b) => b.status === 'paid').reduce((n, b) => n + b.total, 0),
    commissions,
    // a seller chosen: the salaries belong to no seller
    salaries: one === null ? salaries : null,
    cost,
    profit: earned - cost,
    margin: margin(earned, earned - cost),
    sellers: [...sellers.values()].map((s) => ({ ...s, profit: s.earned - s.cost, margin: margin(s.earned, s.earned - s.cost) })).sort((a, b) => b.earned - a.earned || b.cost - a.cost),
    agents: agents.sort((a, b) => b.total - a.total),
  };
}

export const agencyStatsProcs = {
  /**
   * Dashboard (everyone in the agency): what waits now, the period's numbers next to the period before, the days, who is
   * on line and each agent's numbers. An agent: his own orders and his own row (and his rank), nobody else's.
   */
  'agency.dash': proc(null, Range, async (ctx, r) => {
    needAgency(ctx);
    const lead = isLead(ctx);
    const me = ctx.session.profile.id;
    const mine = lead ? undefined : new Set([me]);
    const f = await figures(ctx, r, { mine, detail: false });
    // the period before: the team's totals (an agent: his own), and an agent's own line (his job's numbers compare with it)
    const pf = await figures(ctx, prevOf(r, ctx.now()), { mine, detail: false });
    const prev = withRates(pf.total);
    const workers = f.people.filter((p) => p.roles.some((x) => x === 'confirmation' || x === 'suivi'));
    const rows = workers.map((p) => ({ ...agentLine(f, p.id), name: p.name, presence: p.presence, conf: p.roles.includes('confirmation'), suivi: p.roles.includes('suivi') }));
    // an agent: his rank and the team's ladder — the other agents' numbers without their names (his job: confirmation, else
    // suivi), counted on the whole team on the server
    let rank: { rank: number; of: number } | null = null;
    let ladder: { by: 'conf' | 'follow'; rows: { pos: number; me: boolean; name: string | null; a: number; b: number; rate: number | null; rate2: number | null }[] } | null = null;
    const job = ctx.session.roles.includes('confirmation') ? 'conf' : ctx.session.roles.includes('suivi') ? 'follow' : null;
    if (!lead && job) {
      const all = await figures(ctx, r, { detail: false });
      const mates = workers.filter((p) => p.roles.includes(job === 'conf' ? 'confirmation' : 'suivi'));
      const lines = mates.map((p) => {
        if (job === 'conf') {
          const l = withRates(all.confBy.get(p.id) ?? line());
          // the rate's own numbers: confirmed out of the ones decided (confirmed + cancelled)
          return { id: p.id, name: p.name, a: l.confirmed, b: l.confirmed + l.cancelled, rate: l.confRate, rate2: l.deliveryRate };
        }
        const l = all.followBy.get(p.id) ?? line();
        return { id: p.id, name: p.name, a: l.delivered, b: l.delivered + l.returned, rate: ratio(l.delivered, l.delivered + l.returned), rate2: null };
      });
      lines.sort((x, y) => (y.rate ?? -1) - (x.rate ?? -1) || y.a - x.a || y.b - x.b);
      ladder = { by: job, rows: lines.map((x, i) => ({ pos: i + 1, me: x.id === me, name: x.id === me ? x.name : null, a: x.a, b: x.b, rate: x.rate, rate2: x.rate2 })) };
      const ranked = lines.filter((x) => x.rate !== null);
      const i = ranked.findIndex((x) => x.id === me);
      if (i >= 0 && ranked.length > 1) rank = { rank: i + 1, of: ranked.length };
    }
    return {
      lead,
      range: r,
      prevRange: prevOf(r, ctx.now()),
      now: await nowOf(ctx, lead ? null : new Set([me])),
      team: withRates(f.total),
      prev,
      days: f.days,
      online: workers.filter((p) => p.presence === 'online' || p.presence === 'call').length,
      agents: lead ? sortRows(rows) : rows.filter((x) => x.id === me),
      prevMe: lead ? null : agentLine(pf, me),
      rank,
      ladder,
      sellers: f.stores.length,
      // the leads: each seller's numbers over the period (confirmation, delivery, upsells, value delivered)
      bySeller: lead ? sortRows([...f.sellers.entries()].map(([id, l]) => ({ key: String(id), ...withRates(l), name: l.name }))) : [],
    };
  }),

  /** The money of a month (the chief): what each seller owes, what the agents cost, the profit. */
  'agency.money': proc([], MonthIn, async (ctx, i) => {
    needAgency(ctx);
    if (i.month > monthNow(ctx.now())) throw bad('Ce mois n’est pas encore commencé');
    // the agents' pay reads each seller's store
    paySpace(ctx);
    return moneyOf(ctx, i.month);
  }),

  /** Analyse & statistiques (the chief and the agent managers): the results per seller, product, wilaya and agent. */
  'agency.analytics': proc(['agent_manager'], Range, async (ctx, r) => {
    needAgency(ctx);
    const f = await figures(ctx, r, { detail: true });
    const prev = await totalsOnly(ctx, prevOf(r, ctx.now()));
    const nameOf = (id: number) => f.names.get(id) ?? '?';
    return {
      range: r,
      prevRange: prevOf(r, ctx.now()),
      team: withRates(f.total),
      prev,
      days: f.days,
      sellers: sortRows([...f.sellers.entries()].map(([id, l]) => ({ key: String(id), ...withRates(l), name: l.name }))),
      products: sortRows([...f.products.entries()].map(([key, l]) => ({ key, ...withRates(l), name: l.name, seller: l.seller }))).slice(0, 100),
      wilayas: sortRows([...f.wilayas.entries()].map(([id, l]) => ({ key: String(id), ...withRates(l), name: id ? `${String(id).padStart(2, '0')} · ${WILAYAS[id - 1] ?? '?'}` : '—' }))),
      agents: sortRows([...f.confBy.keys()].map((id) => ({ ...agentLine(f, id), key: String(id), name: nameOf(id) }))),
      followers: sortRows([...f.followBy.entries()].map(([id, l]) => ({ key: String(id), ...withRates(l), name: nameOf(id) }))),
      sellerCount: f.stores.length,
      // the money: what each seller owes the agency (the chief only, as Facturation)
      earnings: ctx.session.isAdmin ? await earningsOf(ctx, r) : null,
    };
  }),
};
