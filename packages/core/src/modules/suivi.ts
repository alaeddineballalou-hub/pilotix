// Suivi des livraisons: alerts, treated alerts, delivered, cancelled parcels, swaps and claims (réclamations) to couriers / livreurs.
import type { Order, Page } from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, isoOrNull, num, numOrNull, Where } from '../db';
import { bad, Ctx, forbidden, hasRole, notFound, proc, withActionLock } from '../rpc';
import { getSetting, setSetting } from '../settings';
import { addWorkMinutes, algiersDayStart, workMinutes } from '@pilotix/shared';
import { getPrefs } from './prefs';
import { rotateTimes } from './assign';
import { cancelParcel, swapFees } from './delivery';
import { addEvent, FollowInput, getOrder, listOrders, ListInput, PICKED_UP_SQL, releasePicked, setFollow, withClientScores } from './orders';
import { agencyLead, agencyOf, agencyRowSql, andSql, queueSql, rowScopeSql } from './agencyscope';
import { findOrders } from './sav';
import { applyTrust, DRIVER_CLAIMS } from './trust';
import { KINDS } from '../couriers/kinds';
import { demoClaimFound, demoClaimState } from '../couriers/demo';
import type { ClaimCategory, ClaimFound, ClaimMessage, ClaimSent, ClaimState, ParcelInfo, SwapSent } from '../couriers/types';
import type { CourierKind } from '@pilotix/shared';
import { itemsKey, SWAP_API_KINDS, SWAP_SAME_WILAYA_ONLY, swapWayOf, WILAYAS } from '@pilotix/shared';

const id = z.number().int().positive();

// alertes_new / alertes_encours: the alerts nobody acted on yet, and those someone is working on (a call, a note…, or
// treated and waiting for the company: « Attend ZR »); resolus: the alerts the company then delivered (30 days) — the
// owner's way, 25 Nov 2026: Nouvelles alertes → En cours → Résolu (only when delivered) or Swap
export const SUIVI_TABS = ['enlivraison', 'alertes', 'alertes_new', 'alertes_encours', 'bloques', 'traites', 'livres', 'annules', 'swap', 'swapped', 'resolus'] as const;
export type SuiviTab = (typeof SUIVI_TABS)[number];
/** Where a parcel can be swapped from: it is still with the courier or the livreur. */
export const SWAP_FROM = ['returning', 'failed', 'alert', 'out_for_delivery', 'shipped'] as const;
export const CLAIM_STATUSES = ['waiting', 'still_waiting', 'resolved', 'lost'] as const;
/** a claim is over: « Résolue » (money or parcel back) or « Perdue » (refused, or never answered) */
const CLAIM_DONE = `('resolved', 'lost')`;
export const CLAIM_REASONS = ['relivrer', 'late', 'nocall', 'fakedeliv', 'fakeret', 'address', 'damaged', 'money', 'noreturn', 'other'] as const;
export const TREAT_WHAT = ['date', 'adresse', 'injoignable', 'autre'] as const;

const DAY = 86_400_000;
// The delivery overview includes every active parcel; Alertes remains its strict alert-only subset.
const IN_DELIVERY = ['shipped', 'out_for_delivery', 'failed', 'alert', 'in_exchange'] as const;
const readQueue = (ctx: Ctx) => hasRole(ctx.session, 'suivi') ? 'follow' as const : 'conf' as const;

/** Filters of each Suivi tab, expressed with the orders list. */
function tabFilter(tab: SuiviTab, now: number, agency = false): Partial<ListInput> {
  switch (tab) {
    case 'enlivraison':
      // an agency's suivi agent: only the parcels with no problem — one flagged as an alert moves to its « Alertes »;
      // its confirmation agent (no Alertes) sees every parcel of its orders on the road
      // only the parcels their company has (the owner's rule, 25 Nov 2026): one handed over and not taken yet is still in
      // Dispatchées (Dépôt, Confirmation › Confirmées)
      return { follow: agency ? IN_DELIVERY.filter((s) => s !== 'alert') : [...IN_DELIVERY], pickedUp: true, sort: 'shipped_at', dir: 'asc' };
    case 'bloques':
      // the ids come from stuckParcels (see suivi.list)
      return { follow: ['shipped', 'out_for_delivery', 'failed', 'in_exchange'], sort: 'shipped_at', dir: 'asc' };
    case 'alertes':
    case 'alertes_new':
      return { follow: ['alert'], sort: 'updated_at', dir: 'asc' };
    case 'alertes_encours':
      // the alerts someone works on, and the treated ones back on the road (« Attend ZR »): the ids come from suivi.list
      return { follow: ['alert', 'out_for_delivery', 'shipped', 'failed'], sort: 'updated_at', dir: 'asc' };
    case 'resolus':
      // the ids come from resolvedIds (suivi.list): delivered after an alert, these 30 days
      return { follow: ['delivered'], dateField: 'delivered_at', from: new Date(now - 30 * DAY).toISOString(), sort: 'delivered_at', dir: 'desc' };
    case 'traites':
      return { follow: ['out_for_delivery', 'shipped', 'failed'], subStatus: 'alert_traitee', sort: 'updated_at', dir: 'desc' };
    case 'livres':
      return { follow: ['delivered'], dateField: 'delivered_at', from: new Date(now - 30 * DAY).toISOString(), sort: 'delivered_at', dir: 'desc' };
    case 'annules':
      // Suivi › Annulés (the owner, 25 Nov 2026): the parcels coming or come back, and the ones a swap can still take (ZR's
      // « Commande annulée »…); the ids come from annulesIds (suivi.list)
      return { follow: [...SWAP_FROM, 'returned'], sort: 'updated_at', dir: 'desc' };
    case 'swap':
      // the ids come from swappableIds (see suivi.list): ZR's parcels while it takes a swap, the others coming back
      return { follow: [...SWAP_FROM], sort: 'updated_at', dir: 'desc' };
    case 'swapped':
      return { follow: ['cancelled'], subStatus: 'annule_swappe', sort: 'updated_at', dir: 'desc' };
  }
}

/** The clock of an alert: the first call (until someone acts on it), then the alert solved; in working minutes. */
export interface AlertClock {
  kind: 'call' | 'solve';
  dueAt: string;
  /** working minutes left (negative: late by that much) */
  left: number;
  state: 'ok' | 'soon' | 'late';
}

/** The clock of each alert among these orders (first call, then solved), with the shop's call slots and Préférences. */
export async function alertClocks(db: Db, ids: number[], now: number): Promise<Map<number, AlertClock>> {
  const out = new Map<number, AlertClock>();
  if (!ids.length) return out;
  const calls = await getSetting(db, 'calls');
  const clock = (await getPrefs(db)).suiviClock;
  const rows = await db.query(
    `SELECT o.id, a.at AS alert_at,
       -- someone acted on the alert: a call, a note, a treatment, a status, an edit (not a chat message or a bot's line)
       (SELECT min(e.at) FROM order_events e WHERE e.order_id = o.id AND e.at > a.at AND e.user_id IS NOT NULL
           AND e.kind IN ('call', 'note', 'sub_status', 'suivi_motif', 'suivi_stuck', 'follow_status', 'edit')) AS acted_at
       FROM orders o
       JOIN LATERAL (SELECT max(e.at) AS at FROM order_events e WHERE e.order_id = o.id AND e.kind = 'follow_status' AND e.to_value = 'alert') a ON true
      WHERE o.id = ANY($1) AND o.follow_status = 'alert'`,
    [ids],
  );
  for (const r of rows) {
    const start = r.alert_at ? Date.parse(iso(r.alert_at)) : now;
    const kind: AlertClock['kind'] = r.acted_at ? 'solve' : 'call';
    const total = (kind === 'call' ? clock.firstHours : clock.solveHours) * 60;
    const due = addWorkMinutes(start, total, calls);
    const left = Math.round(due > now ? workMinutes(now, due, calls) : -workMinutes(due, now, calls));
    out.set(num(r.id), { kind, dueAt: new Date(due).toISOString(), left, state: left < 0 ? 'late' : left <= total * 0.25 ? 'soon' : 'ok' });
  }
  return out;
}

/** The calls made on an alert (since it became one), counted as tries only when far enough apart (Préférences). */
export interface AlertTries {
  done: number;
  need: number;
  /** when the next call counts as a new try (null: now, or all done) */
  nextAt: string | null;
}

export async function alertTries(db: Db, ids: number[], now: number): Promise<Map<number, AlertTries>> {
  const out = new Map<number, AlertTries>();
  if (!ids.length) return out;
  const { calls: need, gapMinutes } = (await getPrefs(db)).suiviTries;
  const rows = await db.query(
    `SELECT o.id, COALESCE(array_agg(c.at ORDER BY c.at) FILTER (WHERE c.at IS NOT NULL), '{}') AS calls
       FROM orders o
       LEFT JOIN LATERAL (SELECT max(e.at) AS at FROM order_events e WHERE e.order_id = o.id AND e.kind = 'follow_status' AND e.to_value = 'alert') a ON true
       LEFT JOIN order_events c ON c.order_id = o.id AND c.kind = 'call' AND c.user_id IS NOT NULL AND (a.at IS NULL OR c.at >= a.at)
      WHERE o.id = ANY($1) GROUP BY o.id`,
    [ids],
  );
  for (const r of rows) {
    let done = 0;
    let last = -Infinity;
    for (const at of (r.calls ?? []) as (string | Date)[]) {
      const t = Date.parse(iso(at));
      if (t - last >= gapMinutes * 60_000) {
        done++;
        last = t;
      }
    }
    const next = last + gapMinutes * 60_000;
    out.set(num(r.id), { done: Math.min(done, need), need, nextAt: done >= need || next <= now ? null : new Date(next).toISOString() });
  }
  return out;
}

export interface SuiviRowExtra {
  stuck?: StuckInfo | null;
  /** how the alert was treated: « Résolu » or « Perdu », and its motif (Management › Motifs du Suivi) */
  motif: { outcome: 'resolved' | 'lost'; label: string } | null;
  clock: AlertClock | null;
  tries: AlertTries | null;
  companyKind: string | null;
  livreurPhone: string | null;
  claim: { id: number; status: string; createdAt: string; sentAt: string | null } | null;
  /** why the parcel is in alert (note of its last "alert" event), shown next to the tracking */
  alertReason: string | null;
  /** when the alert goes to another agent if nobody acts (Affectation › rotation), ms; null: it will not move */
  rotateAt: number | null;
}

async function extras(ctx: Ctx, orders: Order[], now = ctx.now()): Promise<Record<number, SuiviRowExtra>> {
  if (!orders.length) return {};
  const db = ctx.db;
  const ids = orders.map((o) => o.id);
  const alertIds = orders.filter((o) => o.followStatus === 'alert').map((o) => o.id);
  const clocks = await alertClocks(db, alertIds, now);
  const tries = await alertTries(db, alertIds, now);
  const rot = await rotateTimes(ctx, 'follow', alertIds);
  const rows = await db.query(
    `SELECT o.id, co.kind AS company_kind, lv.phone AS livreur_phone,
       (SELECT json_build_object('id', c.id, 'status', c.status, 'createdAt', c.created_at, 'sentAt', c.sent_at)
          FROM claims c WHERE c.order_id = o.id ORDER BY c.created_at DESC LIMIT 1) AS claim,
       (SELECT e.note FROM order_events e WHERE e.order_id = o.id AND e.kind = 'follow_status' AND e.to_value = 'alert' ORDER BY e.at DESC, e.id DESC LIMIT 1) AS alert_reason,
       (SELECT json_build_object('outcome', e.from_value, 'label', e.note) FROM order_events e WHERE e.order_id = o.id AND e.kind = 'suivi_motif' ORDER BY e.at DESC, e.id DESC LIMIT 1) AS motif
     FROM orders o LEFT JOIN delivery_companies co ON co.id = o.company_id LEFT JOIN profiles lv ON lv.id = o.livreur_id
     WHERE o.id = ANY($1)`,
    [ids],
  );
  const out: Record<number, SuiviRowExtra> = {};
  for (const r of rows) {
    const c = typeof r.claim === 'string' ? JSON.parse(r.claim) : r.claim;
    out[num(r.id)] = {
      motif: (() => {
        const m = typeof r.motif === 'string' ? JSON.parse(r.motif) : r.motif;
        return m && (m.outcome === 'resolved' || m.outcome === 'lost') ? { outcome: m.outcome, label: String(m.label ?? '') } : null;
      })(),
      clock: clocks.get(num(r.id)) ?? null,
      tries: tries.get(num(r.id)) ?? null,
      companyKind: r.company_kind ?? null,
      livreurPhone: r.livreur_phone ?? null,
      claim: c ? { id: num(c.id), status: c.status, createdAt: iso(c.createdAt), sentAt: isoOrNull(c.sentAt) } : null,
      alertReason: r.alert_reason ?? null,
      rotateAt: rot.get(num(r.id)) ?? null,
    };
  }
  return out;
}

/** The parcels « Swap » can take now: through its company's API while it allows it (ZR: the customer cancelled or never
 *  answered, the parcel still at its destination), else a parcel coming back (another company, our livreurs). */
/**
 * Suivi › Annulés: the parcels coming back (all) and back (since `from`, 30 days by default), and the ones a swap can
 * still take — what « Annulé › Retours » listed, with Swap's.
 */
async function annulesIds(ctx: Ctx, from?: string | null, to?: string | null): Promise<number[]> {
  const since = from ?? new Date(ctx.now() - 30 * DAY).toISOString();
  const back = await ctx.db.query(
    `SELECT o.id FROM sales o WHERE o.shipped_at IS NOT NULL AND (o.follow_status = 'returning'
        OR (o.follow_status = 'returned' AND coalesce(o.back_at, o.updated_at) >= $1${to ? ' AND coalesce(o.back_at, o.updated_at) < $2' : ''}))${andSql(queueSql(ctx, readQueue(ctx)))}
      ORDER BY coalesce(o.back_at, o.updated_at) DESC LIMIT 1500`,
    to ? [since, to] : [since],
  );
  return [...new Set([...(await swappableIds(ctx)), ...back.map((r: any) => num(r.id))])];
}

async function swappableIds(ctx: Ctx): Promise<number[]> {
  const rows = await ctx.db.query(
    `SELECT o.id, o.follow_status, o.ext_status, o.shipped_at, c.kind FROM sales o LEFT JOIN delivery_companies c ON c.id = o.company_id
     WHERE o.shipped_at IS NOT NULL AND o.follow_status IN ('shipped','out_for_delivery','failed','alert','returning')${andSql(queueSql(ctx, readQueue(ctx)))}
     ORDER BY o.updated_at DESC LIMIT 3000`,
  );
  return rows.filter((r: any) => swapWayOf({ followStatus: r.follow_status, extStatus: r.ext_status, shippedAt: isoOrNull(r.shipped_at) }, r.kind)).map((r: any) => num(r.id));
}

export async function suiviCounts(ctx: Ctx) {
  const d30 = new Date(ctx.now() - 30 * DAY).toISOString();
  // an agency's suivi agent: « En livraison » without the alerts (they are its « Alertes »); a confirmation agent: all
  const onRoad = agencyOf(ctx) !== null && hasRole(ctx.session, 'suivi') ? `'shipped','out_for_delivery','failed','in_exchange'` : `'shipped','out_for_delivery','failed','alert','in_exchange'`;
  const r = (
    await ctx.db.query(
      `SELECT
         count(*) FILTER (WHERE follow_status IN (${onRoad}) AND ${PICKED_UP_SQL('o')})::int AS enlivraison,
         count(*) FILTER (WHERE follow_status = 'alert')::int AS alertes,
         count(*) FILTER (WHERE sub_status = 'alert_traitee' AND follow_status IN ('out_for_delivery','shipped','failed'))::int AS traites,
         count(*) FILTER (WHERE follow_status = 'delivered' AND delivered_at >= $1)::int AS livres,
         count(*) FILTER (WHERE follow_status = 'returning')::int AS returning,
         count(*) FILTER (WHERE follow_status = 'cancelled' AND sub_status = 'annule_swappe')::int AS swapped
       FROM sales o WHERE follow_status IS NOT NULL${andSql(queueSql(ctx, readQueue(ctx)))}`,
      [d30],
    )
  )[0];
  // an agency's agents: the open claims on the agency's orders
  const ownClaims = rowScopeSql(ctx);
  const claims = !hasRole(ctx.session, 'suivi') && agencyOf(ctx) === null ? 0 : num((await ctx.db.query(`SELECT count(*)::int AS n FROM claims c WHERE c.status NOT IN ${CLAIM_DONE}${ownClaims ? ` AND c.order_id IN (SELECT o.id FROM orders o WHERE ${ownClaims})` : ''}`))[0]?.n);
  // the manager's red number: alerts nobody called in time
  const alertIds = (await ctx.db.query(`SELECT o.id FROM orders o WHERE o.follow_status = 'alert'${andSql(queueSql(ctx, readQueue(ctx)))}`)).map((x: any) => num(x.id));
  const clocks = await alertClocks(ctx.db, alertIds, ctx.now());
  const lateCall = [...clocks.values()].filter((c) => c.kind === 'call' && c.state === 'late').length;
  const lateSolve = [...clocks.values()].filter((c) => c.kind === 'solve' && c.state === 'late').length;
  const alertesNew = [...clocks.values()].filter((c) => c.kind === 'call').length;
  const stuckAll = await stuckParcels(ctx);
  const resolus = (await resolvedIds(ctx)).length;
  // Suivi › Annulés (the parcels coming back, back these 30 days, and the ones a swap can take)
  const annulesClair = (await annulesIds(ctx)).length;
  return {
    bloques: stuckAll.size,
    bloquesTodo: [...stuckAll.values()].filter((x) => !x.handled).length,
    lateCall,
    lateSolve,
    enlivraison: num(r.enlivraison),
    alertes: num(r.alertes),
    alertes_new: alertesNew,
    // in progress: someone acted on it, or it was treated and waits for the company (« Attend ZR »)
    alertes_encours: Math.max(0, num(r.alertes) - alertesNew) + num(r.traites),
    traites: num(r.traites),
    resolus,
    annulesClair,
    livres: num(r.livres),
    annules: num(r.returning) + num(r.swapped),
    swap: (await swappableIds(ctx)).length,
    swapped: num(r.swapped),
    claims,
  };
}

// ---------------------------------------------------------------- swap
/** The parcel's company at the courier, and whether that company swaps through its API (ZR). */
async function swapHead(db: Db, orderId: number) {
  const r = (await db.query('SELECT o.company_id, o.wilaya_id, o.tracking, o.ext_id, c.kind, c.name FROM orders o LEFT JOIN delivery_companies c ON c.id = o.company_id WHERE o.id = $1', [orderId]))[0];
  const kind = (r?.kind as string | null) ?? null;
  return { companyId: numOrNull(r?.company_id), companyName: (r?.name as string | null) ?? null, kind, viaApi: !!kind && SWAP_API_KINDS.includes(kind) && !!r?.tracking, wilayaId: num(r?.wilaya_id), tracking: (r?.tracking as string | null) ?? null, extId: (r?.ext_id as string | null) ?? null };
}
/** The products of an order in words (« 1 × Pouf (Beige) + 1 × Pouf (Bleu) »). */
const itemsText = (o: Order) => o.items.map((i) => `${i.qty} × ${i.name}${i.variantTitle ? ` (${i.variantTitle})` : ''}`).join(' + ');
/** Only an order that asks for exactly what is in the parcel can take it: the same products, variants and quantities —
 *  the parcel is never opened (owner's rule, 24 Nov 2026: « other variant never show it »). */
const sameParcel = (a: Order, b: Order) => itemsKey(a.items) === itemsKey(b.items);
/** A suivi agent gives a parcel to any waiting order of the shop, not only the orders given to him (the owner's choice,
 *  25 Nov 2026); an agency's agent: the agency's own orders only. Everyone else: the usual rule. */
const swapAccess = (ctx: Ctx) => (hasRole(ctx.session, 'suivi') ? ('swap' as const) : undefined);
const swapScopeSql = (ctx: Ctx) => (swapAccess(ctx) ? agencyRowSql(ctx) : rowScopeSql(ctx));

async function swapCandidates(ctx: Ctx, fromId: number, q?: string) {
  const from = await getOrder(ctx, fromId);
  const head = await swapHead(ctx.db, fromId);
  // ZR: a parcel in one of its 11 southern wilayas only goes to a customer of the same wilaya
  const sameWilayaOnly = head.viaApi && SWAP_SAME_WILAYA_ONLY.includes(from.wilayaId);
  const products = [...new Set(from.items.map((i) => i.productId))];
  let rows: Order[];
  if (q?.trim()) {
    // an agency's agent: only the agency's own orders get its parcels
    rows = await findOrders(ctx, q.trim(), 30, (w) => w.add(`o.conf_status = 'confirmed' AND (o.follow_status IS NULL OR o.follow_status IN ('to_prepare','prepared')) AND o.shipped_at IS NULL${andSql(swapScopeSql(ctx))}`), undefined, swapAccess(ctx));
  } else {
    // confirmed orders still at the depot with the parcel's products and nothing else: the same wilaya first
    const ids = await ctx.db.query(
      `SELECT o.id FROM sales o
       WHERE o.conf_status = 'confirmed' AND (o.follow_status IS NULL OR o.follow_status IN ('to_prepare','prepared')) AND o.shipped_at IS NULL AND o.id <> $1
         AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.product_id = ANY($2))
         AND NOT EXISTS (SELECT 1 FROM order_items j WHERE j.order_id = o.id AND NOT (j.product_id = ANY($2)))${andSql(swapScopeSql(ctx))}
       ORDER BY (o.wilaya_id = $3) DESC, o.confirmed_at ASC LIMIT 150`,
      [fromId, products, from.wilayaId],
    );
    rows = [];
    for (const r of ids) rows.push(await getOrder(ctx, num(r.id), ctx.db, swapAccess(ctx)));
  }
  // a stop-desk order takes the parcel only at a bureau of the parcel's company (the parcel goes there)
  const deskIds = [...new Set(rows.filter((x) => x.isStopdesk && x.stopdeskId).map((x) => x.stopdeskId!))];
  const deskCo = new Map<number, number | null>((deskIds.length ? await ctx.db.query('SELECT id, company_id FROM stopdesks WHERE id = ANY($1)', [deskIds]) : []).map((r: any) => [num(r.id), numOrNull(r.company_id)]));
  const deskOk = (x: Order) => !x.isStopdesk || !head.companyId || (!!x.stopdeskId && deskCo.get(x.stopdeskId) === head.companyId);
  // the parcel's company price to each candidate's place (home or bureau), next to what it costs now
  const fees = from.companyId ? await ctx.db.query('SELECT wilaya_id, home, desk FROM delivery_fees WHERE company_id = $1', [from.companyId]) : [];
  const now = num((await ctx.db.query('SELECT delivery_cost FROM orders WHERE id = $1', [fromId]))[0]?.delivery_cost);
  // what the company itself charges to swap (ZR: same wilaya / another wilaya)
  const sw = from.companyId ? await swapFees(ctx, from.companyId) : { same: null, other: null };
  const feeTo = (x: Order) => {
    const f = fees.find((r: any) => num(r.wilaya_id) === x.wilayaId);
    if (!f) return null;
    const v = x.isStopdesk ? num(f.desk) : num(f.home);
    return v > 0 ? v : null;
  };
  const norm = (c: string | null | undefined) => String(c ?? '').toLowerCase().replace(/[^a-z0-9؀-ۿ]/g, '');
  const list = rows
    .filter((x) => x.id !== fromId && !x.shippedAt && sameParcel(from, x) && (!sameWilayaOnly || x.wilayaId === from.wilayaId) && deskOk(x))
    .map((x) => {
      const fee = feeTo(x);
      const sameWilaya = x.wilayaId === from.wilayaId;
      return { ...x, swapFee: sameWilaya ? sw.same : sw.other, sameWilaya, sameCommune: sameWilaya && !!x.commune && norm(x.commune) === norm(from.commune), sameVariant: true, sameProduct: true, fee, feeDiff: fee !== null && now > 0 ? fee - now : null };
    })
    .sort(
      (a, b) =>
        Number(b.sameWilaya) - Number(a.sameWilaya) ||
        Number(b.sameCommune) - Number(a.sameCommune) ||
        Number(a.followStatus === 'prepared') - Number(b.followStatus === 'prepared') ||
        String(a.confirmedAt).localeCompare(String(b.confirmedAt)),
    )
    .slice(0, 30);
  // ZR itself, when the window opens: does it still take a swap of this parcel, how many were made, its prices
  let courier: { eligible: boolean; count: number; same: number | null; other: number | null } | null = null;
  if (head.viaApi && !q?.trim()) {
    if (!ctx.server || ctx.shop?.demo) courier = { eligible: true, count: 0, same: sw.same, other: sw.other };
    else {
      try {
        const info = (await ctx.server.courier('parcel', { companyId: head.companyId, item: { id: fromId, tracking: head.tracking, extId: head.extId } }, ctx)) as ParcelInfo;
        if (info?.swap) courier = { eligible: info.swap.eligible, count: info.swap.count, same: info.swap.sameCityPrice ?? sw.same, other: info.swap.differentCityPrice ?? sw.other };
      } catch {
        courier = null;
      }
    }
  }
  return { from, rows: list, viaApi: head.viaApi, company: head.companyName, sameWilayaOnly, courier };
}

export async function swapParcel(ctx: Ctx, fromId: number, toId: number, note?: string | null) {
  if (!hasRole(ctx.session, 'suivi')) {
    const source = await getOrder(ctx, fromId);
    // a confirmation agent: a parcel coming back, or one its company still lets swap (ZR: the customer cancelled)
    if (source.followStatus !== 'returning' && source.swapWay !== 'api') throw bad('Le colis doit être en retour');
    await getOrder(ctx, toId);
  }
  if (fromId === toId) throw bad('Choisissez une autre commande');
  const me = ctx.session.profile.id;
  // one swap at a time per parcel: a double click never sends (and pays) the same swap twice at its company
  return withActionLock(ctx.db, `swap:${fromId}`, me, 'Un swap est déjà en cours pour ce colis', async () => {
    const [fa, fb] = [await getOrder(ctx, fromId), await getOrder(ctx, toId, ctx.db, swapAccess(ctx))];
    // the parcel must still be with the company (or the livreur), the order confirmed and still at the depot — checked
    // before anything is asked to the company
    if (!fa.shippedAt || !(SWAP_FROM as readonly string[]).includes(fa.followStatus ?? '')) throw bad(`${fa.ref} : le colis n’est pas chez la société ou le livreur`);
    if (fb.confStatus !== 'confirmed') throw bad(`${fb.ref} : la commande n’est pas confirmée`);
    if (fb.shippedAt || !(fb.followStatus === null || ['to_prepare', 'prepared'].includes(fb.followStatus))) throw bad(`${fb.ref} : déjà expédiée`);
    if (!sameParcel(fa, fb)) throw bad(`${fb.ref} ne demande pas exactement les mêmes produits que le colis de ${fa.ref} (${itemsText(fa)}) : choisissez une commande identique`);
    const head = await swapHead(ctx.db, fromId);
    // what the company takes to give its parcel to another customer (same wilaya or another): counted on the order whose
    // customer did not take it, like a return fee (the owner's rule, 25 Nov 2026) — never on the new order's cost
    const sameWilaya = fa.wilayaId === fb.wilayaId;
    const sw = head.companyId ? await swapFees(ctx, head.companyId) : null;
    const swapFee = (sw ? (sameWilaya ? sw.same : sw.other) : null) ?? 0;
    if (head.viaApi && !sameWilaya && SWAP_SAME_WILAYA_ONLY.includes(fa.wilayaId))
      throw bad(`${head.companyName} : un colis à ${WILAYAS[fa.wilayaId - 1] ?? fa.wilayaId} ne peut être swappé que dans la même wilaya`);
    if (head.viaApi && fb.isStopdesk) {
      const sd = fb.stopdeskId ? (await ctx.db.query('SELECT company_id FROM stopdesks WHERE id = $1', [fb.stopdeskId]))[0] : null;
      if (!sd || numOrNull(sd.company_id) !== head.companyId) throw bad(`${fb.ref} : livraison au bureau d’une autre société — choisissez une commande à domicile ou à un bureau ${head.companyName}`);
    }
    // B's own parcel already made at its company (packed, label printed): cancelled there first — else the company would
    // still pick it up and bill it (two parcels for one customer); refused there: no swap, say why
    const own = (await ctx.db.query('SELECT ref, tracking, shipped_at, conf_status, follow_status FROM orders WHERE id = $1', [toId]))[0];
    const from = (await ctx.db.query('SELECT shipped_at, follow_status FROM orders WHERE id = $1', [fromId]))[0];
    // (the swap's own checks first: nothing is cancelled at the company for a swap that cannot be made)
    const canSwap = !!own && !!from?.shipped_at && (SWAP_FROM as readonly string[]).includes(from.follow_status ?? '') && own.conf_status === 'confirmed' && !own.shipped_at && (own.follow_status === null || ['to_prepare', 'prepared'].includes(own.follow_status));
    const live = head.viaApi && canSwap && !!ctx.server && !ctx.shop?.demo;
    // ZR asked first whether it still takes this swap: B's own parcel is never cancelled for a swap ZR would refuse
    if (live && own.tracking) {
      const info = (await ctx.server!.courier('parcel', { companyId: head.companyId, item: { id: fromId, tracking: head.tracking, extId: head.extId } }, ctx).catch(() => null)) as ParcelInfo | null;
      if (info?.swap && !info.swap.eligible) throw bad(`${head.companyName} n’accepte plus de swap pour ce colis (${[info.state, info.situation].filter(Boolean).join(' · ') || '—'})`);
    }
    if (canSwap && own.tracking) {
      try {
        await cancelParcel(ctx, toId);
      } catch (e) {
        throw bad(`${own.ref} : son propre colis chez la société n’a pas pu être annulé (${(e as Error)?.message ?? 'refusé'}). Annulez-le d’abord, puis refaites le swap.`);
      }
    }
    // through the company's API (ZR): it changes the parcel's customer, phones, address and amount itself, at once
    let sent: SwapSent | null = null;
    if (head.viaApi && canSwap) {
      if (!live) sent = { extId: null, parcelExtId: head.extId, tracking: head.tracking! };
      else {
        try {
          sent = (await ctx.server!.courier('swap', { companyId: head.companyId, item: { id: fromId, tracking: head.tracking, extId: head.extId }, orderId: toId }, ctx)) as SwapSent;
        } catch (e) {
          const why = (e as Error)?.message ?? `${head.companyName} refuse le swap`;
          if (own?.tracking) await addEvent(ctx.db, toId, me, 'note', null, 'event', `Son colis chez la société a été annulé pour un swap que ${head.companyName} a refusé : il repartira avec un nouveau colis`);
          throw bad(why);
        }
      }
    }
    const res = await ctx.db.tx(async (tx) => {
      const A = (await tx.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [fromId]))[0];
      const B = (await tx.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [toId]))[0];
      if (!A || !B) throw notFound('Commande introuvable');
      // made at the company already: Pilotix follows it, whatever happened here meanwhile (never two stories)
      if (!sent) {
        if (!A.shipped_at || !(SWAP_FROM as readonly string[]).includes(A.follow_status ?? '')) throw bad(`${A.ref} : le colis n’est pas chez la société ou le livreur`);
        if (B.conf_status !== 'confirmed') throw bad(`${B.ref} : la commande n’est pas confirmée`);
        if (B.shipped_at || !(B.follow_status === null || ['to_prepare', 'prepared'].includes(B.follow_status))) throw bad(`${B.ref} : déjà expédiée`);
      }
      const nowIso = new Date(ctx.now()).toISOString();
      // what the depot had already picked for B goes back on the shelf (B leaves with A's parcel)
      if (B.follow_status === 'to_prepare') await releasePicked(tx, num(B.id));
      // The parcel (and its stock, already out of the depot) goes to B: no new stock out for B, no return for A. B is
      // followed like any parcel on the road: by its own suivi agent, else by the one who followed A (the same team)
      const fAgent = numOrNull(B.follow_agent_id) ?? (numOrNull(A.follow_agency_id) === numOrNull(B.follow_agency_id) ? numOrNull(A.follow_agent_id) : null);
      await tx.query(
        `UPDATE orders SET company_id=$2, delivery_cost=$3, tracking=$4, ext_id=$5, label_url=$6, ext_status=NULL, ext_status_at=NULL, taken_at=NULL,
           warehouse_id=COALESCE($7, warehouse_id), livreur_id=$8, follow_status='out_for_delivery', sub_status='livraison_swappe',
           prepared_at=COALESCE(prepared_at, $9::timestamptz), shipped_at=$9::timestamptz, follow_agent_id=$10, updated_at=now(), version=version+1 WHERE id=$1`,
        [B.id, A.company_id, num(A.delivery_cost) || num(B.delivery_cost), sent?.tracking ?? A.tracking, sent?.parcelExtId ?? A.ext_id, sent ? null : A.label_url, A.warehouse_id, A.livreur_id, nowIso, fAgent],
      );
      await tx.query(
        `UPDATE orders SET follow_status='cancelled', sub_status='annule_swappe', tracking=NULL, ext_id=NULL, label_url=NULL, ext_status=NULL, ext_status_at=NULL, taken_at=NULL,
           updated_at=now(), version=version+1 WHERE id=$1`,
        [A.id],
      );
      const n = note ? ` · ${note}` : '';
      const atCo = sent ? ` · fait chez ${head.companyName} par API` : '';
      const viaApi = !!sent;
      // A keeps the swap fee (its own swap step), counted like a return fee everywhere a return fee counts
      const fee = swapFee ? ` · frais d’échange ${swapFee} DA (${sameWilaya ? 'même wilaya' : 'autre wilaya'}), comptés sur ${A.ref} comme un retour` : '';
      await addEvent(tx, num(A.id), me, 'follow_status', A.follow_status, 'cancelled', `Colis swappé vers ${B.ref}${atCo}${fee}${n}`, { swap_to: num(B.id), tracking: A.tracking, via_api: viaApi, swap_ext: sent?.extId ?? null, swap_fee: swapFee, swap_same: sameWilaya });
      await addEvent(tx, num(A.id), me, 'sub_status', A.sub_status, 'annule_swappe', null);
      const was = B.follow_status === 'prepared' ? ' · était En dispatch (emballée) : colis à défaire' : ' · retirée de En préparation';
      const newNo = sent && sent.tracking !== A.tracking ? ` · nouveau n° ${sent.tracking}` : '';
      // B's place before the swap: « Annuler le swap » puts it back (only a swap Pilotix made alone, never one made at ZR)
      const prev = { follow: B.follow_status ?? null, company: numOrNull(B.company_id), cost: num(B.delivery_cost), prepared: B.prepared_at ? iso(B.prepared_at) : null, warehouse: numOrNull(B.warehouse_id), livreur: numOrNull(B.livreur_id), fagent: numOrNull(B.follow_agent_id) };
      // (`fee_on`: the swap fee is A's — B's cost stays its normal delivery price)
      await addEvent(tx, num(B.id), me, 'follow_status', B.follow_status, 'out_for_delivery', `Colis swappé depuis ${A.ref} (${A.tracking ?? '—'})${atCo}${newNo}${was}${n}`, { swap_from: num(A.id), tracking: A.tracking, swap_fee: swapFee, fee_on: 'from', via_api: viaApi, swap_ext: sent?.extId ?? null, prev });
      await addEvent(tx, num(B.id), me, 'sub_status', B.sub_status, 'livraison_swappe', null);
      return {
        from: await getOrder(ctx, num(A.id), tx, swapAccess(ctx)),
        to: await getOrder(ctx, num(B.id), tx, swapAccess(ctx)),
        oldTracking: (A.tracking as string | null) ?? null,
        wasPrepared: B.follow_status === 'prepared',
        oldTotal: num(A.total),
        companyKind: head.kind,
        viaApi,
        swapFee,
      };
    });
    ctx.emit({ type: 'orders' });
    return res;
  });
}

/**
 * « Annuler le swap »: a swap Pilotix made alone (never one made at the company: ZR applies it and cannot undo it) goes
 * back — the parcel and its number return to the order it came from, as it was; the order that had received it waits at
 * the depot again for its own parcel (« À préparer »). Refused once that order is delivered, cashed or its parcel changed.
 */
export async function unswapParcel(ctx: Ctx, orderId: number) {
  const me = ctx.session.profile.id;
  // each order of a swap keeps it in its own history: the one that gave the parcel (swap_to), the one that got it (swap_from)
  const swapsOf = async (oid: number) =>
    (await ctx.db.query(`SELECT data FROM order_events WHERE order_id = $1 AND kind = 'follow_status' AND data IS NOT NULL ORDER BY at DESC, id DESC LIMIT 40`, [oid]))
      .map((e: any) => (typeof e.data === 'string' ? JSON.parse(e.data) : e.data) ?? {})
      .filter((d: any) => d.swap_from || d.swap_to);
  const mine = (await swapsOf(orderId))[0];
  if (!mine) throw bad('Pas de swap sur cette commande');
  const fromId = mine.swap_from ? num(mine.swap_from) : orderId;
  const toId = mine.swap_to ? num(mine.swap_to) : orderId;
  await getOrder(ctx, fromId, ctx.db, swapAccess(ctx));
  await getOrder(ctx, toId, ctx.db, swapAccess(ctx));
  const got = (await swapsOf(toId)).find((d: any) => num(d.swap_from) === fromId) as { tracking?: string | null; swap_fee?: number; fee_on?: string; via_api?: boolean; prev?: any } | undefined;
  if (got?.via_api) throw bad('Swap fait chez la société par API : elle l’a appliqué et ne l’annule pas. Changez le colis chez elle si besoin.');
  return withActionLock(ctx.db, `swap:${fromId}`, me, 'Un swap est déjà en cours pour ce colis', async () => {
    const res = await ctx.db.tx(async (tx) => {
      const A = (await tx.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [fromId]))[0];
      const B = (await tx.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [toId]))[0];
      if (!A || !B) throw notFound('Commande introuvable');
      if (A.sub_status !== 'annule_swappe' || A.follow_status !== 'cancelled') throw bad(`${A.ref} n’est plus « Annulé · swappé » : rien à annuler`);
      const tracking = got?.tracking ?? null;
      if (!B.tracking || (tracking && B.tracking !== tracking)) throw bad(`${B.ref} n’a plus le colis de ${A.ref} : rien à annuler`);
      if (B.cashed) throw bad(`${B.ref} est déjà encaissée : le swap ne peut plus être annulé`);
      if (['delivered', 'returned', 'exchanged', 'lost'].includes(B.follow_status ?? '')) throw bad(`${B.ref} est déjà « ${B.follow_status} » : le swap ne peut plus être annulé`);
      // the swap's own step on A (« Annulé · swappé »): where A was before it
      const back = (await tx.query(`SELECT from_value FROM order_events WHERE order_id = $1 AND kind = 'follow_status' AND to_value = 'cancelled' AND (data->>'swap_to')::bigint = $2 ORDER BY at DESC, id DESC LIMIT 1`, [A.id, B.id]))[0];
      const aWas = String(back?.from_value || 'returning');
      const prev = got?.prev ?? null;
      // the parcel and its number back on A (where B kept them), A as it was before the swap; the company's next status follows
      await tx.query(
        `UPDATE orders SET company_id=$2, tracking=$3, ext_id=$4, label_url=$5, ext_status=$6, ext_status_at=$7, follow_status=$8, sub_status=NULL,
           updated_at=now(), version=version+1 WHERE id=$1`,
        [A.id, B.company_id, B.tracking, B.ext_id, B.label_url, B.ext_status, B.ext_status_at, aWas],
      );
      // B back at the depot, to be prepared again with its own products (its stock never left: the parcel was A's), with
      // its own suivi agent again; a swap made before 25 Nov 2026 had its fee in B's cost: taken off
      const fagentBack = prev && 'fagent' in prev;
      await tx.query(
        `UPDATE orders SET follow_status='to_prepare', sub_status=NULL, tracking=NULL, ext_id=NULL, label_url=NULL, ext_status=NULL, ext_status_at=NULL, taken_at=NULL,
           shipped_at=NULL, prepared_at=$2::timestamptz, company_id=COALESCE($3, company_id), delivery_cost=$4, livreur_id=$5,
           follow_agent_id=CASE WHEN $6 THEN $7::bigint ELSE follow_agent_id END, updated_at=now(), version=version+1 WHERE id=$1`,
        [B.id, prev && prev.follow === 'prepared' ? prev.prepared : null, prev ? prev.company : null, prev ? num(prev.cost) : Math.max(0, num(B.delivery_cost) - (got?.fee_on === 'from' ? 0 : num(got?.swap_fee))), prev ? prev.livreur : null, fagentBack, fagentBack ? numOrNull(prev.fagent) : null],
      );
      await addEvent(tx, num(A.id), me, 'follow_status', 'cancelled', aWas, `Swap annulé : le colis ${B.tracking} revient à ${A.ref}`, { unswap: num(B.id) });
      await addEvent(tx, num(B.id), me, 'follow_status', B.follow_status, 'to_prepare', `Swap annulé : le colis de ${A.ref} n’est plus pour cette commande — à préparer avec son propre colis`, { unswap: num(A.id) });
      return { from: await getOrder(ctx, num(A.id), tx, swapAccess(ctx)), to: await getOrder(ctx, num(B.id), tx, swapAccess(ctx)) };
    });
    ctx.emit({ type: 'orders' });
    return res;
  });
}

/** For a swapped parcel: the order that received it. */
async function swapTarget(ctx: Ctx, fromId: number) {
  const from = await getOrder(ctx, fromId);
  const ev = (
    await ctx.db.query(`SELECT data FROM order_events WHERE order_id = $1 AND kind = 'follow_status' AND data IS NOT NULL ORDER BY at DESC, id DESC LIMIT 20`, [fromId])
  ).find((e: any) => {
    const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    return d?.swap_to;
  });
  if (!ev) throw notFound(`${from.ref} : commande qui a reçu le colis introuvable`);
  const d = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
  const to = await getOrder(ctx, num(d.swap_to), ctx.db, swapAccess(ctx));
  const kind = to.companyId ? (await ctx.db.query('SELECT kind FROM delivery_companies WHERE id=$1', [to.companyId]))[0]?.kind ?? null : null;
  // the company's swap fee, kept on the receiving order's own step
  const got = (await ctx.db.query(`SELECT data FROM order_events WHERE order_id = $1 AND kind = 'follow_status' AND data IS NOT NULL ORDER BY at DESC, id DESC LIMIT 40`, [to.id]))
    .map((e: any) => (typeof e.data === 'string' ? JSON.parse(e.data) : e.data) ?? {})
    .find((x: any) => num(x.swap_from) === fromId);
  return { from, to, oldTracking: (d.tracking as string | null) ?? to.tracking, oldTotal: from.total, companyKind: kind as string | null, viaApi: !!d.via_api, swapFee: num(got?.swap_fee) };
}

// ---------------------------------------------------------------- claims
/**
 * Where a claim stands: the company has 48 h to answer after each message; no answer → « À relancer » (a task for
 * the agent who opened it); still no answer after 2 relances → « Manager » (red); an answer → the agent decides;
 * « Résolue » or « Perdue » ends it.
 */
export type ClaimStage = 'wait' | 'answered' | 'relancer' | 'manager' | 'done';
export const CLAIM_WAIT_H = 48;
export const CLAIM_PUSHES = 2;

export interface Claim {
  stage: ClaimStage;
  /** relances sent (by WhatsApp / e-mail / phone, or through the API) */
  pushes: number;
  /** when the company should have answered the last message */
  dueAt: string;
  id: number;
  ref: string;
  orderId: number | null;
  orderRef: string | null;
  tracking: string | null;
  customerName: string | null;
  phone: string | null;
  companyId: number | null;
  companyName: string | null;
  livreurId: number | null;
  livreurName: string | null;
  livreurPhone: string | null;
  reason: string;
  details: string;
  message: string;
  channel: string;
  status: (typeof CLAIM_STATUSES)[number];
  notes: { at: string; userId: number | null; userName?: string | null; text: string; status?: string | null }[];
  createdBy: number | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  resolvedAt: string | null;
  /** created at the courier through its API (ZR): its id, number, last state, last answer, last refusal */
  extId: string | null;
  extRef: string | null;
  extStatus: string | null;
  extAnswer: string | null;
  extError: string | null;
  /** the courier takes réclamations through its API */
  viaApi: boolean;
  /** 'courier': made in the courier's own app (ZR) and brought into Pilotix; 'pilotix': made here */
  origin: 'pilotix' | 'courier';
  /** the courier's category it is in, in the courier's words (ZR: « Relancer un colis ») */
  extCategory: string | null;
  /** the courier's work on it is over (solved or refused): one closed here while still open there says so */
  extClosed: boolean;
  /** the agent who follows the parcel: a réclamation made in the courier's app is his to follow */
  followAgentId: number | null;
}

/** A line of a réclamation's history. `ext`: a message of the courier's conversation (its team's answers, or the shop's
 *  own messages: sent from Pilotix or written in the courier's app), kept once by the courier's id for it. */
interface ClaimNote {
  at: string;
  userId: number | null;
  text: string;
  status?: string | null;
  ext?: { id: string | null; by?: string | null; byId?: string | null; mine: boolean };
}

const claimRef = (n: number) => `REC-${String(n).padStart(4, '0')}`;
const CLAIM_SELECT = `SELECT c.*, o.ref AS order_ref, o.tracking, o.customer_name, o.phone, o.follow_agent_id, co.name AS company_name, co.kind AS company_kind, lv.name AS livreur_name, lv.phone AS livreur_phone, cb.name AS created_by_name
  FROM claims c LEFT JOIN orders o ON o.id = c.order_id LEFT JOIN delivery_companies co ON co.id = c.company_id
  LEFT JOIN profiles lv ON lv.id = c.livreur_id LEFT JOIN profiles cb ON cb.id = c.created_by`;

function toClaim(r: any, now = Date.now()): Claim {
  const notes: ClaimNote[] = typeof r.notes === 'string' ? JSON.parse(r.notes) : r.notes ?? [];
  // our follow-ups: relances from Pilotix, and the shop's own messages written in the courier's app
  const relances = notes.filter((n) => /^Relance/.test(n.text ?? '') || n.ext?.mine);
  const time = (n: ClaimNote) => Date.parse(n.at);
  const last = Math.max(Date.parse(iso(r.sent_at ?? r.created_at)), ...relances.map(time).filter((x) => !Number.isNaN(x)));
  const due = last + CLAIM_WAIT_H * 3_600_000;
  const done = r.status === 'resolved' || r.status === 'lost';
  // the courier answered when its team wrote after our last message (never our own messages read back from it); a
  // réclamation whose conversation was not read yet keeps the courier's last answer as before
  const theirs = notes.filter((n) => n.ext && !n.ext.mine).map(time).filter((x) => !Number.isNaN(x));
  const answered = theirs.length ? Math.max(...theirs) > last : !notes.some((n) => n.ext) && !!(r.ext_answer && String(r.ext_answer).trim());
  const stage: ClaimStage = done ? 'done' : answered ? 'answered' : now < due ? 'wait' : relances.length >= CLAIM_PUSHES ? 'manager' : 'relancer';
  return {
    stage,
    pushes: relances.length,
    dueAt: new Date(due).toISOString(),
    id: num(r.id),
    ref: claimRef(num(r.id)),
    orderId: numOrNull(r.order_id),
    orderRef: r.order_ref ?? null,
    tracking: r.tracking ?? null,
    customerName: r.customer_name ?? null,
    phone: r.phone ?? null,
    companyId: numOrNull(r.company_id),
    companyName: r.company_name ?? null,
    livreurId: numOrNull(r.livreur_id),
    livreurName: r.livreur_name ?? null,
    livreurPhone: r.livreur_phone ?? null,
    reason: r.reason,
    details: r.details ?? '',
    message: r.message,
    channel: r.channel,
    status: r.status,
    notes,
    createdBy: numOrNull(r.created_by),
    createdByName: r.created_by_name ?? null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at ?? r.created_at),
    sentAt: isoOrNull(r.sent_at),
    resolvedAt: isoOrNull(r.resolved_at),
    extId: r.ext_id ?? null,
    extRef: r.ext_ref ?? null,
    extStatus: r.ext_status ?? null,
    extAnswer: r.ext_answer ?? null,
    extError: r.ext_error ?? null,
    viaApi: r.livreur_id == null && !!KINDS[r.company_kind as CourierKind]?.claims,
    origin: r.ext_origin === 'courier' ? 'courier' : 'pilotix',
    extCategory: r.ext_category ?? null,
    extClosed: !!r.ext_closed,
    followAgentId: numOrNull(r.follow_agent_id),
  };
}

// ---------------------------------------------------------------- claims through the courier API (ZR)
const REASON_FR: Record<string, string> = {
  relivrer: 'Relivrer le colis', late: 'Retard de livraison', nocall: 'Le livreur n’a pas appelé le client', fakedeliv: 'Faux statut « livré »',
  fakeret: 'Faux statut « retour »', address: 'Changement d’adresse', damaged: 'Colis endommagé', money: 'Problème de versement',
  noreturn: 'Retour non reçu', other: 'Autre',
};

/** ZR's own 12 categories (read in its app, 25 Nov 2026), for the demo. */
const DEMO_CATS: ClaimCategory[] = [
  { id: 'demo-acc-commande', name: 'Accélération de la commande' },
  { id: 'demo-acc-encaissement', name: 'Accélération d’encaissement' },
  { id: 'demo-annulation', name: 'Annulation de la commande' },
  { id: 'demo-autre', name: 'Autre' },
  { id: 'demo-endommage', name: 'Colis endommagé' },
  { id: 'demo-perdu', name: 'Colis perdu' },
  { id: 'demo-retour', name: 'Demande de retour' },
  { id: 'demo-information', name: 'Demande d’information' },
  { id: 'demo-situations', name: 'Mise à jour des situations' },
  { id: 'demo-relancer', name: 'Relancer un colis' },
  { id: 'demo-reporter', name: 'Reporter un colis' },
  { id: 'demo-retard', name: 'Retard de livraison' },
];
/** The demo's ZR category for each of our reasons (as ZR's API chooses it when nobody picks one). */
const DEMO_CAT_OF: Record<string, string> = {
  relivrer: 'demo-relancer', late: 'demo-retard', nocall: 'demo-relancer', fakedeliv: 'demo-situations', fakeret: 'demo-situations',
  address: 'demo-autre', damaged: 'demo-endommage', money: 'demo-acc-encaissement', noreturn: 'demo-retour', other: 'demo-autre',
};

/** Sends a saved claim to the courier's API. Never throws: a refusal is kept on the claim (ext_error) and in its history. */
async function pushClaim(ctx: Ctx, cid: number, categoryId: string | null): Promise<Claim> {
  const cur = await getClaim(ctx.db, cid);
  if (!cur.viaApi || !cur.companyId) throw bad(`${cur.ref} : cette société ne prend pas les réclamations par API`);
  if (cur.extId) return cur;
  const o = (await ctx.db.query('SELECT id, ref, tracking, ext_id, customer_name, phone FROM orders WHERE id = $1', [cur.orderId]))[0];
  if (!o?.tracking) throw bad(`${cur.ref} : la commande n’a pas de numéro de suivi`);
  const me = ctx.session.profile.id;
  const nowIso = new Date(ctx.now()).toISOString();
  const reasonText = REASON_FR[cur.reason] ?? cur.reason;
  const description = [cur.details.trim() || reasonText, `Commande ${o.ref} · suivi ${o.tracking}`, `Client : ${o.customer_name ?? ''} ${o.phone ?? ''}`.trim()].join('\n');
  let sent: ClaimSent | null = null;
  let error: string | null = null;
  try {
    if (!ctx.server) {
      const cat = DEMO_CATS.find((x) => x.id === (categoryId ?? DEMO_CAT_OF[cur.reason] ?? 'demo-autre'));
      sent = { extId: `demo-${cid}`, extRef: o.tracking, status: 'En attente de traitement', category: cat?.name ?? null };
    }
    else
      sent = (await ctx.server.courier('claim', { companyId: cur.companyId, claim: { ref: cur.ref, item: { id: num(o.id), tracking: o.tracking, extId: o.ext_id ?? null }, reason: cur.reason, reasonText, categoryId, description } }, ctx)) as ClaimSent;
  } catch (e: any) {
    error = String(e?.message ?? 'Erreur').slice(0, 300);
  }
  const text = sent ? `Envoyée à ${cur.companyName ?? 'la société'} (API)${sent.extRef ? ` · n° ${sent.extRef}` : ''}` : `${cur.companyName ?? 'La société'} refuse : ${error}`;
  const notes = [...cur.notes, { at: nowIso, userId: me, text, status: null }];
  await ctx.db.query(
    `UPDATE claims SET notes = $2, ext_id = $3, ext_ref = $4, ext_status = $5, ext_error = $6, ext_category = COALESCE($8, ext_category),
       channel = CASE WHEN $3::text IS NULL THEN channel ELSE 'api' END,
       sent_at = CASE WHEN $3::text IS NULL THEN sent_at ELSE COALESCE(sent_at, $7::timestamptz) END, updated_at = $7::timestamptz WHERE id = $1`,
    [cid, JSON.stringify(notes), sent?.extId ?? null, sent?.extRef ?? null, sent?.status ?? null, error, nowIso, sent?.category ?? null],
  );
  if (cur.orderId) await addEvent(ctx.db, cur.orderId, me, 'note', null, 'event', `Réclamation ${cur.ref} : ${text}`.slice(0, 300));
  ctx.emit({ type: 'order', id: cur.orderId ?? undefined });
  return getClaim(ctx.db, cid);
}

/** Settings kept for the courier's réclamations: the shop's own account at the courier (per company, learned from the
 *  messages Pilotix sent), the ones deleted here (never brought in again) and where the last look for new ones stopped. */
const MINE_KEY = (companyId: number) => `claims_ext_mine_${companyId}`;
const GONE_KEY = 'claims_ext_gone';
const SEEN_KEY = (companyId: number) => `claims_ext_seen_${companyId}`;
/** each look goes back 2 days before the last one (a réclamation made while the last look was running is not missed) */
const SEEN_MARGIN_MS = 2 * 86_400_000;

async function readJson(db: Db, key: string): Promise<any> {
  const v = (await db.query('SELECT value FROM settings WHERE key = $1', [key]))[0]?.value;
  return typeof v === 'string' ? JSON.parse(v) : v ?? null;
}
async function writeJson(db: Db, key: string, value: unknown) {
  await db.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, JSON.stringify(value)]);
}

/** Our reason for a réclamation made in the courier's app, from its category (« Autre » when nothing fits). ZR's own 12,
 *  read in its app on 25 Nov 2026: Accélération de la commande → late, Accélération d'encaissement → money, Colis
 *  endommagé → damaged, Demande de retour → noreturn, Relancer / Reporter un colis → relivrer, Retard de livraison →
 *  late; Annulation de la commande, Colis perdu, Demande d'information, Mise à jour des situations, Autre → other (its
 *  own words stay on the réclamation). */
function reasonOfCategory(words: string): (typeof CLAIM_REASONS)[number] {
  const w = words.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const by: [(typeof CLAIM_REASONS)[number], RegExp][] = [
    ['money', /encaissement|paiement|versement|argent|montant/],
    ['late', /acceleration de la commande|retard|delai|bloque/],
    ['relivrer', /relancer|reporter|relivr|nouvelle tentative/],
    ['damaged', /endommag|casse|abim/],
    ['noreturn', /demande de retour|retour (non|pas) (recu|rendu)/],
    ['address', /adresse/],
    ['nocall', /appel|injoignable/],
  ];
  return by.find(([, re]) => re.test(w))?.[0] ?? 'other';
}

/** Brings into Pilotix the réclamations made in the courier's own app (ZR), so Pilotix shows the same ones as the courier:
 *  each on its order (found by the parcel's number), its words, the courier's state. Never one deleted here. */
async function importCourierClaims(ctx: Ctx, errors: string[]): Promise<number> {
  const kinds = Object.entries(KINDS).filter(([, k]) => k.claims).map(([kind]) => kind);
  const cos = await ctx.db.query(`SELECT id, name, kind FROM delivery_companies WHERE active AND kind = ANY($1) ORDER BY id`, [kinds]);
  const expanded = !ctx.server && (await ctx.db.query(`SELECT value FROM settings WHERE key = 'demoExpanded'`))[0]?.value === true;
  const gone = new Set<string>(((await readJson(ctx.db, GONE_KEY)) ?? []) as string[]);
  const nowIso = new Date(ctx.now()).toISOString();
  let added = 0;
  for (const co of cos) {
    const companyId = num(co.id);
    const seen = await readJson(ctx.db, SEEN_KEY(companyId));
    const since = seen?.at ? new Date(Date.parse(seen.at) - SEEN_MARGIN_MS).toISOString() : null;
    let found: ClaimFound[] = [];
    if (!ctx.server) {
      if (!expanded) continue;
      // the demo: two of its ZR parcels on the road have a réclamation made in ZR's app (chosen once, then always the same)
      const key = `claims_demo_zr_${companyId}`;
      let ids: number[] = (await readJson(ctx.db, key)) ?? [];
      if (!ids.length) {
        ids = (
          await ctx.db.query(`SELECT id FROM orders WHERE company_id = $1 AND tracking IS NOT NULL AND shipped_at IS NOT NULL AND follow_status IN ('shipped', 'out_for_delivery', 'alert', 'failed') ORDER BY id DESC LIMIT 2`, [companyId])
        ).map((o: any) => num(o.id));
        await writeJson(ctx.db, key, ids);
      }
      const os = await ctx.db.query(`SELECT id, tracking, shipped_at FROM orders WHERE id = ANY($1) AND tracking IS NOT NULL AND shipped_at IS NOT NULL ORDER BY id`, [ids]);
      found = os.map((o: any) => demoClaimFound(num(o.id), String(o.tracking), iso(o.shipped_at), ctx.now()));
    } else
      try {
        found = (await ctx.server.courier('claimList', { companyId, since }, ctx)) as ClaimFound[];
      } catch (e: any) {
        errors.push(String(e?.message ?? 'Erreur'));
        continue;
      }
    const known = new Set<string>(
      (await ctx.db.query('SELECT ext_id FROM claims WHERE company_id = $1 AND ext_id = ANY($2)', [companyId, found.map((f) => f.extId)])).map((r: any) => String(r.ext_id)),
    );
    for (const f of found) {
      if (known.has(f.extId) || gone.has(`${companyId}:${f.extId}`)) continue;
      known.add(f.extId);
      const o = (
        await ctx.db.query(
          `SELECT id FROM orders WHERE company_id = $1 AND ((tracking IS NOT NULL AND tracking = $2) OR (ext_id IS NOT NULL AND ext_id = $3)) ORDER BY id DESC LIMIT 1`,
          [companyId, f.tracking ?? '', f.parcelExtId ?? ''],
        )
      )[0];
      // only a parcel Pilotix knows (owner's choice, 25 Nov 2026): the ones from before Pilotix stay at ZR only
      if (!o) continue;
      const at = f.createdAt && !Number.isNaN(Date.parse(f.createdAt)) ? new Date(f.createdAt).toISOString() : nowIso;
      // ZR's names can end with a space (« Reporter un colis »)
      const category = f.category?.trim() || null;
      const words = category || f.title || '';
      const status = f.closed ? (f.refused ? 'lost' : 'resolved') : 'waiting';
      const notes: ClaimNote[] = [{ at, userId: null, text: `Créée dans l’espace ${co.name}${category ? ` · ${category}` : ''}`, status: null }];
      if (f.closed) notes.push({ at: nowIso, userId: null, text: `Statut ${co.name} : ${f.status} · ${CLAIM_STATUS_FR[status]}`, status });
      const r = (
        await ctx.db.query(
          `INSERT INTO claims (order_id, company_id, livreur_id, reason, details, message, channel, status, created_by, notes, created_at, updated_at, sent_at, resolved_at,
             ext_id, ext_ref, ext_status, ext_origin, ext_category, ext_closed, ext_synced_at)
           VALUES ($1, $2, NULL, $3, $4, $5, 'api', $6, NULL, $7, $8::timestamptz, $9::timestamptz, $8::timestamptz, CASE WHEN $6 = 'resolved' THEN $9::timestamptz END,
             $10, $11, $12, 'courier', $13, $14, $9::timestamptz) RETURNING id`,
          [
            num(o.id),
            companyId,
            reasonOfCategory(words),
            (f.description || f.title || f.category || '').slice(0, 1000),
            (f.description || f.title || '').slice(0, 4000),
            status,
            JSON.stringify(notes),
            at,
            nowIso,
            f.extId,
            f.extRef,
            f.status,
            category,
            f.closed,
          ],
        )
      )[0];
      added++;
      await addEvent(ctx.db, num(o.id), null, 'note', null, 'event', `Réclamation ${claimRef(num(r.id))} créée dans l’espace ${co.name}${category ? ` : ${category}` : ''}`.slice(0, 300));
    }
    await writeJson(ctx.db, SEEN_KEY(companyId), { at: nowIso });
  }
  return added;
}

/** Which messages of the courier's conversations are the shop's own: the ones Pilotix sent (their ids, else their text),
 *  then every message from the same account at the courier (the shop also writes in the courier's app with it). */
function mineOf(list: { notes: ClaimNote[] }[], states: ClaimState[], known: string[]) {
  const ids = new Set<string>();
  const texts = new Set<string>();
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();
  for (const r of list)
    for (const n of r.notes) {
      // a message Pilotix sent: « Relance envoyée à ZR (API) : … » (also those sent before their id was kept)
      if (n.userId == null || !(n.ext?.mine || /^Relance/.test(n.text ?? ''))) continue;
      if (n.ext?.id) ids.add(n.ext.id);
      const sent = /\(API\) : ([\s\S]*)$/.exec(n.text ?? '')?.[1];
      if (sent) texts.add(norm(sent));
    }
  const authors = new Set<string>(known);
  for (const st of states) for (const m of st.messages ?? []) if (m.byId && (ids.has(m.id) || texts.has(norm(m.text)))) authors.add(m.byId);
  return { authors, mine: (m: ClaimMessage) => ids.has(m.id) || texts.has(norm(m.text)) || (!!m.byId && authors.has(m.byId)) };
}

/** Reads back from the courier (ZR) its réclamations: the ones made in its own app come in, and each one followed here
 *  gets the courier's state and its whole conversation (its team's answers; the shop's own messages are never taken for
 *  an answer). Closed by the courier: « Résolue », or « Perdue » when it refused. One closed here while the courier still
 *  works on it keeps being read, so it shows that it is still open there. */
async function syncClaims(ctx: Ctx, onlyId?: number) {
  const errors: string[] = [];
  const added = onlyId ? 0 : await importCourierClaims(ctx, errors);
  const rows = await ctx.db.query(
    `SELECT c.id, c.company_id, c.ext_id, c.ext_status, c.ext_answer, c.ext_closed, c.sent_at, c.notes, c.order_id, c.status, co.name AS company_name FROM claims c
     LEFT JOIN delivery_companies co ON co.id = c.company_id
     WHERE c.ext_id IS NOT NULL AND (c.status NOT IN ${CLAIM_DONE} OR NOT c.ext_closed) ${onlyId ? 'AND c.id = $1' : ''} ORDER BY c.updated_at LIMIT 200`,
    onlyId ? [onlyId] : [],
  );
  let changed = added;
  let checked = 0;
  const byCompany = new Map<number, any[]>();
  for (const r of rows) {
    r.notes = typeof r.notes === 'string' ? JSON.parse(r.notes) : r.notes ?? [];
    byCompany.set(num(r.company_id), [...(byCompany.get(num(r.company_id)) ?? []), r]);
  }
  const nowIso = new Date(ctx.now()).toISOString();
  const expanded = !ctx.server && (await ctx.db.query(`SELECT value FROM settings WHERE key = 'demoExpanded'`))[0]?.value === true;
  for (const [companyId, list] of byCompany) {
    const name = String(list[0].company_name ?? 'La société');
    let states: ClaimState[] = [];
    if (!ctx.server) states = list.map((r) => expanded ? demoClaimState(r.ext_id, num(r.id), r.sent_at ? iso(r.sent_at) : null, ctx.now()) : { extId: r.ext_id, status: r.ext_status || 'Nouvelle', resolved: false });
    else
      try {
        states = (await ctx.server.courier('claimStates', { companyId, extIds: [...new Set(list.map((r) => String(r.ext_id)))] }, ctx)) as ClaimState[];
      } catch (e: any) {
        errors.push(String(e?.message ?? 'Erreur'));
        continue;
      }
    const knownMine: string[] = (await readJson(ctx.db, MINE_KEY(companyId))) ?? [];
    // the demo: the shop's account at its fake ZR
    if (!ctx.server && expanded && !knownMine.includes('demo-shop')) knownMine.push('demo-shop');
    const { authors, mine } = mineOf(list, states, knownMine);
    if (authors.size !== knownMine.length) await writeJson(ctx.db, MINE_KEY(companyId), [...authors]);
    for (const r of list) {
      const st = states.find((x) => x.extId === r.ext_id);
      if (!st) continue;
      checked++;
      const notes: ClaimNote[] = r.notes;
      const parts: string[] = [];
      // the conversation: each message once, in its own time; ours are kept apart from the courier's answers
      let answer: string | null = null;
      for (const m of st.messages ?? []) {
        const ours = mine(m);
        if (!ours) answer = `${m.by ? `${m.by} : ` : ''}${m.text}`;
        // already in the history: read before, or one Pilotix sent itself (its relance line)
        const had = notes.find((n) => (n.ext?.id && n.ext.id === m.id) || (ours && n.userId != null && !n.ext?.id && /^Relance/.test(n.text ?? '') && n.text.trim().endsWith(m.text.trim())));
        if (had) {
          if (!had.ext?.id) had.ext = { ...(had.ext ?? { mine: true }), id: m.id, mine: true };
          continue;
        }
        notes.push({
          at: m.at && !Number.isNaN(Date.parse(m.at)) ? new Date(m.at).toISOString() : nowIso,
          userId: null,
          text: ours ? `Vous, dans l’espace ${name} : ${m.text}` : `${name}${m.by ? ` (${m.by})` : ''} : ${m.text}`,
          status: null,
          ext: { id: m.id, by: m.by, byId: m.byId, mine: ours },
        });
        parts.push(ours ? 'message de la boutique' : `réponse de ${name}`);
      }
      if (st.messages === undefined) answer = st.answer ?? null;
      const closed = !!(st.closed ?? st.resolved);
      if (st.status && st.status !== r.ext_status) parts.push(`Statut ${name} : ${st.status}`);
      // closed by the courier while still open here: « Résolue », or « Perdue » when it refused
      const open = r.status !== 'resolved' && r.status !== 'lost';
      const status = open && closed ? (st.refused ? 'lost' : 'resolved') : r.status;
      if (!parts.length && status === r.status && closed === !!r.ext_closed && (answer ?? null) === (r.ext_answer ?? null)) {
        await ctx.db.query('UPDATE claims SET ext_synced_at = $2 WHERE id = $1', [r.id, nowIso]);
        continue;
      }
      changed++;
      notes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      if (status !== r.status) notes.push({ at: nowIso, userId: null, text: `Fermée par ${name} : ${CLAIM_STATUS_FR[status]}`, status });
      await ctx.db.query(
        `UPDATE claims SET ext_status = $2, ext_answer = $3, status = $4, notes = $5, ext_closed = $7, ext_synced_at = $6::timestamptz, updated_at = $6::timestamptz,
           resolved_at = CASE WHEN $4 = 'resolved' THEN COALESCE(resolved_at, $6::timestamptz) ELSE resolved_at END WHERE id = $1`,
        [r.id, st.status || r.ext_status, answer, status, JSON.stringify(notes), nowIso, closed],
      );
      if (r.order_id && parts.length) await addEvent(ctx.db, num(r.order_id), null, 'note', null, 'event', `Réclamation ${claimRef(num(r.id))} : ${parts.join(' · ')}`.slice(0, 300));
    }
  }
  if (changed) ctx.emit({ type: 'orders' });
  return { checked, changed, added, errors };
}

async function getClaim(db: Db, cid: number) {
  const r = (await db.query(`${CLAIM_SELECT} WHERE c.id = $1`, [cid]))[0];
  if (!r) throw notFound('Réclamation introuvable');
  return toClaim(r);
}

const ClaimsInput = z.object({
  target: z.enum(['company', 'livreur', 'all']).default('all'),
  status: z.enum([...CLAIM_STATUSES, 'open', 'all', 'todo', 'manager', 'answered']).default('all'),
  orderId: id.optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(500).default(100),
});

async function listClaims(ctx: Ctx, f: z.infer<typeof ClaimsInput>): Promise<Page<Claim> & { counts: Record<string, number> }> {
  const w = new Where();
  if (f.target === 'company') w.add('c.livreur_id IS NULL');
  if (f.target === 'livreur') w.add('c.livreur_id IS NOT NULL');
  if (f.orderId) w.add('c.order_id = ?', f.orderId);
  // an agency's agent: the claims on the agency's orders only
  const own = rowScopeSql(ctx);
  if (own) w.add(`c.order_id IN (SELECT o.id FROM orders o WHERE ${own})`);
  const base = w.sql;
  const cnt = await ctx.db.query(`SELECT c.status AS k, count(*)::int AS n FROM claims c ${base} GROUP BY 1`, w.params);
  const counts: Record<string, number> = { waiting: 0, still_waiting: 0, resolved: 0, lost: 0 };
  for (const r of cnt) counts[r.k] = num(r.n);
  counts.open = counts.waiting + counts.still_waiting;
  counts.all = counts.open + counts.resolved + counts.lost;
  // the stages are worked out from the open claims: « À relancer » (the agent's own), « Manager »
  const me = ctx.session.profile.id;
  const open = (await ctx.db.query(`${CLAIM_SELECT} ${base ? `${base} AND` : 'WHERE'} c.status NOT IN ${CLAIM_DONE} ORDER BY c.created_at`, w.params)).map((r: any) => toClaim(r, ctx.now()));
  // a réclamation made in the courier's app belongs to the agent who follows the parcel
  const mine = (c: Claim) => c.createdBy === me || (c.createdBy == null && c.origin === 'courier' && c.followAgentId === me) || ctx.session.isAdmin;
  counts.todo = open.filter((c) => c.stage === 'relancer' && mine(c)).length;
  counts.answered = open.filter((c) => c.stage === 'answered').length;
  counts.manager = open.filter((c) => c.stage === 'manager').length;
  counts.late = open.filter((c) => c.stage === 'relancer' || c.stage === 'manager').length;
  if (f.status === 'todo' || f.status === 'manager' || f.status === 'answered') {
    const pick = open.filter((c) => (f.status === 'todo' ? c.stage === 'relancer' && mine(c) : c.stage === f.status));
    return { rows: pick.slice((f.page - 1) * f.pageSize, f.page * f.pageSize), total: pick.length, page: f.page, pageSize: f.pageSize, counts };
  }
  if (f.status === 'open') w.add(`c.status NOT IN ${CLAIM_DONE}`);
  else if (f.status !== 'all') w.add('c.status = ?', f.status);
  const total = num((await ctx.db.query(`SELECT count(*)::int AS n FROM claims c ${w.sql}`, w.params))[0]?.n);
  const lim = w.p(f.pageSize);
  const off = w.p((f.page - 1) * f.pageSize);
  const rows = await ctx.db.query(`${CLAIM_SELECT} ${w.sql} ORDER BY c.created_at DESC, c.id DESC LIMIT ${lim} OFFSET ${off}`, w.params);
  return { rows: rows.map((r: any) => toClaim(r, ctx.now())), total, page: f.page, pageSize: f.pageSize, counts };
}

const ClaimCreate = z.object({
  orderId: id,
  reason: z.enum(CLAIM_REASONS),
  details: z.string().max(1000).default(''),
  message: z.string().min(1).max(4000),
  channel: z.enum(['whatsapp', 'email', 'copy', 'phone']).default('whatsapp'),
  /** to our own livreur instead of the company */
  toLivreur: z.boolean().default(false),
  /** courier with a claim API (ZR): send it there right away, in this category (null = chosen from the reason) */
  viaApi: z.boolean().default(true),
  categoryId: z.string().max(100).nullable().optional(),
});

const ClaimUpdate = z.object({
  id,
  status: z.enum(CLAIM_STATUSES).optional(),
  note: z.string().max(1000).optional(),
  /** the message was just sent through this channel */
  sentVia: z.enum(['whatsapp', 'email', 'copy', 'phone']).optional(),
  message: z.string().min(1).max(4000).optional(),
});

const CLAIM_STATUS_FR: Record<string, string> = { waiting: 'En attente', still_waiting: 'Toujours en attente', resolved: 'Résolue', lost: 'Perdue' };
const VIA_FR: Record<string, string> = { whatsapp: 'WhatsApp', email: 'e-mail', copy: 'copié', phone: 'téléphone' };

// ---------------------------------------------------------------- procedures
const ListSuivi = z.object({
  tab: z.enum(SUIVI_TABS),
  q: z.string().max(100).optional(),
  // the list's filters: the suivi agent, the product (its variant), the company, the livreur, the wilaya, the period
  followAgentId: ListInput.shape.followAgentId,
  productId: ListInput.shape.productId,
  variantId: ListInput.shape.variantId,
  companyId: ListInput.shape.companyId,
  livreurId: ListInput.shape.livreurId,
  wilayaId: ListInput.shape.wilayaId,
  from: z.string().min(10).max(40).optional(),
  to: z.string().min(10).max(40).optional(),
  /** the managers' « Toutes / Non affectées / Affectées » on the alerts: nobody has it yet, or a suivi agent does */
  assigned: z.enum(['free', 'given']).optional(),
  /** « Suivi · Clair »: one counter only (late, soon, ok · call, later, zr · today, yesterday · client, zr; all: none) */
  bucket: z.enum(['late', 'soon', 'ok', 'call', 'later', 'zr', 'today', 'yesterday', 'client', 'all']).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(500).default(300),
});

/** The date « Du / Au » looks at in each list: when the parcel left, last changed, was delivered or came back. */
const SUIVI_DATE: Record<SuiviTab, ListInput['dateField']> = {
  enlivraison: 'shipped_at',
  bloques: 'shipped_at',
  alertes: 'updated_at',
  alertes_new: 'updated_at',
  alertes_encours: 'updated_at',
  traites: 'updated_at',
  livres: 'delivered_at',
  annules: 'back_at',
  swap: 'back_at',
  swapped: 'updated_at',
  resolus: 'delivered_at',
};

/** The filters chosen on the list, as orders.list reads them (the tab's own period stays unless a date is chosen). */
function suiviFilters(i: z.infer<typeof ListSuivi>, base: Partial<ListInput>): Partial<ListInput> {
  const out: Partial<ListInput> = {};
  for (const k of ['followAgentId', 'productId', 'variantId', 'companyId', 'livreurId', 'wilayaId'] as const) if (i[k] !== undefined) (out as any)[k] = i[k];
  if (i.from || i.to) {
    out.dateField = SUIVI_DATE[i.tab];
    out.from = i.from ?? (base.dateField === out.dateField ? base.from : undefined);
    out.to = i.to;
  }
  return out;
}

/** A new claim on an order (one open claim per reason: a second click or the same claim again is refused). */
async function createClaim(ctx: Ctx, i: z.infer<typeof ClaimCreate>): Promise<Claim> {
  const o = await getOrder(ctx, i.orderId);
  const open = (await ctx.db.query(`SELECT id FROM claims WHERE order_id = $1 AND reason = $2 AND status NOT IN ${CLAIM_DONE} LIMIT 1`, [i.orderId, i.reason]))[0];
  if (open) throw bad(`${o.ref} a déjà une réclamation ouverte pour ce motif (${claimRef(num(open.id))})`);
  const me = ctx.session.profile.id;
  let companyId: number | null = null;
  let livreurId: number | null = null;
  if (i.toLivreur) {
    if (!o.livreurId) throw bad(`${o.ref} n’a pas de livreur`);
    livreurId = o.livreurId;
    companyId = o.companyId;
  } else {
    if (!o.companyId) throw bad(`${o.ref} n’est pas chez une société de livraison`);
    const kind = (await ctx.db.query('SELECT kind FROM delivery_companies WHERE id=$1', [o.companyId]))[0]?.kind;
    if (kind === 'own') {
      if (!o.livreurId) throw bad(`${o.ref} est chez nos livreurs : écrivez au livreur`);
      livreurId = o.livreurId;
    }
    companyId = o.companyId;
  }
  const nowIso = new Date(ctx.now()).toISOString();
  const cid = await ctx.db.tx(async (tx) => {
    const r = (
      await tx.query(
        `INSERT INTO claims (order_id, company_id, livreur_id, reason, details, message, channel, status, created_by, notes, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'waiting',$8,$9,$10,$10) RETURNING id`,
        [o.id, companyId, livreurId, i.reason, i.details, i.message, i.channel, me, JSON.stringify([{ at: nowIso, userId: me, text: 'Réclamation préparée', status: 'waiting' }]), nowIso],
      )
    )[0];
    const n = num(r.id);
    await addEvent(tx, o.id, me, 'note', null, 'event', `Réclamation ${claimRef(n)} : ${i.details || i.reason}`.slice(0, 300));
    // the driver was at fault (never called, fake return or delivery): this refusal does not count against the customer (once)
    if (DRIVER_CLAIMS.includes(i.reason)) {
      const t = await applyTrust(tx, o.customerId);
      if (t) await addEvent(tx, o.id, null, 'note', null, 'event', t);
    }
    return n;
  });
  ctx.emit({ type: 'order', id: o.id });
  const made = await getClaim(ctx.db, cid);
  if (made.viaApi && i.viaApi && o.tracking) return pushClaim(ctx, cid, i.categoryId ?? null);
  return made;
}

const MotifIn = z.object({ key: z.string().regex(/^[a-z0-9_]{1,40}$/), fr: z.string().trim().min(1).max(80), ar: z.string().trim().max(80).default(''), on: z.boolean(), client: z.boolean().optional(), date: z.boolean().optional() });
const cleanMotif = (m: z.infer<typeof MotifIn>) => ({ key: m.key, fr: m.fr, ar: m.ar, on: m.on, ...(m.client ? { client: true } : {}), ...(m.date ? { date: true } : {}) });

// ---------------------------------------------------------------- Bloqués
/** On the road (with the company or our livreur), and not an alert: where a parcel can get stuck. */
const ROAD = ['shipped', 'out_for_delivery', 'failed', 'in_exchange'];
/** The last time the parcel moved: a status from the company, a delivery status, or when it left. */
const LAST_MOVE = `GREATEST(o.ext_status_at, o.shipped_at, (SELECT max(e.at) FROM order_events e WHERE e.order_id = o.id AND e.kind = 'follow_status'))`;

export interface StuckInfo {
  /** whole days without news */
  days: number;
  since: string;
  /** what the agent did since it stopped moving (relancé, réclamation, client rappelé), or null */
  handled: string | null;
  /** days before the claim by itself (0: due, null: done or the company has no API) */
  autoClaimIn: number | null;
}

/** The stuck parcels (no new status for the Préférences' days), with how long and what the agent did. */
export async function stuckParcels(ctx: Ctx, ids?: number[], free = false): Promise<Map<number, StuckInfo>> {
  const { days } = (await getPrefs(ctx.db)).suiviStuck;
  const rows = await ctx.db.query(
    `SELECT o.id, ${LAST_MOVE} AS since, co.kind,
       (SELECT e.to_value FROM order_events e WHERE e.order_id = o.id AND e.kind = 'suivi_stuck' AND e.at >= ${LAST_MOVE} ORDER BY e.at DESC LIMIT 1) AS handled,
       EXISTS (SELECT 1 FROM claims c WHERE c.order_id = o.id AND c.status NOT IN ${CLAIM_DONE} AND c.created_at >= ${LAST_MOVE}) AS claimed,
       EXISTS (SELECT 1 FROM claims c WHERE c.order_id = o.id AND c.reason = 'late' AND c.created_at >= ${LAST_MOVE}) AS late_claimed
       FROM orders o LEFT JOIN delivery_companies co ON co.id = o.company_id
      WHERE o.follow_status = ANY($1) AND o.shipped_at IS NOT NULL AND ${LAST_MOVE} < now() - make_interval(days => $2)
        ${ids ? 'AND o.id = ANY($3)' : ''}${andSql(queueSql(ctx, readQueue(ctx), 'o', { free }))}`,
    ids ? [ROAD, days, ids] : [ROAD, days],
  );
  const out = new Map<number, StuckInfo>();
  for (const r of rows) {
    const since = Date.parse(iso(r.since));
    const d = Math.floor((ctx.now() - since) / 86_400_000);
    const api = !!KINDS[r.kind as keyof typeof KINDS]?.claims;
    // (one automatic claim for the time it has been stuck: closed by the agent, it is not made again until it moves)
    out.set(num(r.id), { days: d, since: iso(r.since), handled: r.claimed ? (r.handled ?? 'claim') : (r.handled ?? null), autoClaimIn: !api || r.claimed || r.late_claimed ? null : Math.max(0, days + 2 - d) });
  }
  return out;
}

/** Bloqués still without news 2 days after: a claim « en retard » to the company through its API (once). */
export async function stuckAutoClaims(ctx: Ctx) {
  const stuck = await stuckParcels(ctx);
  let made = 0;
  const errors: string[] = [];
  for (const [oid, s] of stuck) {
    if (s.autoClaimIn !== 0) continue;
    try {
      const o = await getOrder(ctx, oid);
      if (!o.tracking) continue;
      const shop = (await getSetting(ctx.db, 'shop')).name;
      const message = `Bonjour, le colis ${o.tracking} (${o.ref}) — ${o.customerName} ${o.phone} n’a plus de nouvelles depuis ${s.days} jours. Merci de nous dire où il en est et de le livrer. ${shop}`;
      await createClaim(ctx, ClaimCreate.parse({ orderId: oid, reason: 'late', details: `Bloqué depuis ${s.days} jours (réclamation automatique)`, message, viaApi: true }));
      made++;
    } catch (e) {
      errors.push(`${oid}: ${(e as Error).message}`);
    }
  }
  if (made) ctx.emit({ type: 'orders' });
  return { made, errors };
}

/** A parcel another agent took with « Alerte suivante » (15 minutes): he is calling, nobody else acts on it. */
async function notLockedByOther(ctx: Ctx, oid: number) {
  const r = (await ctx.db.query(
    `SELECT o.ref, p.name FROM orders o JOIN profiles p ON p.id = o.locked_by WHERE o.id = $1 AND o.locked_until > now() AND o.locked_by <> $2 AND o.follow_status = 'alert'`,
    [oid, ctx.session.profile.id],
  ))[0];
  if (r && !ctx.session.isAdmin) throw bad(`${r.ref} : ${r.name} s’en occupe en ce moment`);
}

/** The alerts in this person's reach: nobody acted on it since it came (new), or someone did (in progress). */
async function alertSplit(ctx: Ctx): Promise<{ fresh: number[]; working: number[] }> {
  const ids = (await ctx.db.query(`SELECT o.id FROM orders o WHERE o.follow_status = 'alert'${andSql(queueSql(ctx, readQueue(ctx)))}`)).map((x: any) => num(x.id));
  const clocks = await alertClocks(ctx.db, ids, ctx.now());
  const fresh = ids.filter((id: number) => (clocks.get(id)?.kind ?? 'call') === 'call');
  return { fresh, working: ids.filter((id: number) => !fresh.includes(id)) };
}

// ---------------------------------------------------------------- « Suivi · Clair » (the owner's design 1, 25 Nov 2026)
/** The lists of the alert bar, each with its three counters (they are filters too); 'all' counts the whole list. */
export const CLAIR_TABS = ['alertes_new', 'alertes_encours', 'resolus', 'swap', 'annules'] as const;
export type ClairTab = (typeof CLAIR_TABS)[number];
export const SUIVI_BUCKETS: Record<ClairTab, readonly string[]> = {
  alertes_new: ['late', 'soon', 'ok'],
  alertes_encours: ['call', 'later', 'zr'],
  resolus: ['today', 'yesterday', 'all'],
  swap: ['client', 'zr', 'all'],
  annules: ['client', 'zr', 'all'],
};
const isClair = (t: string): t is ClairTab => (CLAIR_TABS as readonly string[]).includes(t);

/** What an alert's line says besides the usual (SuiviRowExtra). */
export interface ClairExtra {
  /** the last thing done on the alert (En cours › « Dernier résultat ») */
  last: { key: 'no_answer' | 'busy' | 'called' | 'callback' | 'relivrer' | 'claim' | 'lost'; at: string; note: string | null } | null;
  /** the call back asked with « Rappel », when it is the last thing done */
  callbackAt: string | null;
  /** Résolu: the person who last worked on the alert (« Sauvé par ») */
  savedBy: string | null;
  /** Swap: the customer cancelled (« Client annule », someone in Pilotix) or the company did */
  cancelBy: 'client' | 'zr' | null;
  /** which counter the line is in */
  bucket: string;
}

/** The treated alerts back on the road (waiting for the company to deliver): En cours › « Attend ZR ». */
async function treatedIds(ctx: Ctx): Promise<number[]> {
  return (
    await ctx.db.query(`SELECT o.id FROM orders o WHERE o.sub_status = 'alert_traitee' AND o.follow_status IN ('out_for_delivery','shipped','failed')${andSql(queueSql(ctx, readQueue(ctx)))}`)
  ).map((x: any) => num(x.id));
}

/** Résolu: the parcels the company delivered after an alert, these 30 days. Nobody presses anything: it fills itself. */
async function resolvedIds(ctx: Ctx): Promise<number[]> {
  return (
    await ctx.db.query(
      `SELECT o.id FROM orders o WHERE o.follow_status = 'delivered' AND o.delivered_at >= $1
         AND EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.kind = 'follow_status' AND e.to_value = 'alert')${andSql(queueSql(ctx, readQueue(ctx)))}
       ORDER BY o.delivered_at DESC LIMIT 500`,
      [new Date(ctx.now() - 30 * DAY).toISOString()],
    )
  ).map((x: any) => num(x.id));
}

/** The line of each alert: the last thing done, the call back, who saved it, who cancelled, its counter. */
async function clairExtras(ctx: Ctx, tab: ClairTab, rows: Order[], ex: Record<number, SuiviRowExtra>, now: number): Promise<Record<number, ClairExtra>> {
  const out: Record<number, ClairExtra> = {};
  if (!rows.length) return out;
  const ids = rows.map((o) => o.id);
  const alertAt = new Map<number, number>();
  for (const r of await ctx.db.query(`SELECT e.order_id, max(e.at) AS at FROM order_events e WHERE e.order_id = ANY($1) AND e.kind = 'follow_status' AND e.to_value = 'alert' GROUP BY 1`, [ids]))
    alertAt.set(num(r.order_id), Date.parse(iso(r.at)));
  // the last thing a person did on it since it became an alert: a call (and how it went), a call back, a treatment
  const lastOf = new Map<number, any>();
  for (const r of await ctx.db.query(
    `SELECT DISTINCT ON (e.order_id) e.order_id, e.kind, e.from_value, e.to_value, e.note, e.data, e.at, p.name AS who
       FROM order_events e LEFT JOIN profiles p ON p.id = e.user_id
      WHERE e.order_id = ANY($1) AND e.user_id IS NOT NULL
        AND (e.kind IN ('call', 'suivi_motif') OR (e.kind = 'sub_status' AND e.to_value = 'alert_traitee') OR (e.kind = 'note' AND e.to_value = 'suivi_rappel'))
      ORDER BY e.order_id, e.at DESC, e.id DESC`,
    [ids],
  ))
    lastOf.set(num(r.order_id), r);
  // Swap: the last turn back of the parcel, made by a person in Pilotix (« Client annule ») or by the company's news
  const backBy = new Map<number, boolean>();
  if (tab === 'swap' || tab === 'annules')
    for (const r of await ctx.db.query(
      `SELECT DISTINCT ON (e.order_id) e.order_id, e.user_id FROM order_events e
        WHERE e.order_id = ANY($1) AND e.kind = 'follow_status' AND e.to_value IN ('returning', 'cancelled') ORDER BY e.order_id, e.at DESC, e.id DESC`,
      [ids],
    ))
      backBy.set(num(r.order_id), r.user_id != null);
  const today = algiersDayStart(now);
  for (const o of rows) {
    const x = ex[o.id];
    const since = alertAt.get(o.id) ?? 0;
    const r = lastOf.get(o.id);
    const at = r ? Date.parse(iso(r.at)) : 0;
    let last: ClairExtra['last'] = null;
    let callbackAt: string | null = null;
    if (r && at >= since) {
      const data = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
      const key: NonNullable<ClairExtra['last']>['key'] =
        r.kind === 'call' ? (r.to_value === 'no_answer' ? 'no_answer' : r.to_value === 'busy' ? 'busy' : 'called') : r.kind === 'note' ? 'callback' : r.kind === 'suivi_motif' && r.from_value === 'lost' ? 'lost' : 'relivrer';
      last = { key, at: iso(r.at), note: r.note ?? null };
      if (key === 'callback' && data?.at) callbackAt = String(data.at);
    }
    // a réclamation sent after the last thing done (and still open): « Réclamation envoyée »
    const c = x?.claim;
    if (c && !['resolved', 'lost'].includes(c.status) && Date.parse(c.createdAt) >= since && (!last || Date.parse(c.createdAt) > Date.parse(last.at)))
      last = { key: 'claim', at: c.createdAt, note: null };
    let bucket = 'all';
    if (tab === 'alertes_new') bucket = x?.clock?.state ?? 'ok';
    else if (tab === 'alertes_encours')
      bucket = o.followStatus !== 'alert' || last?.key === 'claim' ? 'zr' : callbackAt && Date.parse(callbackAt) > now ? 'later' : 'call';
    else if (tab === 'resolus') {
      const d = o.deliveredAt ? Date.parse(o.deliveredAt) : 0;
      bucket = d >= today ? 'today' : d >= today - DAY ? 'yesterday' : 'older';
    } else bucket = backBy.get(o.id) ? 'client' : 'zr';
    out[o.id] = {
      last,
      callbackAt,
      savedBy: tab === 'resolus' ? (r?.who as string | null) ?? o.followAgentName ?? null : null,
      cancelBy: tab === 'swap' || tab === 'annules' ? (backBy.get(o.id) ? 'client' : 'zr') : null,
      bucket,
    };
  }
  return out;
}

/** The three counters of a list (with its search and filters): 'all' is the whole list. */
function countBuckets(tab: ClairTab, rows: Order[], cx: Record<number, ClairExtra>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of SUIVI_BUCKETS[tab]) out[k] = k === 'all' ? rows.length : rows.filter((o) => cx[o.id]?.bucket === k).length;
  return out;
}

export const suiviProcs = {
  'suivi.counts': proc(['suivi', 'confirmation'], z.object({}), (ctx) => suiviCounts(ctx)),

  'suivi.list': proc(['suivi', 'confirmation'], ListSuivi, async (ctx, i) => {
    // « Toutes / Non affectées / Affectées » on the alerts (the owner's ask, 25 Nov 2026), with its numbers: for the
    // owner, the agent managers and a confirmation agency's chiefs — never a suivi agent
    const boss = (i.tab === 'alertes' || i.tab === 'alertes_new' || i.tab === 'alertes_encours') && (ctx.session.isAdmin || hasRole(ctx.session, 'agent_manager', 'vendeur') || agencyLead(ctx));
    const empty = { rows: [] as Order[], total: 0, page: 1, pageSize: i.pageSize ?? 50, extra: {} as Record<number, SuiviRowExtra & Partial<ClairExtra>>, assign: boss ? { free: 0, given: 0 } : null, buckets: null as Record<string, number> | null };
    // « Suivi · Clair »: the four lists of the alert bar, each with its counters over the whole list (search and filters
    // too), the line's last result, its counter, and the most urgent first
    if (isClair(i.tab)) {
      const tab = i.tab;
      const zero = Object.fromEntries(SUIVI_BUCKETS[tab].map((k) => [k, 0]));
      const split = tab === 'alertes_new' || tab === 'alertes_encours' ? await alertSplit(ctx) : null;
      const all =
        tab === 'alertes_new' ? split!.fresh : tab === 'alertes_encours' ? [...split!.working, ...(await treatedIds(ctx))] : tab === 'resolus' ? await resolvedIds(ctx) : tab === 'annules' ? await annulesIds(ctx, i.from, i.to) : await swappableIds(ctx);
      if (!all.length) return { ...empty, buckets: zero };
      const tf = tabFilter(tab, ctx.now(), agencyOf(ctx) !== null && hasRole(ctx.session, 'suivi'));
      const base: Partial<ListInput> = { ...tf, ...suiviFilters(i, tf), ids: all.slice(0, 500), q: i.q };
      const who = (side: 'free' | 'given') => ({ followAgentId: side === 'free' ? ('none' as const) : ('any' as const) });
      const found = await listOrders(ctx, ListInput.parse({ ...base, ...(i.assigned ? who(i.assigned) : {}), page: 1, pageSize: 500 }), { queue: readQueue(ctx) });
      const count = async (side: 'free' | 'given') => (await listOrders(ctx, ListInput.parse({ ...base, ...who(side), page: 1, pageSize: 1 }), { queue: readQueue(ctx) })).total;
      const assign = boss ? { free: await count('free'), given: await count('given') } : null;
      const now = ctx.now();
      let rows = tab === 'swap' || tab === 'annules' ? found.rows.filter((o) => o.shippedAt) : found.rows;
      const ex = await extras(ctx, rows, now);
      // En cours: the calls count on every line (○○○ 0/6 as on Confirmation), a treated parcel's too (calls since its alert)
      if (tab === 'alertes_encours') {
        const more = rows.filter((o) => ex[o.id] && !ex[o.id].tries).map((o) => o.id);
        for (const [id, tr] of await alertTries(ctx.db, more, now)) ex[id].tries = tr;
      }
      const cx = await clairExtras(ctx, tab, rows, ex, now);
      const buckets = countBuckets(tab, rows, cx);
      if (i.bucket && i.bucket !== 'all') rows = rows.filter((o) => cx[o.id]?.bucket === i.bucket);
      // the most urgent first: a new alert by its clock; in progress, the ones to call, then the call backs, then ZR's
      if (tab === 'alertes_new') rows = [...rows].sort((a, b) => (ex[a.id]?.clock?.left ?? 1e9) - (ex[b.id]?.clock?.left ?? 1e9) || a.id - b.id);
      if (tab === 'alertes_encours') {
        const rank = (o: Order) => ['call', 'later', 'zr'].indexOf(cx[o.id]?.bucket ?? 'zr');
        const when = (o: Order) => (cx[o.id]?.callbackAt ? Date.parse(cx[o.id]!.callbackAt!) : Date.parse(o.updatedAt));
        rows = [...rows].sort((a, b) => rank(a) - rank(b) || when(a) - when(b) || a.id - b.id);
      }
      const total = rows.length;
      const pageRows = await withClientScores(ctx, rows.slice((i.page - 1) * i.pageSize, i.page * i.pageSize));
      const extra: Record<number, SuiviRowExtra & Partial<ClairExtra>> = {};
      for (const o of pageRows) extra[o.id] = { ...ex[o.id], ...cx[o.id] };
      return { rows: pageRows, total, page: i.page, pageSize: i.pageSize, extra, assign, buckets };
    }
    const stuck = i.tab === 'bloques' ? await stuckParcels(ctx) : null;
    if (stuck && !stuck.size) return empty;
    // (the new alerts, the ones in progress, Résolu and Swap: the Clair lists above)
    const ids = stuck ? [...stuck.keys()].slice(0, 500) : null;
    const tf = tabFilter(i.tab, ctx.now(), agencyOf(ctx) !== null && hasRole(ctx.session, 'suivi'));
    const base: Partial<ListInput> = { ...tf, ...suiviFilters(i, tf), ...(ids ? { ids } : {}), q: i.q };
    const who = (side: 'free' | 'given') => ({ followAgentId: side === 'free' ? ('none' as const) : ('any' as const) });
    const page = await listOrders(ctx, ListInput.parse({ ...base, ...(i.assigned ? who(i.assigned) : {}), page: i.page, pageSize: i.pageSize }), { queue: readQueue(ctx) });
    // the switch's numbers: this list (its search and filters, not its agent filter) with nobody on it / someone
    const count = async (side: 'free' | 'given') => (await listOrders(ctx, ListInput.parse({ ...base, ...who(side), page: 1, pageSize: 1 }), { queue: readQueue(ctx) })).total;
    const assign = boss ? { free: await count('free'), given: await count('given') } : null;
    if (stuck) {
      const ex = await extras(ctx, page.rows, ctx.now());
      for (const o of page.rows) if (ex[o.id]) ex[o.id].stuck = stuck.get(o.id) ?? null;
      // the longest without news first
      const rows = await withClientScores(ctx, [...page.rows].sort((a, b) => (stuck.get(b.id)?.days ?? 0) - (stuck.get(a.id)?.days ?? 0)));
      return { ...page, rows, extra: ex as Record<number, SuiviRowExtra & Partial<ClairExtra>>, assign, buckets: null as Record<string, number> | null };
    }
    const rows = await withClientScores(ctx, page.rows);
    return { ...page, rows, extra: (await extras(ctx, rows, ctx.now())) as Record<number, SuiviRowExtra & Partial<ClairExtra>>, assign, buckets: null as Record<string, number> | null };
  }),

  /**
   * « Statut » on an alert (Suivi · Clair): « Pas de réponse » and « Occupé » are one call each (they count as a try, as
   * Préférences › Appels du Suivi says), « Rappel » is a call back at a day and hour (« Plus tard » until then). The alert
   * moves to En cours (someone acted on it).
   */
  'suivi.callResult': proc(
    ['suivi'],
    z.object({ id, result: z.enum(['no_answer', 'busy', 'callback']), at: z.string().max(40).nullable().optional() }),
    async (ctx, i) => {
      const cur = await getOrder(ctx, i.id);
      if (cur.followStatus !== 'alert') throw bad(`${cur.ref} n’est pas en alerte`);
      await notLockedByOther(ctx, i.id);
      const me = ctx.session.profile.id;
      if (i.result === 'callback') {
        const at = i.at ? Date.parse(i.at) : NaN;
        if (!Number.isFinite(at) || at < ctx.now() - 5 * 60_000) throw bad('Choisissez le jour et l’heure du rappel');
        const d = new Date(at + 3_600_000); // Algiers
        const p2 = (n: number) => String(n).padStart(2, '0');
        const txt = `Rappel le ${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)} à ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
        await addEvent(ctx.db, i.id, me, 'note', null, 'suivi_rappel', txt, { at: new Date(at).toISOString() });
      } else await addEvent(ctx.db, i.id, me, 'call', null, i.result, i.result === 'busy' ? 'Occupé' : 'Pas de réponse', { result: i.result });
      ctx.emit({ type: 'order', id: i.id });
      return { ok: true };
    },
  ),

  /** "Traiter" an alert: what was done, new date, note → back on the road with sub-status alert_traitee. */
  'suivi.treat': proc(['suivi'], z.object({ id, what: z.enum(TREAT_WHAT), date: z.string().max(20).nullable().optional(), note: z.string().max(1000).nullable().optional() }), async (ctx, i) => {
    const cur = await getOrder(ctx, i.id);
    if (cur.followStatus !== 'alert') throw bad(`${cur.ref} n’est pas en alerte`);
    await notLockedByOther(ctx, i.id);
    const WHAT: Record<string, string> = { date: 'Client joint : nouvelle date de livraison', adresse: 'Adresse ou téléphone corrigé', injoignable: 'Client injoignable : nouvel essai', autre: 'Autre' };
    const day = i.date ? `le ${i.date.slice(0, 10).split('-').reverse().join('/')}` : '';
    const text = [WHAT[i.what], day, i.note?.trim()].filter(Boolean).join(' · ');
    await setFollow(ctx, FollowInput.parse({ ids: [i.id], status: 'out_for_delivery', subStatus: 'alert_traitee', note: `Alerte traitée — ${text}` }));
    await addEvent(ctx.db, i.id, ctx.session.profile.id, 'sub_status', cur.subStatus ?? null, 'alert_traitee', text);
    ctx.emit({ type: 'order', id: i.id });
    return getOrder(ctx, i.id);
  }),

  /** Takes the suivi agent off an order (the order stays where it is; the next suivi agent who acts on it takes it). */
  /**
   * Dashboard › Suivi › « Motifs du Suivi »: what the alerts of the period ended with — each « Résolu » motif and how
   * many of those parcels were then delivered, each « Perdu » motif and its share of the lost parcels.
   */
  'suivi.motifStats': proc(['suivi', 'agent_manager', 'vendeur'], z.object({ from: z.string().max(40), to: z.string().max(40) }), async (ctx, i) => {
    const rows = await ctx.db.query(
      `SELECT e.from_value AS outcome, e.to_value AS key, max(e.note) AS label, count(DISTINCT e.order_id)::int AS n,
              count(DISTINCT e.order_id) FILTER (WHERE o.follow_status = 'delivered')::int AS delivered
         FROM order_events e JOIN orders o ON o.id = e.order_id
        WHERE e.kind = 'suivi_motif' AND e.at >= $1::timestamptz AND e.at < $2::timestamptz${andSql(queueSql(ctx, 'follow'))}
        GROUP BY 1, 2 ORDER BY n DESC`,
      [i.from, i.to],
    );
    const motifs = await getSetting(ctx.db, 'suiviMotifs');
    const name = (out: string, k: string, fallback: string) => (out === 'resolved' ? motifs.resolved : motifs.lost).find((m) => m.key === k)?.fr ?? fallback;
    const side = (out: 'resolved' | 'lost') => rows.filter((r: any) => r.outcome === out).map((r: any) => ({ key: String(r.key), label: name(out, String(r.key), String(r.label ?? r.key)), count: num(r.n), delivered: num(r.delivered) }));
    const resolved = side('resolved');
    const lost = side('lost');
    // each agent: what he treated, how many of his « Résolu » were then delivered, his « annulé trop tôt »
    const agents = (
      await ctx.db.query(
        `SELECT e.user_id AS id, p.name,
                count(DISTINCT e.order_id) FILTER (WHERE e.from_value = 'resolved')::int AS resolved,
                count(DISTINCT e.order_id) FILTER (WHERE e.from_value = 'resolved' AND o.follow_status = 'delivered')::int AS delivered,
                count(DISTINCT e.order_id) FILTER (WHERE e.from_value = 'lost')::int AS lost,
                count(DISTINCT e.order_id) FILTER (WHERE e.from_value = 'lost' AND o.sub_status = 'annule_trop_tot')::int AS early,
                (SELECT e2.to_value FROM order_events e2 WHERE e2.user_id = e.user_id AND e2.kind = 'suivi_motif' AND e2.from_value = 'lost' AND e2.at >= $1::timestamptz AND e2.at < $2::timestamptz
                  GROUP BY 1 ORDER BY count(*) DESC LIMIT 1) AS top_lost
           FROM order_events e JOIN orders o ON o.id = e.order_id JOIN profiles p ON p.id = e.user_id
          WHERE e.kind = 'suivi_motif' AND e.at >= $1::timestamptz AND e.at < $2::timestamptz${andSql(queueSql(ctx, 'follow'))}
          GROUP BY e.user_id, p.name ORDER BY count(DISTINCT e.order_id) DESC`,
        [i.from, i.to],
      )
    ).map((r: any) => ({ id: num(r.id), name: String(r.name), resolved: num(r.resolved), delivered: num(r.delivered), lost: num(r.lost), early: num(r.early), topLost: r.top_lost ? name('lost', String(r.top_lost), String(r.top_lost)) : null }));
    return { agents, resolved, lost, totalResolved: resolved.reduce((a, r) => a + r.count, 0), totalLost: lost.reduce((a, r) => a + r.count, 0) };
  }),

  /**
   * Bloqués: what the agent did for a parcel without news — « relancé » (the company or the livreur, by phone),
   * « réclamation » (a claim « en retard », through the API when the company has one) or « client rappelé ».
   */
  'suivi.stuckDone': proc(['suivi'], z.object({ id, action: z.enum(['relance', 'claim', 'client']), note: z.string().max(1000).nullable().optional() }), async (ctx, i) => {
    const s = (await stuckParcels(ctx, [i.id])).get(i.id);
    if (!s) throw bad('Ce colis n’est pas bloqué');
    const me = ctx.session.profile.id;
    let claim: Claim | null = null;
    let claimError: string | null = null;
    if (i.action === 'claim') {
      const o = await getOrder(ctx, i.id);
      const own = o.companyId ? (await ctx.db.query('SELECT kind FROM delivery_companies WHERE id = $1', [o.companyId]))[0]?.kind === 'own' : false;
      const shop = (await getSetting(ctx.db, 'shop')).name;
      try {
        claim = await createClaim(
          ctx,
          ClaimCreate.parse({
            orderId: i.id,
            reason: 'late',
            details: [`Bloqué depuis ${s.days} jours`, i.note?.trim()].filter(Boolean).join(' — '),
            message: `Bonjour, le colis ${o.tracking ?? o.ref} (${o.ref}) — ${o.customerName} ${o.phone} n’a plus de nouvelles depuis ${s.days} jours. Merci de nous dire où il en est. ${shop}`,
            toLivreur: own && !!o.livreurId,
            viaApi: true,
          }),
        );
      } catch (e) {
        claimError = (e as Error).message;
      }
    }
    const WHAT = { relance: 'Relancé', claim: 'Réclamation ouverte', client: 'Client rappelé' } as const;
    await addEvent(ctx.db, i.id, me, 'suivi_stuck', String(s.days), i.action, [`Bloqué ${s.days} j : ${WHAT[i.action]}`, i.note?.trim()].filter(Boolean).join(' — '));
    // the agent who handled it follows the parcel
    await ctx.db.query('UPDATE orders SET follow_agent_id = CASE WHEN follow_agency_id IS NOT DISTINCT FROM $3 THEN COALESCE(follow_agent_id, $2) ELSE follow_agent_id END, locked_by = CASE WHEN locked_by = $2 THEN NULL ELSE locked_by END, locked_until = CASE WHEN locked_by = $2 THEN NULL ELSE locked_until END WHERE id = $1', [i.id, me, agencyOf(ctx)]);
    ctx.emit({ type: 'order', id: i.id });
    return { order: await getOrder(ctx, i.id), claim, claimError };
  }),

  /** Management › Motifs du Suivi: everyone reads them (the « Traiter » window), an admin changes them. */
  'suivi.motifs': proc(null, z.object({}), async (ctx) => getSetting(ctx.db, 'suiviMotifs')),
  'suivi.motifsSet': proc(
    [],
    z.object({
      resolved: z.array(MotifIn).min(1).max(30),
      lost: z.array(MotifIn).min(1).max(30),
    }),
    async (ctx, i) => {
      for (const list of [i.resolved, i.lost]) if (new Set(list.map((m) => m.key)).size !== list.length) throw bad('Deux motifs ont la même clé');
      if (!i.resolved.some((m) => m.on) || !i.lost.some((m) => m.on)) throw bad('Gardez au moins un motif allumé de chaque côté');
      await setSetting(ctx.db, 'suiviMotifs', { resolved: i.resolved.map(cleanMotif), lost: i.lost.map(cleanMotif) }, ctx.session.profile.id);
      return { ok: true };
    },
  ),

  /**
   * « Traiter » an alert, after calling the customer: « Résolu » (relancé: back on the road, and the delivery company
   * asked to deliver again — through its API, or a message to write, or our livreur) or « Perdu » (after the seller's
   * calls, or the customer said it himself, or « annulé trop tôt » with a reason) — always with a motif.
   */
  'suivi.resolve': proc(
    ['suivi'],
    z.object({
      id,
      outcome: z.enum(['resolved', 'lost']),
      motif: z.string().max(40),
      date: z.string().max(20).nullable().optional(),
      note: z.string().max(1000).nullable().optional(),
      /** « Perdu » before the calls, with a reason (the note) */
      early: z.boolean().optional(),
      /** « Résolu »: ask the delivery company (or our livreur) to deliver again */
      relance: z.boolean().default(false),
      /** « Perdu »: before the return, the parcel goes to this waiting order instead (swap) */
      swapTo: id.nullable().optional(),
    }),
    async (ctx, i) => {
      const cur = await getOrder(ctx, i.id);
      if (cur.followStatus !== 'alert') throw bad(`${cur.ref} n’est pas en alerte`);
      await notLockedByOther(ctx, i.id);
      const all = await getSetting(ctx.db, 'suiviMotifs');
      const m = (i.outcome === 'resolved' ? all.resolved : all.lost).find((x) => x.key === i.motif && x.on);
      if (!m) throw bad('Choisissez un motif');
      if (i.outcome === 'resolved' && m.date && !i.date) throw bad(`« ${m.fr} » : choisissez la nouvelle date`);
      const day = i.date ? ` le ${i.date.slice(0, 10).split('-').reverse().join('/')}` : '';
      const note = i.note?.trim() ?? '';
      const me = ctx.session.profile.id;
      if (i.outcome === 'resolved') {
        await setFollow(ctx, FollowInput.parse({ ids: [i.id], status: 'out_for_delivery', subStatus: 'alert_traitee', note: ['Traité · Résolu · ' + m.fr + day, note].filter(Boolean).join(' — ') }));
        await addEvent(ctx.db, i.id, me, 'suivi_motif', 'resolved', m.key, m.fr);
        let claim: Claim | null = null;
        let claimError: string | null = null;
        if (i.relance && cur.companyId) {
          try {
            const own = (await ctx.db.query('SELECT kind FROM delivery_companies WHERE id = $1', [cur.companyId]))[0]?.kind === 'own';
            const shop = (await getSetting(ctx.db, 'shop')).name;
            const message = `Bonjour, merci de relivrer le colis ${cur.tracking ?? cur.ref} — ${cur.customerName} ${cur.phone}${cur.commune ? `, ${cur.commune}` : ''} : ${m.fr}${day}${note ? ` (${note})` : ''}. ${shop}`;
            claim = await createClaim(ctx, ClaimCreate.parse({ orderId: i.id, reason: 'relivrer', details: `${m.fr}${day}${note ? ` — ${note}` : ''}`.slice(0, 1000), message, toLivreur: own && !!cur.livreurId, viaApi: true }));
          } catch (e) {
            claimError = (e as Error).message ?? 'Erreur';
          }
        }
        ctx.emit({ type: 'order', id: i.id });
        return { order: await getOrder(ctx, i.id), claim, claimError, swap: null };
      }
      const tr = (await alertTries(ctx.db, [i.id], ctx.now())).get(i.id);
      const enough = !!tr && tr.done >= tr.need;
      const early = !enough && !m.client;
      if (early && (!i.early || !note)) throw bad(`${cur.ref} : faites d’abord ${tr?.need ?? 3} appels (${tr?.done ?? 0} faits), ou dites pourquoi vous annulez avant`);
      if (i.swapTo) {
        await addEvent(ctx.db, i.id, me, 'suivi_motif', 'lost', m.key, m.fr);
        const swap = await swapParcel(ctx, i.id, i.swapTo, [`Traité · Perdu · ${m.fr}`, early ? 'annulé trop tôt' : '', note].filter(Boolean).join(' — '));
        return { order: await getOrder(ctx, i.id), claim: null, claimError: null, swap };
      }
      await setFollow(
        ctx,
        FollowInput.parse({
          ids: [i.id],
          status: 'returning',
          subStatus: early ? 'annule_trop_tot' : null,
          note: [`Traité · Perdu · ${m.fr}`, early ? `annulé trop tôt (${tr?.done ?? 0}/${tr?.need ?? 3} appels)` : '', note].filter(Boolean).join(' — '),
        }),
      );
      await addEvent(ctx.db, i.id, me, 'suivi_motif', 'lost', m.key, m.fr);
      ctx.emit({ type: 'order', id: i.id });
      return { order: await getOrder(ctx, i.id), claim: null, claimError: null, swap: null };
    },
  ),

  /**
   * « Alerte suivante »: the most urgent alert for this agent, locked to him 15 minutes so nobody calls the same customer.
   * His own parcels first (once he acted on a parcel it stays his until it ends), then the alerts of nobody — or of an
   * agent not seen for 8 hours (off today) — the oldest alert first.
   */
  'suivi.next': proc(['suivi'], z.object({ skip: z.array(id).max(200).default([]), release: id.nullable().optional(), only: z.enum(['stuck']).optional() }), async (ctx, i) => {
    const me = ctx.session.profile.id;
    if (i.release) await ctx.db.query('UPDATE orders SET locked_by = NULL, locked_until = NULL WHERE id = $1 AND locked_by = $2', [i.release, me]);
    // picked and locked in one statement: two agents pressing at the same time never get the same parcel
    const r = i.only === 'stuck' ? [] : await ctx.db.query(
      `UPDATE orders SET locked_by = $1, locked_until = now() + interval '15 minutes'
        WHERE id = (
          SELECT o.id FROM orders o LEFT JOIN profiles fa ON fa.id = o.follow_agent_id
           WHERE o.follow_status = 'alert' AND NOT (o.id = ANY($2))
             AND (o.locked_until IS NULL OR o.locked_until < now() OR o.locked_by = $1)
             AND (o.follow_agent_id IS NULL OR o.follow_agent_id = $1 OR fa.last_seen_at IS NULL OR fa.last_seen_at < now() - interval '8 hours')${andSql(queueSql(ctx, 'follow', 'o', { free: true }))} AND o.follow_agency_id IS NOT DISTINCT FROM ${agencyOf(ctx) ?? 'NULL'}
           ORDER BY (o.follow_agent_id = $1) DESC NULLS LAST,
             (SELECT max(e.at) FROM order_events e WHERE e.order_id = o.id AND e.kind = 'follow_status' AND e.to_value = 'alert') ASC NULLS FIRST, o.id
           LIMIT 1 FOR UPDATE OF o SKIP LOCKED)
       RETURNING id`,
      [me, i.skip],
    );
    if (r[0]) {
      const order = await getOrder(ctx, num(r[0].id));
      return { id: order.id, kind: 'alert' as const, order, extra: (await extras(ctx, [order], ctx.now()))[order.id] ?? null };
    }
    // no alert left: the Bloqués nobody handled yet, the longest without news first
    const stuck = [...(await stuckParcels(ctx, undefined, true)).entries()].filter(([oid, x]) => !x.handled && !i.skip.includes(oid)).sort((a, b) => b[1].days - a[1].days);
    for (const [oid, x] of stuck) {
      const got = await ctx.db.query(
        `UPDATE orders o SET locked_by = $1, locked_until = now() + interval '15 minutes'
           FROM (SELECT o2.id FROM orders o2 LEFT JOIN profiles fa ON fa.id = o2.follow_agent_id
                  WHERE o2.id = $2 AND (o2.locked_until IS NULL OR o2.locked_until < now() OR o2.locked_by = $1)
                    AND o2.follow_agency_id IS NOT DISTINCT FROM ${agencyOf(ctx) ?? 'NULL'} AND (o2.follow_agent_id IS NULL OR o2.follow_agent_id = $1 OR fa.last_seen_at IS NULL OR fa.last_seen_at < now() - interval '8 hours')${andSql(queueSql(ctx, 'follow', 'o2', { free: true }))}
                  FOR UPDATE OF o2 SKIP LOCKED) f
          WHERE o.id = f.id RETURNING o.id`,
        [me, oid],
      );
      if (!got[0]) continue;
      const order = await getOrder(ctx, oid);
      const ex = (await extras(ctx, [order], ctx.now()))[oid] ?? null;
      return { id: oid, kind: 'stuck' as const, order, extra: ex ? { ...ex, stuck: x } : null };
    }
    return { id: null, kind: null, order: null, extra: null };
  }),

  /** Leaves the parcel taken with « Alerte suivante » (closed without acting): another agent may take it. */
  'suivi.release': proc(['suivi'], z.object({ id }), async (ctx, i) => {
    await ctx.db.query('UPDATE orders SET locked_by = NULL, locked_until = NULL WHERE id = $1 AND follow_agency_id IS NOT DISTINCT FROM $4::integer AND (locked_by = $2 OR $3)', [i.id, ctx.session.profile.id, ctx.session.isAdmin, agencyOf(ctx)]);
    return { ok: true };
  }),

  'suivi.unassign': proc(['suivi'], z.object({ id }), async (ctx, { id: oid }) => {
    const order = await getOrder(ctx, oid);
    const changed = await ctx.db.query('UPDATE orders SET follow_agent_id = NULL, updated_at = now() WHERE id = $1 AND follow_agency_id IS NOT DISTINCT FROM $2 AND follow_agent_id IS NOT NULL RETURNING id', [oid, agencyOf(ctx)]);
    if (!changed.length) {
      const cur = (await ctx.db.query('SELECT follow_agency_id FROM orders WHERE id = $1', [oid]))[0];
      if (!cur) throw notFound('Commande introuvable');
      if (numOrNull(cur.follow_agency_id) !== agencyOf(ctx)) throw forbidden('L’affectation est réservée à l’équipe qui gère le suivi');
    } else {
      await addEvent(ctx.db, oid, ctx.session.profile.id, 'note', null, null, 'Agent suivi retiré');
      ctx.emit({ type: 'orders' });
    }
    return { ...order, followAgentId: null, followAgentName: null };
  }),

  /** Client annule / Livré / Nouvelle alerte from the Suivi lists. */
  'suivi.act': proc(
    ['suivi'],
    z.object({
      id,
      action: z.enum(['cancel', 'delivered', 'realert']),
      note: z.string().max(1000).nullable().optional(),
      /** « Client annule » on an alert: the customer said it himself (always allowed), or before the tries (a reason, « annulé trop tôt ») */
      by: z.enum(['client', 'early']).optional(),
    }),
    async (ctx, i) => {
    if (i.action === 'cancel') {
      const cur = await getOrder(ctx, i.id);
      if (cur.followStatus === 'alert') {
        await notLockedByOther(ctx, i.id);
        const tr = (await alertTries(ctx.db, [i.id], ctx.now())).get(i.id);
        const enough = !!tr && tr.done >= tr.need;
        if (!enough && i.by !== 'client') {
          if (i.by !== 'early' || !i.note?.trim()) throw bad(`${cur.ref} : faites d’abord ${tr?.need ?? 3} appels (${tr?.done ?? 0} faits), ou dites pourquoi vous annulez avant`);
        }
        if (!enough && i.by === 'early') {
          await setFollow(ctx, FollowInput.parse({ ids: [i.id], status: 'returning', subStatus: 'annule_trop_tot', note: `Annulé trop tôt (${tr?.done ?? 0}/${tr?.need ?? 3} appels) — ${i.note!.trim()}` }));
          return getOrder(ctx, i.id);
        }
        if (i.by === 'client') {
          await setFollow(ctx, FollowInput.parse({ ids: [i.id], status: 'returning', note: ['Le client annule lui-même (suivi)', i.note].filter(Boolean).join(' — ') }));
          return getOrder(ctx, i.id);
        }
      }
    }
    const map = {
      cancel: { status: 'returning', note: 'Annulé par le client (suivi)' },
      delivered: { status: 'delivered', note: 'Livré après alerte traitée' },
      realert: { status: 'alert', note: 'Nouvelle alerte' },
    } as const;
    const m = map[i.action];
    await notLockedByOther(ctx, i.id);
    await setFollow(ctx, FollowInput.parse({ ids: [i.id], status: m.status, note: [m.note, i.note].filter(Boolean).join(' — ') }));
    return getOrder(ctx, i.id);
    },
  ),

  'suivi.swapCandidates': proc(['suivi', 'confirmation'], z.object({ fromId: id, q: z.string().max(100).optional() }), (ctx, i) => swapCandidates(ctx, i.fromId, i.q)),
  'suivi.swap': proc(['suivi', 'confirmation'], z.object({ fromId: id, toId: id, note: z.string().max(500).nullable().optional() }), (ctx, i) => swapParcel(ctx, i.fromId, i.toId, i.note)),
  'suivi.swapTarget': proc(['suivi', 'confirmation'], z.object({ id }), (ctx, i) => swapTarget(ctx, i.id)),
  /** « Annuler le swap »: a swap made in Pilotix alone goes back (one made at the company by API never does). */
  'suivi.unswap': proc(['suivi', 'confirmation'], z.object({ id }), (ctx, i) => unswapParcel(ctx, i.id)),

  /** Couriers and livreurs that can receive a claim, with their claim contacts. */
  'suivi.contacts': proc(['suivi', 'confirmation', 'depot'], z.object({}), async (ctx) => {
    const shop = await getSetting(ctx.db, 'shop');
    const comps = await ctx.db.query(`SELECT id, name, kind, active, config FROM delivery_companies WHERE active ORDER BY name`);
    const livreurs = await ctx.db.query(`SELECT id, name, phone, livreur_company_id FROM profiles WHERE active AND 'livreur' = ANY(roles) ORDER BY name`);
    return {
      shopName: shop.name,
      companies: comps.map((c: any) => {
        const cfg = (typeof c.config === 'string' ? JSON.parse(c.config) : c.config) ?? {};
        const k = cfg.claim ?? {};
        return { id: num(c.id), name: c.name as string, kind: c.kind as string, api: !!KINDS[c.kind as CourierKind]?.claims, wa: (k.wa as string) || null, email: (k.email as string) || null, phone: (k.phone as string) || null, portal: (k.portal as string) || null };
      }),
      livreurs: livreurs.map((l: any) => ({ id: num(l.id), name: l.name as string, phone: (l.phone as string) ?? null, companyId: numOrNull(l.livreur_company_id) })),
    };
  }),

  /** Orders that can get a claim: sent to a courier or given to a livreur. */
  'suivi.findOrders': proc(['suivi', 'confirmation', 'depot'], z.object({ q: z.string().min(2).max(100) }), (ctx, { q }) =>
    findOrders(ctx, q, 8, (w) => w.add(`(o.company_id IS NOT NULL AND (o.tracking IS NOT NULL OR o.livreur_id IS NOT NULL))${andSql(rowScopeSql(ctx))}`)),
  ),

  /** Dashboard › Suivi: per delivery company (and our livreurs), the open claims, those without an answer after 48 h, and those at the manager. */
  'suivi.claimsLate': proc(['suivi', 'agent_manager', 'vendeur'], z.object({}), async (ctx) => {
    // a confirmation agency: only the claims on its own orders
    const mine = rowScopeSql(ctx);
    const rows = (await ctx.db.query(`${CLAIM_SELECT} WHERE c.status NOT IN ${CLAIM_DONE}${mine ? ` AND c.order_id IN (SELECT o.id FROM orders o WHERE ${mine})` : ''}`)).map((r: any) => toClaim(r, ctx.now()));
    const by = new Map<string, { name: string; open: number; late: number; manager: number; oldest: string | null }>();
    for (const c of rows) {
      const name = c.livreurId ? c.livreurName ?? '—' : c.companyName ?? '—';
      const g = by.get(name) ?? { name, open: 0, late: 0, manager: 0, oldest: null };
      g.open++;
      if (c.stage === 'relancer' || c.stage === 'manager') g.late++;
      if (c.stage === 'manager') g.manager++;
      if (!g.oldest || c.createdAt < g.oldest) g.oldest = c.createdAt;
      by.set(name, g);
    }
    return [...by.values()].sort((a, b) => b.late - a.late || b.open - a.open);
  }),

  'suivi.claims': proc(['suivi', 'confirmation', 'depot'], ClaimsInput, (ctx, f) => listClaims(ctx, f)),

  'suivi.claimCreate': proc(['suivi', 'confirmation', 'depot'], ClaimCreate, (ctx, i) =>
    withActionLock(ctx.db, `claim:order:${i.orderId}`, ctx.session.profile.id, 'Réclamation déjà en cours d’envoi pour cette commande', () => createClaim(ctx, i)),
  ),

  /** Sends (again) a saved claim to the courier's API, e.g. after a refusal. */
  'suivi.claimPush': proc(['suivi', 'confirmation', 'depot'], z.object({ id, categoryId: z.string().max(100).nullable().optional() }), (ctx, i) =>
    withActionLock(ctx.db, `claim:${i.id}`, ctx.session.profile.id, 'Réclamation déjà en cours d’envoi', () => pushClaim(ctx, i.id, i.categoryId ?? null)),
  ),

  /** The courier's claim categories (ZR), to choose one in the form. */
  'suivi.claimCategories': proc(['suivi', 'confirmation', 'depot'], z.object({ companyId: id }), async (ctx, { companyId }): Promise<ClaimCategory[]> => {
    const k = (await ctx.db.query('SELECT kind FROM delivery_companies WHERE id = $1', [companyId]))[0]?.kind as CourierKind | undefined;
    if (!k || !KINDS[k]?.claims) return [];
    if (!ctx.server) return DEMO_CATS;
    try {
      return (await ctx.server.courier('claimCategories', { companyId }, ctx)) as ClaimCategory[];
    } catch {
      return [];
    }
  }),

  /** Relance of a claim sent through the API: the text goes to the courier as a comment on its claim. */
  'suivi.claimRemind': proc(['suivi', 'confirmation', 'depot'], z.object({ id, text: z.string().trim().min(1).max(2000) }), async (ctx, i) => {
    const cur = await getClaim(ctx.db, i.id);
    if (!cur.extId || !cur.companyId) throw bad(`${cur.ref} n’a pas été créée chez la société par l’API`);
    // ZR's id for the message: read back with the conversation, it is known as the shop's own (never as ZR's answer)
    const sent = ctx.server ? ((await ctx.server.courier('claimComment', { companyId: cur.companyId, extId: cur.extId, text: i.text }, ctx)) as { extId?: string | null } | null) : null;
    const me = ctx.session.profile.id;
    const nowIso = new Date(ctx.now()).toISOString();
    const status = cur.status === 'waiting' ? 'still_waiting' : cur.status;
    const text = `Relance envoyée à ${cur.companyName ?? 'la société'} (API) : ${i.text}`.slice(0, 1000);
    await ctx.db.query(`UPDATE claims SET notes = $2, status = $3, updated_at = $4::timestamptz WHERE id = $1`, [i.id, JSON.stringify([...cur.notes, { at: nowIso, userId: me, text, status: status !== cur.status ? status : null, ext: { id: sent?.extId ?? null, mine: true } }]), status, nowIso]);
    if (cur.orderId) await addEvent(ctx.db, cur.orderId, me, 'note', null, 'event', `Réclamation ${cur.ref} : ${text}`.slice(0, 300));
    ctx.emit({ type: 'order', id: cur.orderId ?? undefined });
    return getClaim(ctx.db, i.id);
  }),

  /** Reads back from the courier the state of the claims sent through its API. */
  'suivi.claimSync': proc(['suivi', 'confirmation', 'depot'], z.object({ id: id.optional() }), (ctx, i) => {
    // a confirmation agency asks one claim of its own (all the store's claims are not its business)
    if (agencyOf(ctx) !== null && !i.id) throw bad('Choisissez la réclamation');
    return syncClaims(ctx, i.id);
  }),

  'suivi.claimUpdate': proc(['suivi', 'confirmation', 'depot'], ClaimUpdate, async (ctx, i) => {
    const cur = await getClaim(ctx.db, i.id);
    const me = ctx.session.profile.id;
    const nowIso = new Date(ctx.now()).toISOString();
    const parts: string[] = [];
    if (i.sentVia) parts.push(`${cur.sentAt ? 'Relance' : 'Envoyée'} (${VIA_FR[i.sentVia]})`);
    if (i.status && i.status !== cur.status) parts.push(CLAIM_STATUS_FR[i.status]);
    if (i.note?.trim()) parts.push(i.note.trim());
    if (!parts.length && !i.message) return cur;
    const notes = parts.length ? [...cur.notes, { at: nowIso, userId: me, text: parts.join(' · '), status: i.status ?? null }] : cur.notes;
    const status = i.status ?? cur.status;
    await ctx.db.query(
      `UPDATE claims SET status=$2, notes=$3, message=COALESCE($4, message), channel=COALESCE($5, channel),
         sent_at = CASE WHEN $6 THEN $7::timestamptz ELSE sent_at END,
         resolved_at = CASE WHEN $2 = 'resolved' THEN COALESCE(resolved_at, $7::timestamptz) ELSE NULL END,
         updated_at=$7::timestamptz WHERE id=$1`,
      [i.id, status, JSON.stringify(notes), i.message ?? null, i.sentVia ?? null, !!i.sentVia, nowIso],
    );
    if (cur.orderId && parts.length) await addEvent(ctx.db, cur.orderId, me, 'note', null, 'event', `Réclamation ${cur.ref} : ${parts.join(' · ')}`.slice(0, 300));
    ctx.emit({ type: 'order', id: cur.orderId ?? undefined });
    return getClaim(ctx.db, i.id);
  }),

  /** « Supprimer la réclamation » (admin only): removes it from Pilotix only — nothing is sent to the company. */
  'suivi.claimDelete': proc([], z.object({ id }), async (ctx, i) => {
    if (!ctx.session.isAdmin) throw bad('Seul un administrateur peut supprimer une réclamation');
    const cur = await getClaim(ctx.db, i.id);
    await ctx.db.query('DELETE FROM claims WHERE id = $1', [i.id]);
    // still at the courier: never brought back in from there
    if (cur.extId && cur.companyId) {
      const gone: string[] = (await readJson(ctx.db, GONE_KEY)) ?? [];
      await writeJson(ctx.db, GONE_KEY, [...gone, `${cur.companyId}:${cur.extId}`].slice(-5000));
    }
    if (cur.orderId) await addEvent(ctx.db, cur.orderId, ctx.session.profile.id, 'note', null, 'event', `Réclamation ${cur.ref} supprimée (dans Pilotix seulement)`);
    ctx.emit({ type: 'order', id: cur.orderId ?? undefined });
    return { ok: true };
  }),
};

