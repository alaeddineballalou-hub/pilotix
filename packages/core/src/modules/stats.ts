// Stats: Accueil (home) counters and the Dashboard areas (Confirmation teams, Dépôt, Suivi, Livreurs, SAV).
import { algiersDayStart, CONF_DONE_BAD, CONF_TODO, FOLLOW_ON_ROAD, nextDue, slotAt } from '@pilotix/shared';
import { z } from 'zod';
import { iso, num } from '../db';
import { bad, Ctx, forbidden, proc } from '../rpc';
import { getSetting, setSetting, SettingsMap } from '../settings';

// ---------------------------------------------------------------- helpers
export const AREAS = ['confirmation', 'depot', 'suivi', 'livreurs', 'sav'] as const;
export type Area = (typeof AREAS)[number];

export const Range = z
  .object({ from: z.string().min(10).max(40), to: z.string().min(10).max(40) })
  .refine((r) => !isNaN(Date.parse(r.from)) && !isNaN(Date.parse(r.to)) && Date.parse(r.to) > Date.parse(r.from), { message: 'Période invalide' })
  .refine((r) => Date.parse(r.to) - Date.parse(r.from) <= 400 * 86_400_000, { message: 'Période trop longue (400 jours max.)' });
type RangeT = z.infer<typeof Range>;

/** The period before, as long; a period still running (today, this month) is compared up to the same moment. */
export function prevOf(r: RangeT, now: number): RangeT {
  const a = Date.parse(r.from);
  const b = Date.parse(r.to);
  const len = b - a;
  const upTo = Math.min(now, b) - a;
  return { from: new Date(a - len).toISOString(), to: new Date(a - len + (upTo > 0 ? upTo : len)).toISOString() };
}

const CONFIRMED = ['confirmed', 'no_stock'];
const FAKE = ['fake', 'wrong_number'];
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const isoNow = (ctx: Ctx) => new Date(ctx.now()).toISOString();

/** Admin and vendeur see every dashboard area; an agent manager only the areas the admin gave them (Confirmation by default). */
export async function allowedAreas(ctx: Ctx): Promise<Area[]> {
  const s = ctx.session;
  if (s.isAdmin || s.roles.includes('vendeur')) return [...AREAS];
  if (!s.roles.includes('agent_manager')) return [];
  const scope = await getSetting(ctx.db, 'mgrScope');
  const mine = (scope[String(s.profile.id)] ?? []).filter((a): a is Area => (AREAS as readonly string[]).includes(a));
  return mine.length ? mine : ['confirmation'];
}
export async function needArea(ctx: Ctx, area: Area) {
  if (!(await allowedAreas(ctx)).includes(area)) throw forbidden('Ce tableau de bord ne vous est pas ouvert');
}
export const seesAll = (ctx: Ctx) => ctx.session.isAdmin || ctx.session.roles.includes('vendeur');

async function names(ctx: Ctx): Promise<Map<number, string>> {
  const rows = await ctx.db.query('SELECT id, name FROM profiles');
  return new Map(rows.map((r: any) => [num(r.id), r.name as string]));
}

// ---------------------------------------------------------------- teams
type Team = SettingsMap['teams'][number];
export interface TeamView {
  id: string;
  name: string;
  managerId: number | null;
  managerName: string | null;
  agentIds: number[];
}

/** Confirmation agents (role confirmation or agent_manager, without being livreur only). */
async function confAgents(ctx: Ctx): Promise<{ id: number; name: string; roles: string[] }[]> {
  const rows = await ctx.db.query(`SELECT id, name, roles FROM profiles WHERE active AND roles && $1::text[] ORDER BY name`, [['confirmation', 'agent_manager', 'vendeur']]);
  return rows.map((r: any) => ({ id: num(r.id), name: r.name, roles: r.roles }));
}

/** Teams from the setting, each with its manager inside, plus "Sans manager" for the other agents (and anyone who confirmed in the period). */
export async function teamViews(ctx: Ctx, extraAgents: number[] = []): Promise<TeamView[]> {
  const [teams, agents, nm] = [await getSetting(ctx.db, 'teams'), await confAgents(ctx), await names(ctx)];
  const out: TeamView[] = [];
  const seen = new Set<number>();
  for (const t of teams) {
    const ids = [...new Set([...(t.managerId ? [t.managerId] : []), ...t.agentIds])].filter((id) => nm.has(id));
    ids.forEach((id) => seen.add(id));
    out.push({ id: t.id, name: t.name, managerId: t.managerId, managerName: t.managerId ? nm.get(t.managerId) ?? null : null, agentIds: ids });
  }
  const rest = [...new Set([...agents.filter((a) => !a.roles.includes('vendeur') || extraAgents.includes(a.id)).map((a) => a.id), ...extraAgents])].filter((id) => !seen.has(id) && nm.has(id));
  if (rest.length) out.push({ id: 'none', name: 'Sans manager', managerId: null, managerName: null, agentIds: rest });
  return out;
}

/** The teams this user may look at: all for admin/vendeur, their own for a manager. */
export async function visibleTeams(ctx: Ctx, extra: number[] = []) {
  const all = await teamViews(ctx, extra);
  if (seesAll(ctx)) return all;
  const me = ctx.session.profile.id;
  const own = all.filter((t) => t.managerId === me);
  if (own.length) return own;
  return [{ id: 'me', name: 'Mon équipe', managerId: me, managerName: ctx.session.profile.name, agentIds: [me] }];
}

// ---------------------------------------------------------------- per-agent confirmation metrics
interface AgentStats {
  id: number;
  name: string;
  orders: number;
  todo: number;
  confirmed: number;
  cancelled: number;
  fake: number;
  duplicates: number;
  delivered: number;
  confirmationsInPeriod: number;
  calls: number;
  inProgress: number;
  lateCallbacks: number;
  firstOnTime: number;
  firstTotal: number;
  firstDelays: number[];
  triesOnTime: number;
  triesMissed: number;
  confRate: number | null;
  deliveryRate: number | null;
  finalRate: number | null;
  firstRate: number | null;
  firstMedianMs: number | null;
  triesRate: number | null;
}
const blank = (id: number, name: string): AgentStats => ({
  id, name, orders: 0, todo: 0, confirmed: 0, cancelled: 0, fake: 0, duplicates: 0, delivered: 0, confirmationsInPeriod: 0, calls: 0, inProgress: 0, lateCallbacks: 0,
  firstOnTime: 0, firstTotal: 0, firstDelays: [], triesOnTime: 0, triesMissed: 0, confRate: null, deliveryRate: null, finalRate: null, firstRate: null, firstMedianMs: null, triesRate: null,
});

function finish(a: AgentStats) {
  a.confRate = ratio(a.confirmed, a.orders);
  a.deliveryRate = ratio(a.delivered, a.confirmed);
  a.finalRate = ratio(a.delivered, a.orders);
  a.firstRate = ratio(a.firstOnTime, a.firstTotal);
  a.firstMedianMs = median(a.firstDelays);
  a.triesRate = ratio(a.triesOnTime, a.triesOnTime + a.triesMissed);
  return a;
}
function sum(id: number, name: string, parts: AgentStats[]) {
  const t = blank(id, name);
  for (const p of parts) {
    for (const k of ['orders', 'todo', 'confirmed', 'cancelled', 'fake', 'duplicates', 'delivered', 'confirmationsInPeriod', 'calls', 'inProgress', 'lateCallbacks', 'firstOnTime', 'firstTotal', 'triesOnTime', 'triesMissed'] as const) t[k] += p[k];
    t.firstDelays.push(...p.firstDelays);
  }
  return finish(t);
}

const TeamsInput = Range.and(
  z.object({
    dateType: z.enum(['created', 'status']).default('created'),
    rateType: z.enum(['taux', 'perf']).default('taux'),
    teamId: z.string().max(60).optional(),
    agentId: z.number().int().positive().optional(),
    chart: z.enum(['conf', 'calls']).default('conf'),
  }),
);

export async function confirmationStats(ctx: Ctx, input: z.infer<typeof TeamsInput>) {
  const { from, to } = input;
  const now = ctx.now();
  const calls = await getSetting(ctx.db, 'calls');
  const nm = await names(ctx);

  // Base orders: created in the period (owned by their agent) or whose last status change of the period was made by the agent.
  const base: { id: number; uid: number; conf: string; follow: string | null; created: number; start: number }[] =
    input.dateType === 'created'
      ? (
          await ctx.db.query(
            `SELECT id, agent_id AS uid, conf_status, follow_status, created_at, COALESCE(assigned_at, created_at) AS start FROM sales
             WHERE created_at >= $1 AND created_at < $2 AND agent_id IS NOT NULL`,
            [from, to],
          )
        ).map((r: any) => ({ id: num(r.id), uid: num(r.uid), conf: r.conf_status, follow: r.follow_status, created: Date.parse(r.created_at), start: Date.parse(r.start) }))
      : (
          await ctx.db.query(
            `SELECT o.id, e.user_id AS uid, o.conf_status, o.follow_status, o.created_at, COALESCE(o.assigned_at, o.created_at) AS start
             FROM (SELECT DISTINCT ON (order_id) order_id, user_id FROM order_events WHERE kind = 'conf_status' AND at >= $1 AND at < $2 AND user_id IS NOT NULL ORDER BY order_id, at DESC) e
             JOIN sales o ON o.id = e.order_id`,
            [from, to],
          )
        ).map((r: any) => ({ id: num(r.id), uid: num(r.uid), conf: r.conf_status, follow: r.follow_status, created: Date.parse(r.created_at), start: Date.parse(r.start) }));

  const perf = input.rateType === 'perf';
  const counted = base.filter((o) => !perf || (!['duplicate', 'wrong_number'].includes(o.conf) && (!CONF_TODO.includes(o.conf as any) || o.created < now - 15 * 86_400_000)));

  // Status changes in the period (calls) and confirmations.
  const evs = (
    await ctx.db.query(`SELECT order_id, user_id, at, to_value FROM order_events WHERE kind = 'conf_status' AND at >= $1 AND at < $2 AND user_id IS NOT NULL`, [from, to])
  ).map((r: any) => ({ order: num(r.order_id), uid: num(r.user_id), at: Date.parse(r.at), to: r.to_value as string }));

  // Live numbers (not by period).
  const live = await ctx.db.query(
    `SELECT agent_id AS uid, count(*) FILTER (WHERE conf_status = ANY($1))::int AS todo,
            count(*) FILTER (WHERE conf_status IN ('callback','postponed') AND next_call_at < $2)::int AS late
     FROM sales WHERE agent_id IS NOT NULL GROUP BY agent_id`,
    [CONF_TODO, isoNow(ctx)],
  );
  const unassigned = num((await ctx.db.query(`SELECT count(*)::int AS n FROM sales WHERE agent_id IS NULL AND conf_status = 'new'`))[0]?.n);

  // First call: the first status change after arrival / assignment.
  const firstRows = counted.length
    ? await ctx.db.query(`SELECT order_id, min(at) AS at FROM order_events WHERE kind = 'conf_status' AND order_id = ANY($1) GROUP BY order_id`, [counted.map((o) => o.id)])
    : [];
  const firstAt = new Map(firstRows.map((r: any) => [num(r.order_id), Date.parse(r.at)]));

  // Tries: after "no answer" / "busy" the next try is due in the next slot.
  const tries = evs.filter((e) => e.to === 'no_answer' || e.to === 'busy');
  const triesOrders = [...new Set(tries.map((e) => e.order))];
  const after = triesOrders.length
    ? (await ctx.db.query(`SELECT order_id, at FROM order_events WHERE kind = 'conf_status' AND order_id = ANY($1) AND at >= $2 ORDER BY at`, [triesOrders, from])).map((r: any) => ({ order: num(r.order_id), at: Date.parse(r.at) }))
    : [];
  const byOrder = new Map<number, number[]>();
  for (const a of after) (byOrder.get(a.order) ?? byOrder.set(a.order, []).get(a.order)!).push(a.at);

  const ids = new Set<number>([...base.map((o) => o.uid), ...evs.map((e) => e.uid)]);
  const per = new Map<number, AgentStats>();
  const get = (id: number) => per.get(id) ?? per.set(id, blank(id, nm.get(id) ?? '?')).get(id)!;
  for (const id of ids) get(id);

  for (const o of counted) {
    const a = get(o.uid);
    a.orders++;
    if (CONF_TODO.includes(o.conf as any)) a.todo++;
    if (CONFIRMED.includes(o.conf)) a.confirmed++;
    if (o.conf === 'cancelled') a.cancelled++;
    if (FAKE.includes(o.conf)) a.fake++;
    if (o.conf === 'duplicate') a.duplicates++;
    if (o.follow === 'delivered' || o.follow === 'exchanged') a.delivered++;
    const due = nextDue({ createdAt: new Date(o.start).toISOString(), attempts: 0, nextCallAt: null, done: false }, calls, now).at ?? o.start;
    const first = firstAt.get(o.id);
    if (first !== undefined) {
      a.firstTotal++;
      if (first <= due) a.firstOnTime++;
      a.firstDelays.push(Math.max(0, first - o.start));
    } else if (now > due && CONF_TODO.includes(o.conf as any)) {
      a.firstTotal++;
    }
  }
  for (const e of evs) {
    const a = get(e.uid);
    a.calls++;
    if (CONFIRMED.includes(e.to)) a.confirmationsInPeriod++;
  }
  const triedCount = new Map<string, number>();
  for (const e of tries) {
    const key = `${e.order}:${e.uid}`;
    const k = (triedCount.get(key) ?? 0) + 1;
    triedCount.set(key, k);
    if (k >= calls.tries) continue;
    const last = slotAt(e.at, calls);
    const nextFrom = last.open ? last.to : last.from;
    const next = slotAt(nextFrom, calls);
    const end = next.to;
    const nextCall = (byOrder.get(e.order) ?? []).find((t) => t > e.at);
    const a = get(e.uid);
    if (nextCall !== undefined && nextCall <= end) a.triesOnTime++;
    else if (end < now) a.triesMissed++;
  }
  for (const r of live) {
    const id = num(r.uid);
    if (!per.has(id)) continue;
    const a = get(id);
    a.inProgress = num(r.todo);
    a.lateCallbacks = num(r.late);
  }
  for (const a of per.values()) finish(a);

  return { per, evs, counted, unassigned, now };
}

/** Day (or hour) buckets for the team chart, in Algiers time. */
function buckets(from: string, to: string) {
  const a = Date.parse(from);
  const b = Date.parse(to);
  const hourly = b - a <= 86_400_000 + 3_600_000;
  const step = hourly ? 3_600_000 : 86_400_000;
  const start = hourly ? a : algiersDayStart(a);
  const out: { t: number; label: string }[] = [];
  for (let t = start; t < b && out.length < 400; t += step) {
    const d = new Date(t + 3_600_000);
    out.push({ t, label: hourly ? `${String(d.getUTCHours()).padStart(2, '0')}h` : `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}` });
  }
  return { hourly, step, list: out };
}

const strip = (a: AgentStats) => {
  const { firstDelays: _f, ...rest } = a;
  void _f;
  return rest;
};

const LivInput = Range.and(z.object({ by: z.enum(['livreur', 'company']).default('livreur'), dateType: z.enum(['delivered', 'created']).default('delivered'), livreurId: z.number().int().positive().optional() }));

export async function livreursStats(ctx: Ctx, i: z.infer<typeof LivInput>) {
      const pay = (await getSetting(ctx.db, 'payPlans')).livreur;
      const key = i.by === 'company' ? 'o.company_id' : 'o.livreur_id';
      const dcol = i.dateType === 'created' ? 'o.created_at' : 'o.delivered_at';
      const rcol = i.dateType === 'created' ? 'o.created_at' : 'o.returned_at';
      const scol = i.dateType === 'created' ? 'o.created_at' : 'o.shipped_at';
      const late = new Date(ctx.now() - 2 * 86_400_000).toISOString();
      const old = new Date(ctx.now() - 3 * 86_400_000).toISOString();
      const rows = await ctx.db.query(
        `WITH w AS (SELECT oi.order_id, sum(oi.qty * p.weight_kg) AS kg FROM order_items oi JOIN products p ON p.id = oi.product_id GROUP BY oi.order_id)
         SELECT ${key} AS k,
           count(*) FILTER (WHERE ${scol} >= $1 AND ${scol} < $2 AND o.shipped_at IS NOT NULL)::int AS shipped,
           count(*) FILTER (WHERE o.follow_status IN ('to_prepare','prepared'))::int AS pickup,
           count(*) FILTER (WHERE o.follow_status IN ('to_prepare','prepared') AND COALESCE(o.prepared_at, o.updated_at) < $4)::int AS pickup_old,
           COALESCE(sum(o.total) FILTER (WHERE o.follow_status IN ('to_prepare','prepared')),0)::bigint AS pickup_value,
           count(*) FILTER (WHERE o.follow_status = ANY($5))::int AS in_hand,
           COALESCE(sum(o.total) FILTER (WHERE o.follow_status = ANY($5)),0)::bigint AS in_hand_value,
           count(*) FILTER (WHERE o.follow_status = ANY($5) AND COALESCE(o.shipped_at, o.updated_at) < $3)::int AS late,
           count(*) FILTER (WHERE ${dcol} >= $1 AND ${dcol} < $2 AND o.follow_status IN ('delivered','exchanged'))::int AS delivered,
           count(*) FILTER (WHERE ${rcol} >= $1 AND ${rcol} < $2 AND o.follow_status = 'returned')::int AS returned,
           count(*) FILTER (WHERE o.follow_status = 'returning')::int AS to_bring,
           count(*) FILTER (WHERE o.follow_status = 'delivered' AND NOT o.cashed)::int AS uncashed_n,
           COALESCE(sum(o.total) FILTER (WHERE o.follow_status = 'delivered' AND NOT o.cashed),0)::bigint AS uncashed,
           count(*) FILTER (WHERE o.follow_status = 'delivered' AND NOT o.cashed AND COALESCE(w.kg,0) >= $6)::int AS uncashed_heavy,
           count(*) FILTER (WHERE ${dcol} >= $1 AND ${dcol} < $2 AND o.follow_status IN ('delivered','exchanged') AND COALESCE(w.kg,0) >= $6)::int AS delivered_heavy,
           count(*) FILTER (WHERE o.cashed AND o.cashed_at >= $1 AND o.cashed_at < $2)::int AS cashed_n,
           COALESCE(sum(o.total) FILTER (WHERE o.cashed AND o.cashed_at >= $1 AND o.cashed_at < $2),0)::bigint AS cashed,
           COALESCE(sum(o.delivery_cost) FILTER (WHERE o.follow_status = 'delivered' AND NOT o.cashed),0)::bigint AS uncashed_cost
         FROM sales o LEFT JOIN w ON w.order_id = o.id
         WHERE ${key} IS NOT NULL GROUP BY ${key}`,
        [i.from, i.to, late, old, FOLLOW_ON_ROAD, pay.heavyFromKg],
      );
      const people =
        i.by === 'company'
          ? (await ctx.db.query(`SELECT id, name FROM delivery_companies WHERE active AND kind <> 'own' ORDER BY name`)).map((r: any) => ({ id: num(r.id), name: r.name as string }))
          : (await ctx.db.query(`SELECT id, name FROM profiles WHERE 'livreur' = ANY(roles) ORDER BY name`)).map((r: any) => ({ id: num(r.id), name: r.name as string }));
      const by = new Map(rows.map((r: any) => [num(r.k), r]));
      let list = people.map((p) => {
        const r: any = by.get(p.id) ?? {};
        const delivered = num(r.delivered);
        const returned = num(r.returned);
        const uncashedN = num(r.uncashed_n);
        const uncashed = num(r.uncashed);
        const heavyU = num(r.uncashed_heavy);
        const share = i.by === 'company' ? num(r.uncashed_cost) : heavyU * pay.heavy + (uncashedN - heavyU) * pay.light;
        const heavyD = num(r.delivered_heavy);
        return {
          id: p.id,
          name: p.name,
          shipped: num(r.shipped),
          pickup: num(r.pickup),
          pickupOld: num(r.pickup_old),
          pickupValue: num(r.pickup_value),
          inHand: num(r.in_hand),
          inHandValue: num(r.in_hand_value),
          late: num(r.late),
          delivered,
          returned,
          deliveryRate: ratio(delivered, delivered + returned),
          toBring: num(r.to_bring),
          uncashedCount: uncashedN,
          uncashed,
          net: uncashed - share,
          share: i.by === 'company' ? num(r.uncashed_cost) : heavyD * pay.heavy + (delivered - heavyD) * pay.light,
          heldShare: share,
          cashed: num(r.cashed),
          cashedCount: num(r.cashed_n),
        };
      });
      if (i.livreurId) list = list.filter((l) => l.id === i.livreurId);
      const active = (l: (typeof list)[number]) => l.shipped + l.pickup + l.inHand + l.delivered + l.returned + l.toBring + l.uncashedCount + l.cashedCount > 0;
      const tot = list.reduce(
        (s, l) => {
          for (const k of ['shipped', 'pickup', 'pickupOld', 'pickupValue', 'inHand', 'inHandValue', 'late', 'delivered', 'returned', 'toBring', 'uncashedCount', 'uncashed', 'net', 'share', 'heldShare', 'cashed', 'cashedCount'] as const) s[k] += l[k];
          return s;
        },
        { shipped: 0, pickup: 0, pickupOld: 0, pickupValue: 0, inHand: 0, inHandValue: 0, late: 0, delivered: 0, returned: 0, toBring: 0, uncashedCount: 0, uncashed: 0, net: 0, share: 0, heldShare: 0, cashed: 0, cashedCount: 0 },
      );
      return {
        by: i.by,
        pay: { light: pay.light, heavy: pay.heavy },
        totals: { ...tot, deliveryRate: ratio(tot.delivered, tot.delivered + tot.returned) },
        rows: list.filter(active),
        all: list,
        hidden: list.filter((l) => !active(l)).length,
      };
}

// ---------------------------------------------------------------- procedures
const PeriodOnly = Range;


// ---------------------------------------------------------------- overview (admin / vendeur): the whole shop at a glance
const DAY_MS = 86_400_000;
const algDay = (iso: string) => new Date(Date.parse(iso) + 3_600_000).toISOString().slice(0, 10);

async function overview(ctx: Ctx, r: RangeT) {
  const a = Date.parse(r.from);
  const b = Date.parse(r.to);
  // the period before (a running one is compared up to the same moment)
  const P = prevOf(r, ctx.now());
  const q1 = async (sql: string, params: unknown[]) => (await ctx.db.query(sql, params))[0];
  const block = async (from: string, to: string) =>
    q1(
      `SELECT
        (SELECT count(*) FROM sales WHERE created_at >= $1 AND created_at < $2)::int AS received,
        (SELECT COALESCE(sum(total),0) FROM sales WHERE follow_status IN ('delivered','exchanged') AND delivered_at >= $1 AND delivered_at < $2)::bigint AS revenue,
        (SELECT count(*) FROM sales WHERE follow_status IN ('delivered','exchanged') AND delivered_at >= $1 AND delivered_at < $2)::int AS delivered,
        (SELECT count(*) FROM sales WHERE follow_status IN ('returning','returned') AND coalesce(returned_at, returning_at, updated_at) >= $1 AND coalesce(returned_at, returning_at, updated_at) < $2)::int AS returned`,
      [from, to],
    );
  const cur = await block(r.from, r.to);
  const prev = await block(P.from, P.to);
  const rate = (x: any) => ratio(num(x.delivered), num(x.delivered) + num(x.returned));

  // per day: orders received / delivered (same unit, one axis)
  const days: string[] = [];
  for (let t = a; t < b && days.length < 400; t += DAY_MS) days.push(algDay(new Date(t).toISOString()));
  const rec = await ctx.db.query(`SELECT to_char(created_at + interval '1 hour', 'YYYY-MM-DD') AS d, count(*)::int AS n FROM sales WHERE created_at >= $1 AND created_at < $2 GROUP BY 1`, [r.from, r.to]);
  const del = await ctx.db.query(
    `SELECT to_char(delivered_at + interval '1 hour', 'YYYY-MM-DD') AS d, count(*)::int AS n, COALESCE(sum(total),0)::bigint AS v FROM sales
      WHERE follow_status IN ('delivered','exchanged') AND delivered_at >= $1 AND delivered_at < $2 GROUP BY 1`,
    [r.from, r.to],
  );
  const R = new Map(rec.map((x: any) => [x.d as string, num(x.n)]));
  const D = new Map(del.map((x: any) => [x.d as string, { n: num(x.n), v: num(x.v) }]));
  const series = [...new Set(days)].map((d) => ({ day: d, received: R.get(d) ?? 0, delivered: D.get(d)?.n ?? 0, revenue: D.get(d)?.v ?? 0 }));

  // this month vs the goal
  const now = new Date(ctx.now() + 3_600_000);
  const m0 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 3_600_000).toISOString();
  const pm0 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1) - 3_600_000).toISOString();
  const sameDayPrev = new Date(Date.parse(pm0) + (ctx.now() - Date.parse(m0))).toISOString();
  const month = num((await q1(`SELECT COALESCE(sum(total),0)::bigint AS v FROM sales WHERE follow_status IN ('delivered','exchanged') AND delivered_at >= $1`, [m0])).v);
  const monthPrev = num((await q1(`SELECT COALESCE(sum(total),0)::bigint AS v FROM sales WHERE follow_status IN ('delivered','exchanged') AND delivered_at >= $1 AND delivered_at < $2`, [pm0, sameDayPrev])).v);
  const goal = (await getSetting(ctx.db, 'goals')).monthlyRevenue;

  // top products (delivered value)
  const prods = await ctx.db.query(
    `SELECT i.name, COALESCE(sum(i.qty * i.unit_price),0)::bigint AS v, COALESCE(sum(i.qty),0)::int AS q FROM order_items i JOIN sales o ON o.id = i.order_id
      WHERE o.follow_status IN ('delivered','exchanged') AND o.delivered_at >= $1 AND o.delivered_at < $2 GROUP BY i.name ORDER BY 2 DESC`,
    [r.from, r.to],
  );
  const top = prods.slice(0, 4).map((x: any) => ({ name: x.name as string, value: num(x.v), qty: num(x.q) }));
  const other = prods.slice(4).reduce((s: number, x: any) => s + num(x.v), 0);

  // wilayas (share of orders received)
  const wil = await ctx.db.query(`SELECT wilaya_id AS w, count(*)::int AS n FROM sales WHERE created_at >= $1 AND created_at < $2 GROUP BY 1 ORDER BY 2 DESC LIMIT 5`, [r.from, r.to]);

  // funnel: orders received in the period, how far they went
  const f = await q1(
    `SELECT count(*)::int AS received,
            count(*) FILTER (WHERE attempts > 0 OR conf_status NOT IN ('new','to_check'))::int AS called,
            count(*) FILTER (WHERE conf_status = 'confirmed')::int AS confirmed,
            count(*) FILTER (WHERE shipped_at IS NOT NULL)::int AS shipped,
            count(*) FILTER (WHERE follow_status IN ('delivered','exchanged'))::int AS delivered
       FROM sales WHERE created_at >= $1 AND created_at < $2`,
    [r.from, r.to],
  );

  // sales channels
  const ch = await ctx.db.query(`SELECT channel AS c, count(*)::int AS n FROM sales WHERE created_at >= $1 AND created_at < $2 GROUP BY 1 ORDER BY 2 DESC`, [r.from, r.to]);

  // recent orders and activity
  const recent = await ctx.db.query(
    `SELECT o.id, o.ref, o.customer_name, o.total, o.conf_status, o.follow_status, o.created_at,
            (SELECT i.name FROM order_items i WHERE i.order_id = o.id ORDER BY i.id LIMIT 1) AS product,
            (SELECT COALESCE(sum(i.qty),0) FROM order_items i WHERE i.order_id = o.id)::int AS qty
       FROM sales o ORDER BY o.created_at DESC, o.id DESC LIMIT 6`,
    [],
  );
  const act = await ctx.db.query(
    `SELECT e.at, e.kind, e.to_value, e.note, o.ref, o.id, p.name AS who FROM order_events e JOIN sales o ON o.id = e.order_id LEFT JOIN profiles p ON p.id = e.user_id
      WHERE e.kind IN ('conf_status','follow_status','created') AND e.at <= $1 ORDER BY e.at DESC, e.id DESC LIMIT 6`,
    [isoNow(ctx)],
  );
  return {
    kpis: {
      revenue: num(cur.revenue),
      revenuePrev: num(prev.revenue),
      received: num(cur.received),
      receivedPrev: num(prev.received),
      delivered: num(cur.delivered),
      deliveryRate: rate(cur),
      deliveryRatePrev: rate(prev),
    },
    series,
    month: { revenue: month, prevSamePoint: monthPrev, goal },
    products: { top, other, total: top.reduce((s: number, x: { value: number }) => s + x.value, 0) + other },
    wilayas: wil.map((x: any) => ({ wilayaId: num(x.w), n: num(x.n) })),
    funnel: { received: num(f.received), called: num(f.called), confirmed: num(f.confirmed), shipped: num(f.shipped), delivered: num(f.delivered) },
    channels: ch.map((x: any) => ({ channel: x.c as string, n: num(x.n) })),
    recent: recent.map((x: any) => ({ id: num(x.id), ref: x.ref as string, customer: x.customer_name as string, product: (x.product ?? '') as string, qty: num(x.qty), total: num(x.total), conf: x.conf_status as string, follow: (x.follow_status ?? null) as string | null, at: iso(x.created_at) })),
    activity: act.map((x: any) => ({ at: iso(x.at), kind: x.kind as string, to: (x.to_value ?? '') as string, ref: x.ref as string, id: num(x.id), who: (x.who ?? null) as string | null })),
  };
}

export const statsProcs = {
  'stats.overview2': proc(['vendeur'], Range, (ctx, r) => overview(ctx, r)),
  'stats.setGoal': proc([], z.object({ monthlyRevenue: z.number().int().min(0).max(10_000_000_000) }), async (ctx, i) => {
    await setSetting(ctx.db, 'goals', { monthlyRevenue: i.monthlyRevenue }, ctx.session.profile.id);
    return { ok: true };
  }),
  /** Live counters of the "Maintenant" card. */
  'stats.now': proc(['confirmation', 'suivi', 'depot'], z.object({}), async (ctx) => {
    const now = isoNow(ctx);
    const r = (
      await ctx.db.query(
        `SELECT
          count(*) FILTER (WHERE conf_status = ANY($1) AND (next_call_at IS NULL OR next_call_at <= $2))::int AS to_call,
          count(*) FILTER (WHERE conf_status = ANY($1) AND next_call_at > $2)::int AS later,
          count(*) FILTER (WHERE conf_status = 'no_stock')::int AS no_stock,
          count(*) FILTER (WHERE follow_status = 'to_prepare')::int AS to_prepare,
          count(*) FILTER (WHERE follow_status = 'prepared')::int AS prepared,
          count(*) FILTER (WHERE follow_status = ANY($3))::int AS on_road,
          count(*) FILTER (WHERE follow_status IN ('failed','alert'))::int AS failed,
          count(*) FILTER (WHERE follow_status = 'delivered' AND NOT cashed)::int AS due_n,
          COALESCE(sum(total) FILTER (WHERE follow_status = 'delivered' AND NOT cashed), 0)::bigint AS due
         FROM sales`,
        [CONF_TODO, now, FOLLOW_ON_ROAD],
      )
    )[0];
    const admin = ctx.session.isAdmin;
    return {
      toCall: num(r.to_call),
      callbacksLater: num(r.later),
      noStock: num(r.no_stock),
      toPrepare: num(r.to_prepare),
      prepared: num(r.prepared),
      onRoad: num(r.on_road),
      failed: num(r.failed),
      moneyDue: admin ? num(r.due) : null,
      moneyDueCount: admin ? num(r.due_n) : null,
    };
  }),

  /** The 7 KPIs of the "Période" card. */
  'stats.overview': proc(['confirmation', 'suivi', 'depot'], PeriodOnly, async (ctx, { from, to }) => {
    const r = (
      await ctx.db.query(
        `SELECT
          (SELECT count(*) FROM sales WHERE created_at >= $1 AND created_at < $2)::int AS received,
          (SELECT count(*) FROM sales WHERE created_at >= $1 AND created_at < $2 AND conf_status = ANY($3))::int AS received_todo,
          (SELECT count(*) FROM sales WHERE confirmed_at >= $1 AND confirmed_at < $2 AND conf_status IN ('confirmed','no_stock'))::int AS confirmed,
          (SELECT count(DISTINCT e.order_id) FROM order_events e JOIN sales o ON o.id = e.order_id
             WHERE e.kind = 'conf_status' AND e.at >= $1 AND e.at < $2 AND e.to_value = ANY($4) AND o.conf_status = ANY($4))::int AS cancelled,
          (SELECT count(*) FROM sales WHERE shipped_at >= $1 AND shipped_at < $2)::int AS shipped,
          (SELECT count(*) FROM sales WHERE shipped_at >= $1 AND shipped_at < $2 AND follow_status = ANY($5))::int AS shipped_road,
          (SELECT count(*) FROM sales WHERE delivered_at >= $1 AND delivered_at < $2 AND follow_status IN ('delivered','exchanged'))::int AS delivered,
          (SELECT count(DISTINCT e.order_id) FROM order_events e WHERE e.kind = 'follow_status' AND e.at >= $1 AND e.at < $2 AND e.to_value IN ('returning','returned'))::int AS returns,
          (SELECT count(*) FROM sales WHERE returned_at >= $1 AND returned_at < $2)::int AS returned,
          (SELECT COALESCE(sum(total),0) FROM sales WHERE delivered_at >= $1 AND delivered_at < $2 AND follow_status IN ('delivered','exchanged'))::bigint AS cash,
          (SELECT COALESCE(sum(subtotal - discount),0) FROM sales WHERE delivered_at >= $1 AND delivered_at < $2 AND follow_status IN ('delivered','exchanged'))::bigint AS cash_products`,
        [from, to, CONF_TODO, CONF_DONE_BAD, FOLLOW_ON_ROAD],
      )
    )[0];
    const confirmed = num(r.confirmed);
    const cancelled = num(r.cancelled);
    const delivered = num(r.delivered);
    const returned = num(r.returned);
    return {
      received: num(r.received),
      receivedTodo: num(r.received_todo),
      confirmed,
      confRate: ratio(confirmed, confirmed + cancelled),
      cancelled,
      shipped: num(r.shipped),
      shippedOnRoad: num(r.shipped_road),
      delivered,
      deliveryRate: ratio(delivered, delivered + returned),
      returns: num(r.returns),
      cashed: num(r.cash),
      cashedProducts: num(r.cash_products),
    };
  }),

  /** "Agents de confirmation" table of the Accueil. */
  'stats.agents': proc(['confirmation', 'suivi', 'depot'], PeriodOnly, async (ctx, { from, to }) => {
    const rows = await ctx.db.query(
      `WITH ev AS (
         SELECT DISTINCT ON (order_id, user_id) order_id, user_id, to_value FROM order_events
         WHERE kind = 'conf_status' AND at >= $1 AND at < $2 AND user_id IS NOT NULL ORDER BY order_id, user_id, at DESC),
       t AS (SELECT user_id, count(*)::int AS treated, count(*) FILTER (WHERE to_value = ANY($3))::int AS confirmed,
                    count(*) FILTER (WHERE to_value = ANY($4))::int AS lost FROM ev GROUP BY user_id),
       d AS (SELECT agent_id AS user_id,
                    count(*) FILTER (WHERE delivered_at >= $1 AND delivered_at < $2 AND follow_status IN ('delivered','exchanged'))::int AS delivered,
                    count(*) FILTER (WHERE returned_at >= $1 AND returned_at < $2)::int AS returned
             FROM sales WHERE agent_id IS NOT NULL GROUP BY agent_id)
       SELECT p.id, p.name, COALESCE(t.treated,0) AS treated, COALESCE(t.confirmed,0) AS confirmed, COALESCE(t.lost,0) AS lost,
              COALESCE(d.delivered,0) AS delivered, COALESCE(d.returned,0) AS returned
       FROM profiles p LEFT JOIN t ON t.user_id = p.id LEFT JOIN d ON d.user_id = p.id
       WHERE COALESCE(t.treated,0) + COALESCE(d.delivered,0) + COALESCE(d.returned,0) > 0
       ORDER BY confirmed DESC, treated DESC, p.name`,
      [from, to, CONFIRMED, CONF_DONE_BAD],
    );
    return rows.map((r: any) => {
      const confirmed = num(r.confirmed);
      const delivered = num(r.delivered);
      const returned = num(r.returned);
      return {
        id: num(r.id),
        name: r.name as string,
        treated: num(r.treated),
        confirmed,
        confRate: ratio(confirmed, confirmed + num(r.lost)),
        delivered,
        returned,
        deliveryRate: ratio(delivered, delivered + returned),
      };
    });
  }),

  /** Livreurs (own couriers) or delivery companies: parcels, deliveries, cash. Used by the Accueil card and the Livreurs dashboard. */
  'stats.livreurs': proc(['suivi', 'vendeur', 'agent_manager'], LivInput, async (ctx, i) => {
    if (!seesAll(ctx) && !ctx.session.roles.includes('suivi')) await needArea(ctx, 'livreurs');
    return livreursStats(ctx, i);
  }),

  /** Who is on line: confirmation agents with their presence (heartbeat), calls today and current order. */
  'stats.presence': proc(['agent_manager', 'vendeur'], z.object({}), async (ctx) => {
    const teams = await visibleTeams(ctx);
    const teamOf = new Map<number, string>();
    for (const t of teams) for (const id of t.agentIds) teamOf.set(id, t.name);
    const ids = [...teamOf.keys()];
    const now = ctx.now();
    const dayStart = new Date(algiersDayStart(now)).toISOString();
    const nowIso = isoNow(ctx);
    const rows = ids.length
      ? await ctx.db.query(
          `SELECT p.id, p.name, p.last_seen_at,
             CASE WHEN p.last_seen_at > $2::timestamptz - interval '3 minutes' THEN p.presence ELSE 'offline' END AS live,
             (SELECT count(*) FROM order_events e WHERE e.user_id = p.id AND e.kind = 'conf_status' AND e.at >= $3)::int AS calls,
             (SELECT max(at) FROM order_events e WHERE e.user_id = p.id AND e.kind IN ('conf_status','call')) AS last_call,
             (SELECT ref FROM sales o WHERE o.locked_by = p.id AND o.locked_until > $2 ORDER BY o.locked_until DESC LIMIT 1) AS on_order
           FROM profiles p WHERE p.id = ANY($1) AND p.active`,
          [ids, nowIso, dayStart],
        )
      : [];
    const order = { call: 0, online: 1, idle: 2, offline: 3 } as Record<string, number>;
    const M = 60_000;
    const agents = rows
      .map((r: any) => {
        const seen = r.last_seen_at ? Date.parse(r.last_seen_at) : null;
        const act = r.last_call ? Date.parse(r.last_call) : null;
        const s = seen === null ? Infinity : now - seen;
        const a = act === null ? Infinity : now - act;
        // Same rules as the original: on an order (or "in a call") = En appel; seen < 2.5 min or a call < 5 min = online;
        // online but no call for 15 min (or idle heartbeat) = "En ligne, sans appel"; otherwise offline.
        const presence: 'call' | 'online' | 'idle' | 'offline' =
          r.on_order || (r.live === 'call' && s <= 3 * M) ? 'call' : s <= 2.5 * M || a <= 5 * M || r.live !== 'offline' ? (a > 15 * M || r.live === 'idle' ? 'idle' : 'online') : 'offline';
        return {
          id: num(r.id),
          name: r.name as string,
          presence,
          lastSeenAt: seen === null ? null : new Date(seen).toISOString(),
          lastCallAt: act === null ? null : new Date(act).toISOString(),
          callsToday: num(r.calls),
          orderRef: (r.on_order as string | null) ?? null,
          team: teamOf.get(num(r.id)) ?? null,
        };
      })
      .sort((a, b) => (order[a.presence] ?? 9) - (order[b.presence] ?? 9) || a.name.localeCompare(b.name));
    return {
      at: nowIso,
      agents,
      online: agents.filter((a) => a.presence === 'online' || a.presence === 'call').length,
      inCall: agents.filter((a) => a.presence === 'call').length,
      idle: agents.filter((a) => a.presence === 'idle').length,
      offline: agents.filter((a) => a.presence === 'offline').length,
    };
  }),

  /** What the dashboard may show to this user, and the data the team / scope editors need. */
  'stats.dashMeta': proc(['agent_manager', 'vendeur'], z.object({}), async (ctx) => {
    const areas = await allowedAreas(ctx);
    const all = seesAll(ctx);
    const managers = (await ctx.db.query(`SELECT id, name FROM profiles WHERE active AND 'agent_manager' = ANY(roles) ORDER BY name`)).map((r: any) => ({ id: num(r.id), name: r.name as string }));
    const teams = await getSetting(ctx.db, 'teams');
    const managerOf = new Map<number, number | null>();
    for (const t of teams) for (const a of t.agentIds) managerOf.set(a, t.managerId);
    const agents = (await confAgents(ctx))
      .filter((a) => !a.roles.includes('agent_manager') && !a.roles.includes('vendeur'))
      .map((a) => ({ id: a.id, name: a.name, managerId: managerOf.get(a.id) ?? null }));
    const scope = ctx.session.isAdmin ? await getSetting(ctx.db, 'mgrScope') : {};
    return { areas, seesAll: all, canEditTeams: all, canEditScope: ctx.session.isAdmin, managers, agents, scope };
  }),

  /** Confirmation teams: filters, KPIs per team, ranking of agents, chart, comparison, delays and tries. */
  'stats.teams': proc(['agent_manager', 'vendeur'], TeamsInput, async (ctx, input) => {
    await needArea(ctx, 'confirmation');
    const { per, evs, counted, unassigned, now } = await confirmationStats(ctx, input);
    let teams = await visibleTeams(ctx, seesAll(ctx) ? [...per.keys()].filter((id) => per.get(id)!.orders + per.get(id)!.calls > 0) : []);
    const allTeams = teams;
    if (input.teamId) teams = teams.filter((t) => t.id === input.teamId);
    const nm = await names(ctx);
    const bk = buckets(input.from, input.to);

    const makeTeam = (t: TeamView) => {
      const agentIds = input.agentId ? t.agentIds.filter((id) => id === input.agentId) : t.agentIds;
      const agents = agentIds.map((id) => per.get(id) ?? finish(blank(id, nm.get(id) ?? '?')));
      const total = sum(0, t.name, agents);
      const set = new Set(agentIds);
      const series = bk.list.map((b) => {
        const end = b.t + bk.step;
        const conf = evs.filter((e) => set.has(e.uid) && e.at >= b.t && e.at < end && CONFIRMED.includes(e.to)).length;
        const callsN = evs.filter((e) => set.has(e.uid) && e.at >= b.t && e.at < end).length;
        const made = counted.filter((o) => set.has(o.uid) && o.created >= b.t && o.created < end);
        const madeConf = made.filter((o) => CONFIRMED.includes(o.conf)).length;
        return { label: b.label, confirmed: conf, calls: callsN, rate: made.length ? madeConf / made.length : null };
      });
      return {
        id: t.id,
        name: t.name,
        managerId: t.managerId,
        managerName: t.managerName,
        agentCount: t.agentIds.length,
        total: strip(total),
        unassigned,
        agents: agents.map(strip),
        series,
      };
    };
    const out = teams.map(makeTeam).filter((t) => t.agentCount > 0);
    // Délais et tentatives: first calls already late now, missed tries in the period.
    const calls = await getSetting(ctx.db, 'calls');
    const visibleAgents = [...new Set(teams.flatMap((t) => t.agentIds))];
    const waiting = visibleAgents.length
      ? await ctx.db.query(`SELECT agent_id, created_at, COALESCE(assigned_at, created_at) AS start FROM sales WHERE conf_status IN ('new','to_check') AND attempts = 0 AND agent_id = ANY($1)`, [visibleAgents])
      : [];
    const lateFirst = waiting.filter((r: any) => {
      const due = nextDue({ createdAt: new Date(r.start).toISOString(), attempts: 0, nextCallAt: null, done: false }, calls, now);
      return due.kind === 'first_late';
    }).length;
    const shown = new Set(out.flatMap((t) => t.agents.map((a) => a.id)));
    const overall = sum(0, 'Total', [...shown].map((id) => per.get(id)).filter((a): a is AgentStats => !!a));
    const allDelays = overall.firstDelays;
    const delays = {
      lateFirstNow: lateFirst,
      firstRate: overall.firstRate,
      firstMedianMs: median(allDelays),
      triesOnTime: overall.triesOnTime,
      triesMissed: overall.triesMissed,
      triesRate: overall.triesRate,
      worst: visibleAgents
        .map((id) => per.get(id))
        .filter((a): a is AgentStats => !!a && a.firstTotal + a.triesMissed > 0)
        .map((a) => ({ id: a.id, name: a.name, lateFirst: a.firstTotal - a.firstOnTime, firstRate: a.firstRate, firstMedianMs: a.firstMedianMs, triesMissed: a.triesMissed, triesRate: a.triesRate }))
        .sort((a, b) => b.lateFirst + b.triesMissed - (a.lateFirst + a.triesMissed))
        .slice(0, 10),
    };
    // "Performance" column in the comparison = the agents' rate (without duplicates / wrong numbers, known outcomes only).
    const perfMap = new Map<string, number | null>();
    if (input.rateType === 'taux') {
      const p = await confirmationStats(ctx, { ...input, rateType: 'perf' });
      for (const t of out) {
        const ids = input.agentId ? [input.agentId] : allTeams.find((x) => x.id === t.id)?.agentIds ?? [];
        perfMap.set(t.id, sum(0, '', ids.map((id) => p.per.get(id) ?? finish(blank(id, '')))).confRate);
      }
    } else for (const t of out) perfMap.set(t.id, t.total.confRate);
    const comparison = out.map((t) => ({
      id: t.id,
      name: t.name,
      agents: t.agentCount,
      orders: t.total.orders,
      confirmed: t.total.confirmed,
      perf: perfMap.get(t.id) ?? null,
      rate: t.total.confRate,
      confirmationsInPeriod: t.total.confirmationsInPeriod,
      calls: t.total.calls,
      inProgress: t.total.inProgress,
      lateCallbacks: t.total.lateCallbacks,
    }));
    return {
      hourly: bk.hourly,
      teams: out,
      comparison,
      teamOptions: allTeams.map((t) => ({ id: t.id, name: t.name, agentIds: t.agentIds })),
      agentOptions: [...new Set(allTeams.flatMap((t) => t.agentIds))].map((id) => ({ id, name: nm.get(id) ?? '?' })).sort((a, b) => a.name.localeCompare(b.name)),
      delays,
      mine: !seesAll(ctx),
    };
  }),

  /** Dépôt: stages now, shipped in the period, confirmation → shipping delay, per person. */
  'stats.dashDepot': proc(['agent_manager', 'vendeur'], PeriodOnly, async (ctx, { from, to }) => {
    await needArea(ctx, 'depot');
    const r = (
      await ctx.db.query(
        `SELECT count(*) FILTER (WHERE follow_status = 'to_prepare')::int AS to_prepare,
                count(*) FILTER (WHERE follow_status = 'prepared')::int AS prepared,
                count(*) FILTER (WHERE follow_status = 'shipped')::int AS shipped_now,
                count(*) FILTER (WHERE follow_status = 'out_for_delivery')::int AS out,
                count(*) FILTER (WHERE follow_status = 'returning')::int AS returning,
                count(*) FILTER (WHERE shipped_at >= $1 AND shipped_at < $2)::int AS shipped
         FROM sales`,
        [from, to],
      )
    )[0];
    const delays = (
      await ctx.db.query(`SELECT extract(epoch FROM (shipped_at - confirmed_at)) * 1000 AS ms FROM sales WHERE shipped_at >= $1 AND shipped_at < $2 AND confirmed_at IS NOT NULL AND shipped_at > confirmed_at`, [from, to])
    ).map((x: any) => Number(x.ms));
    const people = await ctx.db.query(
      `SELECT e.user_id, p.name,
              count(DISTINCT e.order_id) FILTER (WHERE e.to_value = 'prepared')::int AS packed,
              count(DISTINCT e.order_id) FILTER (WHERE e.to_value = 'shipped')::int AS shipped,
              count(DISTINCT e.order_id) FILTER (WHERE e.to_value = 'returned')::int AS returns
       FROM order_events e LEFT JOIN profiles p ON p.id = e.user_id
       WHERE e.kind = 'follow_status' AND e.at >= $1 AND e.at < $2 AND e.to_value IN ('prepared','shipped','returned')
       GROUP BY e.user_id, p.name ORDER BY packed DESC, shipped DESC`,
      [from, to],
    );
    return {
      toPrepare: num(r.to_prepare),
      prepared: num(r.prepared),
      dispatched: num(r.shipped_now),
      outForDelivery: num(r.out),
      returning: num(r.returning),
      shipped: num(r.shipped),
      medianConfirmToShipMs: median(delays),
      people: people.map((p: any) => ({ id: p.user_id === null ? null : num(p.user_id), name: (p.name as string | null) ?? null, packed: num(p.packed), shipped: num(p.shipped), returns: num(p.returns) })),
    };
  }),

  /** Suivi: alerts, parcels on the road, delivered / returned in the period, per follow-up agent. */
  'stats.dashSuivi': proc(['agent_manager', 'vendeur'], PeriodOnly, async (ctx, { from, to }) => {
    await needArea(ctx, 'suivi');
    const r = (
      await ctx.db.query(
        `SELECT count(*) FILTER (WHERE follow_status = 'alert' AND COALESCE(sub_status,'') <> 'alert_traitee')::int AS alerts,
                count(*) FILTER (WHERE follow_status = ANY($3))::int AS on_road,
                count(*) FILTER (WHERE follow_status = 'returning' AND (conf_status = 'cancelled' OR sub_status = 'annule_swappe'))::int AS cancelled_back,
                count(*) FILTER (WHERE follow_status = 'returning')::int AS returning,
                count(*) FILTER (WHERE delivered_at >= $1 AND delivered_at < $2 AND follow_status IN ('delivered','exchanged'))::int AS delivered,
                count(*) FILTER (WHERE returned_at >= $1 AND returned_at < $2 AND follow_status = 'returned')::int AS returned
         FROM sales`,
        [from, to, FOLLOW_ON_ROAD],
      )
    )[0];
    const agents = await ctx.db.query(
      `SELECT o.follow_agent_id AS id, p.name,
              count(*) FILTER (WHERE o.delivered_at >= $1 AND o.delivered_at < $2 AND o.follow_status IN ('delivered','exchanged'))::int AS delivered,
              count(*) FILTER (WHERE o.returned_at >= $1 AND o.returned_at < $2 AND o.follow_status = 'returned')::int AS returned
       FROM sales o LEFT JOIN profiles p ON p.id = o.follow_agent_id
       WHERE (o.delivered_at >= $1 AND o.delivered_at < $2) OR (o.returned_at >= $1 AND o.returned_at < $2)
       GROUP BY o.follow_agent_id, p.name ORDER BY delivered DESC`,
      [from, to],
    );
    const delivered = num(r.delivered);
    const returned = num(r.returned);
    return {
      alerts: num(r.alerts),
      onRoad: num(r.on_road),
      cancelledBack: Math.max(num(r.cancelled_back), 0),
      returning: num(r.returning),
      delivered,
      returned,
      deliveryRate: ratio(delivered, delivered + returned),
      agents: agents
        .map((a: any) => ({ id: a.id === null ? null : num(a.id), name: (a.name as string | null) ?? null, delivered: num(a.delivered), returned: num(a.returned), rate: ratio(num(a.delivered), num(a.delivered) + num(a.returned)) }))
        .filter((a: { delivered: number; returned: number }) => a.delivered + a.returned > 0),
    };
  }),

  /** Livreurs dashboard (same numbers as stats.livreurs, checked against the manager's areas). */
  'stats.dashLivreurs': proc(['agent_manager', 'vendeur'], LivInput, async (ctx, i) => {
    await needArea(ctx, 'livreurs');
    return livreursStats(ctx, i);
  }),

  /** SAV: tickets waiting, in progress, older than 48 h, new and settled in the period, per person in charge. */
  'stats.dashSav': proc(['agent_manager', 'vendeur'], PeriodOnly, async (ctx, { from, to }) => {
    await needArea(ctx, 'sav');
    const old = new Date(ctx.now() - 48 * 3_600_000).toISOString();
    const r = (
      await ctx.db.query(
        `SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
                count(*) FILTER (WHERE status = 'progress')::int AS progress,
                count(*) FILTER (WHERE status IN ('open','progress') AND created_at < $3)::int AS old,
                count(*) FILTER (WHERE created_at >= $1 AND created_at < $2)::int AS created,
                count(*) FILTER (WHERE status IN ('resolved','closed') AND updated_at >= $1 AND updated_at < $2)::int AS settled,
                avg(extract(epoch FROM (updated_at - created_at)) * 1000) FILTER (WHERE status IN ('resolved','closed') AND updated_at >= $1 AND updated_at < $2) AS avg_ms
         FROM complaints`,
        [from, to, old],
      )
    )[0];
    const people = await ctx.db.query(
      `SELECT c.assigned_to AS id, p.name,
              count(*) FILTER (WHERE c.status IN ('open','progress'))::int AS todo,
              count(*) FILTER (WHERE c.status IN ('resolved','closed') AND c.updated_at >= $1 AND c.updated_at < $2)::int AS settled
       FROM complaints c LEFT JOIN profiles p ON p.id = c.assigned_to
       GROUP BY c.assigned_to, p.name ORDER BY todo DESC, settled DESC`,
      [from, to],
    );
    return {
      open: num(r.open),
      progress: num(r.progress),
      older48h: num(r.old),
      created: num(r.created),
      settled: num(r.settled),
      avgSettleMs: r.avg_ms === null || r.avg_ms === undefined ? null : Number(r.avg_ms),
      people: people.map((p: any) => ({ id: p.id === null ? null : num(p.id), name: (p.name as string | null) ?? null, todo: num(p.todo), settled: num(p.settled) })).filter((p: { todo: number; settled: number }) => p.todo + p.settled > 0),
    };
  }),

  /** "Composer les équipes": each agent belongs to one agent manager (admin / vendeur). */
  'stats.saveTeams': proc(
    ['vendeur'],
    z.object({ assignments: z.array(z.object({ agentId: z.number().int().positive(), managerId: z.number().int().positive().nullable() })).max(500) }),
    async (ctx, i) => {
      const managers = new Map(
        (await ctx.db.query(`SELECT id, name FROM profiles WHERE 'agent_manager' = ANY(roles)`)).map((r: any) => [num(r.id), r.name as string]),
      );
      for (const a of i.assignments) if (a.managerId !== null && !managers.has(a.managerId)) throw bad('Ce manager n’existe pas ou n’est pas agent manager');
      const old = await getSetting(ctx.db, 'teams');
      const assigned = new Set(i.assignments.map((a) => a.agentId));
      const teams: Team[] = [...managers.entries()].map(([mid, name]) => {
        const prev = old.find((t) => t.managerId === mid);
        const keep = (prev?.agentIds ?? []).filter((id) => !assigned.has(id));
        return { id: prev?.id ?? `m${mid}`, name: prev?.name ?? `Équipe ${name}`, managerId: mid, agentIds: [...new Set([...keep, ...i.assignments.filter((a) => a.managerId === mid).map((a) => a.agentId)])] };
      });
      await setSetting(ctx.db, 'teams', teams, ctx.session.profile.id);
      ctx.emit({ type: 'settings' });
      return { ok: true, teams };
    },
  ),

  /** "Qui gère quoi": the dashboard areas each agent manager sees (admin only). */
  'stats.saveScope': proc([], z.object({ scope: z.record(z.string().regex(/^\d+$/), z.array(z.enum(AREAS)).max(5)) }), async (ctx, i) => {
    const managers = new Set((await ctx.db.query(`SELECT id FROM profiles WHERE 'agent_manager' = ANY(roles)`)).map((r: any) => String(num(r.id))));
    const scope: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(i.scope)) {
      if (!managers.has(k)) throw bad('Ce manager n’existe pas ou n’est pas agent manager');
      scope[k] = [...new Set(v)];
    }
    await setSetting(ctx.db, 'mgrScope', scope, ctx.session.profile.id);
    ctx.emit({ type: 'settings' });
    return { ok: true, scope };
  }),
};
