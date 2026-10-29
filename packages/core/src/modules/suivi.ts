// Suivi des livraisons: alerts, treated alerts, delivered, cancelled parcels, swaps and claims (réclamations) to couriers / livreurs.
import type { Order, Page } from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, isoOrNull, num, numOrNull, Where } from '../db';
import { bad, Ctx, notFound, proc, withActionLock } from '../rpc';
import { getSetting, setSetting } from '../settings';
import { addWorkMinutes, workMinutes } from '@pilotix/shared';
import { getPrefs } from './prefs';
import { addEvent, FollowInput, getOrder, listOrders, ListInput, setFollow } from './orders';
import { agencyOf, andSql, queueSql } from './agencyscope';
import { findOrders } from './sav';
import { applyTrust, DRIVER_CLAIMS } from './trust';
import { KINDS } from '../couriers/kinds';
import type { ClaimCategory, ClaimSent, ClaimState } from '../couriers/types';
import type { CourierKind } from '@pilotix/shared';

const id = z.number().int().positive();

export const SUIVI_TABS = ['enlivraison', 'alertes', 'traites', 'livres', 'annules', 'swap', 'swapped'] as const;
export type SuiviTab = (typeof SUIVI_TABS)[number];
/** Where a parcel can be swapped from: it is still with the courier or the livreur. */
export const SWAP_FROM = ['returning', 'failed', 'alert', 'out_for_delivery', 'shipped'] as const;
export const CLAIM_STATUSES = ['waiting', 'still_waiting', 'resolved'] as const;
export const CLAIM_REASONS = ['relivrer', 'late', 'nocall', 'fakedeliv', 'fakeret', 'address', 'damaged', 'money', 'noreturn', 'other'] as const;
export const TREAT_WHAT = ['date', 'adresse', 'injoignable', 'autre'] as const;

const DAY = 86_400_000;

/** Filters of each Suivi tab, expressed with the orders list. */
function tabFilter(tab: SuiviTab, now: number): Partial<ListInput> {
  switch (tab) {
    case 'enlivraison':
      return { follow: ['out_for_delivery', 'failed'], subStatusNot: 'alert_traitee', sort: 'shipped_at', dir: 'asc' };
    case 'alertes':
      return { follow: ['alert'], sort: 'updated_at', dir: 'asc' };
    case 'traites':
      return { follow: ['out_for_delivery', 'shipped', 'failed'], subStatus: 'alert_traitee', sort: 'updated_at', dir: 'desc' };
    case 'livres':
      return { follow: ['delivered'], dateField: 'delivered_at', from: new Date(now - 30 * DAY).toISOString(), sort: 'delivered_at', dir: 'desc' };
    case 'annules':
      return { follow: ['returning'], sort: 'updated_at', dir: 'desc' };
    case 'swap':
      return { follow: ['returning'], sort: 'updated_at', dir: 'desc' };
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
       (SELECT min(e.at) FROM order_events e WHERE e.order_id = o.id AND e.at > a.at AND e.user_id IS NOT NULL) AS acted_at
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
  /** how the alert was treated: « Résolu » or « Perdu », and its motif (Management › Motifs du Suivi) */
  motif: { outcome: 'resolved' | 'lost'; label: string } | null;
  clock: AlertClock | null;
  tries: AlertTries | null;
  companyKind: string | null;
  livreurPhone: string | null;
  claim: { id: number; status: string; createdAt: string; sentAt: string | null } | null;
  /** why the parcel is in alert (note of its last "alert" event), shown next to the tracking */
  alertReason: string | null;
}

async function extras(db: Db, orders: Order[], now = Date.now()): Promise<Record<number, SuiviRowExtra>> {
  if (!orders.length) return {};
  const ids = orders.map((o) => o.id);
  const alertIds = orders.filter((o) => o.followStatus === 'alert').map((o) => o.id);
  const clocks = await alertClocks(db, alertIds, now);
  const tries = await alertTries(db, alertIds, now);
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
    };
  }
  return out;
}

export async function suiviCounts(ctx: Ctx) {
  const d30 = new Date(ctx.now() - 30 * DAY).toISOString();
  const r = (
    await ctx.db.query(
      `SELECT
         count(*) FILTER (WHERE follow_status IN ('out_for_delivery','failed') AND COALESCE(sub_status,'') <> 'alert_traitee')::int AS enlivraison,
         count(*) FILTER (WHERE follow_status = 'alert')::int AS alertes,
         count(*) FILTER (WHERE sub_status = 'alert_traitee' AND follow_status IN ('out_for_delivery','shipped','failed'))::int AS traites,
         count(*) FILTER (WHERE follow_status = 'delivered' AND delivered_at >= $1)::int AS livres,
         count(*) FILTER (WHERE follow_status = 'returning')::int AS returning,
         count(*) FILTER (WHERE follow_status = 'cancelled' AND sub_status = 'annule_swappe')::int AS swapped
       FROM sales o WHERE follow_status IS NOT NULL${andSql(queueSql(ctx, 'follow'))}`,
      [d30],
    )
  )[0];
  // a confirmation agency's agents do not handle the store's claims with its couriers
  const claims = agencyOf(ctx) !== null ? 0 : num((await ctx.db.query(`SELECT count(*)::int AS n FROM claims WHERE status <> 'resolved'`))[0]?.n);
  // the manager's red number: alerts nobody called in time
  const alertIds = (await ctx.db.query(`SELECT o.id FROM orders o WHERE o.follow_status = 'alert'${andSql(queueSql(ctx, 'follow'))}`)).map((x: any) => num(x.id));
  const clocks = await alertClocks(ctx.db, alertIds, ctx.now());
  const lateCall = [...clocks.values()].filter((c) => c.kind === 'call' && c.state === 'late').length;
  const lateSolve = [...clocks.values()].filter((c) => c.kind === 'solve' && c.state === 'late').length;
  return {
    lateCall,
    lateSolve,
    enlivraison: num(r.enlivraison),
    alertes: num(r.alertes),
    traites: num(r.traites),
    livres: num(r.livres),
    annules: num(r.returning) + num(r.swapped),
    swap: num(r.returning),
    swapped: num(r.swapped),
    claims,
  };
}

// ---------------------------------------------------------------- swap
async function swapCandidates(ctx: Ctx, fromId: number, q?: string) {
  const from = await getOrder(ctx, fromId);
  const variants = new Set(from.items.map((i) => i.variantId).filter(Boolean));
  const products = new Set(from.items.map((i) => i.productId));
  let rows: Order[];
  if (q?.trim()) {
    rows = await findOrders(ctx, q.trim(), 15, (w) => w.add(`o.conf_status = 'confirmed' AND (o.follow_status IS NULL OR o.follow_status IN ('to_prepare','prepared')) AND o.shipped_at IS NULL`));
  } else {
    // confirmed orders still at the depot that ask for one of the parcel's products
    const ids = await ctx.db.query(
      `SELECT DISTINCT o.id FROM sales o JOIN order_items i ON i.order_id = o.id
       WHERE o.conf_status = 'confirmed' AND (o.follow_status IS NULL OR o.follow_status IN ('to_prepare','prepared')) AND o.shipped_at IS NULL
         AND o.id <> $1 AND i.product_id = ANY($2) LIMIT 150`,
      [fromId, [...products]],
    );
    rows = [];
    for (const r of ids) rows.push(await getOrder(ctx, num(r.id)));
  }
  const list = rows
    .filter((x) => x.id !== fromId && !x.shippedAt)
    .map((x) => {
      const sameVariant = x.items.some((i) => i.variantId && variants.has(i.variantId));
      const sameProduct = x.items.some((i) => products.has(i.productId));
      return { ...x, sameWilaya: x.wilayaId === from.wilayaId, sameVariant, sameProduct };
    })
    .sort(
      (a, b) =>
        Number(b.sameWilaya) - Number(a.sameWilaya) ||
        Number(a.followStatus === 'prepared') - Number(b.followStatus === 'prepared') ||
        Number(b.sameVariant) - Number(a.sameVariant) ||
        String(a.confirmedAt).localeCompare(String(b.confirmedAt)),
    )
    .slice(0, 30);
  return { from, rows: list };
}

export async function swapParcel(ctx: Ctx, fromId: number, toId: number, note?: string | null) {
  if (fromId === toId) throw bad('Choisissez une autre commande');
  const me = ctx.session.profile.id;
  const res = await ctx.db.tx(async (tx) => {
    const A = (await tx.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [fromId]))[0];
    const B = (await tx.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [toId]))[0];
    if (!A || !B) throw notFound('Commande introuvable');
    if (!A.shipped_at || !(SWAP_FROM as readonly string[]).includes(A.follow_status ?? '')) throw bad(`${A.ref} : le colis n’est pas chez la société ou le livreur`);
    if (B.conf_status !== 'confirmed') throw bad(`${B.ref} : la commande n’est pas confirmée`);
    if (B.shipped_at || !(B.follow_status === null || ['to_prepare', 'prepared'].includes(B.follow_status))) throw bad(`${B.ref} : déjà expédiée`);
    const nowIso = new Date(ctx.now()).toISOString();
    // The parcel (and its stock, already out of the depot) goes to B: no new stock out for B, no return for A.
    await tx.query(
      `UPDATE orders SET company_id=$2, delivery_cost=$3, tracking=$4, ext_id=$5, label_url=$6, ext_status=NULL, ext_status_at=NULL,
         warehouse_id=COALESCE($7, warehouse_id), livreur_id=$8, follow_status='out_for_delivery', sub_status='livraison_swappe',
         prepared_at=COALESCE(prepared_at, $9::timestamptz), shipped_at=$9::timestamptz, updated_at=now(), version=version+1 WHERE id=$1`,
      [B.id, A.company_id, num(A.delivery_cost) || num(B.delivery_cost), A.tracking, A.ext_id, A.label_url, A.warehouse_id, A.livreur_id, nowIso],
    );
    await tx.query(
      `UPDATE orders SET follow_status='cancelled', sub_status='annule_swappe', tracking=NULL, ext_id=NULL, label_url=NULL, ext_status=NULL, ext_status_at=NULL,
         updated_at=now(), version=version+1 WHERE id=$1`,
      [A.id],
    );
    const n = note ? ` · ${note}` : '';
    await addEvent(tx, num(A.id), me, 'follow_status', A.follow_status, 'cancelled', `Colis swappé vers ${B.ref}${n}`, { swap_to: num(B.id), tracking: A.tracking });
    await addEvent(tx, num(A.id), me, 'sub_status', A.sub_status, 'annule_swappe', null);
    const was = B.follow_status === 'prepared' ? ' · était En dispatch (emballée) : colis à défaire' : ' · retirée de En préparation';
    await addEvent(tx, num(B.id), me, 'follow_status', B.follow_status, 'out_for_delivery', `Colis swappé depuis ${A.ref} (${A.tracking ?? '—'})${was}${n}`, { swap_from: num(A.id), tracking: A.tracking });
    await addEvent(tx, num(B.id), me, 'sub_status', B.sub_status, 'livraison_swappe', null);
    const kind = A.company_id ? (await tx.query('SELECT kind FROM delivery_companies WHERE id=$1', [A.company_id]))[0]?.kind ?? null : null;
    return {
      from: await getOrder(ctx, num(A.id), tx),
      to: await getOrder(ctx, num(B.id), tx),
      oldTracking: (A.tracking as string | null) ?? null,
      wasPrepared: B.follow_status === 'prepared',
      oldTotal: num(A.total),
      companyKind: kind as string | null,
    };
  });
  ctx.emit({ type: 'orders' });
  return res;
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
  const to = await getOrder(ctx, num(d.swap_to));
  const kind = to.companyId ? (await ctx.db.query('SELECT kind FROM delivery_companies WHERE id=$1', [to.companyId]))[0]?.kind ?? null : null;
  return { from, to, oldTracking: (d.tracking as string | null) ?? to.tracking, oldTotal: from.total, companyKind: kind as string | null };
}

// ---------------------------------------------------------------- claims
export interface Claim {
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
}

const claimRef = (n: number) => `REC-${String(n).padStart(4, '0')}`;
const CLAIM_SELECT = `SELECT c.*, o.ref AS order_ref, o.tracking, o.customer_name, o.phone, co.name AS company_name, co.kind AS company_kind, lv.name AS livreur_name, lv.phone AS livreur_phone, cb.name AS created_by_name
  FROM claims c LEFT JOIN orders o ON o.id = c.order_id LEFT JOIN delivery_companies co ON co.id = c.company_id
  LEFT JOIN profiles lv ON lv.id = c.livreur_id LEFT JOIN profiles cb ON cb.id = c.created_by`;

function toClaim(r: any): Claim {
  const notes = typeof r.notes === 'string' ? JSON.parse(r.notes) : r.notes ?? [];
  return {
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
  };
}

// ---------------------------------------------------------------- claims through the courier API (ZR)
const REASON_FR: Record<string, string> = {
  relivrer: 'Relivrer le colis', late: 'Retard de livraison', nocall: 'Le livreur n’a pas appelé le client', fakedeliv: 'Faux statut « livré »',
  fakeret: 'Faux statut « retour »', address: 'Changement d’adresse', damaged: 'Colis endommagé', money: 'Problème de versement',
  noreturn: 'Retour non reçu', other: 'Autre',
};

const DEMO_CATS: ClaimCategory[] = [
  { id: 'demo-retard', name: 'Retard de livraison' },
  { id: 'demo-relivraison', name: 'Demande de relivraison' },
  { id: 'demo-statut', name: 'Statut erroné' },
  { id: 'demo-endommage', name: 'Colis endommagé' },
  { id: 'demo-adresse', name: 'Modification d’adresse' },
  { id: 'demo-paiement', name: 'Paiement / versement' },
  { id: 'demo-retour', name: 'Retour non reçu' },
  { id: 'demo-autre', name: 'Autre' },
];

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
    if (!ctx.server) sent = { extId: `demo-${cid}`, extRef: `D${String(1000000 + cid)}`, status: 'Nouvelle' };
    else
      sent = (await ctx.server.courier('claim', { companyId: cur.companyId, claim: { ref: cur.ref, item: { id: num(o.id), tracking: o.tracking, extId: o.ext_id ?? null }, reason: cur.reason, reasonText, categoryId, description } }, ctx)) as ClaimSent;
  } catch (e: any) {
    error = String(e?.message ?? 'Erreur').slice(0, 300);
  }
  const text = sent ? `Envoyée à ${cur.companyName ?? 'la société'} (API)${sent.extRef ? ` · n° ${sent.extRef}` : ''}` : `${cur.companyName ?? 'La société'} refuse : ${error}`;
  const notes = [...cur.notes, { at: nowIso, userId: me, text, status: null }];
  await ctx.db.query(
    `UPDATE claims SET notes = $2, ext_id = $3, ext_ref = $4, ext_status = $5, ext_error = $6,
       channel = CASE WHEN $3::text IS NULL THEN channel ELSE 'api' END,
       sent_at = CASE WHEN $3::text IS NULL THEN sent_at ELSE COALESCE(sent_at, $7::timestamptz) END, updated_at = $7::timestamptz WHERE id = $1`,
    [cid, JSON.stringify(notes), sent?.extId ?? null, sent?.extRef ?? null, sent?.status ?? null, error, nowIso],
  );
  if (cur.orderId) await addEvent(ctx.db, cur.orderId, me, 'note', null, 'event', `Réclamation ${cur.ref} : ${text}`.slice(0, 300));
  ctx.emit({ type: 'order', id: cur.orderId ?? undefined });
  return getClaim(ctx.db, cid);
}

/** Reads back the state of the open claims sent through an API; a closed one becomes "Réglée", ZR's answer goes in the history. */
async function syncClaims(ctx: Ctx, onlyId?: number) {
  const rows = await ctx.db.query(
    `SELECT c.id, c.company_id, c.ext_id, c.ext_status, c.ext_answer, c.notes, c.order_id, c.status FROM claims c
     WHERE c.ext_id IS NOT NULL AND c.status <> 'resolved' ${onlyId ? 'AND c.id = $1' : ''} ORDER BY c.updated_at LIMIT 200`,
    onlyId ? [onlyId] : [],
  );
  let changed = 0;
  let checked = 0;
  const errors: string[] = [];
  const byCompany = new Map<number, any[]>();
  for (const r of rows) byCompany.set(num(r.company_id), [...(byCompany.get(num(r.company_id)) ?? []), r]);
  const nowIso = new Date(ctx.now()).toISOString();
  for (const [companyId, list] of byCompany) {
    let states: ClaimState[] = [];
    if (!ctx.server) states = list.map((r) => ({ extId: r.ext_id, status: r.ext_status || 'Nouvelle', resolved: false }));
    else
      try {
        states = (await ctx.server.courier('claimStates', { companyId, extIds: list.map((r) => r.ext_id) }, ctx)) as ClaimState[];
      } catch (e: any) {
        errors.push(String(e?.message ?? 'Erreur'));
        continue;
      }
    for (const st of states) {
      const r = list.find((x) => x.ext_id === st.extId);
      if (!r) continue;
      checked++;
      const notes = typeof r.notes === 'string' ? JSON.parse(r.notes) : r.notes ?? [];
      const parts: string[] = [];
      if (st.status && st.status !== r.ext_status) parts.push(`Statut ZR : ${st.status}`);
      if (st.answer && st.answer !== r.ext_answer) parts.push(`Réponse : ${st.answer}`);
      const status = st.resolved ? 'resolved' : r.status;
      if (!parts.length && status === r.status) {
        await ctx.db.query('UPDATE claims SET ext_synced_at = $2 WHERE id = $1', [r.id, nowIso]);
        continue;
      }
      changed++;
      if (status !== r.status) parts.push(CLAIM_STATUS_FR[status]);
      notes.push({ at: nowIso, userId: null, text: parts.join(' · '), status: status !== r.status ? status : null });
      await ctx.db.query(
        `UPDATE claims SET ext_status = $2, ext_answer = COALESCE($3, ext_answer), status = $4, notes = $5, ext_synced_at = $6::timestamptz, updated_at = $6::timestamptz,
           resolved_at = CASE WHEN $4 = 'resolved' THEN COALESCE(resolved_at, $6::timestamptz) ELSE resolved_at END WHERE id = $1`,
        [r.id, st.status, st.answer ?? null, status, JSON.stringify(notes), nowIso],
      );
      if (r.order_id) await addEvent(ctx.db, num(r.order_id), null, 'note', null, 'event', `Réclamation ${claimRef(num(r.id))} : ${parts.join(' · ')}`.slice(0, 300));
    }
  }
  if (changed) ctx.emit({ type: 'orders' });
  return { checked, changed, errors };
}

async function getClaim(db: Db, cid: number) {
  const r = (await db.query(`${CLAIM_SELECT} WHERE c.id = $1`, [cid]))[0];
  if (!r) throw notFound('Réclamation introuvable');
  return toClaim(r);
}

const ClaimsInput = z.object({
  target: z.enum(['company', 'livreur', 'all']).default('all'),
  status: z.enum([...CLAIM_STATUSES, 'open', 'all']).default('all'),
  orderId: id.optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(500).default(100),
});

async function listClaims(ctx: Ctx, f: z.infer<typeof ClaimsInput>): Promise<Page<Claim> & { counts: Record<string, number> }> {
  const w = new Where();
  if (f.target === 'company') w.add('c.livreur_id IS NULL');
  if (f.target === 'livreur') w.add('c.livreur_id IS NOT NULL');
  if (f.orderId) w.add('c.order_id = ?', f.orderId);
  const base = w.sql;
  const cnt = await ctx.db.query(`SELECT c.status AS k, count(*)::int AS n FROM claims c ${base} GROUP BY 1`, w.params);
  const counts: Record<string, number> = { waiting: 0, still_waiting: 0, resolved: 0 };
  for (const r of cnt) counts[r.k] = num(r.n);
  counts.open = counts.waiting + counts.still_waiting;
  counts.all = counts.open + counts.resolved;
  if (f.status === 'open') w.add(`c.status <> 'resolved'`);
  else if (f.status !== 'all') w.add('c.status = ?', f.status);
  const total = num((await ctx.db.query(`SELECT count(*)::int AS n FROM claims c ${w.sql}`, w.params))[0]?.n);
  const lim = w.p(f.pageSize);
  const off = w.p((f.page - 1) * f.pageSize);
  const rows = await ctx.db.query(`${CLAIM_SELECT} ${w.sql} ORDER BY c.created_at DESC, c.id DESC LIMIT ${lim} OFFSET ${off}`, w.params);
  return { rows: rows.map(toClaim), total, page: f.page, pageSize: f.pageSize, counts };
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

const CLAIM_STATUS_FR: Record<string, string> = { waiting: 'En attente', still_waiting: 'Toujours en attente', resolved: 'Réglée' };
const VIA_FR: Record<string, string> = { whatsapp: 'WhatsApp', email: 'e-mail', copy: 'copié', phone: 'téléphone' };

// ---------------------------------------------------------------- procedures
const ListSuivi = z.object({
  tab: z.enum(SUIVI_TABS),
  q: z.string().max(100).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(500).default(300),
});

/** A new claim on an order (one open claim per reason: a second click or the same claim again is refused). */
async function createClaim(ctx: Ctx, i: z.infer<typeof ClaimCreate>): Promise<Claim> {
  const o = await getOrder(ctx, i.orderId);
  const open = (await ctx.db.query(`SELECT id FROM claims WHERE order_id = $1 AND reason = $2 AND status <> 'resolved' LIMIT 1`, [i.orderId, i.reason]))[0];
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

const MotifIn = z.object({ key: z.string().regex(/^[a-z0-9_]{1,40}$/), fr: z.string().trim().min(1).max(80), ar: z.string().trim().max(80).default(''), on: z.boolean(), client: z.boolean().optional() });
const cleanMotif = (m: z.infer<typeof MotifIn>) => ({ key: m.key, fr: m.fr, ar: m.ar, on: m.on, ...(m.client ? { client: true } : {}) });

/** A parcel another agent took with « Alerte suivante » (15 minutes): he is calling, nobody else acts on it. */
async function notLockedByOther(ctx: Ctx, oid: number) {
  const r = (await ctx.db.query(
    `SELECT o.ref, p.name FROM orders o JOIN profiles p ON p.id = o.locked_by WHERE o.id = $1 AND o.locked_until > now() AND o.locked_by <> $2 AND o.follow_status = 'alert'`,
    [oid, ctx.session.profile.id],
  ))[0];
  if (r && !ctx.session.isAdmin) throw bad(`${r.ref} : ${r.name} s’en occupe en ce moment`);
}

export const suiviProcs = {
  'suivi.counts': proc(['suivi'], z.object({}), (ctx) => suiviCounts(ctx)),

  'suivi.list': proc(['suivi'], ListSuivi, async (ctx, i) => {
    const page = await listOrders(ctx, ListInput.parse({ ...tabFilter(i.tab, ctx.now()), q: i.q, page: i.page, pageSize: i.pageSize }), { queue: 'follow' });
    // the swap list only shows parcels that really left (still with the courier or the livreur)
    const rows = i.tab === 'swap' ? page.rows.filter((o) => o.shippedAt) : page.rows;
    return { ...page, rows, extra: await extras(ctx.db, rows, ctx.now()) };
  }),

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
      relance: z.boolean().default(true),
    }),
    async (ctx, i) => {
      const cur = await getOrder(ctx, i.id);
      if (cur.followStatus !== 'alert') throw bad(`${cur.ref} n’est pas en alerte`);
      await notLockedByOther(ctx, i.id);
      const all = await getSetting(ctx.db, 'suiviMotifs');
      const m = (i.outcome === 'resolved' ? all.resolved : all.lost).find((x) => x.key === i.motif && x.on);
      if (!m) throw bad('Choisissez un motif');
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
        return { order: await getOrder(ctx, i.id), claim, claimError };
      }
      const tr = (await alertTries(ctx.db, [i.id], ctx.now())).get(i.id);
      const enough = !!tr && tr.done >= tr.need;
      const early = !enough && !m.client;
      if (early && (!i.early || !note)) throw bad(`${cur.ref} : faites d’abord ${tr?.need ?? 3} appels (${tr?.done ?? 0} faits), ou dites pourquoi vous annulez avant`);
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
      return { order: await getOrder(ctx, i.id), claim: null, claimError: null };
    },
  ),

  /**
   * « Alerte suivante »: the most urgent alert for this agent, locked to him 15 minutes so nobody calls the same customer.
   * His own parcels first (once he acted on a parcel it stays his until it ends), then the alerts of nobody — or of an
   * agent not seen for 8 hours (off today) — the oldest alert first.
   */
  'suivi.next': proc(['suivi'], z.object({ skip: z.array(id).max(200).default([]), release: id.nullable().optional() }), async (ctx, i) => {
    const me = ctx.session.profile.id;
    if (i.release) await ctx.db.query('UPDATE orders SET locked_by = NULL, locked_until = NULL WHERE id = $1 AND locked_by = $2', [i.release, me]);
    // picked and locked in one statement: two agents pressing at the same time never get the same parcel
    const r = await ctx.db.query(
      `UPDATE orders SET locked_by = $1, locked_until = now() + interval '15 minutes'
        WHERE id = (
          SELECT o.id FROM orders o LEFT JOIN profiles fa ON fa.id = o.follow_agent_id
           WHERE o.follow_status = 'alert' AND NOT (o.id = ANY($2))
             AND (o.locked_until IS NULL OR o.locked_until < now() OR o.locked_by = $1)
             AND (o.follow_agent_id IS NULL OR o.follow_agent_id = $1 OR fa.last_seen_at IS NULL OR fa.last_seen_at < now() - interval '8 hours')${andSql(queueSql(ctx, 'follow'))}
           ORDER BY (o.follow_agent_id = $1) DESC NULLS LAST,
             (SELECT max(e.at) FROM order_events e WHERE e.order_id = o.id AND e.kind = 'follow_status' AND e.to_value = 'alert') ASC NULLS FIRST, o.id
           LIMIT 1 FOR UPDATE OF o SKIP LOCKED)
       RETURNING id`,
      [me, i.skip],
    );
    if (!r[0]) return { id: null, order: null, extra: null };
    const order = await getOrder(ctx, num(r[0].id));
    return { id: order.id, order, extra: (await extras(ctx.db, [order], ctx.now()))[order.id] ?? null };
  }),

  /** Leaves the parcel taken with « Alerte suivante » (closed without acting): another agent may take it. */
  'suivi.release': proc(['suivi'], z.object({ id }), async (ctx, i) => {
    await ctx.db.query('UPDATE orders SET locked_by = NULL, locked_until = NULL WHERE id = $1 AND (locked_by = $2 OR $3)', [i.id, ctx.session.profile.id, ctx.session.isAdmin]);
    return { ok: true };
  }),

  'suivi.unassign': proc(['suivi'], z.object({ id }), async (ctx, { id: oid }) => {
    const cur = (await ctx.db.query('SELECT follow_agent_id FROM orders WHERE id = $1', [oid]))[0];
    if (!cur) throw notFound('Commande introuvable');
    if (cur.follow_agent_id !== null) {
      await ctx.db.query('UPDATE orders SET follow_agent_id = NULL, updated_at = now() WHERE id = $1', [oid]);
      await addEvent(ctx.db, oid, ctx.session.profile.id, 'note', null, null, 'Agent suivi retiré');
      ctx.emit({ type: 'orders' });
    }
    return getOrder(ctx, oid);
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

  'suivi.swapCandidates': proc(['suivi'], z.object({ fromId: id, q: z.string().max(100).optional() }), (ctx, i) => swapCandidates(ctx, i.fromId, i.q)),
  'suivi.swap': proc(['suivi'], z.object({ fromId: id, toId: id, note: z.string().max(500).nullable().optional() }), (ctx, i) => swapParcel(ctx, i.fromId, i.toId, i.note)),
  'suivi.swapTarget': proc(['suivi'], z.object({ id }), (ctx, i) => swapTarget(ctx, i.id)),

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
    findOrders(ctx, q, 8, (w) => w.add('(o.company_id IS NOT NULL AND (o.tracking IS NOT NULL OR o.livreur_id IS NOT NULL))')),
  ),

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
    if (ctx.server) await ctx.server.courier('claimComment', { companyId: cur.companyId, extId: cur.extId, text: i.text }, ctx);
    const me = ctx.session.profile.id;
    const nowIso = new Date(ctx.now()).toISOString();
    const status = cur.status === 'waiting' ? 'still_waiting' : cur.status;
    const text = `Relance envoyée à ${cur.companyName ?? 'la société'} (API) : ${i.text}`.slice(0, 1000);
    await ctx.db.query(`UPDATE claims SET notes = $2, status = $3, updated_at = $4::timestamptz WHERE id = $1`, [i.id, JSON.stringify([...cur.notes, { at: nowIso, userId: me, text, status: status !== cur.status ? status : null }]), status, nowIso]);
    if (cur.orderId) await addEvent(ctx.db, cur.orderId, me, 'note', null, 'event', `Réclamation ${cur.ref} : ${text}`.slice(0, 300));
    ctx.emit({ type: 'order', id: cur.orderId ?? undefined });
    return getClaim(ctx.db, i.id);
  }),

  /** Reads back from the courier the state of the claims sent through its API. */
  'suivi.claimSync': proc(['suivi', 'confirmation', 'depot'], z.object({ id: id.optional() }), (ctx, i) => syncClaims(ctx, i.id)),

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
};

