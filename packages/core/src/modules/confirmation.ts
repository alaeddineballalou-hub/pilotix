// Confirmation queue: lists with call deadlines, the agent banner, and the KPI blocks of
// Nouvelles / En cours / Confirmées. Order changes go through modules/orders.ts.
import { algiersDayStart, CallSettings, CONF_STATUSES, CONF_TODO, ConfStatus, nextDue, Order, slotAt } from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, isoOrNull, num, numOrNull } from '../db';
import { bad, Ctx, forbidden, hasRole, proc } from '../rpc';
import { clientFee, getSetting, setSetting } from '../settings';
import { ConfInput, getOrder, ListInput, listOrders, setConf } from './orders';

// ---------------------------------------------------------------- sub-pages
export const CONF_SUBS = {
  nouvelles: ['new'],
  attente: ['to_check', 'no_answer', 'busy', 'callback', 'postponed'],
  confirmees: ['confirmed', 'no_stock'],
  terminees: ['duplicate', 'wrong_number', 'fake'],
} as const satisfies Record<string, readonly ConfStatus[]>;
export type ConfSub = keyof typeof CONF_SUBS;
const SUB = z.enum(['nouvelles', 'attente', 'confirmees', 'terminees']);
const id = z.number().int().positive();
const ids = z.array(id).min(1).max(500);
const MIN = 60_000;
const DAY = 86_400_000;

/** Managers see the team: statistics, assign / remove agents. */
export const isManager = (ctx: Ctx) => hasRole(ctx.session, 'agent_manager', 'vendeur');

// ---------------------------------------------------------------- call deadlines
/** The countdown shown on a row: t = deadline, m = first call / end of slot / start of the next slot (then e = its end). */
export interface Deadline {
  t: number;
  m: 'first' | 'slot' | 'start';
  e?: number;
}
export interface DueInfo {
  kind: ReturnType<typeof nextDue>['kind'];
  at: number | null;
  start: number;
  deadline: Deadline | null;
}
interface TodoRow {
  id: number;
  ref: string;
  name: string;
  agentId: number | null;
  createdAt: number;
  start: number;
  attempts: number;
  nextCallAt: string | null;
  lastCallAt: string | null;
  status: ConfStatus;
}

/** When the clock starts for an order: its assignment (or arrival); at night, the first slot. */
export function workStart(t: number, s: CallSettings): number {
  const sl = slotAt(t, s);
  return sl.open ? t : sl.from;
}

async function loadTodo(db: Db): Promise<TodoRow[]> {
  const rows = await db.query(
    `SELECT id, ref, customer_name, agent_id, created_at, assigned_at, attempts, next_call_at, last_call_at, conf_status
       FROM sales WHERE conf_status = ANY($1)`,
    [CONF_TODO],
  );
  return rows.map((r: any) => {
    const created = Date.parse(iso(r.created_at));
    const assigned = r.agent_id && r.assigned_at ? Date.parse(iso(r.assigned_at)) : null;
    return {
      id: num(r.id),
      ref: r.ref,
      name: r.customer_name,
      agentId: numOrNull(r.agent_id),
      createdAt: created,
      start: assigned && assigned > created ? assigned : created,
      attempts: num(r.attempts),
      nextCallAt: isoOrNull(r.next_call_at),
      lastCallAt: isoOrNull(r.last_call_at),
      status: r.conf_status,
    };
  });
}

/**
 * Next call of every order still in the queue (shared timers.ts rules).
 * Never-called orders: newest first per agent (last in, first out), so each more recent order
 * waiting in the same list pushes the deadline by `paceMinutes`.
 */
export function computeDue(rows: TodoRow[], s: CallSettings, now: number): Map<number, DueInfo> {
  const out = new Map<number, DueInfo>();
  const isFirst = (r: TodoRow) => r.attempts === 0 && !r.nextCallAt;
  const groups = new Map<string, TodoRow[]>();
  for (const r of rows.filter(isFirst)) {
    const k = String(r.agentId ?? '');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const ahead = new Map<number, number>();
  for (const g of groups.values()) {
    g.sort((a, b) => b.start - a.start || b.id - a.id);
    g.forEach((r, i) => ahead.set(r.id, i));
  }
  for (const r of rows) {
    const d = nextDue(
      { createdAt: new Date(r.start).toISOString(), attempts: r.attempts, nextCallAt: r.nextCallAt, lastCallAt: r.lastCallAt, done: false, aheadInList: ahead.get(r.id) ?? 0 },
      s,
      now,
    );
    let deadline: Deadline | null = null;
    if (d.kind.startsWith('first') && d.at !== null) deadline = { t: d.at, m: 'first' };
    else if (d.kind === 'now' && d.at !== null) {
      if (r.nextCallAt) deadline = { t: d.at, m: 'first' };
      else {
        const sl = slotAt(now, s);
        deadline = sl.open ? { t: sl.to, m: 'slot' } : { t: d.at, m: 'first' };
      }
    } else if (d.kind === 'later' && d.at !== null) {
      deadline = { t: d.at, m: 'start', e: r.nextCallAt ? d.at + 30 * MIN : slotAt(d.at, s).to };
    } else if (d.kind === 'missed') {
      const last = r.lastCallAt ? Date.parse(r.lastCallAt) : r.start;
      const sl = slotAt(last, s);
      deadline = { t: sl.open ? sl.to : sl.from, m: 'slot' };
    }
    out.set(r.id, { kind: d.kind, at: d.at, start: workStart(r.start, s), deadline });
  }
  return out;
}

// ---------------------------------------------------------------- periods (Algiers days)
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const KfInput = z.object({
  per: z.enum(['today', 'yesterday', '7', '30', 'month', 'custom']).default('today'),
  from: DATE.optional(),
  to: DATE.optional(),
  basis: z.enum(['created', 'updated']).default('created'),
});
export type KfInput = z.infer<typeof KfInput>;

export function kfRange(now: number, i: { per: KfInput['per']; from?: string; to?: string }): { a: number; b: number } {
  const day = algiersDayStart(now);
  switch (i.per) {
    case 'yesterday':
      return { a: day - DAY, b: day };
    case '7':
      return { a: day - 6 * DAY, b: day + DAY };
    case '30':
      return { a: day - 29 * DAY, b: day + DAY };
    case 'month': {
      const d = new Date(now + 3_600_000);
      return { a: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 3_600_000, b: day + DAY };
    }
    case 'custom': {
      const p = (s: string | undefined) => (s ? Date.parse(s + 'T00:00:00Z') - 3_600_000 : day);
      let a = p(i.from);
      let b = p(i.to);
      if (a > b) [a, b] = [b, a];
      return { a, b: b + DAY };
    }
    default:
      return { a: day, b: day + DAY };
  }
}
const isoT = (t: number) => new Date(t).toISOString();
const pc = (a: number, b: number) => (b > 0 ? Math.round((a * 100) / b) : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

async function names(db: Db): Promise<Map<number, string>> {
  const rows = await db.query('SELECT id, name FROM profiles');
  return new Map(rows.map((r: any) => [num(r.id), r.name as string]));
}

const MGR = ['agent_manager', 'vendeur'] as const;
const CANCELLED_LIKE = ['cancelled', 'fake', 'wrong_number', 'duplicate'];

// ---------------------------------------------------------------- list rows
export interface QueueRow extends Order {
  skus: string[];
  creatorName: string | null;
  deadline: Deadline | null;
  dueKind: string | null;
  /** stock for every line: 'ok' all available, 'short' something missing, null nothing to check */
  stock: 'ok' | 'short' | null;
  /** confirmation statuses the order went through (oldest first, without repeats in a row) */
  passed: string[];
}

const QueueInput = z.object({
  sub: SUB,
  status: z.enum(CONF_STATUSES).optional(),
  q: z.string().max(100).optional(),
  wilayaId: z.number().int().min(1).max(69).optional(),
  agentId: z.union([id, z.literal('none')]).optional(),
  channel: ListInput.shape.channel,
  from: DATE.optional(),
  to: DATE.optional(),
  sort: z.enum(['created_at', 'confirmed_at', 'next_call_at', 'total', 'customer_name']).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(3000).default(50),
});

export const DEFAULT_SORT: Record<ConfSub, { sort: 'created_at' | 'confirmed_at' | 'next_call_at'; dir: 'asc' | 'desc' }> = {
  nouvelles: { sort: 'created_at', dir: 'desc' },
  attente: { sort: 'next_call_at', dir: 'asc' },
  confirmees: { sort: 'confirmed_at', dir: 'desc' },
  terminees: { sort: 'created_at', dir: 'desc' },
};

async function queueList(ctx: Ctx, i: z.infer<typeof QueueInput>) {
  const allowed = CONF_SUBS[i.sub] as readonly ConfStatus[];
  if (i.status && !allowed.includes(i.status)) throw bad('Statut hors de cette liste');
  const def = DEFAULT_SORT[i.sub];
  const day = (s: string) => Date.parse(s + 'T00:00:00Z') - 3_600_000;
  const page = await listOrders(ctx, {
    conf: i.status ? [i.status] : [...allowed],
    q: i.q,
    wilayaId: i.wilayaId,
    agentId: i.agentId,
    channel: i.channel,
    dateField: 'created_at',
    from: i.from ? isoT(day(i.from)) : undefined,
    to: i.to ? isoT(day(i.to) + DAY) : undefined,
    sort: i.sort ?? def.sort,
    dir: i.dir ?? (i.sort ? (i.sort === 'total' ? 'desc' : 'asc') : def.dir),
    page: i.page,
    pageSize: i.pageSize,
  });
  const vids = [...new Set(page.rows.flatMap((o) => o.items.map((it) => it.variantId).filter((v): v is number => !!v)))];
  const skuOf = new Map<number, string>();
  if (vids.length) for (const r of await ctx.db.query('SELECT id, sku FROM product_variants WHERE id = ANY($1)', [vids])) skuOf.set(num(r.id), r.sku);
  const who = await names(ctx.db);
  // stock: sum over the depots for each variant
  const stockOf = new Map<number, number>();
  if (vids.length) for (const r of await ctx.db.query('SELECT variant_id, sum(qty)::int AS q FROM stock WHERE variant_id = ANY($1) GROUP BY 1', [vids])) stockOf.set(num(r.variant_id), num(r.q));
  // statuses passed
  const oids = page.rows.map((o) => o.id);
  const passedOf = new Map<number, string[]>();
  if (oids.length)
    for (const r of await ctx.db.query(`SELECT order_id, array_agg(to_value ORDER BY at, id) AS v FROM order_events WHERE kind = 'conf_status' AND order_id = ANY($1) GROUP BY 1`, [oids])) {
      const v: string[] = (Array.isArray(r.v) ? r.v : String(r.v ?? '').replace(/[{}]/g, '').split(',')).filter(Boolean);
      passedOf.set(num(r.order_id), v.filter((x, k) => k === 0 || v[k - 1] !== x));
    }
  let due = new Map<number, DueInfo>();
  if (i.sub === 'nouvelles' || i.sub === 'attente') {
    const calls = await getSetting(ctx.db, 'calls');
    due = computeDue(await loadTodo(ctx.db), calls, ctx.now());
  }
  const rows: QueueRow[] = page.rows.map((o) => ({
    ...o,
    skus: [...new Set(o.items.map((it) => (it.variantId ? skuOf.get(it.variantId) : undefined)).filter((s): s is string => !!s))],
    creatorName: o.createdBy ? who.get(o.createdBy) ?? null : null,
    deadline: due.get(o.id)?.deadline ?? null,
    dueKind: due.get(o.id)?.kind ?? null,
    stock: o.items.some((it) => it.variantId) ? (o.items.every((it) => !it.variantId || (stockOf.get(it.variantId) ?? 0) >= it.qty) ? 'ok' : 'short') : null,
    passed: passedOf.get(o.id) ?? [],
  }));
  return { ...page, rows };
}

// ---------------------------------------------------------------- KPI blocks
async function firstCall(ctx: Ctx, i: KfInput) {
  const now = ctx.now();
  const calls = await getSetting(ctx.db, 'calls');
  const R = kfRange(now, i);
  const made = await ctx.db.query(
    `SELECT id, ref, customer_name, created_at, assigned_at, agent_id, conf_status FROM sales
      WHERE (created_at >= $1 AND created_at < $2) OR conf_status IN ('new','to_check')`,
    [isoT(R.a - DAY), isoT(R.b)],
  );
  const all = made.map((r: any) => {
    const created = Date.parse(iso(r.created_at));
    const assigned = r.agent_id && r.assigned_at ? Date.parse(iso(r.assigned_at)) : null;
    const r0 = assigned && assigned > created ? assigned : created;
    return { id: num(r.id), ref: r.ref as string, name: r.customer_name as string, agentId: numOrNull(r.agent_id), created, r: r0, s: workStart(r0, calls), status: r.conf_status as ConfStatus };
  });
  const first = new Map<number, { at: number; by: number }>();
  const idList = all.map((o) => o.id);
  for (let k = 0; k < idList.length; k += 1000) {
    const ev = await ctx.db.query(
      `SELECT DISTINCT ON (order_id) order_id, at, user_id FROM order_events
        WHERE kind = 'conf_status' AND user_id IS NOT NULL AND order_id = ANY($1) ORDER BY order_id, at`,
      [idList.slice(k, k + 1000)],
    );
    for (const e of ev) first.set(num(e.order_id), { at: Date.parse(iso(e.at)), by: num(e.user_id) });
  }
  // called in the period
  const groups = new Map<string, typeof all>();
  for (const o of all) {
    const g = String(o.agentId ?? '');
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(o);
  }
  const called: { d: number; ok: boolean }[] = [];
  for (const g of groups.values())
    for (const x of g) {
      const f = first.get(x.id);
      if (!f) continue;
      // date de création: orders created in the period · changement de statut: first call made in the period
      if (i.basis === 'created' ? x.created < R.a || x.created >= R.b : f.at < R.a || f.at >= R.b) continue;
      const newer = g.filter((y) => y.r > x.r && y.s <= f.at).length;
      const due = Math.min(x.s + (calls.firstMinutes + newer * calls.paceMinutes) * MIN, x.s + DAY);
      called.push({ d: Math.max(0, (f.at - x.s) / MIN), ok: f.at <= due });
    }
  // waiting now
  const todo = await loadTodo(ctx.db);
  const waitingRows = todo.filter((o) => (o.status === 'new' || o.status === 'to_check') && o.attempts === 0 && !o.nextCallAt && !first.has(o.id));
  const due = computeDue(waitingRows, calls, now);
  const waiting = waitingRows.map((o) => ({ o, s: due.get(o.id)!.start, at: due.get(o.id)!.at ?? o.start }));
  const late = waiting.filter((x) => now > x.at).length;
  const oldest = waiting.filter((x) => x.s <= now).sort((a, b) => a.s - b.s)[0] ?? null;
  const ds = called.map((x) => x.d);
  const bounds = [5, 15, 30, 60, Infinity];
  const buckets = bounds.map(() => 0);
  for (const d of ds) buckets[bounds.findIndex((b) => d <= b)]++;
  return {
    waiting: waiting.length,
    waitingNoAgent: waiting.filter((x) => !x.o.agentId).length,
    late,
    oldest: oldest ? { id: oldest.o.id, ref: oldest.o.ref, name: oldest.o.name, since: isoT(oldest.s) } : null,
    received: all.filter((o) => o.created >= R.a && o.created < R.b && o.status !== 'duplicate').length,
    called: called.length,
    onTime: called.filter((x) => x.ok).length,
    medianMin: median(ds),
    under5: ds.filter((d) => d <= 5).length,
    buckets,
    firstMinutes: calls.firstMinutes,
  };
}

async function periodNew(ctx: Ctx, i: KfInput) {
  const R = kfRange(ctx.now(), i);
  const col = i.basis === 'updated' ? 'updated_at' : 'created_at';
  const O = await ctx.db.query(`SELECT id, conf_status, attempts, agent_id, total FROM sales WHERE ${col} >= $1 AND ${col} < $2`, [isoT(R.a), isoT(R.b)]);
  const news = O.filter((o: any) => o.conf_status === 'new' || o.conf_status === 'to_check');
  const called = O.filter((o: any) => num(o.attempts) > 0 || !['new', 'to_check'].includes(o.conf_status));
  const conf = O.filter((o: any) => o.conf_status === 'confirmed').length;
  const canc = O.filter((o: any) => CANCELLED_LIKE.includes(o.conf_status)).length;
  return {
    received: O.length,
    value: O.reduce((s: number, o: any) => s + num(o.total), 0),
    notCalled: news.length,
    notCalledNoAgent: news.filter((o: any) => !o.agent_id).length,
    called: called.length,
    calledPct: pc(called.length, O.length),
    confirmed: conf,
    cancelled: canc,
    rate: pc(conf, conf + canc),
  };
}

const PREP = ['to_prepare', 'prepared'];
const ROUTE = ['shipped', 'out_for_delivery', 'failed', 'alert', 'in_exchange'];
const OK = ['delivered', 'exchanged'];
const BACK = ['returning', 'returned', 'lost'];

async function deliveryPerf(ctx: Ctx, i: KfInput & { on: 'created' | 'confirmed' }) {
  const R = kfRange(ctx.now(), i);
  const col = i.on === 'confirmed' && i.basis === 'updated' ? 'confirmed_at' : 'created_at';
  const O = await ctx.db.query(`SELECT total, follow_status FROM sales WHERE conf_status = 'confirmed' AND ${col} >= $1 AND ${col} < $2`, [isoT(R.a), isoT(R.b)]);
  const f = (L: string[]) => O.filter((o: any) => L.includes(o.follow_status));
  const val = (L: any[]) => L.reduce((s: number, o: any) => s + num(o.total), 0);
  const ok = f(OK);
  const back = f(BACK);
  return {
    confirmed: O.length,
    value: val(O),
    depot: O.filter((o: any) => !o.follow_status || PREP.includes(o.follow_status)).length,
    route: f(ROUTE).length,
    delivered: ok.length,
    deliveredValue: val(ok),
    back: back.length,
    rate: pc(ok.length, ok.length + back.length),
    overall: pc(ok.length, O.length),
    cancelledAfter: f(['cancelled']).length,
  };
}

async function enCours(ctx: Ctx, i: KfInput) {
  const now = ctx.now();
  const R = kfRange(now, i);
  const upd = i.basis === 'updated';
  const col = upd ? 'updated_at' : 'created_at';
  const ST = ['no_answer', 'busy', 'callback', 'postponed'];
  const O = await ctx.db.query(
    `SELECT id, ref, conf_status, attempts, next_call_at, agent_id, created_at, total FROM sales WHERE conf_status = ANY($1) AND ${col} >= $2 AND ${col} < $3`,
    [ST, isoT(R.a), isoT(R.b)],
  );
  const rec = num(
    (await ctx.db.query(`SELECT count(*)::int AS n FROM sales WHERE conf_status = 'confirmed' AND attempts >= 2 AND ${upd ? 'confirmed_at' : 'created_at'} >= $1 AND ${upd ? 'confirmed_at' : 'created_at'} < $2`, [isoT(R.a), isoT(R.b)]))[0]?.n,
  );
  const lost = num(
    (
      await ctx.db.query(
        upd
          ? `SELECT count(*)::int AS n FROM sales o WHERE o.conf_status = 'cancelled' AND o.attempts >= 2 AND EXISTS
               (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.kind = 'conf_status' AND e.to_value = 'cancelled' AND e.at >= $1 AND e.at < $2)`
          : `SELECT count(*)::int AS n FROM sales WHERE conf_status = 'cancelled' AND attempts >= 2 AND created_at >= $1 AND created_at < $2`,
        [isoT(R.a), isoT(R.b)],
      )
    )[0]?.n,
  );
  const nx = (o: any) => (o.next_call_at ? Date.parse(iso(o.next_call_at)) : null);
  const isDue = (o: any) => nx(o) === null || nx(o)! <= now;
  const isLate = (o: any) => nx(o) !== null && nx(o)! < now - 30 * MIN;
  const late = O.filter(isLate).sort((a: any, b: any) => nx(a)! - nx(b)!);
  const later = O.filter((o: any) => nx(o) !== null && nx(o)! > now).sort((a: any, b: any) => nx(a)! - nx(b)!);
  const who = await names(ctx.db);
  const M = new Map<string, { agentId: number | null; name: string | null; n: number; due: number; late: number; many: number }>();
  for (const o of O) {
    const k = String(o.agent_id ?? '');
    if (!M.has(k)) M.set(k, { agentId: numOrNull(o.agent_id), name: o.agent_id ? who.get(num(o.agent_id)) ?? '—' : null, n: 0, due: 0, late: 0, many: 0 });
    const v = M.get(k)!;
    v.n++;
    if (isDue(o)) v.due++;
    if (isLate(o)) v.late++;
    if (num(o.attempts) >= 3) v.many++;
  }
  return {
    count: O.length,
    value: O.reduce((s: number, o: any) => s + num(o.total), 0),
    dueNow: O.filter(isDue).length,
    late: late.length,
    lateOldest: late[0] ? { ref: late[0].ref, since: iso(late[0].next_call_at) } : null,
    later: later.length,
    nextLater: later[0] ? { ref: later[0].ref, at: iso(later[0].next_call_at) } : null,
    noAgent: O.filter((o: any) => !o.agent_id).length,
    avgAttempts: O.length ? O.reduce((s: number, o: any) => s + num(o.attempts), 0) / O.length : null,
    many: O.filter((o: any) => num(o.attempts) >= 3).length,
    old: O.filter((o: any) => now - Date.parse(iso(o.created_at)) > 48 * 3_600_000).length,
    recovered: rec,
    lost,
    recoveryRate: pc(rec, rec + lost),
    byStatus: Object.fromEntries(ST.map((s) => [s, O.filter((o: any) => o.conf_status === s).length])),
    byAgent: [...M.values()].sort((a, b) => b.late - a.late || b.due - a.due || b.n - a.n),
  };
}

async function confirmedKpis(ctx: Ctx, i: KfInput) {
  const R = kfRange(ctx.now(), i);
  const upd = i.basis === 'updated';
  const cc = upd ? 'confirmed_at' : 'created_at';
  const O = await ctx.db.query(
    `SELECT id, total, agent_id, created_at, confirmed_at, has_upsell FROM sales WHERE conf_status = 'confirmed' AND ${cc} >= $1 AND ${cc} < $2`,
    [isoT(R.a), isoT(R.b)],
  );
  const X = num(
    (
      await ctx.db.query(
        upd
          ? `SELECT count(*)::int AS n FROM sales o WHERE o.conf_status = ANY($3) AND EXISTS
              (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.kind = 'conf_status' AND e.to_value = o.conf_status AND e.at >= $1 AND e.at < $2)`
          : `SELECT count(*)::int AS n FROM sales WHERE conf_status = ANY($3) AND created_at >= $1 AND created_at < $2`,
        [isoT(R.a), isoT(R.b), CANCELLED_LIKE],
      )
    )[0]?.n,
  );
  const oids = O.map((o: any) => num(o.id));
  const items = oids.length
    ? await ctx.db.query(`SELECT i.order_id, i.qty, i.unit_price, i.is_upsell, p.packs FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = ANY($1)`, [oids])
    : [];
  const byOrder = new Map<number, any[]>();
  for (const it of items) {
    const k = num(it.order_id);
    if (!byOrder.has(k)) byOrder.set(k, []);
    byOrder.get(k)!.push(it);
  }
  const info = (o: any) => {
    const I = byOrder.get(num(o.id)) ?? [];
    const packsOf = (it: any) => (typeof it.packs === 'string' ? JSON.parse(it.packs) : it.packs ?? []) as { qty: number }[];
    const up = I.filter((x) => x.is_upsell);
    const upV = up.reduce((s, x) => s + num(x.qty) * num(x.unit_price), 0);
    const pk = I.some((x) => num(x.qty) >= 2 && packsOf(x).some((p) => Number(p.qty) === num(x.qty)));
    const qty = I.reduce((s, x) => s + num(x.qty), 0);
    const extra = I.reduce((s, x) => s + Math.max(0, num(x.qty) - 1) * num(x.unit_price), 0);
    return { up: up.length > 0 || !!o.has_upsell || pk, upV: upV + (pk && !up.length ? extra : 0), pk, qty };
  };
  const U = new Map(O.map((o: any) => [num(o.id), info(o)]));
  const n = O.length;
  const val = O.reduce((s: number, o: any) => s + num(o.total), 0);
  const lead = O.filter((o: any) => o.confirmed_at)
    .map((o: any) => Date.parse(iso(o.confirmed_at)) - Date.parse(iso(o.created_at)))
    .filter((d: number) => d >= 0);
  const who = await names(ctx.db);
  const M = new Map<string, { agentId: number | null; name: string | null; n: number; value: number; up: number; upValue: number }>();
  for (const o of O) {
    const k = String(o.agent_id ?? '');
    if (!M.has(k)) M.set(k, { agentId: numOrNull(o.agent_id), name: o.agent_id ? who.get(num(o.agent_id)) ?? '—' : null, n: 0, value: 0, up: 0, upValue: 0 });
    const v = M.get(k)!;
    const u = U.get(num(o.id))!;
    v.n++;
    v.value += num(o.total);
    if (u.up) v.up++;
    v.upValue += u.upV;
  }
  const ups = O.filter((o: any) => U.get(num(o.id))!.up).length;
  return {
    confirmed: n,
    value: val,
    cancelled: X,
    rate: pc(n, n + X),
    basket: n ? Math.round(val / n) : null,
    itemsPerOrder: n ? [...U.values()].reduce((s, u) => s + u.qty, 0) / n : null,
    leadMedianMs: median(lead),
    upsellOrders: ups,
    upsellRate: pc(ups, n),
    upsellValue: [...U.values()].reduce((s, u) => s + u.upV, 0),
    packs: [...U.values()].filter((u) => u.pk).length,
    byAgent: [...M.values()].sort((a, b) => b.n - a.n),
  };
}

// ---------------------------------------------------------------- the agent banner
async function banner(ctx: Ctx) {
  const now = ctx.now();
  const me = ctx.session.profile.id;
  const calls = await getSetting(ctx.db, 'calls');
  const todo = await loadTodo(ctx.db);
  const due = computeDue(todo, calls, now);
  const L = todo.map((o) => ({ o, d: due.get(o.id)! }));
  const forMe = (x: (typeof L)[number]) => !x.o.agentId || x.o.agentId === me;
  const mine = L.filter((x) => x.o.agentId === me);
  const late = mine.filter((x) => x.d.kind === 'missed').length;
  const nowN = mine.filter((x) => x.d.kind === 'now').length;
  const fresh = L.filter((x) => forMe(x) && (x.d.kind === 'first_late' || x.d.kind === 'first_due')).length;
  const night = L.filter((x) => forMe(x) && x.d.kind === 'first_next').length;
  const firstLate = L.filter((x) => forMe(x) && x.d.kind === 'first_late').length;
  const cands = L.filter((x) => forMe(x) && x.d.deadline && ['first_late', 'first_due', 'first_next', 'now', 'missed'].includes(x.d.kind)).sort((a, b) => {
    const A = a.d.deadline!.t;
    const B = b.d.deadline!.t;
    return Number(A < now) - Number(B < now) || (A < now ? B - A : A - B);
  });
  const sl = slotAt(now, calls);
  return {
    late,
    now: nowN,
    fresh,
    night,
    firstLate,
    slot: sl.open ? { key: sl.key, to: Math.round((sl.to - algiersDayStart(now)) / 3_600_000) } : null,
    nightFrom: calls.slots[0]?.from ?? 9,
    next: cands[0] ? { id: cands[0].o.id, ref: cands[0].o.ref, deadline: cands[0].d.deadline } : null,
  };
}

// ---------------------------------------------------------------- the procedures
export const confirmationProcs = {
  /** Shop name, WhatsApp template, call rules and the agents for the pickers. */
  'confirmation.meta': proc(['confirmation'], z.object({}), async (ctx) => {
    const [shop, calls, agents] = await Promise.all([
      getSetting(ctx.db, 'shop'),
      getSetting(ctx.db, 'calls'),
      ctx.db.query(`SELECT id, name FROM profiles WHERE active AND roles && '{confirmation,agent_manager,vendeur,admin}'::text[] ORDER BY name`),
    ]);
    return {
      shopName: shop.name,
      whatsappTemplate: shop.whatsappTemplate,
      calls,
      agents: agents.map((a: any) => ({ id: num(a.id), name: a.name as string })),
      manager: isManager(ctx),
    };
  }),

  /** Counts of the stage bar. */
  /** Column presets: everyone reads them; only an admin adds or deletes; a saved preset is never changed. */
  'confirmation.colPresets': proc(['confirmation'], z.object({}), async (ctx) => getSetting(ctx.db, 'colPresets')),
  'confirmation.addColPreset': proc(['confirmation'], z.object({ name: z.string().trim().min(1).max(40), cols: z.array(z.string().max(30)).min(1).max(40) }), async (ctx, i) => {
    if (!ctx.session.isAdmin) throw forbidden();
    const list = await getSetting(ctx.db, 'colPresets');
    if (list.some((p) => p.name.toLowerCase() === i.name.toLowerCase())) throw bad('Un préréglage porte déjà ce nom');
    if (list.length >= 30) throw bad('30 préréglages au maximum');
    const preset = { id: `p${ctx.now().toString(36)}`, name: i.name, cols: [...new Set(i.cols)], by: ctx.session.profile.name, at: new Date(ctx.now()).toISOString() };
    await setSetting(ctx.db, 'colPresets', [...list, preset], ctx.session.profile.id);
    return preset;
  }),
  'confirmation.deleteColPreset': proc(['confirmation'], z.object({ id: z.string().max(40) }), async (ctx, { id }) => {
    if (!ctx.session.isAdmin) throw forbidden();
    const list = await getSetting(ctx.db, 'colPresets');
    await setSetting(ctx.db, 'colPresets', list.filter((p) => p.id !== id), ctx.session.profile.id);
    return { ok: true };
  }),
  'confirmation.counts': proc(['confirmation'], z.object({}), async (ctx) => {
    const rows = await ctx.db.query(`SELECT conf_status AS k, count(*)::int AS n FROM sales GROUP BY 1`);
    const by = Object.fromEntries(rows.map((r: any) => [r.k, num(r.n)]));
    const sum = (s: readonly string[]) => s.reduce((t, k) => t + (by[k] ?? 0), 0);
    return { nouvelles: sum(CONF_SUBS.nouvelles), attente: sum(CONF_SUBS.attente), confirmees: sum(CONF_SUBS.confirmees), terminees: sum(CONF_SUBS.terminees) };
  }),

  /** One page of a confirmation list, with SKUs, creator and call deadline per row. */
  'confirmation.list': proc(['confirmation'], QueueInput, (ctx, i) => queueList(ctx, i)),

  /** Products for the open row: variants, packs, linked products, and the client delivery price of the order. */
  'confirmation.catalog': proc(['confirmation'], z.object({}), async (ctx) => {
    const P = await ctx.db.query('SELECT id, name, sku, price, fixed_price, packs, linked, is_service, fee_grid FROM products WHERE active ORDER BY name');
    const V = await ctx.db.query('SELECT id, product_id, title, sku, price FROM product_variants WHERE active ORDER BY id');
    return P.map((p: any) => ({
      id: num(p.id),
      name: p.name as string,
      sku: p.sku as string,
      price: num(p.price),
      fixedPrice: !!p.fixed_price,
      isService: !!p.is_service,
      feeGrid: (p.fee_grid as string | null) ?? null,
      packs: ((typeof p.packs === 'string' ? JSON.parse(p.packs) : p.packs) ?? []).map((x: any) => ({ qty: Number(x.qty), price: Number(x.price) })) as { qty: number; price: number }[],
      linked: ((p.linked ?? []) as unknown[]).map(num),
      variants: V.filter((v: any) => num(v.product_id) === num(p.id)).map((v: any) => ({ id: num(v.id), title: v.title as string, sku: v.sku as string, price: numOrNull(v.price) })),
    }));
  }),

  /** Delivery price from the client grid for this order's wilaya / delivery type / first product. */
  'confirmation.gridFee': proc(['confirmation'], z.object({ id }), async (ctx, { id }) => {
    const o = await getOrder(ctx, id);
    const grid = o.items[0] ? (await ctx.db.query('SELECT fee_grid FROM products WHERE id = $1', [o.items[0].productId]))[0]?.fee_grid : null;
    return { fee: await clientFee(ctx.db, o.wilayaId, o.isStopdesk, grid) };
  }),

  /** "Tentative 01/02/03": no answer, with the attempt number set. */
  'confirmation.setTry': proc(['confirmation'], z.object({ ids, n: z.number().int().min(1).max(9), note: z.string().max(1000).nullable().optional() }), async (ctx, i) => {
    const r = await setConf(ctx, ConfInput.parse({ ids: i.ids, status: 'no_answer', note: i.note ?? null }));
    await ctx.db.query(`UPDATE orders SET attempts = $2 WHERE id = ANY($1) AND conf_status = 'no_answer'`, [r.changed, i.n]);
    return r;
  }),

  /** Blacklists the customers of these orders ("Bloquer le client"). */
  'confirmation.block': proc(['confirmation'], z.object({ ids, reason: z.string().max(200).nullable().optional() }), async (ctx, i) => {
    const rows = await ctx.db.query('SELECT DISTINCT customer_id FROM sales WHERE id = ANY($1)', [i.ids]);
    const cids = rows.map((r: any) => num(r.customer_id));
    if (cids.length) await ctx.db.query('UPDATE customers SET blacklisted = true, blacklist_reason = COALESCE($2, blacklist_reason) WHERE id = ANY($1)', [cids, i.reason ?? null]);
    ctx.emit({ type: 'orders' });
    return { customers: cids.length };
  }),

  /** Gives back the order taken with orders.next (another agent can take it). */
  'confirmation.release': proc(['confirmation'], z.object({ id }), async (ctx, { id }) => {
    await ctx.db.query('UPDATE orders SET locked_by = NULL, locked_until = NULL WHERE id = $1 AND (locked_by = $2 OR $3)', [id, ctx.session.profile.id, ctx.session.isAdmin]);
    return { ok: true };
  }),

  /** Small numbers above the single-order mode. */
  'confirmation.mine': proc(['confirmation'], z.object({}), async (ctx) => {
    const me = ctx.session.profile.id;
    const day = isoT(algiersDayStart(ctx.now()));
    const r = (
      await ctx.db.query(
        `SELECT
           count(*) FILTER (WHERE conf_status = ANY($1) AND (next_call_at IS NULL OR next_call_at <= now()))::int AS due,
           count(*) FILTER (WHERE conf_status = ANY($1) AND next_call_at > now())::int AS later,
           count(*) FILTER (WHERE conf_status = 'confirmed' AND agent_id = $2 AND confirmed_at >= $3)::int AS confirmed
         FROM sales`,
        [CONF_TODO, me, day],
      )
    )[0];
    const canc = (
      await ctx.db.query(
        `SELECT count(DISTINCT order_id)::int AS n FROM order_events WHERE kind = 'conf_status' AND user_id = $1 AND to_value IN ('cancelled','fake','wrong_number') AND at >= $2`,
        [me, day],
      )
    )[0];
    return { due: num(r?.due), later: num(r?.later), confirmed: num(r?.confirmed), cancelled: num(canc?.n) };
  }),

  /** Late calls / night orders / current slot for the agent (banner on every page). */
  'confirmation.banner': proc(['confirmation'], z.object({}), (ctx) => banner(ctx)),

  // ---- statistics (managers)
  'confirmation.firstCall': proc([...MGR], KfInput, (ctx, i) => firstCall(ctx, i)),
  'confirmation.period': proc([...MGR], KfInput, (ctx, i) => periodNew(ctx, i)),
  'confirmation.delivery': proc([...MGR], KfInput.extend({ on: z.enum(['created', 'confirmed']).default('created') }), (ctx, i) => deliveryPerf(ctx, i)),
  'confirmation.enCours': proc([...MGR], KfInput, (ctx, i) => enCours(ctx, i)),
  'confirmation.confirmed': proc([...MGR], KfInput, (ctx, i) => confirmedKpis(ctx, i)),
};

