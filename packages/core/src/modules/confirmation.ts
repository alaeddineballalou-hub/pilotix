// Confirmation queue: lists with call deadlines, the agent banner, and the KPI blocks of
// Nouvelles / En cours / Confirmées. Order changes go through modules/orders.ts.
import { algiersDayStart, CallSettings, CLIENT_LEVELS, CONF_STATUSES, CONF_TODO, ConfStatus, LEVEL_RANK, messageTry, nextDue, Order, slotAt, wilayaAndOld } from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, isoOrNull, num, numOrNull } from '../db';
import { bad, Ctx, forbidden, hasRole, proc } from '../rpc';
import { getSetting, setSetting, type SettingsMap } from '../settings';
import { ConfInput, dueNowSql, getOrder, highestGridFee, holdOrder, lineGrids, ListInput, listOrders, setConf, teamMembers, triedSince, withClientScores } from './orders';
import { agencyLead, agencyOf, andSql, queueSql } from './agencyscope';
import { HAS_GUIDE } from './guide';
import { assignedProductIds } from './productscope';
import { readMontage } from './montage';
import { rotateTimes } from './assign';
import { CART_CAME, cartLeftOut, teamCountsSql } from './carts';
import { attackOf, AUTO_NO_ANSWER, CONFIRMED_LIKE, type Lead, leadOf } from './leadkind';
import { reasonCode } from './pilotlearn';
import { checkRules } from './pilotchecks';
import { blackNumbers, shareBlacklist } from './sharedblacklist';
import { withNewWilayas } from '../newwilayas';
import { agencyNames, confirmationAgencies } from './agencies';

// ---------------------------------------------------------------- sub-pages
export const CONF_SUBS = {
  nouvelles: ['new'],
  attente: ['to_check', 'no_answer', 'busy', 'callback', 'postponed'],
  confirmees: ['confirmed', 'no_stock'],
  terminees: ['duplicate', 'wrong_number', 'fake'],
  /** the agent's confirmed orders that reached the customer (admin and managers see the whole team's) */
  livrees: ['confirmed'],
} as const satisfies Record<string, readonly ConfStatus[]>;
export type ConfSub = keyof typeof CONF_SUBS;
const SUB = z.enum(['nouvelles', 'attente', 'confirmees', 'terminees', 'livrees']);
/** « Confirmées »: the confirmed orders their delivery company does not have yet, with where each one is (the owner's ask,
 *  25 Nov 2026): not in the dépôt yet (sans stock), « À préparer », « En dispatch », « Dispatchées » (handed over, not
 *  taken yet). An agent can still cancel the ones not sent; the dépôt is alerted for a printed label. Once the company has
 *  the parcel (taken_at) it leaves this list: it is in Commandes › En livraison. */
const NOT_SENT = ['none', 'to_prepare', 'prepared', 'shipped'] as const;
const NOT_SENT_SQL = "(follow_status IS NULL OR follow_status IN ('to_prepare', 'prepared') OR (follow_status = 'shipped' AND taken_at IS NULL))";
/** Confirmées' stages, the Dépôt's words: sans stock › en préparation › en dispatch › dispatchées */
export const CONF_STAGES = ['nostock', 'preparer', 'prepares', 'dispatchees'] as const;
export type ConfStage = (typeof CONF_STAGES)[number];
const STAGE_WHERE: Record<ConfStage, { conf?: ConfStatus[]; follow: ('none' | 'to_prepare' | 'prepared' | 'shipped')[] }> = {
  nostock: { conf: ['no_stock'], follow: ['none'] },
  preparer: { conf: ['confirmed'], follow: ['to_prepare'] },
  prepares: { follow: ['prepared'] },
  dispatchees: { follow: ['shipped'] },
};
const id = z.number().int().positive();
const ids = z.array(id).min(1).max(500);
const MIN = 60_000;
const DAY = 86_400_000;

/** Managers see the team: statistics, assign / remove agents. */
export const isManager = (ctx: Ctx) => hasRole(ctx.session, 'agent_manager', 'vendeur');

/**
 * Who saves, deletes and puts in use the column presets of his team: a store's administrator, for the store's team; in
 * a confirmation agency's own space, its chief and its chefs d'équipe, for the agency's team only, in every seller and
 * in « Tous les vendeurs » (owner's choice, 25 Nov 2026). Inside a seller's store an agency's people stay agents: the
 * store's presets are the store's team's, never theirs to change.
 */
export const presetLead = (ctx: Ctx) => ctx.session.isAdmin || (ctx.shop?.kind === 'agency' && hasRole(ctx.session, 'agent_manager'));

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

/** The orders still to call (`queue`: only one person's work queue, see queueSql). */
async function loadTodo(db: Db, queue = ''): Promise<TodoRow[]> {
  const rows = await db.query(
    `SELECT id, ref, customer_name, agent_id, created_at, assigned_at, attempts, next_call_at, last_call_at, conf_status
       FROM sales o WHERE conf_status = ANY($1)${andSql(queue)}`,
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
/**
 * « Date de changement de statut » (the owner's rule, 27 Nov 2026): the day an order's CONFIRMATION status changed —
 * never its last change of any kind (updated_at moves when the depot or the courier touches the order: an order
 * delivered today was counted as confirmed today). « Date de création »: the day it came in. `alias`: the orders row.
 */
const periodSql = (basis: KfInput['basis'], alias: string) =>
  basis === 'updated'
    ? `EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = ${alias}.id AND e.kind = 'conf_status' AND e.at >= $1 AND e.at < $2)`
    : `${alias}.created_at >= $1 AND ${alias}.created_at < $2`;
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
  /** when it goes to another agent if nobody acts (Affectation › rotation), ms; null: it will not move */
  rotateAt: number | null;
  /** its last call was « Occupé » (En cours says « Occupé » next to its tries) */
  lastBusy: boolean;
  /**
   * its shop's « annuler après N tentatives » (En cours' dots), on each row: in « Tous les vendeurs » and « Toutes les
   * boutiques » the rows of several shops are in one list, each with its own number (null: not a queue list)
   */
  tries: number | null;
}

const QueueInput = z.object({
  sub: SUB,
  status: z.enum(CONF_STATUSES).optional(),
  /** Confirmées: one stage only (where the order is in the dépôt) */
  stage: z.enum(CONF_STAGES).optional(),
  q: z.string().max(100).optional(),
  wilayaId: z.number().int().min(1).max(69).optional(),
  agentId: z.union([id, z.literal('none'), z.literal('any')]).optional(),
  /** the managers' « Toutes / Non affectées / Affectées » (Nouvelles, En cours): no agent yet, or given to one */
  assigned: z.enum(['free', 'given']).optional(),
  /** one of the counters over the list (QUEUE_BUCKETS): only those orders */
  bucket: z.enum(['late', 'soon', 'ontime', 'now', 'later', 'postponed']).optional(),
  /** a team from the settings: its manager and its agents */
  teamId: z.string().max(40).optional(),
  productId: id.optional(),
  variantId: id.optional(),
  channel: ListInput.shape.channel,
  from: DATE.optional(),
  to: DATE.optional(),
  /** the customer's score level (Top / Bon / À surveiller / Risqué / Nouveau) */
  level: z.enum(CLIENT_LEVELS).optional(),
  /** deadline: the call countdown (most urgent first), only for Nouvelles and En cours · score: the best customers first
   *  (desc: a customer we know is good, then a new one, then the ones to watch; the countdown decides between equals) */
  sort: z.enum(['created_at', 'confirmed_at', 'next_call_at', 'total', 'customer_name', 'deadline', 'score']).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(3000).default(50),
});

export const DEFAULT_SORT: Record<ConfSub, { sort: 'created_at' | 'confirmed_at' | 'next_call_at' | 'deadline'; dir: 'asc' | 'desc' }> = {
  nouvelles: { sort: 'deadline', dir: 'asc' },
  attente: { sort: 'deadline', dir: 'asc' },
  confirmees: { sort: 'confirmed_at', dir: 'desc' },
  terminees: { sort: 'created_at', dir: 'desc' },
  livrees: { sort: 'confirmed_at', dir: 'desc' },
};

// ---------------------------------------------------------------- the counters over the lists
/**
 * The counters at the top of Nouvelles and En cours (the owner's design, 25 Nov 2026); each is a filter too.
 * - Nouvelles: « En retard » (its first call is past due: the row's chrono shows + in red, the banner's « en retard »),
 *   « À appeler vite » (due in the next 30 minutes), « À temps » (later, or the next call slot).
 * - En cours: « Reportées » (the customer asked for another day), « Plus tard » (a time to come: a callback, the next
 *   slot), « À rappeler » (due now or late, a missed try too).
 */
export const QUEUE_BUCKETS = { nouvelles: ['late', 'soon', 'ontime'], attente: ['now', 'later', 'postponed'] } as const;
export type QueueBucket = (typeof QUEUE_BUCKETS)[keyof typeof QUEUE_BUCKETS][number];
const SOON = 30 * MIN;
export function bucketOf(sub: 'nouvelles' | 'attente', o: { confStatus: string }, d: DueInfo | undefined, now: number): QueueBucket {
  if (sub === 'nouvelles') {
    const dl = d?.deadline;
    // 'start': the clock starts at a later slot (nothing to do before)
    if (!dl || dl.m === 'start') return 'ontime';
    if (dl.t < now) return 'late';
    return dl.t - now <= SOON ? 'soon' : 'ontime';
  }
  if (o.confStatus === 'postponed') return 'postponed';
  return d && (d.kind === 'later' || d.kind === 'first_next') ? 'later' : 'now';
}

/** The people of a team (its manager and agents); an unknown team matches nobody. */
const teamAgents = (ctx: Ctx, teamId: string) => teamMembers(ctx.db, teamId);

async function queueList(ctx: Ctx, i: z.infer<typeof QueueInput>) {
  const allowed = CONF_SUBS[i.sub] as readonly ConfStatus[];
  if (i.status && !allowed.includes(i.status)) throw bad('Statut hors de cette liste');
  const def = DEFAULT_SORT[i.sub];
  const day = (s: string) => Date.parse(s + 'T00:00:00Z') - 3_600_000;
  const queue = i.sub === 'nouvelles' || i.sub === 'attente';
  let sort = i.sort ?? def.sort;
  if (sort === 'deadline' && !queue) sort = 'created_at';
  const byDeadline = sort === 'deadline';
  const byScore = sort === 'score';
  const dir = i.dir ?? (i.sort ? (i.sort === 'total' || i.sort === 'score' ? 'desc' : 'asc') : def.dir);
  // « Toutes / Non affectées / Affectées » (the owner's ask, 25 Nov 2026): the managers' switch in Nouvelles and En
  // cours — the owner, the agent managers, a confirmation agency's chiefs; never a plain agent (he has his own orders)
  const split = queue && (ctx.session.isAdmin || isManager(ctx) || agencyLead(ctx));
  // sorted or filtered by something the database does not hold (the countdown, the score), or split in two: the whole
  // list (3000 at most), sorted here, then the page cut
  // (Nouvelles and En cours: always, their counters count the whole list)
  const whole = queue || byDeadline || byScore || !!i.level || split || !!i.assigned;
  const base = byDeadline || byScore ? (queue ? 'deadline' : def.sort === 'deadline' ? 'created_at' : def.sort) : sort;
  const stage = i.sub === 'confirmees' && i.stage ? STAGE_WHERE[i.stage] : null;
  const conf = (i.status ? [i.status] : [...allowed]).filter((s) => !stage?.conf || stage.conf.includes(s));
  // (a status and a stage that never meet: « Confirmée » and « Sans stock »)
  if (!conf.length) return { rows: [] as QueueRow[], total: 0, page: i.page, pageSize: i.pageSize, assign: null, buckets: null, tries: null };
  const found = await listOrders(ctx, {
    conf,
    follow: i.sub === 'livrees' ? ['delivered'] : stage ? stage.follow : i.sub === 'confirmees' ? [...NOT_SENT] : undefined,
    // Confirmées: until the delivery company has the parcel
    taken: i.sub === 'confirmees' ? false : undefined,
    q: i.q,
    wilayaId: i.wilayaId,
    agentId: i.sub === 'livrees' && !ctx.session.isAdmin && !isManager(ctx) && !agencyLead(ctx) ? ctx.session.profile.id : i.agentId,
    agentIds: i.teamId ? await teamAgents(ctx, i.teamId) : undefined,
    productId: i.productId,
    variantId: i.variantId,
    channel: i.channel,
    dateField: 'created_at',
    from: i.from ? isoT(day(i.from)) : undefined,
    to: i.to ? isoT(day(i.to) + DAY) : undefined,
    sort: base === 'deadline' ? 'created_at' : (base as Exclude<typeof sort, 'deadline' | 'score'>),
    dir: base === 'deadline' ? 'asc' : byScore ? def.dir : dir,
    page: whole ? 1 : i.page,
    pageSize: whole ? 3000 : i.pageSize,
  }, { queue: 'conf' });
  let due = new Map<number, DueInfo>();
  /** the shop's « annuler après N tentatives » (the dots of En cours) */
  let tries: number | null = null;
  if (queue) {
    const calls = await getSetting(ctx.db, 'calls');
    tries = calls.tries;
    due = computeDue(await loadTodo(ctx.db, queueSql(ctx, 'conf')), calls, ctx.now());
  }
  let page = found;
  let scoredAll = false;
  /** the switch's numbers: orders of this list (its search and filters) with no agent yet / given to one */
  let assign: { free: number; given: number } | null = null;
  /** the counters over the list (its search, filters and switch), before one of them filters it */
  let buckets: Partial<Record<QueueBucket, number>> | null = null;
  if (whole) {
    let all = [...found.rows];
    if (base === 'deadline') {
      // the countdown that shows: a waiting order counts from the end of its first slot
      const key = (id: number) => {
        const d = due.get(id)?.deadline;
        return d ? (d.m === 'start' ? d.e ?? d.t : d.t) : Number.POSITIVE_INFINITY;
      };
      all.sort((a, b) => (key(a.id) - key(b.id)) * (byDeadline && dir === 'desc' ? -1 : 1) || a.id - b.id);
    }
    if (byScore || i.level) {
      all = await withClientScores(ctx, all);
      scoredAll = true;
      // a customer with no score here (a livreur's own view) is « nouveau »
      const lv = (o: Order) => o.clientScore?.level ?? 'new';
      if (i.level) all = all.filter((o) => lv(o) === i.level);
      if (byScore) {
        const rank = (o: Order) => LEVEL_RANK[lv(o)] * 1000 + (o.clientScore?.score ?? 60);
        // stable: between equals the countdown (or the list's own order) decides
        all = all.map((o, k) => ({ o, k })).sort((a, b) => (rank(b.o) - rank(a.o)) * (dir === 'asc' ? -1 : 1) || a.k - b.k).map((x) => x.o);
      }
    }
    if (split) assign = { free: all.filter((o) => !o.agentId).length, given: all.filter((o) => !!o.agentId).length };
    if (i.assigned) all = all.filter((o) => (i.assigned === 'free' ? !o.agentId : !!o.agentId));
    if (i.sub === 'nouvelles' || i.sub === 'attente') {
      const sub = i.sub;
      const now = ctx.now();
      const of = new Map(all.map((o) => [o.id, bucketOf(sub, o, due.get(o.id), now)] as const));
      buckets = Object.fromEntries(QUEUE_BUCKETS[sub].map((k) => [k, 0]));
      for (const k of of.values()) buckets[k] = (buckets[k] ?? 0) + 1;
      if (i.bucket) all = all.filter((o) => of.get(o.id) === i.bucket);
    }
    page = { ...found, total: i.level || i.assigned || i.bucket ? all.length : found.total, page: i.page, pageSize: i.pageSize, rows: all.slice((i.page - 1) * i.pageSize, i.page * i.pageSize) };
  }
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
  /** the last call was « Occupé » (an action since 25 Nov 2026: the order stays « Tentative 0N », its line says « Occupé ») */
  const busyLast = new Set<number>();
  if (oids.length) {
    // (a « Tentative » made by « Occupé » shows « Occupé », one made by « Rappel » « À rappeler »: orders.ts › setConf)
    for (const r of await ctx.db.query(
      `SELECT order_id, array_agg(CASE WHEN data->>'busy' = 'true' THEN 'busy' WHEN data->>'callback' IS NOT NULL THEN 'callback' ELSE to_value END ORDER BY at, id) AS v
         FROM order_events WHERE kind = 'conf_status' AND order_id = ANY($1) GROUP BY 1`,
      [oids],
    )) {
      const v: string[] = (Array.isArray(r.v) ? r.v : String(r.v ?? '').replace(/[{}]/g, '').split(',')).filter(Boolean);
      passedOf.set(num(r.order_id), v.filter((x, k) => k === 0 || v[k - 1] !== x));
    }
    for (const r of await ctx.db.query(
      `SELECT DISTINCT ON (order_id) order_id, kind, to_value, data->>'busy' AS busy FROM order_events
        WHERE order_id = ANY($1) AND (kind = 'conf_status' OR (kind = 'call' AND to_value = 'busy')) ORDER BY order_id, at DESC, id DESC`,
      [oids],
    ))
      if (r.kind === 'call' || r.busy === 'true' || r.to_value === 'busy') busyLast.add(num(r.order_id));
  }
  const scored = scoredAll ? page.rows : await withClientScores(ctx, page.rows);
  const rot = queue ? await rotateTimes(ctx, 'conf', oids) : new Map<number, number>();
  const rows: QueueRow[] = scored.map((o) => ({
    ...o,
    skus: [...new Set(o.items.map((it) => (it.variantId ? skuOf.get(it.variantId) : undefined)).filter((s): s is string => !!s))],
    creatorName: o.createdBy ? who.get(o.createdBy) ?? null : null,
    deadline: due.get(o.id)?.deadline ?? null,
    dueKind: due.get(o.id)?.kind ?? null,
    stock: o.items.some((it) => it.variantId) ? (o.items.every((it) => !it.variantId || (stockOf.get(it.variantId) ?? 0) >= it.qty) ? 'ok' : 'short') : null,
    passed: passedOf.get(o.id) ?? [],
    rotateAt: rot.get(o.id) ?? null,
    lastBusy: busyLast.has(o.id),
    tries,
  }));
  return { ...page, rows, assign, buckets, tries };
}

// ---------------------------------------------------------------- KPI blocks
/**
 * What « Statistiques » count: the same orders as the person's lists (owner's choice, 27 Nov 2026 — Confirmation in three
 * views). The Super admin view (the owner, the administrators): every order of the shop; the Admin view (an agent
 * manager): his team's and the ones no agent has yet, never another manager's team (82 in the numbers and 50 in his list
 * before). `alias`: the table's name or alias in the query ('sales' when it has none).
 */
const statsSql = (ctx: Ctx, alias: string) => andSql(queueSql(ctx, 'conf', alias));

async function firstCall(ctx: Ctx, i: KfInput) {
  const now = ctx.now();
  const calls = await getSetting(ctx.db, 'calls');
  const R = kfRange(now, i);
  const made = await ctx.db.query(
    `SELECT id, ref, customer_name, created_at, assigned_at, agent_id, conf_status FROM sales
      WHERE ((created_at >= $1 AND created_at < $2) OR conf_status IN ('new','to_check'))${statsSql(ctx, 'sales')}`,
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
  const todo = await loadTodo(ctx.db, queueSql(ctx, 'conf'));
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

// ---------------------------------------------------------------- Nouvelles › Statistiques (27 Nov 2026)
/** A first call that found the client: he answered (confirmed, said no, asked to postpone, out of stock, « never ordered »). */
const REACHED_FIRST = ['confirmed', 'cancelled', 'postponed', 'no_stock', 'fake'];
/** First changes that are not a call: an order put back to « Nouvelle » / « À vérifier », or marked as a duplicate. */
const NOT_A_CALL = ['new', 'to_check', 'duplicate'];
export interface NvSum {
  /** orders that came in (duplicates left out) */
  received: number;
  /** first calls made */
  called: number;
  under5: number;
  onTime: number;
  /** minutes, the middle value (null: no call) */
  median: number | null;
  /** first calls where the client answered */
  reached: number;
  /** first calls that confirmed the order */
  converted: number;
}
export interface NvAgent extends Omit<NvSum, 'received'> {
  id: number;
  name: string;
  /** his orders waiting for their first call past the deadline, now */
  late: number;
}
export interface NvTeam extends NvSum {
  key: string;
  /** 'none': what no team has (orders with no agent yet, people in no team) */
  kind: 'team' | 'agency' | 'none';
  name: string;
  /** agents who made a first call today (null: an agency — its agents stay private) */
  agents: number | null;
  late: number;
  /** orders waiting for a first call that no agent has yet (null: a team of the store — those orders belong to no team) */
  unassigned: number | null;
}

type Teams = SettingsMap['teams'];
/**
 * A team the director (the store's owner, an administrator) opened from his teams table: what its manager sees in his
 * lists (confSeeSql) — his agents' orders and the ones no agent has yet. No team opened: everything in view.
 */
function teamView(T: Teams, key: string | undefined) {
  const opened = key ? T.find((t) => `t${t.id}` === key) ?? null : null;
  const membersOf = (t: Teams[number]) => new Set<number>([...(t.managerId ? [t.managerId] : []), ...t.agentIds]);
  const mine = opened ? membersOf(opened) : null;
  const inView = (agentId: number | null, _agencyId: number | null) => !mine || agentId === null || mine.has(agentId);
  return { opened, membersOf, inView };
}

/**
 * Nouvelles › Statistiques, as the owner's sketches (27 Nov 2026, « Agent manager view » and « Teams director view »):
 * today only, live, no filters. The first calls made today (by status change) and the orders that came in today; the
 * same numbers yesterday at the same hour (the arrows); what waits right now; one line per agent. The store's owner and
 * administrators get all the teams together and each team side by side — his own teams, and each confirmation agency as
 * one line whose agents stay private — and the load per agent; `team` (one of his teams): that team's manager view.
 */
async function nouvellesStats(ctx: Ctx, i: { team?: string } = {}) {
  const now = ctx.now();
  const calls = await getSetting(ctx.db, 'calls');
  const day = algiersDayStart(now);
  const director = (ctx.session.isAdmin || ctx.session.roles.includes('vendeur')) && agencyOf(ctx) === null;
  const T = director ? await getSetting(ctx.db, 'teams') : [];
  const { opened, membersOf, inView } = teamView(T, director ? i.team : undefined);
  const rows = await ctx.db.query(
    `SELECT id, created_at, assigned_at, agent_id, conf_status, conf_agency_id FROM sales
      WHERE (created_at >= $1 OR conf_status IN ('new','to_check'))${statsSql(ctx, 'sales')}`,
    [isoT(day - 3 * DAY)],
  );
  const all = rows
    .map((r: any) => {
      const created = Date.parse(iso(r.created_at));
      const assigned = r.agent_id && r.assigned_at ? Date.parse(iso(r.assigned_at)) : null;
      const r0 = assigned && assigned > created ? assigned : created;
      return { id: num(r.id), agentId: numOrNull(r.agent_id), agencyId: numOrNull(r.conf_agency_id), created, r: r0, s: workStart(r0, calls), status: r.conf_status as ConfStatus };
    })
    .filter((o) => inView(o.agentId, o.agencyId));
  const agencyOfOrder = new Map(all.map((o) => [o.id, o.agencyId]));
  // each order's first call: the first change of its confirmation status made by a person (not a duplicate mark)
  const first = new Map<number, { at: number; by: number; to: string }>();
  const idList = all.map((o) => o.id);
  for (let k = 0; k < idList.length; k += 1000) {
    const ev = await ctx.db.query(
      `SELECT DISTINCT ON (order_id) order_id, at, user_id, to_value FROM order_events
        WHERE kind = 'conf_status' AND user_id IS NOT NULL AND order_id = ANY($1) AND NOT (to_value = ANY($2)) ORDER BY order_id, at`,
      [idList.slice(k, k + 1000), NOT_A_CALL],
    );
    for (const e of ev) first.set(num(e.order_id), { at: Date.parse(iso(e.at)), by: num(e.user_id), to: String(e.to_value ?? '') });
  }
  type Call = { at: number; by: number; d: number; ok: boolean; reached: boolean; converted: boolean; agencyId: number | null };
  const made: Call[] = [];
  const groups = new Map<string, typeof all>();
  for (const o of all) {
    const g = String(o.agentId ?? '');
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(o);
  }
  for (const g of groups.values())
    for (const x of g) {
      const f = first.get(x.id);
      if (!f) continue;
      // on time: within the first-call minutes, + the pace for each newer order called before it (as « Appel à temps »)
      const newer = g.filter((y) => y.r > x.r && y.s <= f.at).length;
      const due = Math.min(x.s + (calls.firstMinutes + newer * calls.paceMinutes) * MIN, x.s + DAY);
      made.push({ at: f.at, by: f.by, d: Math.max(0, (f.at - x.s) / MIN), ok: f.at <= due, reached: REACHED_FIRST.includes(f.to), converted: f.to === 'confirmed', agencyId: x.agencyId });
    }
  type Ord = (typeof all)[number];
  const W0 = { a: day, b: now + 1 };
  const W1 = { a: day - DAY, b: now - DAY + 1 };
  const sumOf = (cs: Call[], received: number): NvSum => {
    const ds = cs.map((c) => c.d);
    return {
      received,
      called: cs.length,
      under5: ds.filter((d) => d <= 5).length,
      onTime: cs.filter((c) => c.ok).length,
      median: median(ds),
      reached: cs.filter((c) => c.reached).length,
      converted: cs.filter((c) => c.converted).length,
    };
  };
  const inW = (w: { a: number; b: number }, t: number) => t >= w.a && t < w.b;
  const newIn = (w: { a: number; b: number }, keepO: (o: Ord) => boolean = () => true) => all.filter((o) => inW(w, o.created) && o.status !== 'duplicate' && keepO(o)).length;
  const sum = (w: { a: number; b: number }) => sumOf(made.filter((c) => inW(w, c.at)), newIn(w));
  // what waits right now (the orders never called yet)
  const todo = await loadTodo(ctx.db, queueSql(ctx, 'conf'));
  const waitingRows = todo.filter((o) => (o.status === 'new' || o.status === 'to_check') && o.attempts === 0 && !o.nextCallAt && !first.has(o.id));
  const dueW = computeDue(waitingRows, calls, now);
  const waiting = waitingRows
    .map((o) => ({ agentId: o.agentId, agencyId: agencyOfOrder.get(o.id) ?? null, late: now > (dueW.get(o.id)!.at ?? o.start) }))
    .filter((w) => inView(w.agentId, w.agencyId));
  const live = { waiting: waiting.length, late: waiting.filter((w) => w.late).length, noAgent: waiting.filter((w) => w.agentId === null).length };
  // one line per agent: the store's own agents (an agency's agents stay private: never a line here)
  const who = await names(ctx.db);
  const today = made.filter((c) => inW(W0, c.at) && c.agencyId === null);
  const ids = new Set<number>([...today.map((c) => c.by), ...waiting.filter((w) => w.late && w.agentId !== null && w.agencyId === null).map((w) => w.agentId!)]);
  const agents: NvAgent[] = [...ids]
    .map((id) => {
      const x = sumOf(today.filter((c) => c.by === id), 0);
      return { id, name: who.get(id) ?? '—', called: x.called, under5: x.under5, onTime: x.onTime, median: x.median, reached: x.reached, converted: x.converted, late: waiting.filter((w) => w.late && w.agentId === id).length };
    })
    .sort((a, b) => b.called - a.called || a.name.localeCompare(b.name));
  // the store's owner and administrators (not inside one of his teams): each team side by side, the load per agent
  const dir = director && !opened;
  let teams: NvTeam[] | null = null;
  let allTeams: NvTeam | null = null;
  let perAgent: { orders: number; agents: number } | null = null;
  let perAgentPrev: { orders: number; agents: number } | null = null;
  if (dir) {
    // the load: the store's own new orders ÷ its agents who made a first call (now, and yesterday at the same hour)
    const load = (w: { a: number; b: number }) => ({
      orders: newIn(w, (o) => o.agencyId === null),
      agents: new Set(made.filter((c) => inW(w, c.at) && c.agencyId === null).map((c) => c.by)).size,
    });
    perAgent = load(W0);
    perAgentPrev = load(W1);
    const own = new Set(today.map((c) => c.by));
    const A = await agencyNames(ctx);
    const built = [
      ...T.map((t) => {
        const m = membersOf(t);
        const cs = made.filter((c) => inW(W0, c.at) && c.agencyId === null && m.has(c.by));
        const row: NvTeam = {
          key: `t${t.id}`,
          kind: 'team',
          name: t.name,
          ...sumOf(cs, newIn(W0, (o) => o.agencyId === null && o.agentId !== null && m.has(o.agentId))),
          agents: [...own].filter((id) => m.has(id)).length,
          late: waiting.filter((w) => w.late && w.agencyId === null && w.agentId !== null && m.has(w.agentId)).length,
          unassigned: null,
        };
        return { row, cs };
      }),
      ...A.map((a) => {
        const cs = made.filter((c) => inW(W0, c.at) && c.agencyId === a.id);
        const row: NvTeam = {
          key: `a${a.id}`,
          kind: 'agency',
          name: a.name,
          ...sumOf(cs, newIn(W0, (o) => o.agencyId === a.id)),
          agents: null,
          late: waiting.filter((w) => w.late && w.agencyId === a.id).length,
          unassigned: waiting.filter((w) => w.agencyId === a.id && w.agentId === null).length,
        };
        return { row, cs };
      }),
    ].filter((x) => x.row.kind === 'team' || x.row.received || x.row.called);
    // what no team has: the orders no agent has yet, the people in no team — one line, so the lines add up to the cards
    const inTeams = new Set<number>(T.flatMap((t) => [...membersOf(t)]));
    const restCs = made.filter((c) => inW(W0, c.at) && c.agencyId === null && !inTeams.has(c.by));
    const restRec = newIn(W0, (o) => o.agencyId === null && (o.agentId === null || !inTeams.has(o.agentId)));
    const restWait = waiting.filter((w) => w.agencyId === null && (w.agentId === null || !inTeams.has(w.agentId)));
    if (restCs.length || restRec || restWait.length)
      built.push({
        row: { key: 'none', kind: 'none', name: '', ...sumOf(restCs, restRec), agents: [...own].filter((x) => !inTeams.has(x)).length, late: restWait.filter((w) => w.late).length, unassigned: restWait.filter((w) => w.agentId === null).length },
        cs: restCs,
      });
    teams = built.map((x) => x.row);
    // « Toutes les équipes »: the lines above added up (every call once), never an average of the teams
    const union = [...new Set(built.flatMap((x) => x.cs))];
    allTeams = {
      key: 'all',
      kind: 'team',
      name: '',
      ...sumOf(union, teams.reduce((s, r) => s + r.received, 0)),
      agents: teams.reduce((s, r) => s + (r.agents ?? 0), 0),
      late: teams.reduce((s, r) => s + r.late, 0),
      unassigned: live.noAgent,
    };
  }
  return {
    firstMinutes: calls.firstMinutes,
    today: sum(W0),
    prev: sum(W1),
    live,
    agents,
    /** the agent table's « Équipe » line: every call of those agents added up (an agency's calls are not in it) */
    agentsTotal: sumOf(today, 0),
    director: dir,
    /** the team the director opened (its manager view), or null */
    team: opened ? { key: `t${opened.id}`, name: opened.name } : null,
    perAgent,
    perAgentPrev,
    teams,
    allTeams,
  };
}

// ---------------------------------------------------------------- En cours › Statistiques (27 Nov 2026)
/** The confirmation statuses of the « En cours » tab: an order called once already, waiting for another call. */
const EN_COURS = CONF_SUBS.attente as readonly string[];
/** How an order leaves En cours: confirmed (also « sans stock »), cancelled, a fake, a wrong number. */
const EC_CLOSED = ['confirmed', 'no_stock', 'cancelled', 'fake', 'wrong_number'];
/** A call back (« Rappel », « Reportée ») is on time until 30 minutes after the time picked: the list's call window. */
const CALLBACK_WINDOW = 30 * MIN;
const HOUR = 60 * MIN;
/** Closed without ever reaching the client: cancelled after the tries with no answer (or « injoignable »), a wrong number. */
const neverReached = (to: string, note: string | null) =>
  to === 'wrong_number' || (to === 'cancelled' && (AUTO_NO_ANSWER.test(note ?? '') || reasonCode(note) === 'unreachable' || /^\s*(pas de r[ée]ponse|no answer)/i.test(note ?? '')));
/** The call slot after the one `t` is in: when the next try of an unanswered call is due, and until when. */
function nextSlot(t: number, s: CallSettings): { at: number; end: number } {
  const cur = slotAt(t, s);
  const from = cur.open ? cur.to : cur.from;
  const nx = slotAt(from, s);
  const at = nx.open ? from : nx.from;
  return { at, end: slotAt(at, s).to };
}

export interface EcSum {
  /** calls made on orders already called once (the call backs) */
  calls: number;
  /** of those, made in time: before the call-back time + 30 min, or within the call slot after an unanswered try */
  onTime: number;
  /** orders closed in En cours: confirmed, the client said no (both reached), never reached */
  confirmed: number;
  saidNo: number;
  never: number;
  /** calls made until the client answered, added up over the orders reached (÷ reached = the average) */
  tries: number;
}
export interface EcAgent extends EcSum {
  id: number;
  name: string;
  /** his En cours orders whose call back is late, now */
  late: number;
}
export interface EcTeam extends EcSum {
  key: string;
  /** 'none': what no team has (orders with no agent, people in no team) */
  kind: 'team' | 'agency' | 'none';
  name: string;
  /** agents who made a call today (null: an agency — its agents stay private) */
  agents: number | null;
  inProgress: number;
  late: number;
}

/**
 * En cours › Statistiques, as the owner's sketches (27 Nov 2026, « Agent manager view — En cours » and « Teams director
 * view — En cours »): today only, live, no filters. The job of En cours is to reach the client (he can say no at the 2nd
 * call): the call backs made today and how many on time, how the orders closed today ended (confirmed, said no, never
 * reached) and the calls it took to reach the client; the same yesterday at the same hour (the arrows); what is in
 * progress right now; one line per agent — or, for the store's owner and administrators, one line per team (an agency
 * is one line, its agents private) and the load per agent; `team`: that team's manager view.
 */
async function enCoursStats(ctx: Ctx, i: { team?: string } = {}) {
  const now = ctx.now();
  const calls = await getSetting(ctx.db, 'calls');
  const day = algiersDayStart(now);
  const director = (ctx.session.isAdmin || ctx.session.roles.includes('vendeur')) && agencyOf(ctx) === null;
  const T = director ? await getSetting(ctx.db, 'teams') : [];
  const { opened, membersOf, inView } = teamView(T, director ? i.team : undefined);
  // the orders with a call or a change of their confirmation since yesterday, and each one's whole call history
  const touched = (
    await ctx.db.query(
      `SELECT DISTINCT o.id, o.agent_id, o.conf_agency_id, o.came FROM order_events e JOIN sales o ON o.id = e.order_id
        WHERE e.at >= $1 AND (e.kind = 'conf_status' OR (e.kind = 'call' AND e.to_value = 'busy'))${statsSql(ctx, 'o')}`,
      [isoT(day - DAY)],
    )
  )
    .map((r: any) => ({ id: num(r.id), agentId: numOrNull(r.agent_id), agencyId: numOrNull(r.conf_agency_id), came: (r.came ?? null) as string | null }))
    .filter((o) => inView(o.agentId, o.agencyId));
  type Ev = { at: number; by: number | null; kind: string; from: string | null; to: string; note: string | null; data: any };
  const hist = new Map<number, Ev[]>();
  const idList = touched.map((o) => o.id);
  for (let k = 0; k < idList.length; k += 1000) {
    const ev = await ctx.db.query(
      `SELECT order_id, at, user_id, kind, from_value, to_value, note, data FROM order_events
        WHERE order_id = ANY($1) AND (kind = 'conf_status' OR (kind = 'call' AND to_value = 'busy')) ORDER BY order_id, at, id`,
      [idList.slice(k, k + 1000)],
    );
    for (const e of ev) {
      const id = num(e.order_id);
      if (!hist.has(id)) hist.set(id, []);
      hist.get(id)!.push({ at: Date.parse(iso(e.at)), by: numOrNull(e.user_id), kind: String(e.kind), from: e.from_value ?? null, to: String(e.to_value ?? ''), note: e.note ?? null, data: e.data ?? null });
    }
  }
  // a call: a person's change of the confirmation (not a reset to « Nouvelle », not a duplicate mark), or « Occupé »
  const isCall = (e: Ev) => e.by !== null && (e.kind === 'call' || !NOT_A_CALL.includes(e.to));
  type Back = { at: number; by: number; ok: boolean; agencyId: number | null };
  type Close = { id: number; at: number; agentId: number | null; agencyId: number | null; how: 'confirmed' | 'saidNo' | 'never'; tries: number };
  const backs: Back[] = [];
  const closes: Close[] = [];
  const anyCall: { at: number; by: number; agencyId: number | null }[] = [];
  for (const o of touched) {
    const evs = hist.get(o.id) ?? [];
    const cl = evs.filter(isCall);
    cl.forEach((c, k) => {
      anyCall.push({ at: c.at, by: c.by!, agencyId: o.agencyId });
      // the first call is Nouvelles'; a change made on an order that was not in En cours is not a call back
      if (k === 0 || (c.kind === 'conf_status' && !EN_COURS.includes(c.from ?? ''))) return;
      // when it was due: the call-back time it had (+30 min), else within the call slot after the last call
      const nca: string | null = c.kind === 'conf_status' && c.data && 'nca' in c.data ? c.data.nca : cl[k - 1].data?.callback ?? null;
      const end = nca ? Date.parse(nca) + CALLBACK_WINDOW : nextSlot(cl[k - 1].at, calls).end;
      backs.push({ at: c.at, by: c.by!, ok: c.at <= end, agencyId: o.agencyId });
    });
    for (const e of evs) {
      // (an abandoned cart counts in the team's numbers only once confirmed: carts.ts)
      if (e.kind !== 'conf_status' || !EN_COURS.includes(e.from ?? '') || !EC_CLOSED.includes(e.to) || cartLeftOut(o.came, e.to)) continue;
      // closed in En cours: called once at least before (else its first call closed it: Nouvelles)
      if (!cl.some((c) => c.at < e.at)) continue;
      const how = CONFIRMED_LIKE.includes(e.to) ? 'confirmed' : neverReached(e.to, e.note) ? 'never' : 'saidNo';
      closes.push({ id: o.id, at: e.at, agentId: o.agentId, agencyId: o.agencyId, how, tries: cl.filter((c) => c.at <= e.at).length });
    }
  }
  closes.sort((a, b) => a.at - b.at);
  const W0 = { a: day, b: now + 1 };
  const W1 = { a: day - DAY, b: now - DAY + 1 };
  const inW = (w: { a: number; b: number }, t: number) => t >= w.a && t < w.b;
  const sumOf = (bs: Back[], cs: Close[]): EcSum => {
    // an order closed twice in the window counts once, as it ended
    const last = [...new Map(cs.map((c) => [c.id, c])).values()];
    const reached = last.filter((c) => c.how !== 'never');
    return {
      calls: bs.length,
      onTime: bs.filter((b) => b.ok).length,
      confirmed: last.filter((c) => c.how === 'confirmed').length,
      saidNo: last.filter((c) => c.how === 'saidNo').length,
      never: last.filter((c) => c.how === 'never').length,
      tries: reached.reduce((s, c) => s + c.tries, 0),
    };
  };
  const sum = (w: { a: number; b: number }) => sumOf(backs.filter((b) => inW(w, b.at)), closes.filter((c) => inW(w, c.at)));
  // right now: the orders of the En cours tab; a call back is late past its window, « due within the hour » before
  const rows = (
    await ctx.db.query(
      `SELECT id, agent_id, conf_agency_id, total, attempts, next_call_at, last_call_at, created_at, assigned_at FROM sales o
        WHERE conf_status = ANY($1)${statsSql(ctx, 'o')}`,
      [EN_COURS],
    )
  )
    .map((r: any) => {
      const created = Date.parse(iso(r.created_at));
      const assigned = r.agent_id && r.assigned_at ? Date.parse(iso(r.assigned_at)) : null;
      const attempts = num(r.attempts);
      const next = r.next_call_at ? Date.parse(iso(r.next_call_at)) : null;
      const last = r.last_call_at ? Date.parse(iso(r.last_call_at)) : assigned && assigned > created ? assigned : created;
      // its next call: the time picked, else the slot after the last try (past the shop's tries: until that slot ends);
      // never called (an « À vérifier »): its first call, Nouvelles'
      let win: { at: number; end: number } | null = null;
      if (next !== null) win = { at: next, end: next + CALLBACK_WINDOW };
      else if (attempts > 0 && attempts < calls.tries) win = nextSlot(last, calls);
      else if (attempts > 0) {
        const sl = slotAt(last, calls);
        win = { at: last, end: sl.open ? sl.to : sl.from };
      }
      return {
        agentId: numOrNull(r.agent_id),
        agencyId: numOrNull(r.conf_agency_id),
        total: num(r.total),
        late: !!win && win.end < now,
        soon: !!win && win.end >= now && win.at <= now + HOUR,
      };
    })
    .filter((o) => inView(o.agentId, o.agencyId));
  const live = {
    inProgress: rows.length,
    value: rows.reduce((s, o) => s + o.total, 0),
    late: rows.filter((o) => o.late).length,
    dueHour: rows.filter((o) => o.soon).length,
  };
  // one line per agent: the store's own agents (an agency's agents stay private: never a line here)
  const who = await names(ctx.db);
  const ownB = backs.filter((b) => inW(W0, b.at) && b.agencyId === null);
  const ownC = closes.filter((c) => inW(W0, c.at) && c.agencyId === null && c.agentId !== null);
  const ownLate = rows.filter((o) => o.late && o.agencyId === null && o.agentId !== null);
  const ids = new Set<number>([...ownB.map((b) => b.by), ...ownC.map((c) => c.agentId!), ...ownLate.map((o) => o.agentId!)]);
  const agents: EcAgent[] = [...ids]
    .map((id) => ({ id, name: who.get(id) ?? '—', ...sumOf(ownB.filter((b) => b.by === id), ownC.filter((c) => c.agentId === id)), late: ownLate.filter((o) => o.agentId === id).length }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  // the store's owner and administrators (not inside one of his teams): each team side by side, the load per agent
  const dir = director && !opened;
  let teams: EcTeam[] | null = null;
  let allTeams: EcTeam | null = null;
  let perAgent: { orders: number; agents: number } | null = null;
  if (dir) {
    // active: made a call today (a first call or a call back) on the store's own orders
    const active = new Set(anyCall.filter((c) => inW(W0, c.at) && c.agencyId === null).map((c) => c.by));
    perAgent = { orders: rows.filter((o) => o.agencyId === null).length, agents: active.size };
    const A = await agencyNames(ctx);
    teams = [
      ...T.map((t): EcTeam => {
        const m = membersOf(t);
        return {
          key: `t${t.id}`,
          kind: 'team',
          name: t.name,
          ...sumOf(ownB.filter((b) => m.has(b.by)), ownC.filter((c) => m.has(c.agentId!))),
          agents: [...active].filter((id) => m.has(id)).length,
          inProgress: rows.filter((o) => o.agencyId === null && o.agentId !== null && m.has(o.agentId)).length,
          late: ownLate.filter((o) => m.has(o.agentId!)).length,
        };
      }),
      ...A.map((a): EcTeam => ({
        key: `a${a.id}`,
        kind: 'agency',
        name: a.name,
        ...sumOf(backs.filter((b) => inW(W0, b.at) && b.agencyId === a.id), closes.filter((c) => inW(W0, c.at) && c.agencyId === a.id)),
        agents: null,
        inProgress: rows.filter((o) => o.agencyId === a.id).length,
        late: rows.filter((o) => o.late && o.agencyId === a.id).length,
      })),
    ].filter((x) => x.kind === 'team' || x.inProgress || x.calls || x.confirmed + x.saidNo + x.never);
    // what no team has: orders with no agent, people in no team — one line, so the lines add up to the cards
    const inTeams = new Set<number>(T.flatMap((t) => [...membersOf(t)]));
    const out = (aid: number | null) => aid === null || !inTeams.has(aid);
    const rest: EcTeam = {
      key: 'none',
      kind: 'none',
      name: '',
      ...sumOf(ownB.filter((b) => !inTeams.has(b.by)), closes.filter((c) => inW(W0, c.at) && c.agencyId === null && out(c.agentId))),
      agents: [...active].filter((x) => !inTeams.has(x)).length,
      inProgress: rows.filter((o) => o.agencyId === null && out(o.agentId)).length,
      late: rows.filter((o) => o.late && o.agencyId === null && out(o.agentId)).length,
    };
    if (rest.inProgress || rest.calls || rest.confirmed + rest.saidNo + rest.never) teams.push(rest);
    // « Toutes les équipes »: the lines above added up, never an average of the teams
    const add = (k: keyof EcSum | 'inProgress' | 'late') => teams!.reduce((s, r) => s + r[k], 0);
    allTeams = {
      key: 'all',
      kind: 'team',
      name: '',
      calls: add('calls'),
      onTime: add('onTime'),
      confirmed: add('confirmed'),
      saidNo: add('saidNo'),
      never: add('never'),
      tries: add('tries'),
      agents: teams.reduce((s, r) => s + (r.agents ?? 0), 0),
      inProgress: add('inProgress'),
      late: add('late'),
    };
  }
  return {
    today: sum(W0),
    prev: sum(W1),
    live,
    agents,
    /** the agent table's « Équipe » line: those agents' numbers added up */
    agentsTotal: sumOf(ownB, ownC),
    director: dir,
    team: opened ? { key: `t${opened.id}`, name: opened.name } : null,
    perAgent,
    teams,
    allTeams,
  };
}

async function periodNew(ctx: Ctx, i: KfInput) {
  const R = kfRange(ctx.now(), i);
  const O = await ctx.db.query(`SELECT id, conf_status, attempts, agent_id, total FROM sales WHERE ${periodSql(i.basis, 'sales')}${statsSql(ctx, 'sales')}`, [isoT(R.a), isoT(R.b)]);
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
  const O = await ctx.db.query(`SELECT total, follow_status FROM sales WHERE conf_status = 'confirmed' AND ${col} >= $1 AND ${col} < $2${statsSql(ctx, 'sales')}`, [isoT(R.a), isoT(R.b)]);
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

// ---------------------------------------------------------------- Confirmées › Statistiques (27 Nov 2026)
/** What became of a confirmed order out of the depot: left (on the road, delivered, back) and delivered. */
const SHIPPED = [...ROUTE, ...OK, ...BACK];
export interface CfSum {
  /** every order of the period (an abandoned cart only once confirmed) */
  leads: number;
  /** not a fake, a competitor, a duplicate, a wrong number or a « never answered » (a pending order stays qualified) */
  qualified: number;
  confirmed: number;
  /** confirmed with an upsell */
  upsell: number;
  /** confirmed and gone out of the depot (on the road counted), and delivered */
  shipped: number;
  delivered: number;
}
export interface CfRow extends CfSum {
  key: string;
  name: string;
  kind?: 'team' | 'agency' | 'none';
  /** agents with leads (a team; null: an agency — its agents stay private) */
  agents?: number | null;
}
/** Why real clients said no, as the sketch groups the agents' reasons. */
const CF_REASON: Record<string, string> = { price: 'price', fee: 'price', changed_mind: 'mind', too_long: 'slow', elsewhere: 'elsewhere' };
export const CfInput = KfInput.extend({
  /** one agent: the cards are his, the table per product */
  agent: id.optional(),
  /** one product: every number keeps only the orders with it */
  product: id.optional(),
  /** the store's owner: one of his teams (t<id>: its manager view) or a confirmation agency (a<id>) */
  team: z.string().max(40).optional(),
  /** the table: per agent (per team for the owner) or per product */
  by: z.enum(['people', 'product']).default('people'),
});

/**
 * Confirmées › Statistiques, as the owner's sketch (27 Nov 2026, « Agent manager view — Confirmées »): are the leads good,
 * does the team confirm them, and do the confirmed orders end up delivered? Filters: the dates (by creation, or by the
 * day the CONFIRMATION status changed), an agent, a product — and, for the store's owner, a team or an agency. Every
 * number is a « taux » (pending orders counted). Cards: leads, qualified leads, confirmed, lead quality (qualified ÷
 * leads), taux conf. (confirmed ÷ qualified), upsell; why real clients said no (bad leads left out); a table per agent
 * (per team for the owner) or per product, with the delivery only there: taux livr. (delivered ÷ shipped) and taux
 * final (delivered ÷ qualified).
 */
async function confirmeesStats(ctx: Ctx, i: z.infer<typeof CfInput>) {
  const R = kfRange(ctx.now(), i);
  const director = (ctx.session.isAdmin || ctx.session.roles.includes('vendeur')) && agencyOf(ctx) === null;
  const T = director ? await getSetting(ctx.db, 'teams') : [];
  const A = director ? await agencyNames(ctx) : [];
  const agency = director && i.team?.startsWith('a') ? A.find((a) => `a${a.id}` === i.team) ?? null : null;
  const { opened, membersOf, inView } = teamView(T, director && !agency ? i.team : undefined);
  const rows = await ctx.db.query(
    `SELECT id, conf_status, follow_status, agent_id, conf_agency_id, has_upsell, came FROM sales WHERE ${periodSql(i.basis, 'sales')}${statsSql(ctx, 'sales')}`,
    [isoT(R.a), isoT(R.b)],
  );
  let O = rows
    .filter((o: any) => !cartLeftOut(o.came, o.conf_status))
    .map((o: any) => ({ id: num(o.id), status: String(o.conf_status), follow: (o.follow_status ?? null) as string | null, agentId: numOrNull(o.agent_id), agencyId: numOrNull(o.conf_agency_id), up: !!o.has_upsell }))
    .filter((o) => (agency ? o.agencyId === agency.id : inView(o.agentId, o.agencyId)));
  // each order's products, and the note of its last confirmation change (the reason of a cancel, a fake, no answer)
  const prods = new Map<number, { id: number; name: string }[]>();
  const note = new Map<number, string | null>();
  const ids = O.map((o) => o.id);
  for (let k = 0; k < ids.length; k += 1000) {
    const part = ids.slice(k, k + 1000);
    for (const e of await ctx.db.query(`SELECT DISTINCT ON (order_id) order_id, note FROM order_events WHERE kind = 'conf_status' AND order_id = ANY($1) ORDER BY order_id, at DESC, id DESC`, [part]))
      note.set(num(e.order_id), e.note ?? null);
    for (const r of await ctx.db.query(`SELECT DISTINCT i.order_id, p.id, p.name FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = ANY($1) ORDER BY i.order_id, p.id`, [part])) {
      const o = num(r.order_id);
      if (!prods.has(o)) prods.set(o, []);
      prods.get(o)!.push({ id: num(r.id), name: String(r.name) });
    }
  }
  const who = await names(ctx.db);
  // the filters' choices (before the agent and product filters themselves)
  const agentChoices = [...new Set(O.filter((o) => o.agencyId === null && o.agentId !== null).map((o) => o.agentId!))]
    .map((aid) => ({ id: aid, name: who.get(aid) ?? '—' }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const prodChoices = [...new Map(O.flatMap((o) => prods.get(o.id) ?? []).map((p) => [p.id, p])).values()].sort((a, b) => a.name.localeCompare(b.name));
  if (i.agent) O = O.filter((o) => o.agentId === i.agent);
  if (i.product) O = O.filter((o) => (prods.get(o.id) ?? []).some((p) => p.id === i.product));
  const L = O.map((o) => ({ ...o, lead: leadOf(o.status, note.get(o.id)) }));
  type Ld = (typeof L)[number];
  const sumOf = (xs: Ld[]): CfSum => {
    const conf = xs.filter((o) => o.lead === 'confirmed');
    return {
      leads: xs.length,
      qualified: xs.filter((o) => o.lead === 'confirmed' || o.lead === 'refused' || o.lead === 'pending').length,
      confirmed: conf.length,
      upsell: conf.filter((o) => o.up).length,
      shipped: conf.filter((o) => o.follow !== null && SHIPPED.includes(o.follow)).length,
      delivered: conf.filter((o) => o.follow !== null && OK.includes(o.follow)).length,
    };
  };
  // why real clients said no (fakes, competitors, wrong numbers, no answers and duplicates are not clients' answers)
  const RS = new Map<string, number>();
  for (const o of L.filter((x) => x.lead === 'refused')) {
    const k = CF_REASON[cancelReason(note.get(o.id))] ?? 'other';
    RS.set(k, (RS.get(k) ?? 0) + 1);
  }
  // the table
  const dir = director && !opened && !agency;
  let table: CfRow[];
  const productRows = () =>
    [...new Map(L.flatMap((o) => (prods.get(o.id) ?? []).map((p) => [p.id, p] as const))).values()]
      .filter((p) => !i.product || p.id === i.product)
      .map((p) => ({ key: `p${p.id}`, name: p.name, ...sumOf(L.filter((o) => (prods.get(o.id) ?? []).some((x) => x.id === p.id))) }));
  if (i.by === 'product' || i.agent || agency) table = productRows();
  else if (dir) {
    const own = L.filter((o) => o.agencyId === null);
    const inTeams = new Set<number>();
    table = [
      ...T.map((t): CfRow => {
        const m = membersOf(t);
        for (const x of m) inTeams.add(x);
        const xs = own.filter((o) => o.agentId !== null && m.has(o.agentId));
        return { key: `t${t.id}`, name: t.name, kind: 'team', agents: new Set(xs.map((o) => o.agentId)).size, ...sumOf(xs) };
      }),
      ...A.map((a): CfRow => ({ key: `a${a.id}`, name: a.name, kind: 'agency', agents: null, ...sumOf(L.filter((o) => o.agencyId === a.id)) })),
    ].filter((r) => r.kind === 'team' || r.leads);
    // the leads no team has (no agent yet, or an agent in no team): one line, so the lines add up to the cards
    const rest = own.filter((o) => o.agentId === null || !inTeams.has(o.agentId));
    if (rest.length) table.push({ key: 'none', name: '', kind: 'none', agents: null, ...sumOf(rest) });
  } else {
    const per = new Map<string, Ld[]>();
    for (const o of L) {
      const k = o.agentId === null ? 'none' : `u${o.agentId}`;
      if (!per.has(k)) per.set(k, []);
      per.get(k)!.push(o);
    }
    table = [...per.entries()].map(([k, xs]) => ({ key: k, name: k === 'none' ? '' : who.get(Number(k.slice(1))) ?? '—', ...(k === 'none' ? { kind: 'none' as const } : {}), ...sumOf(xs) }));
  }
  table.sort((a, b) => (a.kind === 'none' ? 1 : 0) - (b.kind === 'none' ? 1 : 0) || b.leads - a.leads || a.name.localeCompare(b.name));
  // Leads/agent (the owner): his own agents with leads in the period
  const ownAgents = new Set(L.filter((o) => o.agencyId === null && o.agentId !== null).map((o) => o.agentId)).size;
  return {
    director: dir,
    /** the owner's choices: his teams and the agencies (null: not the owner) */
    teams: director ? [...T.map((t) => ({ key: `t${t.id}`, name: t.name, kind: 'team' as const })), ...A.map((a) => ({ key: `a${a.id}`, name: a.name, kind: 'agency' as const }))] : null,
    team: opened ? { key: `t${opened.id}`, name: opened.name } : agency ? { key: `a${agency.id}`, name: agency.name } : null,
    agents: agency ? [] : agentChoices,
    products: prodChoices,
    sum: sumOf(L),
    perAgent: director && !agency ? { leads: L.filter((o) => o.agencyId === null).length, agents: ownAgents } : null,
    reasons: [...RS.entries()].map(([code, n]) => ({ code, n })).sort((a, b) => b.n - a.n),
    by: i.by === 'product' || i.agent || agency ? ('product' as const) : ('people' as const),
    table,
  };
}

async function confirmedKpis(ctx: Ctx, i: KfInput) {
  const R = kfRange(ctx.now(), i);
  const upd = i.basis === 'updated';
  const cc = upd ? 'confirmed_at' : 'created_at';
  const O = await ctx.db.query(
    `SELECT id, total, agent_id, created_at, confirmed_at, has_upsell, upsell_value FROM sales WHERE conf_status = 'confirmed' AND ${cc} >= $1 AND ${cc} < $2${statsSql(ctx, 'sales')}`,
    [isoT(R.a), isoT(R.b)],
  );
  const X = num(
    (
      await ctx.db.query(
        upd
          ? `SELECT count(*)::int AS n FROM sales o WHERE o.conf_status = ANY($3) AND ${teamCountsSql('o.')}${statsSql(ctx, 'o')} AND EXISTS
              (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.kind = 'conf_status' AND e.to_value = o.conf_status AND e.at >= $1 AND e.at < $2)`
          : `SELECT count(*)::int AS n FROM sales WHERE conf_status = ANY($3) AND created_at >= $1 AND created_at < $2 AND ${teamCountsSql()}${statsSql(ctx, 'sales')}`,
        [isoT(R.a), isoT(R.b), CANCELLED_LIKE],
      )
    )[0]?.n,
  );
  const oids = O.map((o: any) => num(o.id));
  const items = oids.length
    ? await ctx.db.query(`SELECT i.order_id, i.qty, i.unit_price, p.packs FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = ANY($1)`, [oids])
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
    const pk = I.some((x) => num(x.qty) >= 2 && packsOf(x).some((p) => Number(p.qty) === num(x.qty)));
    const qty = I.reduce((s, x) => s + num(x.qty), 0);
    // the upsell Pilotix counted on the order: above what the customer first ordered (a pack they chose themselves is not one)
    return { up: !!o.has_upsell, upV: num(o.upsell_value), pk, qty };
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

// ---------------------------------------------------------------- Confirmation › Statistiques (one page)
/** pilotlearn's reason codes → the cancel reasons agents pick (CANCEL_REASONS); none → 'none' (no reason written) */
const REASON_OF: Record<string, string> = { price: 'price', fee: 'fee', elsewhere: 'elsewhere', not_ordered: 'not_ordered', slow: 'too_long', mind: 'changed_mind' };
export function cancelReason(note: string | null | undefined): string {
  const label = note?.split(' — ', 1)[0].trim();
  if (label && /^(panier abandonné|abandoned cart|سلة متروكة)$/iu.test(label)) return 'abandoned_cart';
  const code = reasonCode(note);
  return code === null ? 'none' : REASON_OF[code] ?? 'other';
}
// what became of a lead (confirmed, refused, an attack…): leadkind.ts, shared with Publicité's « Qualité des leads »
export { attackOf, leadOf };

/**
 * Confirmation › Statistiques: everything about the leads of the period on one page.
 * Leads quality = confirmed ÷ (confirmed + cancelled by a real client): attacks, duplicates and the leads still to call
 * never count. « Ancienne formule » = confirmed ÷ every finished lead, kept so the two can be compared.
 */
async function overview(ctx: Ctx, i: KfInput) {
  const now = ctx.now();
  const R = kfRange(now, i);
  const calls = await getSetting(ctx.db, 'calls');
  const all = await ctx.db.query(
    `SELECT id, conf_status, follow_status, agent_id, created_at, total, has_upsell, upsell_value, came, next_call_at FROM sales WHERE ${periodSql(i.basis, 'sales')}${statsSql(ctx, 'sales')}`,
    [isoT(R.a), isoT(R.b)],
  );
  // abandoned carts (leadkind.ts): on their own line; in the team's numbers only once confirmed
  const cartRows = all.filter((o: any) => CART_CAME.includes(String(o.came)));
  const cartsOk = cartRows.filter((o: any) => CONFIRMED_LIKE.includes(o.conf_status));
  const carts = {
    n: cartRows.length,
    confirmed: cartsOk.length,
    value: cartsOk.reduce((s: number, o: any) => s + num(o.total), 0),
    pending: cartRows.filter((o: any) => leadOf(o.conf_status, null) === 'pending').length,
  };
  const O = all.filter((o: any) => !cartLeftOut(o.came, o.conf_status));
  const ids = O.map((o: any) => num(o.id));
  const last = new Map<number, { by: number | null; note: string | null }>();
  const touch = new Map<number, number>();
  const given = new Map<number, number>();
  const prods = new Map<number, { id: number; name: string }[]>();
  for (let k = 0; k < ids.length; k += 1000) {
    const part = ids.slice(k, k + 1000);
    // who settled the lead, and the reason written with it (« Changé d'avis — … »)
    for (const e of await ctx.db.query(
      `SELECT DISTINCT ON (order_id) order_id, user_id, note FROM order_events WHERE kind = 'conf_status' AND order_id = ANY($1) ORDER BY order_id, at DESC, id DESC`,
      [part],
    ))
      last.set(num(e.order_id), { by: numOrNull(e.user_id), note: e.note ?? null });
    // first time a person called or changed it, first time it was given to an agent
    for (const e of await ctx.db.query(
      `SELECT order_id, min(at) AS at FROM order_events WHERE kind IN ('call', 'conf_status') AND user_id IS NOT NULL AND order_id = ANY($1) GROUP BY order_id`,
      [part],
    ))
      touch.set(num(e.order_id), Date.parse(iso(e.at)));
    for (const e of await ctx.db.query(`SELECT order_id, min(at) AS at FROM order_events WHERE kind = 'assign' AND order_id = ANY($1) GROUP BY order_id`, [part]))
      given.set(num(e.order_id), Date.parse(iso(e.at)));
    for (const r of await ctx.db.query(
      `SELECT DISTINCT i.order_id, p.id, p.name FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = ANY($1) ORDER BY i.order_id, p.id`,
      [part],
    )) {
      const k2 = num(r.order_id);
      if (!prods.has(k2)) prods.set(k2, []);
      prods.get(k2)!.push({ id: num(r.id), name: r.name as string });
    }
  }
  const who = await names(ctx.db);
  const L = O.map((o: any) => {
    const id = num(o.id);
    const e = last.get(id);
    const status = o.conf_status as string;
    const lead = leadOf(status, e?.note);
    const created = Date.parse(iso(o.created_at));
    return {
      id,
      status,
      lead,
      reason: lead === 'refused' ? cancelReason(e?.note) : null,
      attack: attackOf(status, e?.note),
      by: e?.by ?? null,
      agentId: numOrNull(o.agent_id),
      follow: o.follow_status as string | null,
      total: num(o.total),
      up: lead === 'confirmed' && !!o.has_upsell,
      upV: lead === 'confirmed' ? num(o.upsell_value) : 0,
      created,
      night: workStart(created, calls) > created,
      // a « Tentative » waiting for its « Rappel » (an action since 25 Nov 2026): « Plus tard », not « Pas de réponse »
      callback: !!o.next_call_at && ['no_answer', 'busy'].includes(status),
    };
  });
  type Row = (typeof L)[number];
  const count = (f: (o: Row) => boolean) => L.filter(f).length;
  const sum = (f: (o: Row) => boolean) => L.filter(f).reduce((s: number, o: Row) => s + o.total, 0);
  const is = (k: Lead) => (o: Row) => o.lead === k;
  const conf = count(is('confirmed'));
  const refused = count(is('refused'));
  const attacks = count(is('attack'));
  const dups = count(is('duplicate'));
  const pending = count(is('pending'));
  const confValue = sum(is('confirmed'));
  const ups = count((o) => o.up);
  // why real clients said no
  const RS = new Map<string, { code: string; n: number; value: number }>();
  for (const o of L.filter(is('refused'))) {
    if (!RS.has(o.reason!)) RS.set(o.reason!, { code: o.reason!, n: 0, value: 0 });
    const r = RS.get(o.reason!)!;
    r.n++;
    r.value += o.total;
  }
  // when the leads came in (Algiers time) and how fast the first call came
  const hours = Array.from({ length: 24 }, () => 0);
  for (const o of L) hours[new Date(o.created + 3_600_000).getUTCHours()]++;
  const dayFirst: number[] = [];
  const dayGiven: number[] = [];
  const nightWait: number[] = [];
  const nightOpen: number[] = [];
  let onTime = 0;
  for (const o of L) {
    const f = touch.get(o.id);
    if (f === undefined || f < o.created) continue;
    if (o.night) {
      nightWait.push((f - o.created) / MIN);
      nightOpen.push(Math.max(0, (f - workStart(o.created, calls)) / MIN));
      continue;
    }
    const d = (f - o.created) / MIN;
    dayFirst.push(d);
    if (d <= calls.firstMinutes) onTime++;
    const g = given.get(o.id);
    if (g !== undefined && g >= o.created && g <= f) dayGiven.push((g - o.created) / MIN);
  }
  const mins = (xs: number[]) => {
    const m = median(xs);
    return m === null ? null : Math.round(m);
  };
  // per agent: who settled the lead (an admin who confirms counts too); « à rappeler »: the orders given to them
  type A = { agentId: number | null; name: string | null; treated: number; confirmed: number; refused: number; attacks: number; fake: number; wrong: number; noAnswer: number; duplicates: number; toCall: number; toCallNight: number; upsell: number; delivered: number; returned: number };
  const AG = new Map<string, A>();
  const ag = (id: number | null): A => {
    const k = String(id ?? '');
    if (!AG.has(k)) AG.set(k, { agentId: id, name: id ? who.get(id) ?? '—' : null, treated: 0, confirmed: 0, refused: 0, attacks: 0, fake: 0, wrong: 0, noAnswer: 0, duplicates: 0, toCall: 0, toCallNight: 0, upsell: 0, delivered: 0, returned: 0 });
    return AG.get(k)!;
  };
  for (const o of L) {
    if (o.lead === 'pending') {
      if (o.agentId) {
        const a = ag(o.agentId);
        a.toCall++;
        if (o.night) a.toCallNight++;
      }
      if (o.by) ag(o.by).treated++;
      continue;
    }
    const a = ag(o.by);
    a.treated++;
    if (o.lead === 'confirmed') {
      a.confirmed++;
      if (o.up) a.upsell++;
      if (o.follow && OK.includes(o.follow)) a.delivered++;
      if (o.follow && BACK.includes(o.follow)) a.returned++;
    } else if (o.lead === 'refused') a.refused++;
    else if (o.lead === 'duplicate') a.duplicates++;
    else {
      a.attacks++;
      a[o.attack as 'fake' | 'wrong' | 'noAnswer']++;
    }
  }
  const byAgent = [...AG.values()]
    .map((a) => ({
      ...a,
      leadsQuality: pc(a.confirmed, a.confirmed + a.refused),
      oldRate: pc(a.confirmed, a.confirmed + a.refused + a.attacks + a.duplicates),
      upsellRate: pc(a.upsell, a.confirmed),
      deliveryRate: pc(a.delivered, a.delivered + a.returned),
    }))
    .sort((x, y) => y.confirmed - x.confirmed || y.treated - x.treated || (x.name ?? '').localeCompare(y.name ?? ''));
  // per product (an order with two products counts for both)
  type P = { productId: number; name: string; n: number; confirmed: number; refused: number; attacks: number; duplicates: number; pending: number; attackValue: number };
  const PR = new Map<number, P>();
  for (const o of L)
    for (const p of prods.get(o.id) ?? []) {
      if (!PR.has(p.id)) PR.set(p.id, { productId: p.id, name: p.name, n: 0, confirmed: 0, refused: 0, attacks: 0, duplicates: 0, pending: 0, attackValue: 0 });
      const v = PR.get(p.id)!;
      v.n++;
      if (o.lead === 'confirmed') v.confirmed++;
      else if (o.lead === 'refused') v.refused++;
      else if (o.lead === 'duplicate') v.duplicates++;
      else if (o.lead === 'pending') v.pending++;
      else {
        v.attacks++;
        v.attackValue += o.total;
      }
    }
  const byProduct = [...PR.values()]
    .map((p) => ({ ...p, real: p.confirmed + p.refused, leadsQuality: pc(p.confirmed, p.confirmed + p.refused) }))
    .sort((x, y) => y.n - x.n || x.name.localeCompare(y.name));
  const finished = conf + refused + attacks + dups;
  // the judge is Pilot Checks « Leads quality » (Q2), with the owner's own limits: good, alert, stop, and how many real
  // leads before judging at all
  const q2 = (await checkRules(ctx.db)).find((r) => r.id === 'Q2');
  return {
    limits: { good: q2?.g ?? 65, alert: q2?.v ?? 60, stop: q2?.s ?? 55, wait: q2?.wait ?? 30 },
    received: L.length,
    value: sum(() => true),
    pending: { n: pending, value: sum(is('pending')), fresh: count((o) => o.status === 'new' || o.status === 'to_check'), noAnswer: count((o) => (o.status === 'no_answer' || o.status === 'busy') && !o.callback), later: count((o) => o.status === 'callback' || o.status === 'postponed' || o.callback) },
    confirmed: { n: conf, value: confValue, basket: conf ? Math.round(confValue / conf) : null },
    refused: { n: refused, value: sum(is('refused')), reasons: [...RS.values()].sort((x, y) => y.n - x.n || y.value - x.value) },
    /** the abandoned carts of the period: the confirmed ones are in every number of this page, the others in none */
    carts,
    attacks: {
      n: attacks,
      value: sum(is('attack')),
      fake: count((o) => o.attack === 'fake'),
      wrong: count((o) => o.attack === 'wrong'),
      noAnswer: count((o) => o.attack === 'noAnswer'),
      fakeValue: sum((o) => o.attack === 'fake'),
      wrongValue: sum((o) => o.attack === 'wrong'),
      noAnswerValue: sum((o) => o.attack === 'noAnswer'),
    },
    duplicates: { n: dups, value: sum(is('duplicate')) },
    finished,
    real: conf + refused,
    leadsQuality: pc(conf, conf + refused),
    oldRate: pc(conf, finished),
    upsell: { orders: ups, rate: pc(ups, conf), value: L.reduce((s: number, o: Row) => s + o.upV, 0) },
    hours,
    slots: calls.slots.map((s: any) => ({ from: s.from, to: s.to })),
    night: { n: count((o) => o.night), noAnswer: count((o) => o.night && (o.status === 'no_answer' || o.status === 'busy') && !o.callback), noAnswerAll: count((o) => (o.status === 'no_answer' || o.status === 'busy') && !o.callback) },
    /** « Annuler automatiquement après N appels sans réponse » (0: off) */
    cancelAfter: calls.cancelAfterNoAnswer,
    speed: {
      firstMinutes: calls.firstMinutes,
      dayCalled: dayFirst.length,
      dayMedianMin: mins(dayFirst),
      onTime,
      givenMedianMin: mins(dayGiven),
      nightCalled: nightWait.length,
      nightMedianMin: mins(nightWait),
      nightAfterOpenMedianMin: mins(nightOpen),
    },
    byAgent,
    byProduct,
  };
}

// ---------------------------------------------------------------- the agent banner
async function banner(ctx: Ctx) {
  const now = ctx.now();
  const me = ctx.session.profile.id;
  const calls = await getSetting(ctx.db, 'calls');
  // what this person sees: an agent his own orders (the same numbers as his lists)
  const todo = await loadTodo(ctx.db, queueSql(ctx, 'conf'));
  const due = computeDue(todo, calls, now);
  const L = todo.map((o) => ({ o, d: due.get(o.id)! }));
  const forMe = (x: (typeof L)[number]) => !x.o.agentId || x.o.agentId === me;
  const mine = L.filter((x) => x.o.agentId === me);
  const late = mine.filter((x) => x.d.kind === 'missed').length;
  // « nouvelles commandes » and their « en retard »: Nouvelles' own orders, so the banner and Nouvelles' « En retard »
  // counter say the same number (an order « À vérifier » never called is in En cours: a try to make there)
  const isNew = (x: (typeof L)[number]) => x.o.status === 'new';
  const nowN = mine.filter((x) => (x.d.kind === 'now' && !isNew(x)) || (!isNew(x) && (x.d.kind === 'first_late' || x.d.kind === 'first_due'))).length;
  const fresh = L.filter((x) => isNew(x) && forMe(x) && (x.d.kind === 'first_late' || x.d.kind === 'first_due' || x.d.kind === 'now')).length;
  const night = L.filter((x) => isNew(x) && forMe(x) && x.d.kind === 'first_next').length;
  // (the very rule of Nouvelles' « En retard » counter: bucketOf)
  const firstLate = L.filter((x) => isNew(x) && forMe(x) && bucketOf('nouvelles', { confStatus: 'new' }, x.d, now) === 'late').length;
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
    const agency = agencyOf(ctx);
    const [shop, calls, agents] = await Promise.all([
      getSetting(ctx.db, 'shop'),
      getSetting(ctx.db, 'calls'),
      agency === null
        ? // the store's own people (its Community managers too: they confirm their own orders) — never an agency's
          // agents: the seller gives an order to the agency itself (owner's rule, 26 Nov 2026)
          ctx.db.query(`SELECT id, name FROM profiles WHERE active AND agency_id IS NULL AND roles && '{confirmation,agent_manager,vendeur,admin,cm}'::text[] ORDER BY name`)
        : // an agency's people: its own confirmation agents here, never the store's team (its chiefs give them its orders)
          ctx.db.query(`SELECT id, name FROM profiles WHERE active AND agency_id = $1 AND 'confirmation' = ANY(roles) ORDER BY name`, [agency]),
    ]);
    return {
      shopName: shop.name,
      whatsappTemplate: shop.whatsappTemplate,
      calls,
      agents: agents.map((a: any) => ({ id: num(a.id), name: a.name as string })),
      // the seller's « Assigner un agent »: his confirmation agency, as one line (orders.giveAgency)
      agencies: agency === null && hasRole(ctx.session, 'vendeur') ? await confirmationAgencies(ctx).catch(() => []) : [],
      teams: (await getSetting(ctx.db, 'teams')).map((t) => ({ id: t.id, name: t.name })),
      manager: isManager(ctx) || agencyLead(ctx),
    };
  }),

  /** Counts of the stage bar. */
  /**
   * Column presets of every order list: everyone reads them and picks one for himself; only a preset lead (presetLead:
   * a store's admin; in a confirmation agency's own space, its chief and its chefs d'équipe) adds or deletes, and the
   * one he saves or picks goes to his whole team; a saved preset is never changed. `all`: every column of the list it
   * was saved in (elsewhere it decides only those, the other columns keep their default).
   */
  'confirmation.colPresets': proc(null, z.object({}), async (ctx) => getSetting(ctx.db, 'colPresets')),
  'confirmation.addColPreset': proc(['confirmation'], z.object({ name: z.string().trim().min(1).max(40), cols: z.array(z.string().max(30)).min(1).max(40), all: z.array(z.string().max(30)).max(60).optional() }), async (ctx, i) => {
    if (!presetLead(ctx)) throw forbidden();
    const list = await getSetting(ctx.db, 'colPresets');
    if (list.some((p) => p.name.toLowerCase() === i.name.toLowerCase())) throw bad('Un préréglage porte déjà ce nom');
    if (list.length >= 30) throw bad('30 préréglages au maximum');
    const cols = [...new Set(i.cols)];
    const preset = {
      id: `p${ctx.now().toString(36)}`,
      name: i.name,
      cols,
      // the list's columns, with the ones kept (an older screen sends none: the preset then decides its own columns only)
      ...(i.all?.length ? { all: [...new Set([...i.all, ...cols])] } : {}),
      by: ctx.session.profile.name,
      at: new Date(ctx.now()).toISOString(),
    };
    await setSetting(ctx.db, 'colPresets', [...list, preset], ctx.session.profile.id);
    // a saved preset is used by every team at once
    await setSetting(ctx.db, 'colPresetActive', { id: preset.id, at: ctx.now(), by: ctx.session.profile.name }, ctx.session.profile.id);
    return preset;
  }),
  'confirmation.deleteColPreset': proc(['confirmation'], z.object({ id: z.string().max(40) }), async (ctx, { id }) => {
    if (!presetLead(ctx)) throw forbidden();
    const list = await getSetting(ctx.db, 'colPresets');
    await setSetting(ctx.db, 'colPresets', list.filter((p) => p.id !== id), ctx.session.profile.id);
    if ((await getSetting(ctx.db, 'colPresetActive'))?.id === id) await setSetting(ctx.db, 'colPresetActive', null, ctx.session.profile.id);
    return { ok: true };
  }),
  /**
   * The preset a lead put in use for his whole team (null: none). It replaces the columns each user chose before it;
   * anyone can tick his own again after. Everyone reads it; only a preset lead sets it.
   */
  'confirmation.colActive': proc(null, z.object({}), async (ctx) => getSetting(ctx.db, 'colPresetActive')),
  'confirmation.setColActive': proc(null, z.object({ id: z.string().max(40).nullable() }), async (ctx, { id }) => {
    if (!presetLead(ctx)) throw forbidden();
    if (id && !(await getSetting(ctx.db, 'colPresets')).some((p) => p.id === id)) throw bad('Préréglage introuvable');
    const v = id ? { id, at: ctx.now(), by: ctx.session.profile.name } : null;
    await setSetting(ctx.db, 'colPresetActive', v, ctx.session.profile.id);
    return v;
  }),
  /** For every screen: names of users and delivery companies (to write order history in words), and the WhatsApp message. */
  'orders.uiMeta': proc(null, z.object({}), async (ctx) => {
    const [shop, people, companies, calls] = await Promise.all([getSetting(ctx.db, 'shop'), ctx.db.query('SELECT id, name FROM profiles'), ctx.db.query('SELECT id, name FROM delivery_companies'), getSetting(ctx.db, 'calls')]);
    return {
      shopName: shop.name,
      whatsappTemplate: shop.whatsappTemplate,
      cancelAfterNoAnswer: calls.cancelAfterNoAnswer,
      /** the try at which the agent sends the shop's first message (Management › Statuts › « Messages client ») */
      messageAtTry: messageTry(calls),
      names: Object.fromEntries([...people.map((p: any) => [String(p.id), p.name as string]), ...companies.map((c: any) => [`c${c.id}`, c.name as string])]) as Record<string, string>,
    };
  }),
  'confirmation.counts': proc(['confirmation'], z.object({}), async (ctx) => {
    const q = andSql(queueSql(ctx, 'conf'));
    const rows = await ctx.db.query(`SELECT conf_status AS k, count(*)::int AS n FROM sales o WHERE true${q} GROUP BY 1`);
    const by = Object.fromEntries(rows.map((r: any) => [r.k, num(r.n)]));
    const sum = (s: readonly string[]) => s.reduce((t, k) => t + (by[k] ?? 0), 0);
    const all = ctx.session.isAdmin || isManager(ctx) || agencyLead(ctx);
    const dl = (await ctx.db.query(`SELECT count(*)::int AS n FROM sales o WHERE conf_status = 'confirmed' AND follow_status = 'delivered'${all ? '' : ' AND agent_id = $1'}${q}`, all ? [] : [ctx.session.profile.id]))[0];
    // Confirmées, and how many at each stage of the dépôt (the stage bar)
    const st = await ctx.db.query(
      `SELECT CASE WHEN follow_status IS NULL AND conf_status = 'no_stock' THEN 'nostock'
                   WHEN follow_status = 'to_prepare' AND conf_status = 'confirmed' THEN 'preparer'
                   WHEN follow_status = 'prepared' THEN 'prepares'
                   WHEN follow_status = 'shipped' THEN 'dispatchees' END AS k, count(*)::int AS n
         FROM sales o WHERE conf_status = ANY($1) AND ${NOT_SENT_SQL}${q} GROUP BY 1`,
      [[...CONF_SUBS.confirmees]],
    );
    const at = Object.fromEntries(st.map((r: any) => [r.k ?? '', num(r.n)]));
    const stages = Object.fromEntries(CONF_STAGES.map((k) => [k, at[k] ?? 0])) as Record<ConfStage, number>;
    const confirmees = st.reduce((t: number, r: any) => t + num(r.n), 0);
    return { nouvelles: sum(CONF_SUBS.nouvelles), attente: sum(CONF_SUBS.attente), confirmees, terminees: sum(CONF_SUBS.terminees), livrees: num(dl?.n), stages };
  }),

  /** One page of a confirmation list, with SKUs, creator and call deadline per row. */
  'confirmation.list': proc(['confirmation'], QueueInput, (ctx, i) => queueList(ctx, i)),

  /** Products for the open row: variants, packs, linked products, and the client delivery price of the order. */
  'confirmation.catalog': proc(['confirmation'], z.object({}), async (ctx) => {
    const allowed = await assignedProductIds(ctx);
    const P = await ctx.db.query(`SELECT id, name, sku, price, fixed_price, max_discount, packs, linked, is_service, fee_grid, montage, ${HAS_GUIDE('products')} AS has_guide FROM products WHERE active AND archived_at IS NULL${allowed ? ' AND id = ANY($1)' : ''} ORDER BY name`, allowed ? [allowed] : []);
    const V = P.length ? await ctx.db.query('SELECT v.id, v.product_id, v.title, v.sku, v.price, COALESCE((SELECT sum(qty) FROM stock s WHERE s.variant_id = v.id), 0)::int AS stock FROM product_variants v WHERE v.active AND v.product_id = ANY($1) ORDER BY v.id', [P.map((p) => num(p.id))]) : [];
    return P.map((p: any) => ({
      id: num(p.id),
      name: p.name as string,
      sku: p.sku as string,
      price: num(p.price),
      fixedPrice: !!p.fixed_price,
      /** biggest discount per unit the agent may give (null: no limit) */
      maxDiscount: numOrNull(p.max_discount),
      isService: !!p.is_service,
      feeGrid: (p.fee_grid as string | null) ?? null,
      /** a sales guide to open during the call (« Guide » on the order's line) */
      hasGuide: !!p.has_guide,
      /** montage: price, cost, wilayas (null: the shop's list); null: none */
      montage: readMontage(p.montage),
      packs: ((typeof p.packs === 'string' ? JSON.parse(p.packs) : p.packs) ?? []).map((x: any) => ({ qty: Number(x.qty), price: Number(x.price) })) as { qty: number; price: number }[],
      linked: ((p.linked ?? []) as unknown[]).map(num).filter((id) => allowed === null || allowed.includes(id)),
      variants: V.filter((v: any) => num(v.product_id) === num(p.id)).map((v: any) => ({ id: num(v.id), title: v.title as string, sku: v.sku as string, price: numOrNull(v.price), stock: num(v.stock) })),
    }));
  }),

  /**
   * The grid price of an order's delivery (its lines' client grids, a size's own first, the highest one, like the order
   * form); `wilayaId` / `isStopdesk` give the price for another choice before it is saved.
   */
  'confirmation.gridFee': proc(['confirmation'], z.object({ id, isStopdesk: z.boolean().optional(), wilayaId: z.number().int().min(1).max(69).optional() }), async (ctx, { id, isStopdesk, wilayaId }) => {
    const o = await getOrder(ctx, id);
    const grids = await lineGrids(ctx.db, o.items.map((l: any) => ({ productId: l.productId, variantId: l.variantId })));
    return { fee: (await highestGridFee(ctx.db, wilayaId ?? o.wilayaId, isStopdesk ?? o.isStopdesk, grids)).fee };
  }),

  /**
   * Delivery choices for a wilaya: each active company says whether it delivers there at home and to a bureau
   * (own / manual companies always do; a courier with a tariff must have a price for it), and the bureaus (stop desks) there.
   */
  'confirmation.deskOptions': proc(['confirmation'], z.object({ wilayaId: z.number().int().min(1).max(69) }), async (ctx, { wilayaId }) => {
    const cos = await ctx.db.query(
      `SELECT c.id, c.name, c.kind, (SELECT count(*)::int FROM delivery_fees f WHERE f.company_id = c.id) AS n
         FROM delivery_companies c WHERE c.active ORDER BY c.name`,
    );
    // a new wilaya (2026): a company without its own price there has its old wilaya's, and its bureaus there count (newwilayas.ts)
    const here = wilayaAndOld(wilayaId);
    const F = new Map(
      withNewWilayas(await ctx.db.query('SELECT company_id, wilaya_id, home, desk FROM delivery_fees WHERE wilaya_id = ANY($1::int[])', [here]))
        .filter((f: any) => num(f.wilaya_id) === wilayaId)
        .map((f: any) => [num(f.company_id), f]),
    );
    const companies = cos.map((c: any) => {
      const free = c.kind === 'own' || c.kind === 'manual' || num(c.n) === 0;
      const f: any = F.get(num(c.id));
      return { id: num(c.id), name: c.name as string, kind: c.kind as string, home: free || num(f?.home) > 0, desk: free || num(f?.desk) > 0 };
    });
    const C = new Map(companies.map((c) => [c.id, c]));
    const desks = (await ctx.db.query('SELECT id, company_id, commune, name, address FROM stopdesks WHERE wilaya_id = ANY($1::int[]) AND gone_at IS NULL ORDER BY name', [here]))
      .filter((d: any) => C.has(num(d.company_id)))
      .map((d: any) => ({ id: num(d.id), companyId: num(d.company_id), companyName: C.get(num(d.company_id))!.name, name: d.name as string, commune: d.commune as string, address: d.address as string, served: C.get(num(d.company_id))!.desk }));
    return { companies, desks };
  }),

  /** "Tentative 01/02/03": no answer, with the attempt number set. */
  'confirmation.setTry': proc(['confirmation'], z.object({ ids, n: z.number().int().min(1).max(30), note: z.string().max(1000).nullable().optional(), messageSentVia: ConfInput.shape.messageSentVia, reorderToken: ConfInput.shape.reorderToken }), async (ctx, i) => {
    // the number of this call, never lower than the calls already made + 1 (so « Annuler après N appels » can be reached)
    return setConf(ctx, ConfInput.parse({ ids: i.ids, status: 'no_answer', note: i.note ?? null, messageSentVia: i.messageSentVia, reorderToken: i.reorderToken, tryN: i.n }));
  }),

  /** Blacklists the customers of these orders ("Bloquer le client"). */
  'confirmation.block': proc(['confirmation'], z.object({ ids, reason: z.string().max(200).nullable().optional() }), async (ctx, i) => {
    const rows = await ctx.db.query('SELECT DISTINCT customer_id FROM sales WHERE id = ANY($1) AND customer_id IS NOT NULL', [i.ids]);
    const cids = rows.map((r: any) => num(r.customer_id));
    // a person's decision: it stays (never lifted by itself), and the owner's other boutiques follow
    if (cids.length) await ctx.db.query('UPDATE customers SET blacklisted = true, blacklist_reason = COALESCE($2, blacklist_reason), blacklist_auto = false, blacklist_shop = NULL WHERE id = ANY($1)', [cids, i.reason ?? null]);
    const shared = cids.length ? await shareBlacklist(ctx, await blackNumbers(ctx.db, cids), true, i.reason ?? null) : [];
    ctx.emit({ type: 'orders' });
    return { customers: cids.length, shared };
  }),

  /** An order opened from a list: kept for this agent 10 minutes; held by another agent: who has it. */
  'confirmation.hold': proc(['confirmation'], z.object({ id }), (ctx, { id }) => holdOrder(ctx, id)),

  /** Gives back the order taken with orders.next (another agent can take it). */
  'confirmation.release': proc(['confirmation'], z.object({ id }), async (ctx, { id }) => {
    await ctx.db.query('UPDATE orders SET locked_by = NULL, locked_until = NULL WHERE id = $1 AND conf_agency_id IS NOT DISTINCT FROM $4::integer AND (locked_by = $2 OR $3)', [id, ctx.session.profile.id, ctx.session.isAdmin, agencyOf(ctx)]);
    return { ok: true };
  }),

  /** Small numbers above the single-order mode. */
  'confirmation.mine': proc(['confirmation'], z.object({}), async (ctx) => {
    const me = ctx.session.profile.id;
    const day = isoT(algiersDayStart(ctx.now()));
    const r = (
      await ctx.db.query(
        `SELECT
           count(*) FILTER (WHERE conf_status = ANY($1) AND ${dueNowSql(4)})::int AS due,
           count(*) FILTER (WHERE conf_status = ANY($1) AND NOT ${dueNowSql(4)})::int AS later,
           count(*) FILTER (WHERE conf_status = 'confirmed' AND agent_id = $2 AND confirmed_at >= $3)::int AS confirmed
         FROM sales o WHERE true${andSql(queueSql(ctx, 'conf'))}`,
        [CONF_TODO, me, day, await triedSince(ctx)],
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
  /** Nouvelles › Statistiques: today only, live, no filters (the owner's design, 27 Nov 2026). */
  'confirmation.nouvelles': proc([...MGR], z.object({ team: z.string().max(40).optional() }), (ctx, i) => nouvellesStats(ctx, i)),
  'confirmation.period': proc([...MGR], KfInput, (ctx, i) => periodNew(ctx, i)),
  'confirmation.delivery': proc([...MGR], KfInput.extend({ on: z.enum(['created', 'confirmed']).default('created') }), (ctx, i) => deliveryPerf(ctx, i)),
  'confirmation.enCours': proc([...MGR], z.object({ team: z.string().max(40).optional() }), (ctx, i) => enCoursStats(ctx, i)),
  'confirmation.confirmed': proc([...MGR], KfInput, (ctx, i) => confirmedKpis(ctx, i)),
  /** Confirmation › Statistiques: leads, Leads quality, why we lose them, upsell, speed, agents and products. */
  'confirmation.overview': proc([...MGR], KfInput, (ctx, i) => overview(ctx, i)),
  'confirmation.confirmees': proc([...MGR], CfInput, (ctx, i) => confirmeesStats(ctx, i)),
};

