// Agent pay (a seller's boutique): Caisse › Paie for the owner, Ma caisse for each agent.
//   - Each person has one plan per job they do (confirmation, suivi, superviseur = his team's delivered orders, his own
//     included, dépôt = each order he prepares first). A plan is copied when it is given (pay_plan_terms): editing the plan
//     later never changes past pay. The first plan of a job counts from the start of the current pay period (the periods
//     before were paid the old way). Nobody may stay without a plan: the owner sees a red alert (Co-Pilot, Caisse › Paie).
//   - An order earns under the plan in force at its event (delivered; confirmed for a plan paid at confirmation; prepared
//     for the dépôt). The upsell is real only when more articles are delivered than the customer first ordered (services
//     like « Montage » never count): each extra article pays the order's amount once more (QTY), as the plan says.
//   - Pay days come from the shop's calendar (shared payPeriodAt). A closed period not paid yet is « prête à payer ».
//     The owner pays everything ready at once, from a caisse he picks (a « Salaire » expense); only the last pay can be
//     cancelled (its money goes back into the caisse).
//   - Acomptes: the agent asks, never more than what he earned in the open period (minus his acomptes) and the shop's
//     monthly maximum, from the shop's day of the month. An acompte is taken off the pay of the period it was paid in.
//   - Every payment waits for the agent's answer: « Reçu », or « Pas encore reçu » — the owners are told at once.
import { agentPlanTask, DEFAULT_PAY_ACOMPTE, DEFAULT_PAY_CALENDAR, ManagementPlanConfig, PAY_TASKS, PayAcompte, PayCalendar, PayTask, payIsOn, payLocalDay, payMonthStart, payPeriodAt, payPeriods, payTasksIn, planPriceBrackets } from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, num } from '../db';
import type { Tenancy } from '../platform/tenancy';
import { bad, Ctx, forbidden, notFound, proc, withActionLock } from '../rpc';
import { getSetting } from '../settings';
import { getRaw, setRaw } from './admin';
import { caisseChoices } from './caisses';
import { caisseLabelOf, CaisseKey, checkCaisse } from './cash';
import { sendPush } from './push';

const STAFF = ['confirmation', 'suivi', 'depot', 'agent_manager'] as const;
export const PAY_CALENDAR_KEY = 'payCalendar';
export const PAY_ACOMPTE_KEY = 'payAcompte';
const Id = z.number().int().positive();
const Money = z.number().int().min(1).max(10_000_000);
const PAID = ['delivered', 'exchanged'];

// ---------------------------------------------------------------- a confirmation agency's pay
// An agency's people work on its sellers' orders, in each seller's own store (where they have a profile of their own,
// agency_id = the agency). Their pay counts the orders the agency confirmed (conf_agency_id) or followed
// (follow_agency_id) there. The agency's db is marked by paySpace (each request, the job, Co-Pilot).
interface AgencySpace {
  t: Tenancy;
  agencyId: number;
}
const SPACE = new WeakMap<object, AgencySpace>();
/** Marks this request's db as an agency's (its pay reads its sellers' stores). */
export function paySpace(ctx: Ctx): void {
  if (ctx.shop?.kind === 'agency' && ctx.t && ctx.shop.id) SPACE.set(ctx.db, { t: ctx.t, agencyId: ctx.shop.id });
}
const kindOf = (db: Db) => (SPACE.has(db) ? 'agency' : 'store');
/** The jobs a person must have a plan for here (allowed: may have). */
const tasksOf = (db: Db, roles: string[], allowed = false) => payTasksIn(kindOf(db), roles, allowed);
/** Where to open the pay pages (an agency: Facturation › Paie and « Mes gains »). */
const boardUrl = (db: Db) => (SPACE.has(db) ? '#/equipe/paie' : '#/caisse/paie');
const mineUrl = (db: Db) => (SPACE.has(db) ? '#/gains' : '#/macaisse');
const mineName = (db: Db) => (SPACE.has(db) ? 'Mes gains' : 'Ma caisse');

/** The databases holding this person's orders, with his profile ids there (an agency: each seller's store). */
interface Source {
  db: Db;
  ids: number[];
  /** an agency's id: only the orders it confirmed / followed */
  agency: number | null;
  /** the seller's name (an agency) */
  store: string | null;
}
async function sourcesOf(db: Db, personId: number): Promise<Source[]> {
  const a = SPACE.get(db);
  if (!a) return [{ db, ids: [personId], agency: null, store: null }];
  const me = (await db.query('SELECT email FROM profiles WHERE id = $1', [personId]))[0];
  const email = String(me?.email ?? '').toLowerCase();
  const links = await a.t.platform.query(
    `SELECT DISTINCT s.schema_name, s.name FROM platform.agency_links l JOIN platform.shops s ON s.id = l.store_id
      WHERE l.agency_id = $1 AND l.started_at IS NOT NULL AND s.status <> 'deleted'`,
    [a.agencyId],
  );
  const out: Source[] = [];
  for (const l of links) {
    const sdb = a.t.shop(String(l.schema_name));
    const ids = (await sdb.query('SELECT id FROM profiles WHERE agency_id = $1 AND (agency_profile_id = $2 OR (agency_profile_id IS NULL AND lower(email) = $3))', [a.agencyId, personId, email])).map((r: any) => num(r.id));
    if (ids.length) out.push({ db: sdb, ids, agency: a.agencyId, store: String(l.name ?? '') });
  }
  return out;
}

// ---------------------------------------------------------------- settings
const Calendar = z.union([
  z.object({ every: z.literal('week'), weekday: z.number().int().min(0).max(6) }),
  z.object({ every: z.literal('half') }),
  z.object({ every: z.literal('month'), day: z.number().int().min(1).max(28) }),
  z.object({ every: z.literal('days'), days: z.array(z.number().int().min(1).max(28)).min(1).max(28) }),
]);
const Acompte = z.object({ max: z.number().int().min(0).max(10_000_000), fromDay: z.number().int().min(1).max(28) });

export async function payCalendarOf(db: Db): Promise<PayCalendar> {
  const v = Calendar.safeParse(await getRaw<unknown>(db, PAY_CALENDAR_KEY, null));
  return v.success ? v.data : DEFAULT_PAY_CALENDAR;
}
export async function payAcompteOf(db: Db): Promise<PayAcompte> {
  const v = Acompte.safeParse(await getRaw<unknown>(db, PAY_ACOMPTE_KEY, null));
  return v.success ? v.data : DEFAULT_PAY_ACOMPTE;
}

// ---------------------------------------------------------------- plans in force
export interface PayTerm {
  id: number;
  task: PayTask;
  planId: number | null;
  name: string;
  config: ManagementPlanConfig | null;
  at: number;
}
const json = (x: unknown) => (typeof x === 'string' ? JSON.parse(x) : x);

async function termsOf(db: Db, ids: number[]): Promise<Map<number, PayTerm[]>> {
  const out = new Map<number, PayTerm[]>();
  if (!ids.length) return out;
  for (const r of await db.query('SELECT * FROM pay_plan_terms WHERE profile_id = ANY($1) ORDER BY effective_at, id', [ids])) {
    const l = out.get(num(r.profile_id)) ?? [];
    l.push({ id: num(r.id), task: r.task as PayTask, planId: r.plan_id === null ? null : num(r.plan_id), name: String(r.name), config: r.configuration ? (json(r.configuration) as ManagementPlanConfig) : null, at: Date.parse(iso(r.effective_at)) });
    out.set(num(r.profile_id), l);
  }
  return out;
}

/** The plan of this job in force at t (null: none, or it was taken away). */
function termAt(list: PayTerm[], task: PayTask, t: number): PayTerm | null {
  let best: PayTerm | null = null;
  for (const x of list) if (x.task === task && x.at <= t && (!best || x.at > best.at || (x.at === best.at && x.id > best.id))) best = x;
  return best?.config ? best : null;
}

/** The members of the teams this person leads, himself included. */
async function teamOf(db: Db, managerId: number): Promise<number[]> {
  const teams = await getSetting(db, 'teams');
  const ids = new Set<number>([managerId]);
  for (const t of teams) if (t.managerId === managerId) for (const a of t.agentIds) ids.add(a);
  return [...ids];
}

// ---------------------------------------------------------------- what one order pays
type Item = { p: number; v: number | null; q: number; u: number; n: string };
type Orig = { productId: number; variantId: number | null; qty: number; unitPrice: number };

/** The order's main product (its price decides the plan's step) and the real upsell (extra articles delivered). */
export function payOrderShape(itemsRaw: unknown, origRaw: unknown, services: Set<number>) {
  const live = ((json(itemsRaw) as Item[] | null) ?? []).filter((i) => !services.has(num(i.p)));
  const key = (p: number, v: number | null) => `${p}:${v ?? ''}`;
  const origList = ((json(origRaw) as Orig[] | null) ?? live.map((i) => ({ productId: i.p, variantId: i.v, qty: i.q, unitPrice: i.u }))).filter((i) => !services.has(num(i.productId)));
  const origQty = new Map<string, number>();
  for (const o of origList) origQty.set(key(num(o.productId), o.variantId), (origQty.get(key(num(o.productId), o.variantId)) ?? 0) + num(o.qty));
  const liveQty = new Map<string, { q: number; u: number; n: string }>();
  for (const i of live) {
    const k = key(num(i.p), i.v);
    const e = liveQty.get(k) ?? { q: 0, u: num(i.u), n: String(i.n ?? '') };
    e.q += num(i.q);
    liveQty.set(k, e);
  }
  let extra = 0;
  for (const [k, e] of liveQty) extra += Math.max(0, e.q - (origQty.get(k) ?? 0));
  const first = origList[0] ? key(num(origList[0].productId), origList[0].variantId) : live[0] ? key(num(live[0].p), live[0].v) : null;
  const main = first ? liveQty.get(first) : undefined;
  const price = main ? main.u : origList[0] ? num(origList[0].unitPrice) : 0;
  const name = main?.n || live[0]?.n || '';
  const qty = main?.q ?? 0;
  const ordered = first ? (origQty.get(first) ?? 0) : 0;
  return { price, name, qty, ordered, extra };
}

/** The plan's amount for one order at this product price, and the step (price bracket) it falls in. */
export function planFee(p: ManagementPlanConfig, price: number): { fee: number; step: number | null } {
  if (p.method === 'fixed') return { fee: Math.round(p.rate), step: null };
  if (p.method === 'percent') return { fee: Math.round((price * p.rate) / 100), step: null };
  if (p.method === 'tier') {
    const b = planPriceBrackets(p);
    const i = b.findIndex((r) => price >= r.from && (r.to === null || price <= r.to));
    return { fee: i >= 0 ? Math.round(b[i].amount) : 0, step: i >= 0 ? i : null };
  }
  return { fee: 0, step: null };
}

function upsellFee(p: ManagementPlanConfig, fee: number, price: number, extra: number) {
  if (!p.upsell.enabled || extra <= 0) return 0;
  if (p.upsell.method === 'qty') return fee * extra;
  if (p.upsell.method === 'double') return fee;
  if (p.upsell.method === 'fixed') return Math.round(p.upsell.rate);
  return Math.round((price * p.upsell.rate) / 100) * extra;
}

export interface PayRow {
  kind: 'order' | 'salary';
  task: PayTask;
  orderId: number | null;
  ref: string | null;
  product: string;
  /** the main product's unit price (without delivery) */
  price: number;
  /** delivered articles of the main product, and how many the customer first ordered */
  qty: number;
  ordered: number;
  /** extra articles delivered (the real upsell) */
  extra: number;
  at: string;
  event: 'delivered' | 'confirmed' | 'prepared' | 'month';
  step: number | null;
  base: number;
  upsell: number;
  amount: number;
  /** a team leader's row: the agent who confirmed it */
  agent: string | null;
  plan: string;
}

const ITEMS = `(SELECT jsonb_agg(jsonb_build_object('p', i.product_id, 'v', i.variant_id, 'q', i.qty, 'u', i.unit_price, 'n', p.name) ORDER BY i.id)
   FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = o.id) AS items`;

/** Everything a person earned in [from, to), job by job, under the plans in force at each event. */
export async function payRows(db: Db, personId: number, terms: PayTerm[], from: number, to: number): Promise<PayRow[]> {
  const F = new Date(from).toISOString();
  const T = new Date(to).toISOString();
  const tasks = new Set(terms.map((t) => t.task));
  const agencySpace = SPACE.has(db);
  const servicesOf = async (d: Db) => new Set<number>((await d.query('SELECT id FROM products WHERE is_service')).map((r: any) => num(r.id)));
  let services = await servicesOf(db);
  const names = new Map<number, string>((await db.query('SELECT id, name FROM profiles')).map((r: any) => [num(r.id), String(r.name)]));
  const rows: PayRow[] = [];
  let store: string | null = null;
  const push = (task: PayTask, term: PayTerm, o: any, event: PayRow['event'], at: string, withBase: boolean, withUpsell: boolean, agentRaw: string | null) => {
    const agent = agentRaw ?? store;
    const s = payOrderShape(o.items, o.orig_items, services);
    const { fee, step } = planFee(term.config!, s.price);
    const base = withBase ? fee : 0;
    const up = withUpsell && (task === 'confirmation' || task === 'superviseur') ? upsellFee(term.config!, fee, s.price, s.extra) : 0;
    if (!base && !up && !(withBase && term.config!.method !== 'none')) return;
    rows.push({ kind: 'order', task, orderId: num(o.id), ref: String(o.ref), product: s.name, price: s.price, qty: s.qty, ordered: s.ordered, extra: withUpsell ? s.extra : 0, at, event, step, base, upsell: up, amount: base + up, agent, plan: term.name });
  };

  // confirmation (his own orders) and team leader (his team's orders): at delivery, or at confirmation for such a plan
  const sources = agencySpace ? await sourcesOf(db, personId) : [{ db, ids: [personId], agency: null, store: null } as Source];
  for (const src of sources) {
  services = src.db === db ? services : await servicesOf(src.db);
  store = src.store;
  for (const task of ['confirmation', 'superviseur'] as const) {
    if (!tasks.has(task) || (task === 'superviseur' && src.agency)) continue;
    const who = task === 'confirmation' ? src.ids : await teamOf(db, personId);
    const os = await src.db.query(
      `SELECT o.id, o.ref, o.agent_id, o.confirmed_at, o.delivered_at, o.follow_status, o.orig_items, ${ITEMS}
         FROM sales o
        WHERE o.agent_id = ANY($1) AND ($5::bigint IS NULL OR o.conf_agency_id = $5)
          AND ((o.follow_status = ANY($4) AND o.delivered_at >= $2 AND o.delivered_at < $3) OR (o.confirmed_at >= $2 AND o.confirmed_at < $3))`,
      [who, F, T, PAID, src.agency],
    );
    for (const o of os) {
      const agent = task === 'superviseur' ? (names.get(num(o.agent_id)) ?? null) : null;
      const del = o.delivered_at && PAID.includes(o.follow_status) ? Date.parse(iso(o.delivered_at)) : null;
      const conf = o.confirmed_at ? Date.parse(iso(o.confirmed_at)) : null;
      if (del !== null && del >= from && del < to) {
        const tm = termAt(terms, task, del);
        if (tm) push(task, tm, o, 'delivered', iso(o.delivered_at), tm.config!.trigger === 'delivered', true, agent);
      }
      if (conf !== null && conf >= from && conf < to) {
        const tm = termAt(terms, task, conf);
        if (tm && tm.config!.trigger === 'confirmed') push(task, tm, o, 'confirmed', iso(o.confirmed_at), true, false, agent);
      }
    }
  }
  // suivi: the parcels he followed that were delivered (no follow-up agent: whoever set « Livré »)
  if (tasks.has('suivi')) {
    const os = await src.db.query(
      `SELECT o.id, o.ref, o.delivered_at, o.orig_items, ${ITEMS}
         FROM sales o
        WHERE o.follow_status = ANY($4) AND o.delivered_at >= $2 AND o.delivered_at < $3 AND ($5::bigint IS NULL OR o.follow_agency_id = $5)
          AND (o.follow_agent_id = ANY($1) OR (o.follow_agent_id IS NULL AND (SELECT e.user_id FROM order_events e WHERE e.order_id = o.id AND e.kind = 'follow_status' AND e.to_value = 'delivered' ORDER BY e.at DESC LIMIT 1) = ANY($1)))`,
      [src.ids, F, T, PAID, src.agency],
    );
    for (const o of os) {
      const at = Date.parse(iso(o.delivered_at));
      const tm = termAt(terms, 'suivi', at);
      if (tm && tm.config!.trigger === 'delivered') push('suivi', tm, o, 'delivered', iso(o.delivered_at), true, false, null);
    }
  }
  }
  store = null;
  services = await servicesOf(db);
  // dépôt: each order he prepared first (preparing it again pays nobody)
  if (tasks.has('depot') && !agencySpace) {
    const os = await db.query(
      `SELECT o.id, o.ref, o.orig_items, f.at AS prepared_at, ${ITEMS}
         FROM (SELECT DISTINCT ON (e.order_id) e.order_id, e.user_id, e.at FROM order_events e
                WHERE e.kind = 'follow_status' AND e.to_value = 'prepared' AND e.user_id IS NOT NULL
                  AND e.order_id IN (SELECT order_id FROM order_events WHERE kind = 'follow_status' AND to_value = 'prepared' AND at >= $2 AND at < $3)
                ORDER BY e.order_id, e.at, e.id) f
         JOIN orders o ON o.id = f.order_id
        WHERE f.user_id = $1 AND f.at >= $2 AND f.at < $3`,
      [personId, F, T],
    );
    for (const o of os) {
      const at = Date.parse(iso(o.prepared_at));
      const tm = termAt(terms, 'depot', at);
      if (tm && tm.config!.trigger === 'prepared') push('depot', tm, o, 'prepared', iso(o.prepared_at), true, false, null);
    }
  }
  // a monthly salary: once a month, in the period holding the 1st of the month
  for (const task of PAY_TASKS) {
    if (!tasks.has(task)) continue;
    for (let m = payMonthStart(from); m < to; m = payMonthStart(m + 32 * 86_400_000)) {
      if (m < from) continue;
      const tm = termAt(terms, task, m);
      if (tm && tm.config!.monthly > 0)
        rows.push({ kind: 'salary', task, orderId: null, ref: null, product: '', price: 0, qty: 0, ordered: 0, extra: 0, at: new Date(m).toISOString(), event: 'month', step: null, base: Math.round(tm.config!.monthly), upsell: 0, amount: Math.round(tm.config!.monthly), agent: null, plan: tm.name });
    }
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at));
}

// ---------------------------------------------------------------- one person's money
type PayPayment = {
  id: number;
  kind: 'pay' | 'acompte';
  from: string | null;
  to: string | null;
  amount: number;
  caisse: string;
  caisseName: string | null;
  paidAt: string;
  paidBy: string | null;
  status: 'paid' | 'received' | 'not_received' | 'cancelled';
  answeredAt: string | null;
  note: string | null;
};

async function paymentsOf(db: Db, personId: number, limit = 200): Promise<PayPayment[]> {
  const rows = await db.query(
    `SELECT p.*, u.name AS paid_by_name FROM pay_payments p LEFT JOIN profiles u ON u.id = p.paid_by WHERE p.profile_id = $1 ORDER BY p.paid_at DESC, p.id DESC LIMIT $2`,
    [personId, limit],
  );
  const out: PayPayment[] = [];
  for (const r of rows)
    out.push({
      id: num(r.id),
      kind: r.kind,
      from: r.period_from ? iso(r.period_from) : null,
      to: r.period_to ? iso(r.period_to) : null,
      amount: num(r.amount),
      caisse: String(r.caisse),
      caisseName: await caisseLabelOf(db, String(r.caisse)),
      paidAt: iso(r.paid_at),
      paidBy: (r.paid_by_name as string | null) ?? null,
      status: r.status,
      answeredAt: r.answered_at ? iso(r.answered_at) : null,
      note: (r.note as string | null) ?? null,
    });
  return out;
}

export interface PayPeriodSum {
  from: string;
  to: string;
  earned: number;
  acomptes: number;
  net: number;
  orders: number;
  upsells: number;
}

const sumRows = (rows: PayRow[], from: number, to: number) => {
  const r = rows.filter((x) => {
    const t = Date.parse(x.at);
    return t >= from && t < to;
  });
  return { earned: r.reduce((s, x) => s + x.amount, 0), orders: r.filter((x) => x.kind === 'order').length, upsells: r.reduce((s, x) => s + x.extra, 0) };
};

/** Where a person's money stands: ready (closed, not paid), the open period, what is coming, acomptes, payments. */
export async function payLedger(db: Db, personId: number, now: number) {
  const cal = await payCalendarOf(db);
  const terms = (await termsOf(db, [personId])).get(personId) ?? [];
  const payments = await paymentsOf(db, personId);
  const live = payments.filter((p) => p.status !== 'cancelled');
  const current = payPeriodAt(cal, now);
  if (!terms.length) {
    return { cal, terms, start: null as string | null, paidUntil: null as string | null, ready: { periods: [] as PayPeriodSum[], total: 0 }, open: { from: new Date(current.from).toISOString(), to: new Date(current.to).toISOString(), earned: 0, acomptes: 0, net: 0, orders: 0, upsells: 0 }, owed: 0, rows: [] as PayRow[], payments };
  }
  const start = Math.min(...terms.map((t) => t.at));
  const pays = live.filter((p) => p.kind === 'pay');
  const paidUntil = Math.max(start, ...pays.map((p) => Date.parse(p.to!)));
  const rows = await payRows(db, personId, terms, paidUntil, current.to);
  const acomptes = live.filter((p) => p.kind === 'acompte' && Date.parse(p.paidAt) >= paidUntil);
  const acompteIn = (a: number, b: number) => acomptes.filter((p) => Date.parse(p.paidAt) >= a && Date.parse(p.paidAt) < b).reduce((s, p) => s + p.amount, 0);
  const periods: PayPeriodSum[] = [];
  for (const p of payPeriods(cal, paidUntil, now)) {
    const from = Math.max(p.from, paidUntil);
    if (p.to > now || from >= p.to) continue;
    const s = sumRows(rows, from, p.to);
    const a = acompteIn(from, p.to);
    periods.push({ from: new Date(from).toISOString(), to: new Date(p.to).toISOString(), earned: s.earned, acomptes: a, net: s.earned - a, orders: s.orders, upsells: s.upsells });
  }
  const readyTotal = periods.reduce((s, p) => s + p.net, 0);
  const oFrom = Math.max(current.from, paidUntil);
  const os = sumRows(rows, oFrom, current.to);
  const oa = acompteIn(oFrom, current.to);
  const open = { from: new Date(oFrom).toISOString(), to: new Date(current.to).toISOString(), earned: os.earned, acomptes: oa, net: os.earned - oa + Math.min(0, readyTotal), orders: os.orders, upsells: os.upsells };
  return {
    cal,
    terms,
    start: new Date(start).toISOString(),
    paidUntil: new Date(paidUntil).toISOString(),
    ready: { periods, total: readyTotal },
    open,
    owed: Math.max(0, readyTotal) + Math.max(0, open.net),
    rows,
    payments,
  };
}

/** Orders still on their way that will pay this person when delivered (an estimate under today's plans). */
async function coming(db: Db, personId: number, terms: PayTerm[], now: number) {
  const out = { count: 0, amount: 0 };
  const road = `(o.follow_status IS NULL OR o.follow_status IN ('to_prepare','prepared','shipped','out_for_delivery','failed','alert','in_exchange'))`;
  for (const src of await sourcesOf(db, personId)) {
  const services = new Set<number>((await src.db.query('SELECT id FROM products WHERE is_service')).map((r: any) => num(r.id)));
  for (const task of ['confirmation', 'superviseur', 'suivi'] as const) {
    const tm = termAt(terms, task, now);
    if (!tm || tm.config!.trigger !== 'delivered' || (task === 'superviseur' && src.agency)) continue;
    const os =
      task === 'suivi'
        ? await src.db.query(`SELECT o.id, o.orig_items, ${ITEMS} FROM sales o WHERE o.follow_agent_id = ANY($1) AND ($2::bigint IS NULL OR o.follow_agency_id = $2) AND o.conf_status = 'confirmed' AND ${road}`, [src.ids, src.agency])
        : await src.db.query(`SELECT o.id, o.orig_items, ${ITEMS} FROM sales o WHERE o.agent_id = ANY($1) AND ($2::bigint IS NULL OR o.conf_agency_id = $2) AND o.conf_status = 'confirmed' AND ${road}`, [task === 'confirmation' ? src.ids : await teamOf(db, personId), src.agency]);
    for (const o of os) {
      const s = payOrderShape(o.items, o.orig_items, services);
      const { fee } = planFee(tm.config!, s.price);
      out.count++;
      out.amount += fee;
    }
  }
  }
  return out;
}

/** How much this person may ask as an acompte right now, and why not when he can't. */
async function acompteRoom(db: Db, personId: number, now: number, open: { net: number }, payments: PayPayment[]) {
  const rule = await payAcompteOf(db);
  const month = payMonthStart(now);
  const taken = payments.filter((p) => p.kind === 'acompte' && p.status !== 'cancelled' && Date.parse(p.paidAt) >= month).reduce((s, p) => s + p.amount, 0);
  const pending = (await db.query(`SELECT id, amount, note, asked_at FROM pay_requests WHERE profile_id = $1 AND status = 'pending'`, [personId]))[0];
  const asked = pending ? num(pending.amount) : 0;
  const room = Math.max(0, Math.min(rule.max - taken - asked, open.net - asked));
  const why = rule.max <= 0 ? 'off' : pending ? 'pending' : payLocalDay(now) < rule.fromDay ? 'day' : room <= 0 ? (rule.max - taken <= 0 ? 'max' : 'earned') : null;
  return {
    max: rule.max,
    fromDay: rule.fromDay,
    taken,
    available: why === 'day' || why === 'off' || why === 'pending' ? 0 : room,
    why,
    pending: pending ? { id: num(pending.id), amount: num(pending.amount), note: (pending.note as string | null) ?? null, askedAt: iso(pending.asked_at) } : null,
  };
}

const termOut = (t: PayTerm) => ({ task: t.task, name: t.name, planId: t.planId, config: t.config!, since: new Date(t.at).toISOString() });

/** The plans in force now, one per job. */
function plansNow(terms: PayTerm[], now: number) {
  return PAY_TASKS.map((task) => termAt(terms, task, now)).filter((t): t is PayTerm => !!t).map(termOut);
}

async function admins(db: Db): Promise<number[]> {
  return (await db.query(`SELECT id FROM profiles WHERE active AND 'admin' = ANY(roles)`)).map((r: any) => num(r.id));
}

/** The people paid here (not owners, vendeurs or a partner agency's agents) and the jobs they must have a plan for. */
async function payPeople(db: Db) {
  const rows = await db.query(`SELECT id, name, roles, created_by FROM profiles WHERE active AND archived_at IS NULL AND agency_id IS NULL ORDER BY name`);
  // an administrator is paid only if he was given a plan (he may have none)
  const withPlan = new Set((await db.query('SELECT DISTINCT profile_id FROM pay_plan_slots')).map((r: any) => num(r.profile_id)));
  return rows
    .map((r: any) => ({ id: num(r.id), name: String(r.name), roles: (r.roles ?? []) as string[], createdBy: r.created_by === null || r.created_by === undefined ? null : num(r.created_by) }))
    .map((p: { id: number; name: string; roles: string[]; createdBy: number | null }) => ({ ...p, required: tasksOf(db, p.roles), allowed: tasksOf(db, p.roles, true) }))
    .filter((p: { id: number; required: PayTask[] }) => p.required.length > 0 || withPlan.has(p.id));
}

/** Red alerts for the owners: people without a plan for one of their jobs, payments an agent says he did not get. */
export async function payAlerts(db: Db, now: number) {
  const people = await payPeople(db);
  const terms = await termsOf(db, people.map((p) => p.id));
  const noPlan = people
    .map((p) => ({ id: p.id, name: p.name, createdBy: p.createdBy, missing: p.required.filter((t) => !termAt(terms.get(p.id) ?? [], t, now)) }))
    .filter((p) => p.missing.length > 0);
  const notReceived = (
    await db.query(`SELECT p.id, p.profile_id, p.amount, p.kind, p.answered_at, u.name FROM pay_payments p JOIN profiles u ON u.id = p.profile_id WHERE p.status = 'not_received' ORDER BY p.answered_at DESC`)
  ).map((r: any) => ({ id: num(r.id), personId: num(r.profile_id), name: String(r.name), amount: num(r.amount), kind: r.kind as 'pay' | 'acompte', at: r.answered_at ? iso(r.answered_at) : null }));
  return { noPlan, notReceived };
}

/** A person's full page (Ma caisse for himself, or the owner looking at him). */
async function personView(ctx: Ctx, personId: number) {
  const now = ctx.now();
  const l = await payLedger(ctx.db, personId, now);
  const room = await acompteRoom(ctx.db, personId, now, l.open, l.payments);
  const requests = (await ctx.db.query(`SELECT r.*, u.name AS decided_by_name FROM pay_requests r LEFT JOIN profiles u ON u.id = r.decided_by WHERE r.profile_id = $1 ORDER BY r.asked_at DESC LIMIT 30`, [personId])).map(
    (r: any) => ({ id: num(r.id), amount: num(r.amount), note: (r.note as string | null) ?? null, status: r.status as string, askedAt: iso(r.asked_at), decidedAt: r.decided_at ? iso(r.decided_at) : null, decidedBy: (r.decided_by_name as string | null) ?? null, reason: (r.reason as string | null) ?? null }),
  );
  const person = (await ctx.db.query('SELECT id, name, roles FROM profiles WHERE id = $1', [personId]))[0];
  const roles = ((person?.roles ?? []) as string[]) ?? [];
  return {
    person: { id: personId, name: String(person?.name ?? ''), required: tasksOf(ctx.db, roles), allowed: tasksOf(ctx.db, roles, true) },
    calendar: l.cal,
    plans: plansNow(l.terms, now),
    start: l.start,
    paidUntil: l.paidUntil,
    owed: l.owed,
    ready: l.ready,
    open: l.open,
    coming: await coming(ctx.db, personId, l.terms, now),
    acompte: room,
    payments: l.payments.slice(0, 60),
    toConfirm: l.payments.filter((p) => p.status === 'paid' || p.status === 'not_received'),
    requests,
    /** the open period's orders (newest first) */
    rows: l.rows.filter((r) => Date.parse(r.at) >= Date.parse(l.open.from)).slice(0, 300),
  };
}

// ---------------------------------------------------------------- giving plans
/** Gives (or takes away) a person's plan for one job. The first plan of a job counts from the start of the pay period. */
export async function assignPayPlan(db: Db, now: number, personId: number, task: PayTask, planId: number | null, by: number | null) {
  const target = (await db.query('SELECT id, roles, active, agency_id FROM profiles WHERE id = $1', [personId]))[0];
  if (!target || !target.active || target.agency_id) throw notFound('Choisissez une personne active de votre équipe');
  if (!tasksOf(db, target.roles ?? [], true).includes(task)) throw bad('Cette personne ne fait pas ce travail : donnez-lui d’abord le rôle dans Utilisateurs');
  const plan = planId === null ? null : (await db.query(`SELECT * FROM management_payment_plans WHERE id = $1 AND kind = 'agent' AND active`, [planId]))[0];
  if (planId !== null && !plan) throw bad('Plan introuvable ou archivé');
  const config = plan ? (json(plan.configuration) as ManagementPlanConfig) : null;
  if (config && agentPlanTask(config) !== task) throw bad('Ce plan est fait pour un autre travail');
  const before = (await db.query('SELECT 1 FROM pay_plan_terms WHERE profile_id = $1 AND task = $2 LIMIT 1', [personId, task])).length > 0;
  const cal = await payCalendarOf(db);
  const paid = (await db.query(`SELECT max(period_to) AS t FROM pay_payments WHERE profile_id = $1 AND kind = 'pay' AND status <> 'cancelled'`, [personId]))[0]?.t;
  const at = before ? now : Math.max(payPeriodAt(cal, now).from, paid ? Date.parse(iso(paid)) : 0);
  await db.tx(async (tx) => {
    await tx.query('INSERT INTO pay_plan_terms (profile_id, task, plan_id, name, configuration, effective_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
      personId,
      task,
      plan ? num(plan.id) : null,
      plan ? String(plan.name) : 'Plan retiré',
      config ? JSON.stringify({ ...config, agentTask: task }) : null,
      new Date(at).toISOString(),
      by,
    ]);
    if (plan) await tx.query('INSERT INTO pay_plan_slots (profile_id, task, plan_id, updated_at) VALUES ($1,$2,$3,now()) ON CONFLICT (profile_id, task) DO UPDATE SET plan_id = EXCLUDED.plan_id, updated_at = now()', [personId, task, num(plan.id)]);
    else await tx.query('DELETE FROM pay_plan_slots WHERE profile_id = $1 AND task = $2', [personId, task]);
  });
}


// ---------------------------------------------------------------- plans when a person is added or changed (Utilisateurs)
/** The active plans of each job, for the user form. */
async function planChoices(db: Db) {
  return (await db.query(`SELECT id, name, configuration FROM management_payment_plans WHERE kind = 'agent' AND active ORDER BY name`)).map((r: any) => ({
    id: num(r.id),
    name: String(r.name),
    task: agentPlanTask(json(r.configuration) as ManagementPlanConfig) as PayTask,
  }));
}

/**
 * Users › save: each job of the person (Confirmation, Suivi…) gets its plan. A job without a plan blocks the save when
 * the shop has a plan for that job (with none yet, the person is saved and stays in the red alert until he gets one).
 * Called before the save (check) and after it (write), with the plans the form sent.
 */
export async function payPlansOnSave(
  ctx: Ctx,
  p: { personId: number | null; roles: string[]; active: boolean; plans: { task: PayTask; planId: number }[] | undefined; write: boolean },
): Promise<void> {
  if (!payIsOn(ctx.shop)) return;
  paySpace(ctx);
  if (!p.active) return;
  const need = tasksOf(ctx.db, p.roles);
  const allowed = tasksOf(ctx.db, p.roles, true);
  const choices = await planChoices(ctx.db);
  const now = ctx.now();
  const terms = p.personId ? ((await termsOf(ctx.db, [p.personId])).get(p.personId) ?? []) : [];
  const given = new Map((p.plans ?? []).filter((x) => allowed.includes(x.task)).map((x) => [x.task, x.planId]));
  for (const [task, planId] of given) {
    const c = choices.find((x) => x.id === planId);
    if (!c || c.task !== task) throw bad('Plan de paie introuvable, archivé ou fait pour un autre travail');
  }
  if (!p.write) {
    const LABEL: Record<PayTask, string> = { confirmation: 'Confirmation', suivi: 'Suivi', superviseur: 'Superviseur', depot: 'Dépôt' };
    const missing = need.filter((t) => !given.has(t) && !termAt(terms, t, now) && choices.some((c) => c.task === t));
    if (missing.length) throw bad(`Choisissez le plan de paie : ${missing.map((t) => LABEL[t]).join(', ')}`);
    return;
  }
  for (const [task, planId] of given) {
    if (termAt(terms, task, now)?.planId === planId) continue;
    await assignPayPlan(ctx.db, now, p.personId!, task, planId, me(ctx));
  }
}

/** The people without a plan this person must hear about: an admin, all of them; someone else, those he added. */
async function noPlanFor(ctx: Ctx) {
  const all = (await payAlerts(ctx.db, ctx.now())).noPlan;
  return ctx.session.isAdmin ? all : all.filter((x) => x.createdBy === ctx.session.profile.id);
}

const TASK_FR: Record<PayTask, string> = { confirmation: 'confirmation', suivi: 'suivi', superviseur: 'superviseur', depot: 'dépôt' };
const PUSHED_KEY = 'payNoPlanPushedOn';

// ---------------------------------------------------------------- paying
const PERIOD_FMT = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: 'Africa/Algiers' });
function periodText(from: string, to: string) {
  const last = new Date(Date.parse(to) - 1);
  return `${PERIOD_FMT.format(new Date(from))} – ${PERIOD_FMT.format(last)}`;
}

/** Writes a payment and its « Salaire » expense in the caisse. */
export async function recordPayment(
  db: Db,
  p: { personId: number; kind: 'pay' | 'acompte'; from?: string; to?: string; amount: number; caisse: string; by: number | null; at?: string; requestId?: number; details?: unknown; status?: string; answeredAt?: string | null },
) {
  const name = String((await db.query('SELECT name FROM profiles WHERE id = $1', [p.personId]))[0]?.name ?? '');
  const note = p.kind === 'pay' ? `Paie ${periodText(p.from!, p.to!)} · ${name}` : `Acompte · ${name}`;
  const at = p.at ?? new Date().toISOString();
  return db.tx(async (tx) => {
    const m = await tx.query(`INSERT INTO cash_moves (caisse, amount, kind, category, note, created_by, created_at) VALUES ($1,$2,'expense','salary',$3,$4,$5) RETURNING id`, [p.caisse, -p.amount, note, p.by, at]);
    const r = await tx.query(
      `INSERT INTO pay_payments (profile_id, kind, period_from, period_to, amount, details, caisse, cash_move_id, request_id, paid_by, paid_at, status, answered_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [p.personId, p.kind, p.from ?? null, p.to ?? null, p.amount, p.details ? JSON.stringify(p.details) : null, p.caisse, num(m[0].id), p.requestId ?? null, p.by, at, p.status ?? 'paid', p.answeredAt ?? null],
    );
    if (p.requestId) await tx.query(`UPDATE pay_requests SET status = 'paid', decided_by = $2, decided_at = $3 WHERE id = $1`, [p.requestId, p.by, at]);
    return num(r[0].id);
  });
}

async function balanceOf(ctx: Ctx, key: string) {
  // an agency keeps no caisse in Pilotix: what it pays is written, never checked against a balance
  if (SPACE.has(ctx.db)) return null;
  return (await caisseChoices(ctx)).find((c) => c.key === key)?.balance ?? null;
}

// ---------------------------------------------------------------- procedures
const me = (ctx: Ctx) => ctx.session.profile.id;

/** Agent pay is a store's (payIsOn): in a partner's space, or a plan without Caisse › Paie, every action answers no. */
const PAY_OFF = 'La paie des agents n’est pas disponible ici';
const payProc: typeof proc = (roles, input, run) =>
  proc(roles, input, async (ctx, i) => {
    if (!payIsOn(ctx.shop)) throw forbidden(PAY_OFF);
    paySpace(ctx);
    return run(ctx, i);
  });

export const payProcs = {
  /** Ma caisse: my pay (ready, open period, coming), my plans, my acomptes, what was paid and waits for my answer. */
  'pay.mine': payProc([...STAFF], z.object({}), async (ctx) => personView(ctx, me(ctx))),

  /** The rows of one period (mine, or a person's for the owner). */
  'pay.rows': payProc([...STAFF], z.object({ personId: Id.optional(), from: z.string().datetime(), to: z.string().datetime() }), async (ctx, i) => {
    const pid = i.personId ?? me(ctx);
    if (pid !== me(ctx) && !ctx.session.isAdmin) throw forbidden('Vous ne voyez que votre propre paie');
    const terms = (await termsOf(ctx.db, [pid])).get(pid) ?? [];
    return payRows(ctx.db, pid, terms, Date.parse(i.from), Date.parse(i.to));
  }),

  /** Asks an acompte (never more than the room left). */
  'pay.ask': payProc([...STAFF], z.object({ amount: Money, note: z.string().trim().max(300).optional() }), async (ctx, i) => {
    const pid = me(ctx);
    const l = await payLedger(ctx.db, pid, ctx.now());
    if (!l.terms.length) throw bad('Vous n’avez pas encore de plan de paie : demandez à votre responsable');
    const room = await acompteRoom(ctx.db, pid, ctx.now(), l.open, l.payments);
    if (room.why === 'off') throw bad('La boutique ne donne pas d’acompte');
    if (room.why === 'pending') throw bad('Vous avez déjà une demande en attente');
    if (room.why === 'day') throw bad(`Les acomptes se demandent à partir du ${room.fromDay} du mois`);
    if (i.amount > room.available) throw bad(`Vous pouvez demander au plus ${room.available} DA`);
    await ctx.db.query('INSERT INTO pay_requests (profile_id, amount, note, asked_at) VALUES ($1,$2,$3,$4)', [pid, i.amount, i.note || null, new Date(ctx.now()).toISOString()]);
    await sendPush(ctx, await admins(ctx.db), { title: `${ctx.session.profile.name} demande un acompte`, body: `${i.amount} DA${i.note ? ` · ${i.note}` : ''}`, tag: `pay-ask-${pid}`, url: boardUrl(ctx.db) }).catch(() => 0);
    return { ok: true };
  }),
  'pay.askCancel': payProc([...STAFF], z.object({}), async (ctx) => {
    await ctx.db.query(`UPDATE pay_requests SET status = 'cancelled', decided_at = $2 WHERE profile_id = $1 AND status = 'pending'`, [me(ctx), new Date(ctx.now()).toISOString()]);
    return { ok: true };
  }),

  /** « Reçu » or « Pas encore reçu » for a payment made to me (the owners are told at once when it is not received). */
  'pay.answer': payProc([...STAFF], z.object({ paymentId: Id, received: z.boolean(), note: z.string().trim().max(300).optional() }), async (ctx, i) => {
    const p = (await ctx.db.query('SELECT * FROM pay_payments WHERE id = $1 AND profile_id = $2', [i.paymentId, me(ctx)]))[0];
    if (!p) throw notFound('Paiement introuvable');
    if (!['paid', 'not_received'].includes(p.status)) throw bad('Ce paiement est déjà confirmé ou annulé');
    const at = new Date(ctx.now()).toISOString();
    await ctx.db.query('UPDATE pay_payments SET status = $2, answered_at = $3, note = $4 WHERE id = $1', [i.paymentId, i.received ? 'received' : 'not_received', at, i.note || null]);
    if (!i.received) {
      const to = [...new Set([...(await admins(ctx.db)), ...(p.paid_by ? [num(p.paid_by)] : [])])];
      await sendPush(ctx, to, { title: `${ctx.session.profile.name} : paiement pas reçu`, body: `${num(p.amount)} DA marqués payés ne sont pas arrivés${i.note ? ` · ${i.note}` : ''}`, tag: `pay-not-${i.paymentId}`, url: boardUrl(ctx.db) }).catch(() => 0);
    }
    return { ok: true };
  }),


  /** The plans the user form offers, by job, and the jobs a set of roles needs (admins and user managers). */
  'pay.planChoices': payProc(null, z.object({ personId: Id.nullable().optional() }), async (ctx, i) => {
    if (!ctx.session.isAdmin && !ctx.session.canManageUsers) throw forbidden();
    const now = ctx.now();
    const terms = i.personId ? ((await termsOf(ctx.db, [i.personId])).get(i.personId) ?? []) : [];
    return {
      plans: await planChoices(ctx.db),
      current: PAY_TASKS.map((task) => termAt(terms, task, now)).filter((t): t is PayTerm => !!t).map((t) => ({ task: t.task, planId: t.planId })),
      tasks: { confirmation: tasksOf(ctx.db, ['confirmation']), suivi: tasksOf(ctx.db, ['suivi']), agent_manager: tasksOf(ctx.db, ['agent_manager'], true), depot: tasksOf(ctx.db, ['depot']) },
      kind: kindOf(ctx.db),
      plansUrl: SPACE.has(ctx.db) ? '#/equipe/paie' : '#/management/plans',
    };
  }),

  /** Utilisateurs: each person's plan per job now, and the jobs left without one (admins and user managers). */
  'pay.teamPlans': proc(null, z.object({}), async (ctx) => {
    if (!payIsOn(ctx.shop) || (!ctx.session.isAdmin && !ctx.session.canManageUsers)) return [];
    paySpace(ctx);
    const now = ctx.now();
    const people = await payPeople(ctx.db);
    const terms = await termsOf(ctx.db, people.map((p) => p.id));
    return people.map((p) => {
      const l = terms.get(p.id) ?? [];
      const plans = p.allowed.map((task) => termAt(l, task, now)).filter((x): x is PayTerm => !!x).map((x) => ({ task: x.task, name: x.name }));
      return { id: p.id, plans, missing: p.required.filter((task) => !plans.some((x) => x.task === task)) };
    });
  }),

  /** The red alert of the home page: the people without a plan (an admin: all; someone else: those he added). */
  'pay.noPlan': proc(null, z.object({}), async (ctx) => {
    if (!payIsOn(ctx.shop)) return { people: [], url: '' };
    paySpace(ctx);
    if (!ctx.session.isAdmin && !ctx.session.canManageUsers) return { people: [], url: boardUrl(ctx.db) };
    return { people: await noPlanFor(ctx), url: ctx.session.isAdmin ? boardUrl(ctx.db) : SPACE.has(ctx.db) ? '#/equipe/personnes' : '#/management/utilisateurs' };
  }),

  /**
   * Once a day (the morning job): each admin, and each person who added someone, hears who still has no plan.
   * Runs as the shop's system admin; a second run the same day sends nothing.
   */
  'pay.noPlanPush': proc([], z.object({}), async (ctx) => {
    if (!payIsOn(ctx.shop)) return { sent: 0 };
    paySpace(ctx);
    const now = ctx.now();
    const day = new Date(now + 3_600_000).toISOString().slice(0, 10);
    if ((await getRaw<string | null>(ctx.db, PUSHED_KEY, null)) === day) return { sent: 0, skipped: 'today' };
    const list = (await payAlerts(ctx.db, now)).noPlan;
    await setRaw(ctx.db, PUSHED_KEY, day);
    if (!list.length) return { sent: 0 };
    const text = (l: typeof list) => l.slice(0, 5).map((x) => `${x.name} (${x.missing.map((t) => TASK_FR[t]).join(', ')})`).join(' · ') + (l.length > 5 ? ` · +${l.length - 5}` : '');
    const adminIds = await admins(ctx.db);
    let sent = 0;
    await sendPush(ctx, adminIds, { title: `${list.length} personne(s) sans plan de paie`, body: text(list), tag: 'pay-noplan', url: boardUrl(ctx.db) }).catch(() => 0);
    sent += adminIds.length;
    const byCreator = new Map<number, typeof list>();
    for (const x of list) if (x.createdBy && !adminIds.includes(x.createdBy)) byCreator.set(x.createdBy, [...(byCreator.get(x.createdBy) ?? []), x]);
    for (const [who, l] of byCreator) {
      await sendPush(ctx, [who], { title: `${l.length} personne(s) ajoutée(s) par vous sans plan de paie`, body: text(l), tag: 'pay-noplan', url: SPACE.has(ctx.db) ? '#/equipe/personnes' : '#/management/utilisateurs' }).catch(() => 0);
      sent++;
    }
    return { sent };
  }),

  // ---------- the owner (Caisse › Paie)
  /** Everyone paid here: alerts, plans per job, ready / open / waiting money, acompte requests, settings, caisses. */
  'pay.board': payProc([], z.object({}), async (ctx) => {
    const now = ctx.now();
    const people = await payPeople(ctx.db);
    const out = [];
    for (const p of people) {
      const l = await payLedger(ctx.db, p.id, now);
      const plans = plansNow(l.terms, now);
      const req = (await ctx.db.query(`SELECT id, amount, note, asked_at FROM pay_requests WHERE profile_id = $1 AND status = 'pending'`, [p.id]))[0];
      out.push({
        id: p.id,
        name: p.name,
        roles: p.roles,
        required: p.required,
        allowed: p.allowed,
        plans,
        missing: p.required.filter((t) => !plans.some((x) => x.task === t)),
        owed: l.owed,
        ready: l.ready,
        open: l.open,
        waiting: l.payments.filter((x) => x.status === 'paid' || x.status === 'not_received'),
        lastPaid: l.payments.find((x) => x.kind === 'pay' && x.status !== 'cancelled') ?? null,
        request: req ? { id: num(req.id), amount: num(req.amount), note: (req.note as string | null) ?? null, askedAt: iso(req.asked_at) } : null,
      });
    }
    const plans = (await ctx.db.query(`SELECT id, name, configuration FROM management_payment_plans WHERE kind = 'agent' AND active ORDER BY name`)).map((r: any) => {
      const c = json(r.configuration) as ManagementPlanConfig;
      return { id: num(r.id), name: String(r.name), task: agentPlanTask(c), config: c };
    });
    return { now: new Date(now).toISOString(), calendar: await payCalendarOf(ctx.db), acompte: await payAcompteOf(ctx.db), alerts: await payAlerts(ctx.db, now), people: out, plans, cashless: SPACE.has(ctx.db), caisses: SPACE.has(ctx.db) ? [{ key: 'main', name: 'Paiement agence', balance: 0 }] : await caisseChoices(ctx) };
  }),

  /** One person seen by the owner (the same page as his Ma caisse). */
  'pay.person': payProc([], z.object({ personId: Id }), async (ctx, i) => personView(ctx, i.personId)),

  'pay.assign': payProc([], z.object({ personId: Id, task: z.enum(PAY_TASKS), planId: Id.nullable() }), async (ctx, i) => {
    await assignPayPlan(ctx.db, ctx.now(), i.personId, i.task, i.planId, me(ctx));
    return { ok: true };
  }),

  'pay.settings': payProc([], z.object({ calendar: Calendar, acompte: Acompte }), async (ctx, i) => {
    await setRaw(ctx.db, PAY_CALENDAR_KEY, i.calendar, me(ctx));
    await setRaw(ctx.db, PAY_ACOMPTE_KEY, i.acompte, me(ctx));
    return { ok: true };
  }),

  /** Pays everything ready for one person, or an acompte he asked, from a caisse. */
  'pay.pay': payProc(
    [],
    z.union([
      z.object({ kind: z.literal('pay'), personId: Id, caisse: CaisseKey, amount: Money }),
      z.object({ kind: z.literal('acompte'), requestId: Id, caisse: CaisseKey, amount: Money }),
    ]),
    async (ctx, i) => {
      if (i.caisse.startsWith('u')) throw bad('Payez depuis une caisse de la boutique');
      await checkCaisse(ctx.db, i.caisse);
      const now = ctx.now();
      const by = me(ctx);
      if (i.kind === 'acompte') {
        const r = (await ctx.db.query(`SELECT * FROM pay_requests WHERE id = $1`, [i.requestId]))[0];
        if (!r || r.status !== 'pending') throw notFound('Cette demande n’est plus en attente');
        if (i.amount > num(r.amount)) throw bad(`Au plus ${num(r.amount)} DA (le montant demandé)`);
        return withActionLock(ctx.db, `pay:${num(r.profile_id)}`, by, 'Un autre paiement de cette personne est en cours, réessayez', async () => {
          const bal = await balanceOf(ctx, i.caisse);
          if (bal !== null && bal < i.amount) throw bad(`Solde insuffisant : ${bal} DA dans cette caisse`);
          const id = await recordPayment(ctx.db, { personId: num(r.profile_id), kind: 'acompte', amount: i.amount, caisse: i.caisse, by, at: new Date(now).toISOString(), requestId: i.requestId });
          await sendPush(ctx, [num(r.profile_id)], { title: 'Ton acompte est payé', body: `${ctx.session.profile.name} a payé ${i.amount} DA. Tu l’as reçu ? Réponds dans ${mineName(ctx.db)}.`, tag: `pay-${id}`, url: mineUrl(ctx.db) }).catch(() => 0);
          return { id };
        });
      }
      return withActionLock(ctx.db, `pay:${i.personId}`, by, 'Un autre paiement de cette personne est en cours, réessayez', async () => {
        const l = await payLedger(ctx.db, i.personId, now);
        if (!l.ready.periods.length || l.ready.total <= 0) throw bad('Rien n’est prêt à payer pour cette personne');
        if (i.amount !== l.ready.total) throw bad(`Le montant a changé : ${l.ready.total} DA sont prêts, rechargez la page`);
        const bal = await balanceOf(ctx, i.caisse);
        if (bal !== null && bal < i.amount) throw bad(`Solde insuffisant : ${bal} DA dans cette caisse`);
        const from = l.paidUntil!;
        const to = l.ready.periods[l.ready.periods.length - 1].to;
        const rows = l.rows.filter((r) => Date.parse(r.at) >= Date.parse(from) && Date.parse(r.at) < Date.parse(to));
        const id = await recordPayment(ctx.db, { personId: i.personId, kind: 'pay', from, to, amount: i.amount, caisse: i.caisse, by, at: new Date(now).toISOString(), details: { periods: l.ready.periods, orders: rows.filter((r) => r.kind === 'order').length, earned: rows.reduce((s, r) => s + r.amount, 0) } });
        await sendPush(ctx, [i.personId], { title: 'Ta paie est payée', body: `${ctx.session.profile.name} a payé ${i.amount} DA (${periodText(from, to)}). Tu l’as reçue ? Réponds dans ${mineName(ctx.db)}.`, tag: `pay-${id}`, url: mineUrl(ctx.db) }).catch(() => 0);
        return { id };
      });
    },
  ),

  'pay.refuse': payProc([], z.object({ requestId: Id, reason: z.string().trim().max(300).optional() }), async (ctx, i) => {
    const r = (await ctx.db.query(`SELECT * FROM pay_requests WHERE id = $1 AND status = 'pending'`, [i.requestId]))[0];
    if (!r) throw notFound('Cette demande n’est plus en attente');
    await ctx.db.query(`UPDATE pay_requests SET status = 'refused', decided_by = $2, decided_at = $3, reason = $4 WHERE id = $1`, [i.requestId, me(ctx), new Date(ctx.now()).toISOString(), i.reason || null]);
    await sendPush(ctx, [num(r.profile_id)], { title: 'Acompte refusé', body: `${num(r.amount)} DA${i.reason ? ` · ${i.reason}` : ''}`, tag: `pay-ask-${num(r.profile_id)}`, url: mineUrl(ctx.db) }).catch(() => 0);
    return { ok: true };
  }),

  /** Cancels a payment (an acompte, or the person's last pay): its money goes back into the caisse. */
  'pay.cancel': payProc([], z.object({ paymentId: Id }), async (ctx, i) => {
    const p = (await ctx.db.query('SELECT * FROM pay_payments WHERE id = $1', [i.paymentId]))[0];
    if (!p || p.status === 'cancelled') throw notFound('Paiement introuvable');
    if (p.kind === 'pay') {
      const last = (await ctx.db.query(`SELECT id FROM pay_payments WHERE profile_id = $1 AND kind = 'pay' AND status <> 'cancelled' ORDER BY period_to DESC, id DESC LIMIT 1`, [p.profile_id]))[0];
      if (num(last?.id) !== i.paymentId) throw bad('Annulez d’abord le dernier paiement de cette personne');
    }
    const at = new Date(ctx.now()).toISOString();
    await ctx.db.tx(async (tx) => {
      await tx.query(`UPDATE pay_payments SET status = 'cancelled', cancelled_by = $2, cancelled_at = $3 WHERE id = $1`, [i.paymentId, me(ctx), at]);
      if (p.cash_move_id) await tx.query('UPDATE cash_moves SET cancelled_at = $2 WHERE id = $1 AND cancelled_at IS NULL', [p.cash_move_id, at]);
      if (p.request_id) await tx.query(`UPDATE pay_requests SET status = 'pending', decided_by = NULL, decided_at = NULL WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM pay_requests x WHERE x.profile_id = $2 AND x.status = 'pending')`, [p.request_id, p.profile_id]);
    });
    return { ok: true };
  }),
};
