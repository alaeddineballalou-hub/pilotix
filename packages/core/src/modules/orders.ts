import {
  API_COURIER_KINDS,
  canSetConf,
  canSetFollow,
  CONF_DONE_BAD,
  CONF_NEEDS_DATE,
  CONF_NEEDS_REASON,
  CONF_STATUSES,
  CONF_TODO,
  ConfStatus,
  FOLLOW_FINAL,
  FOLLOW_LOCKED,
  FOLLOW_STATUSES,
  FollowStatus,
  normalizePhone,
  Order,
  OrderEvent,
  OrderItem,
  OrderPay,
  OrigLine,
  origOf,
  upsellOf,
  Page,
  SALES_CHANNELS,
} from '@pilotix/shared';
import { officialCommune } from './coverage';
import { z } from 'zod';
import { Db, iso, isoOrNull, num, numOrNull, Where } from '../db';
import { CLIENT_FACT_COLS, ClientScore, orderIdsByScore, recordRiskConfirms, scoresOf } from './clientscore';
import { bad, Ctx, forbidden, hasRole, notFound, proc } from '../rpc';
import { clientFee, getSetting } from '../settings';
import { getPrefs } from './prefs';
import { channelGuard, guardNote, type GuardMode } from './guard';
import { assignNow, getAssign } from './assign';
import { notifyContext, onConfChange, onFollowChange, onOrderCreated, sendInPreview } from './notify';
import { landingCounts, landingSettings, onLandingConf, onLandingFollow } from './landingquery';
import { lowStockCount } from './stockquery';
import { agencyOf, agencyRowSql, andSql, queueSql } from './agencyscope';
import { settleTickets } from './tickets';
import { addDepotAlert, alertsDepot, DepotChange, itemsText } from './depotalerts';
import { blockerText, checkLines, checkOrder, deliverCheck } from './confirmcheck';
import { releaseNoStock } from './nostock';
import { applyTrust, lookAlikeNote, lookAlikeOf } from './trust';
import { companyLock, pilotMayRun, pilotPick, setPick, type Pick } from './pilot';
import { apiFees, declaredKg, feesByApi, ruleFee, weightRuleOf, weightRuleSet, wholeKg } from './courierfees';

export const STOPDESK_NOTE = '🏬 Ce client a refusé 2 colis : livraison au bureau (stop-desk) uniquement. Proposez-lui le stop-desk le plus proche.';

// ---------------------------------------------------------------- reading
const ORDER_COLS = `o.*,
  (SELECT coalesce(json_agg(json_build_object('id', i.id, 'productId', i.product_id, 'variantId', i.variant_id, 'name', i.name,
     'variantTitle', i.variant_title, 'qty', i.qty, 'unitPrice', i.unit_price, 'purchasePrice', i.purchase_price, 'isUpsell', i.is_upsell) ORDER BY i.id), '[]')
   FROM order_items i WHERE i.order_id = o.id) AS items_json,
  ag.name AS agent_name, fa.name AS follow_agent_name, co.name AS company_name, lv.name AS livreur_name,
  CASE WHEN o.is_exchange THEN (SELECT k.ref FROM complaints k WHERE k.exchange_order_id = o.id ORDER BY k.id DESC LIMIT 1) END AS sav_ref,
  c.blacklisted AS c_blacklisted, c.delivered AS c_delivered, c.returned AS c_returned, c.stopdesk_only AS c_stopdesk, c.refusals AS c_refusals,
  (SELECT lk.phone FROM customers lk WHERE lk.id = o.looks_like_customer_id) AS looks_like_phone,
  CASE WHEN o.utm->>'ad_id' IS NOT NULL THEN (SELECT ad.name FROM ads ad WHERE ad.id = o.utm->>'ad_id') END AS ad_name,
  EXISTS (SELECT 1 FROM sales d WHERE d.phone = o.phone AND d.id <> o.id AND d.conf_status = ANY('{to_check,new,no_answer,busy,callback,postponed,confirmed,no_stock}')
          AND (d.follow_status IS NULL OR d.follow_status IN ('to_prepare','prepared')) AND d.created_at > o.created_at - interval '15 days') AS possible_dup,
  CASE WHEN o.locked_until > now() THEN o.locked_by END AS lock_id,
  CASE WHEN o.locked_until > now() THEN (SELECT lp.name FROM profiles lp WHERE lp.id = o.locked_by) END AS lock_name`;

const ORDER_FROM = `FROM orders o
  JOIN customers c ON c.id = o.customer_id
  LEFT JOIN profiles ag ON ag.id = o.agent_id
  LEFT JOIN profiles fa ON fa.id = o.follow_agent_id
  LEFT JOIN profiles lv ON lv.id = o.livreur_id
  LEFT JOIN delivery_companies co ON co.id = o.company_id`;

export function toOrder(r: any): Order {
  const items = typeof r.items_json === 'string' ? JSON.parse(r.items_json) : r.items_json ?? [];
  return {
    id: num(r.id),
    ref: r.ref,
    createdAt: iso(r.created_at),
    createdBy: numOrNull(r.created_by),
    customerId: num(r.customer_id),
    customerName: r.customer_name,
    phone: r.phone,
    phone2: r.phone2,
    wilayaId: num(r.wilaya_id),
    commune: r.commune,
    address: r.address,
    isStopdesk: r.is_stopdesk,
    stopdeskId: numOrNull(r.stopdesk_id),
    channel: r.channel,
    source: r.source,
    utm: r.utm,
    landingId: numOrNull(r.landing_id),
    confStatus: r.conf_status,
    agentId: numOrNull(r.agent_id),
    attempts: num(r.attempts),
    nextCallAt: isoOrNull(r.next_call_at),
    confirmedAt: isoOrNull(r.confirmed_at),
    followStatus: r.follow_status,
    followAgentId: numOrNull(r.follow_agent_id),
    companyId: numOrNull(r.company_id),
    warehouseId: numOrNull(r.warehouse_id),
    livreurId: numOrNull(r.livreur_id),
    tracking: r.tracking,
    ownTracking: r.own_tracking,
    extStatus: r.ext_status,
    deliveryAttempts: num(r.delivery_attempts),
    subtotal: num(r.subtotal),
    deliveryFee: num(r.delivery_fee),
    discount: num(r.discount),
    total: num(r.total),
    deliveryCost: num(r.delivery_cost),
    cashed: r.cashed,
    cashedAt: isoOrNull(r.cashed_at),
    customerNote: r.customer_note,
    deliveryNote: r.delivery_note,
    internalNote: r.internal_note,
    isExchange: r.is_exchange,
    savRef: r.sav_ref ?? null,
    originalOrderId: numOrNull(r.original_order_id),
    hasUpsell: r.has_upsell,
    upsellValue: num(r.upsell_value),
    origItems: readOrig(r.orig_items),
    origDiscount: num(r.orig_discount),
    preparedAt: isoOrNull(r.prepared_at),
    shippedAt: isoOrNull(r.shipped_at),
    deliveredAt: isoOrNull(r.delivered_at),
    returnedAt: isoOrNull(r.returned_at),
    updatedAt: iso(r.updated_at),
    items: items.map((i: any) => ({ ...i, id: num(i.id), productId: num(i.productId), variantId: numOrNull(i.variantId) })),
    possibleDuplicate: r.possible_dup ?? undefined,
    blacklisted: r.c_blacklisted ?? undefined,
    customerDelivered: r.c_delivered ?? undefined,
    customerReturned: r.c_returned ?? undefined,
    customerStopdeskOnly: r.c_stopdesk ?? undefined,
    customerRefusals: r.c_refusals ?? undefined,
    looksLikePhone: r.looks_like_phone ?? null,
    adName: r.ad_name ?? null,
    agentName: r.agent_name ?? null,
    lockedBy: r.lock_id ? { id: num(r.lock_id), name: (r.lock_name as string | null) ?? '', until: iso(r.locked_until) } : null,
    followAgentName: r.follow_agent_name ?? null,
    companyName: r.company_name ?? null,
    livreurName: r.livreur_name ?? null,
    subStatus: r.sub_status ?? null,
    lastCallAt: isoOrNull(r.last_call_at),
    version: num(r.version),
    confAgencyId: numOrNull(r.conf_agency_id),
    followAgencyId: numOrNull(r.follow_agency_id),
    sendError: (r.send_error as string | null) ?? null,
    cancelByHand: !!r.cancel_by_hand,
    pilotBy: (r.pilot_by as string | null) ?? null,
    pilotRule: (r.pilot_rule as string | null) ?? null,
    pilotWhy: (r.pilot_why as string | null) ?? null,
  };
}

const onlyOwnDeliveries = (ctx: Ctx) => {
  const s = ctx.session;
  return !s.isAdmin && s.roles.includes('livreur') && !s.roles.some((r) => ['confirmation', 'suivi', 'depot'].includes(r));
};

/** Accounts with no order work at all (a marketer): they never read customers' names, phones or addresses. */
export const noOrderAccess = (ctx: Ctx) => {
  const s = ctx.session;
  return !s.isAdmin && !s.roles.some((r) => ['confirmation', 'suivi', 'depot', 'livreur', 'agent_manager', 'vendeur'].includes(r));
};

/** The orders an agent may take now with « Commande suivante », the most urgent first ($1 to-do statuses, $2 the agent, $3 skipped). */
const nextFrom = (ctx: Ctx) => `FROM orders o WHERE conf_status = ANY($1) AND (agent_id IS NULL OR agent_id = $2) AND NOT (id = ANY($3))
  AND (next_call_at IS NULL OR next_call_at <= now()) AND (locked_until IS NULL OR locked_until < now() OR locked_by = $2)${andSql(queueSql(ctx, 'conf', 'o', { free: true }))}
  ORDER BY (next_call_at IS NOT NULL) DESC, next_call_at ASC, created_at ASC`;

/** What « Commande suivante » would give this agent (nothing taken): to choose between several stores. */
export async function peekNext(ctx: Ctx, skip: number[]): Promise<{ nextCallAt: string | null; createdAt: string } | null> {
  const r = (await ctx.db.query(`SELECT next_call_at, created_at ${nextFrom(ctx)} LIMIT 1`, [CONF_TODO, ctx.session.profile.id, skip]))[0];
  return r ? { nextCallAt: isoOrNull(r.next_call_at), createdAt: iso(r.created_at) } : null;
}

/** Our own livreurs: parcels not in their hands yet (before their scan) show no customer — only the parcel. */
export const NOT_TAKEN = ['to_prepare', 'prepared', 'shipped'];
export const hideCustomer = (o: Order): Order => (NOT_TAKEN.includes(String(o.followStatus)) ? { ...o, customerName: '', phone: '', phone2: null, address: '' } : o);

/** Each order with its customer's score out of 100 (clientscore.ts): one query for all the customers of the page, the
 *  network asked once. Not for a livreur who only sees his own deliveries (no customer data there). */
export async function withClientScores<T extends Order>(ctx: Ctx, list: T[]): Promise<T[]> {
  if (onlyOwnDeliveries(ctx)) return list;
  const ids = [...new Set(list.map((o) => o.customerId).filter((x): x is number => !!x))];
  if (!ids.length) return list;
  const rows = await ctx.db.query(`SELECT c.id, c.phone, c.blacklisted, c.blacklist_auto, c.stopdesk_only, ${CLIENT_FACT_COLS} FROM customers c WHERE c.id = ANY($1::bigint[])`, [ids]);
  const scores = await scoresOf(ctx, rows);
  const by = new Map<number, ClientScore>(rows.map((r: any, k: number) => [num(r.id), scores[k]]));
  return list.map((o) => {
    const s = by.get(o.customerId);
    return s ? { ...o, clientScore: { score: s.score, level: s.level, reasons: s.reasons } } : o;
  });
}

/** A courier status saying the company holds the parcel's money (ZR « Encaissé », « Recouvert »), not « to cash ». */
const COLLECTED_RE = /encaiss[eé](?![a-zà-ÿ])|recouvr/i;

/**
 * The order card: where the money of a delivered parcel is — not paid yet → the company has it (its status) → the
 * company paid it (a ZR payment still to pick up, its parcels known) → received (cashed, with the payment it came in).
 */
export async function payOf(db: Db, o: Order): Promise<OrderPay | null> {
  const paymentOf = async () =>
    o.companyId && o.tracking
      ? ((await db.query(`SELECT ref, ext_id, done, at FROM courier_payments WHERE company_id = $1 AND lines @> $2::jsonb ORDER BY at DESC NULLS LAST, id DESC LIMIT 1`, [o.companyId, JSON.stringify([{ tracking: o.tracking }])]))[0] ?? null)
      : null;
  const refOf = (p: any) => (p ? String(p.ref ?? '').trim() || String(p.ext_id ?? '').slice(0, 8) || null : null);
  if (o.cashed) return { step: 'received', at: o.cashedAt, ref: refOf(await paymentOf()) };
  if (o.followStatus !== 'delivered') return null;
  const p = await paymentOf();
  if (p) return { step: 'ready', at: isoOrNull(p.at), ref: refOf(p) };
  if (o.extStatus && COLLECTED_RE.test(o.extStatus)) return { step: 'collected', at: null, ref: null };
  return { step: 'waiting', at: null, ref: null };
}

export async function getOrder(ctx: Ctx, id: number, db: Db = ctx.db): Promise<Order> {
  if (noOrderAccess(ctx)) throw forbidden();
  const r = (await db.query(`SELECT ${ORDER_COLS} ${ORDER_FROM} WHERE o.id = $1`, [id]))[0];
  if (!r) throw notFound('Commande introuvable');
  const o = toOrder(r);
  if (onlyOwnDeliveries(ctx) && o.livreurId !== ctx.session.profile.id) throw forbidden();
  // a confirmation agency's agent: only the orders the store gives the agency, for their tasks
  const ag = agencyOf(ctx);
  if (ag !== null) {
    const roles = ctx.session.roles;
    if (!((roles.includes('confirmation') && o.confAgencyId === ag) || (roles.includes('suivi') && o.followAgencyId === ag))) throw forbidden('Cette commande n’est pas confiée à votre agence');
    // given some products only (in the agency): the orders that came for them
    const only = ctx.session.profile.agencyProducts;
    if (only && !only.includes(num((await db.query('SELECT route_product_id FROM orders WHERE id = $1', [id]))[0]?.route_product_id))) throw forbidden('Cette commande n’est pas pour vos produits');
  }
  return onlyOwnDeliveries(ctx) ? hideCustomer(o) : o;
}

export async function addEvent(db: Db, orderId: number, userId: number | null, kind: OrderEvent['kind'], from: string | null, to: string | null, note?: string | null, data?: unknown) {
  await db.query('INSERT INTO order_events (order_id, user_id, kind, from_value, to_value, note, data) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
    orderId,
    userId,
    kind,
    from,
    to,
    note ?? null,
    data === undefined ? null : JSON.stringify(data),
  ]);
}

const id = z.number().int().positive();
const ids = z.array(id).min(1).max(500);
const dateStr = z.string().min(10).max(40);

/** The first words of the note of the status change that put the order where it is: the reason given (« Prix trop
 *  cher », « Refusé par le client »…), as it was typed or chosen. */
const reasonOf = (kind: 'conf_status' | 'follow_status', to: string) =>
  `nullif(split_part(coalesce((SELECT e.note FROM order_events e WHERE e.order_id = o.id AND e.kind = '${kind}' AND e.to_value = ${to} ORDER BY e.at DESC, e.id DESC LIMIT 1), ''), ' — ', 1), '')`;
/** why an order was cancelled at the confirmation (its current status) / why its parcel came back */
export const REASON_SQL = { conf: reasonOf('conf_status', 'o.conf_status'), back: reasonOf('follow_status', "'returning'") };

export const ListInput = z.object({
  conf: z.array(z.enum(CONF_STATUSES)).max(50).optional(),
  follow: z.array(z.enum([...FOLLOW_STATUSES, 'none'] as const)).max(50).optional(),
  q: z.string().max(100).optional(),
  wilayaId: z.number().int().min(1).max(69).optional(),
  agentId: z.union([id, z.literal('none')]).optional(),
  /** orders handled by any of these agents (a team) */
  agentIds: z.array(id).max(500).optional(),
  /** orders that contain this product (and this variant of it) */
  productId: id.optional(),
  variantId: id.optional(),
  companyId: z.union([id, z.literal('none')]).optional(),
  livreurId: id.optional(),
  channel: z.enum(SALES_CHANNELS).optional(),
  cashed: z.boolean().optional(),
  isExchange: z.boolean().optional(),
  /** SAV ticket parcels: left out of order lists unless asked for (the depot and livreurs see both) */
  tickets: z.enum(['exclude', 'include', 'only']).optional(),
  subStatus: z.string().max(40).optional(),
  /** not with this sub-status (Suivi › En livraison: the treated alerts are in « Traités ») */
  subStatusNot: z.string().max(40).optional(),
  /** only these orders (selection export / print) */
  ids: z.array(id).max(3000).optional(),
  /** back_at: when the parcel came back, or its last change while it is on its way back */
  dateField: z.enum(['created_at', 'confirmed_at', 'shipped_at', 'delivered_at', 'returned_at', 'updated_at', 'back_at']).default('created_at'),
  /** the reason given when it was cancelled at the confirmation (conf) or sent back (back); null: no reason given */
  reason: z.object({ of: z.enum(['conf', 'back']), text: z.string().max(200).nullable() }).optional(),
  from: dateStr.optional(),
  to: dateStr.optional(),
  sort: z
    /** score: the customer's score (best first in desc; the newest first between equals) */
    .enum(['created_at', 'confirmed_at', 'next_call_at', 'updated_at', 'total', 'customer_name', 'wilaya_id', 'shipped_at', 'delivered_at', 'ref', 'conf_status', 'follow_status', 'score'])
    .default('created_at'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(3000).default(50),
});
export type ListInput = z.infer<typeof ListInput>;

export async function listOrders(ctx: Ctx, f: ListInput, opts: { queue?: 'conf' | 'follow' } = {}): Promise<Page<Order>> {
  if (noOrderAccess(ctx)) return { rows: [], total: 0, page: f.page, pageSize: f.pageSize };
  const w = new Where();
  if (onlyOwnDeliveries(ctx)) w.add('o.livreur_id = ?', ctx.session.profile.id);
  // confirmation agencies: an agency's agent sees its agency's orders; a work list (confirmation, suivi) shows each
  // person the orders they work on (the store's own agents: those no agency handles)
  const scope = agencyRowSql(ctx);
  if (scope) w.add(scope);
  const queue = opts.queue ? queueSql(ctx, opts.queue) : '';
  if (queue) w.add(queue);
  if (f.conf?.length) w.add('o.conf_status = ANY(?)', f.conf);
  if (f.follow?.length) {
    const real = f.follow.filter((x) => x !== 'none');
    const none = f.follow.includes('none');
    if (real.length && none) w.add('(o.follow_status IS NULL OR o.follow_status = ANY(?))', real);
    else if (real.length) w.add('o.follow_status = ANY(?)', real);
    else w.add('o.follow_status IS NULL');
  }
  if (f.wilayaId) w.add('o.wilaya_id = ?', f.wilayaId);
  if (f.agentId === 'none') w.add('o.agent_id IS NULL');
  else if (f.agentId) w.add('o.agent_id = ?', f.agentId);
  if (f.agentIds) w.add('o.agent_id = ANY(?)', f.agentIds);
  if (f.variantId) w.add('EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.variant_id = ?)', f.variantId);
  else if (f.productId) w.add('EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.product_id = ?)', f.productId);
  if (f.companyId === 'none') w.add('o.company_id IS NULL');
  else if (f.companyId) w.add('o.company_id = ?', f.companyId);
  if (f.livreurId) w.add('o.livreur_id = ?', f.livreurId);
  if (f.channel) w.add('o.channel = ?', f.channel);
  if (f.cashed !== undefined) w.add('o.cashed = ?', f.cashed);
  if (f.isExchange !== undefined) w.add('o.is_exchange = ?', f.isExchange);
  else if ((f.tickets ?? 'exclude') === 'exclude' && !f.ids?.length) w.add('NOT o.is_exchange');
  else if (f.tickets === 'only') w.add('o.is_exchange');
  if (f.subStatus) w.add('o.sub_status = ?', f.subStatus);
  if (f.subStatusNot) w.add("COALESCE(o.sub_status, '') <> ?", f.subStatusNot);
  if (f.ids?.length) w.add('o.id = ANY(?)', f.ids);
  const dcol = f.dateField === 'back_at' ? 'coalesce(o.returned_at, o.returning_at, o.updated_at)' : `o.${f.dateField}`;
  if (f.from) w.add(`${dcol} >= ?`, f.from);
  if (f.to) w.add(`${dcol} < ?`, f.to);
  if (f.reason) {
    if (f.reason.text === null) w.add(`${REASON_SQL[f.reason.of]} IS NULL`);
    else w.add(`${REASON_SQL[f.reason.of]} = ?`, f.reason.text);
  }
  if (f.q?.trim()) {
    const q = f.q.trim();
    const phone = normalizePhone(q);
    const digits = q.replace(/\D/g, '');
    if (phone) w.add('(o.phone = ? OR o.phone2 = ?)', phone, phone);
    // a Meta id (ad, ad set, campaign: 12+ digits): the orders that came from it
    else if (/^\d{12,25}$/.test(q)) w.add("(o.utm->>'ad_id' = ? OR o.utm->>'adset_id' = ? OR o.utm->>'campaign_id' = ? OR o.adset_id = ?)", q, q, q, q);
    else if (digits.length >= 4 && digits.length === q.replace(/[\s+.-]/g, '').length) w.add("o.phone LIKE '%' || ? || '%'", digits.slice(-9));
    else w.add("(upper(o.ref) = upper(?) OR o.tracking = ? OR upper(o.own_tracking) = upper(?) OR o.customer_name ILIKE '%' || ? || '%')", q, q, q, q);
  }
  const nulls = f.sort === 'next_call_at' ? (f.dir === 'asc' ? 'NULLS FIRST' : 'NULLS LAST') : f.dir === 'desc' ? 'NULLS LAST' : 'NULLS FIRST';
  const total = num((await ctx.db.query(`SELECT count(*)::int AS n FROM orders o ${w.sql}`, w.params))[0]?.n);
  if (f.sort === 'score' && !onlyOwnDeliveries(ctx)) {
    // the score is not a column: the page's ids sorted by it in the database, then the orders read
    const pick = await orderIdsByScore(ctx, w.sql, w.params, f.dir, f.pageSize, (f.page - 1) * f.pageSize);
    const got = pick.length ? await ctx.db.query(`SELECT ${ORDER_COLS} ${ORDER_FROM} WHERE o.id = ANY($1::bigint[])`, [pick]) : [];
    const by = new Map(got.map((r: any) => [num(r.id), r]));
    return { rows: pick.filter((x) => by.has(x)).map((x) => toOrder(by.get(x))), total, page: f.page, pageSize: f.pageSize };
  }
  const limit = w.p(f.pageSize);
  const offset = w.p((f.page - 1) * f.pageSize);
  const col = f.sort === 'score' ? 'created_at' : f.sort;
  const rows = await ctx.db.query(`SELECT ${ORDER_COLS} ${ORDER_FROM} ${w.sql} ORDER BY o.${col} ${f.dir} ${nulls}, o.id DESC LIMIT ${limit} OFFSET ${offset}`, w.params);
  const list = rows.map(toOrder);
  return { rows: onlyOwnDeliveries(ctx) ? list.map(hideCustomer) : list, total, page: f.page, pageSize: f.pageSize };
}

// ---------------------------------------------------------------- writing
const ItemInput = z.object({
  productId: id,
  variantId: id.nullable().optional(),
  qty: z.number().int().min(1).max(999),
  unitPrice: z.number().int().min(0).max(10_000_000).optional(),
  isUpsell: z.boolean().optional(),
});

export const OrderInput = z.object({
  customerName: z.string().trim().min(2).max(120),
  phone: z.string().min(9).max(20),
  phone2: z.string().max(20).nullable().optional(),
  wilayaId: z.number().int().min(1).max(69),
  commune: z.string().trim().max(120).default(''),
  address: z.string().trim().max(300).default(''),
  isStopdesk: z.boolean().default(false),
  stopdeskId: id.nullable().optional(),
  companyId: id.nullable().optional(),
  channel: z.enum(SALES_CHANNELS).default('appel'),
  source: z.string().max(120).nullable().optional(),
  items: z.array(ItemInput).min(1).max(50),
  deliveryFee: z.number().int().min(0).max(100_000).optional(),
  discount: z.number().int().min(0).max(10_000_000).default(0),
  customerNote: z.string().max(1000).nullable().optional(),
  deliveryNote: z.string().max(1000).nullable().optional(),
  internalNote: z.string().max(1000).nullable().optional(),
  /** sent by the shop's site through its webhook (the order came by itself: the anti-fraud check can put it « À vérifier ») */
  via: z.enum(['api']).optional(),
  confirm: z.boolean().default(false),
  isExchange: z.boolean().default(false),
  originalOrderId: id.nullable().optional(),
  utm: z.record(z.string()).nullable().optional(),
});
export type OrderInput = z.infer<typeof OrderInput>;

/** `kept`: unit prices this order already had (product:variant → price), accepted as they are when the order is edited. */
async function priceItems(db: Db, items: z.infer<typeof ItemInput>[], freePrice = false, kept: Map<string, number> = new Map(), strictVariant = true) {
  const pids = [...new Set(items.map((i) => i.productId))];
  const prods = await db.query('SELECT id, name, price, cost, fixed_price, max_discount, active, fee_grid, weight_kg, packs FROM products WHERE id = ANY($1)', [pids]);
  // a line without its variant would leave the depot without a stock movement: a product without colours / sizes uses
  // its plain variant; one with them needs the customer's choice
  if (items.some((i) => !i.variantId)) {
    const all = await db.query('SELECT id, product_id, title, active FROM product_variants WHERE product_id = ANY($1) ORDER BY id', [pids]);
    items = items.map((i) => {
      if (i.variantId) return i;
      const mine = all.filter((v: any) => num(v.product_id) === i.productId);
      const plain = mine.find((v: any) => v.title === '');
      const named = mine.filter((v: any) => v.title !== '' && v.active);
      if (named.length === 1) return { ...i, variantId: num(named[0].id) };
      if (!named.length && plain) return { ...i, variantId: num(plain.id) };
      if (strictVariant && named.length > 1) throw bad('Choisissez la variante (couleur, taille…) de chaque produit');
      return i;
    });
  }
  const vids = items.map((i) => i.variantId).filter((v): v is number => !!v);
  const vars = vids.length ? await db.query('SELECT id, product_id, title, price FROM product_variants WHERE id = ANY($1)', [vids]) : [];
  const P = new Map(prods.map((p: any) => [num(p.id), p]));
  const V = new Map(vars.map((v: any) => [num(v.id), v]));
  let maxDiscount = 0;
  let unlimited = false;
  let weight = 0;
  let grid: string | null = null;
  /** how much lower than the catalog (or its quantity packs) the typed unit prices sell: it is a discount too */
  let priceCut = 0;
  const lines: OrderItem[] = items.map((i) => {
    const p: any = P.get(i.productId);
    if (!p) throw bad(`Produit inconnu (${i.productId})`);
    const v: any = i.variantId ? V.get(i.variantId) : null;
    if (i.variantId && (!v || num(v.product_id) !== i.productId)) throw bad(`Variante inconnue pour ${p.name}`);
    const listPrice = v?.price ?? p.price;
    // An exchange may be priced freely (often 0: the customer only pays the delivery).
    const unit = i.unitPrice === undefined || (p.fixed_price && !freePrice) ? listPrice : i.unitPrice;
    if (!freePrice) {
      // a quantity pack (2 for 18 000) is a normal price, not a cut
      const packs: { qty: number; price: number }[] = (typeof p.packs === 'string' ? JSON.parse(p.packs) : p.packs ?? []).filter((k: any) => num(k.qty) >= 2 && num(k.qty) <= i.qty);
      const had = kept.get(`${i.productId}:${i.variantId ?? ''}`);
      const ref = Math.min(num(listPrice), ...packs.map((k) => Math.floor(num(k.price) / num(k.qty))), ...(had === undefined ? [] : [had]));
      priceCut += Math.max(0, ref - num(unit)) * i.qty;
    }
    if (p.max_discount === null) unlimited = true;
    else maxDiscount += num(p.max_discount) * i.qty;
    weight += Number(p.weight_kg) * i.qty;
    grid = grid ?? p.fee_grid;
    return { productId: i.productId, variantId: i.variantId ?? null, name: p.name, variantTitle: v?.title ?? '', qty: i.qty, unitPrice: num(unit), purchasePrice: num(p.cost), isUpsell: !!i.isUpsell };
  });
  const subtotal = lines.reduce((s, l) => s + l.unitPrice * l.qty, 0);
  return { lines, subtotal, maxDiscount: unlimited ? subtotal : maxDiscount, weight, grid, priceCut };
}

async function deliveryFeeFor(db: Db, wilayaId: number, stopdesk: boolean, grid: string | null, weight: number): Promise<number> {
  const base = (await clientFee(db, wilayaId, stopdesk, grid)) ?? 0;
  const wf = await getSetting(db, 'weightFees');
  const extra = weight > wf.fromKg ? Math.ceil(weight - wf.fromKg) * wf.perKg : 0;
  return base + extra;
}

/** The copy of what the customer first ordered, as kept on the order (null for an order made before it was kept). */
function readOrig(v: unknown): OrigLine[] | null {
  const a = typeof v === 'string' ? JSON.parse(v) : v;
  if (!Array.isArray(a)) return null;
  return a.map((l: any) => ({ productId: num(l.productId), variantId: numOrNull(l.variantId), qty: num(l.qty), unitPrice: num(l.unitPrice) }));
}

/** The upsell of an order's lines against what the customer first ordered (never on an exchange parcel). */
function upsellFor(isExchange: boolean, orig: OrigLine[], origDiscount: number, lines: OrigLine[], discount: number) {
  return isExchange ? { value: 0, flags: lines.map(() => false) } : upsellOf(orig, origDiscount, lines, discount);
}

/**
 * The confirmation agencies a new order goes to, by its first product: the agency the store gave that product, else
 * the one that has « every product » (none: the store's own team). An order that arrives confirmed has nothing left to
 * confirm: only its suivi can go to an agency.
 */
async function routeToAgencies(db: Db, orderId: number, productId: number | undefined, confirmed: boolean) {
  if (!productId) return;
  const rows = await db.query('SELECT agency_id, task FROM agency_routes WHERE product_id = $1 OR product_id IS NULL ORDER BY (product_id IS NULL), task', [productId]);
  if (!rows.length) return;
  const pick = (task: string) => {
    const r = rows.find((x: any) => x.task === task);
    return r ? num(r.agency_id) : null;
  };
  const conf = confirmed ? null : pick('confirmation');
  const follow = pick('suivi');
  if (conf !== null || follow !== null) await db.query('UPDATE orders SET conf_agency_id = $2, follow_agency_id = $3, route_product_id = $4 WHERE id = $1', [orderId, conf, follow, productId]);
}

async function insertItems(db: Db, orderId: number, lines: OrderItem[]) {
  for (const l of lines) {
    await db.query(
      'INSERT INTO order_items (order_id, product_id, variant_id, name, variant_title, qty, unit_price, purchase_price, is_upsell) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [orderId, l.productId, l.variantId, l.name, l.variantTitle, l.qty, l.unitPrice, l.purchasePrice, l.isUpsell],
    );
  }
}

export async function createOrder(
  ctx: Ctx,
  input: OrderInput,
  db: Db = ctx.db,
  opts: {
    /** taken in this Message AI agent conversation */
    conversationId?: number | null;
    /** typed by someone the shop has not verified (a Messenger chatter): never renames an existing customer */
    untrusted?: boolean;
    /** sent from this landing page (its Meta ad set when the ad link carried it) */
    landingId?: number | null;
    adsetId?: string | null;
    /** no « we received your order » message (an abandoned order added by Pilotix: the customer did not send it) */
    silent?: boolean;
    /** the landing page's device key: a new number on a refuser's device is a look-alike */
    device?: string | null;
    /** the anti-fraud check of the other channels (guard.ts): « note » writes the reasons; « check » also puts what a
     *  landing page would block « À vérifier » (an order coming by itself: a Google Sheet, the AI seller, the site) */
    guard?: GuardMode;
  } = {},
): Promise<Order> {
  const phone = normalizePhone(input.phone);
  if (!phone) throw bad('Numéro de téléphone algérien invalide');
  const phone2 = input.phone2 ? normalizePhone(input.phone2) : null;
  if (input.confirm && !hasRole(ctx.session, 'confirmation')) throw forbidden();
  // the commune is always an official one: written another way (a Google Sheet, the AI seller, an API) Pilotix matches
  // it by sound; none fits → left empty, the agent confirms it with the customer on the call (a bureau order keeps it)
  if (input.wilayaId && String(input.commune ?? '').trim()) {
    const c = officialCommune(input.wilayaId, input.commune);
    if (c || !input.isStopdesk) input = { ...input, commune: c ?? '' };
  }
  if (input.confirm && !input.isStopdesk && !String(input.commune ?? '').trim()) throw bad('Indiquez la commune avant de confirmer');
  const me = ctx.session.profile.id;

  // the other channels get the landing pages' anti-fraud check too (no browser signals): reasons in the note, and
  // what a landing page would block « À vérifier » when the order came by itself (worked out before the transaction:
  // the Pilotix network is asked on the platform's own database)
  const guard =
    opts.guard && !input.isExchange
      ? await channelGuard(ctx, db, {
          phone,
          name: input.customerName,
          wilayaId: input.wilayaId ?? null,
          commune: String(input.commune ?? ''),
          productIds: input.items.map((l) => l.productId).filter((x): x is number => !!x),
          qty: input.items.reduce((n, l) => n + l.qty, 0),
        })
      : null;
  const order = await db.tx(async (tx) => {
    const priced = await priceItems(tx, input.items, input.isExchange);
    if (input.discount > priced.maxDiscount) throw bad(`Remise trop élevée (maximum ${priced.maxDiscount} DA)`);
    // a lower unit price typed by an employee is a discount: together they stay within the products' maximum
    // (prices worked out by Pilotix itself — a landing page, the AI seller — are already the shop's own prices)
    if (!ctx.session.isAdmin && !opts.landingId && !opts.conversationId && priced.priceCut + input.discount > priced.maxDiscount)
      throw bad(`Prix trop bas : la baisse de prix et la remise dépassent la remise maximale (${priced.maxDiscount} DA)`);
    const fee = input.deliveryFee ?? (await deliveryFeeFor(tx, input.wilayaId, input.isStopdesk, priced.grid, priced.weight));
    const total = priced.subtotal - input.discount + fee;
    // what the customer orders is kept: the upsell is counted against it (lines marked upsell while typing a call are sold in addition)
    const orig = origOf(priced.lines);
    const up = upsellFor(input.isExchange, orig, input.discount, priced.lines, input.discount);
    const lines = priced.lines.map((l, k) => ({ ...l, isUpsell: up.flags[k] }));
    const cust = (
      await tx.query(
        `INSERT INTO customers (phone, name, wilaya_id, orders, last_order_at) VALUES ($1,$2,$3,1,now())
         ON CONFLICT (phone) DO UPDATE SET orders = customers.orders + 1, last_order_at = now(),
           name = CASE WHEN $4 THEN customers.name ELSE EXCLUDED.name END, wilaya_id = CASE WHEN $4 THEN customers.wilaya_id ELSE EXCLUDED.wilaya_id END
         RETURNING id, blacklisted, stopdesk_only, delivered`,
        // a landing page or a chat: anyone can type a number, so what they type does not rename the shop's customer
        [phone, input.customerName, input.wilayaId, !!(opts.untrusted || opts.landingId)],
      )
    )[0];
    // a blacklisted number is always checked by a person first, even when the order comes « confirmed » (AI seller)
    // refused 2 parcels: only at the desk. A home delivery is not confirmed by itself (AI seller), a person checks it
    const homeRefused = !!cust.stopdesk_only && !input.isStopdesk;
    // confirmed from the start (the AI seller): the same two checks as « Confirmer » — blocked: a person checks it;
    // a product with nothing left: confirmed « sans stock »
    // who delivers it: the company a person typed, the chosen bureau's, or Pilot's (its rules, or the default company)
    const pick: Pick = input.companyId
      ? { companyId: input.companyId, by: 'hand', rule: null, why: null }
      : await pilotPick(tx, { wilayaId: input.wilayaId ?? null, commune: input.commune ?? null, isStopdesk: !!input.isStopdesk, stopdeskId: input.stopdeskId ?? null, productIds: lines.map((l) => l.productId).filter((x): x is number => !!x) });
    let confWhy: string | null = null;
    let confNoStock = false;
    if (input.confirm) {
      const lc = await checkLines(tx, lines.map((l) => ({ productId: l.productId, variantId: l.variantId ?? null, qty: l.qty })), null);
      const dc = await deliverCheck(tx, { wilayaId: input.wilayaId ?? null, commune: input.commune ?? null, isStopdesk: !!input.isStopdesk, stopdeskId: input.stopdeskId ?? null, companyId: pick.companyId });
      confWhy = blockerText('', lc, dc);
      confNoStock = lc.some((l) => l.state === 'empty');
    }
    let conf: ConfStatus =
      cust.blacklisted || (homeRefused && input.confirm) || confWhy ? 'to_check' : input.confirm ? (confNoStock ? 'no_stock' : 'confirmed') : 'new';
    // a number that never received a parcel and looks like a refuser (same device, same name + commune): 🟡, never blocked
    const look = num(cust.delivered) === 0 && !cust.blacklisted
      ? await lookAlikeOf(tx, { phone, name: input.customerName, wilayaId: input.wilayaId, commune: String(input.commune ?? ''), device: opts.device ?? null })
      : null;
    if (guard?.verdict === 'block' && opts.guard === 'check') conf = 'to_check';
    const trustNotes = [homeRefused ? STOPDESK_NOTE : '', look ? lookAlikeNote(look) : '', guard && guard.verdict !== 'allow' ? guardNote(guard, opts.guard!) : '', confWhy ? `Pas confirmée : ${confWhy}` : ''].filter(Boolean);
    const internalNote = [input.internalNote ?? '', ...trustNotes].filter(Boolean).join('\n') || null;
    const confirmed = conf === 'confirmed';
    // « sans stock » is confirmed too (by this person, now): it only waits for stock before the depot
    const stamped = confirmed || conf === 'no_stock';
    const ref = (await tx.query(`SELECT 'PX' || nextval('order_ref_seq') AS r`))[0].r;
    const wh = (await tx.query('SELECT id FROM warehouses WHERE active ORDER BY is_default DESC, id LIMIT 1'))[0];
    const defCompany = pick.companyId;
    const row = (
      await tx.query(
        `INSERT INTO orders (ref, created_by, customer_id, customer_name, phone, phone2, wilaya_id, commune, address, is_stopdesk, stopdesk_id, channel, source, utm,
           conf_status, agent_id, assigned_at, confirmed_at, follow_status, company_id, warehouse_id, subtotal, delivery_fee, discount, total,
           customer_note, delivery_note, internal_note, is_exchange, original_order_id, has_upsell, upsell_value, orig_items, orig_discount, conversation_id, landing_id, adset_id, looks_like_customer_id,
           pilot_by, pilot_rule, pilot_why)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41) RETURNING id`,
        [ref, me, cust.id, input.customerName, phone, phone2, input.wilayaId, input.commune, input.address, input.isStopdesk, input.stopdeskId ?? null,
          input.channel, input.source ?? null, input.utm ? JSON.stringify(input.utm) : null,
          conf, stamped ? me : null, stamped ? new Date(ctx.now()).toISOString() : null, stamped ? new Date(ctx.now()).toISOString() : null,
          confirmed ? 'to_prepare' : null, defCompany, wh?.id ?? null, priced.subtotal, fee, input.discount, total,
          input.customerNote ?? null, input.deliveryNote ?? null, internalNote, input.isExchange, input.originalOrderId ?? null,
          up.value > 0, up.value, JSON.stringify(orig), input.discount, opts.conversationId ?? null, opts.landingId ?? null, opts.adsetId ?? null, look?.id ?? null,
          pick.by, pick.rule, pick.why],
      )
    )[0];
    const oid = num(row.id);
    await insertItems(tx, oid, lines);
    // SAV exchange parcels stay with the store's team (they are not sales)
    if (!input.isExchange) await routeToAgencies(tx, oid, lines[0]?.productId, stamped);
    await addEvent(tx, oid, me, 'created', null, conf, input.isExchange ? `Échange de la commande #${input.originalOrderId}` : null);
    if (confirmed) await addEvent(tx, oid, me, 'follow_status', null, 'to_prepare');
    for (const n of trustNotes) await addEvent(tx, oid, null, 'note', null, 'event', n);
    // Delivery AI agent: "we received your order" (or "confirmed")
    if (!opts.silent) await onOrderCreated(tx, { id: oid, phone, conf_status: conf, is_exchange: input.isExchange }, ctx.now());
    return getOrder(ctx, oid, tx);
  });
  // made already confirmed (by an agent): a « Risqué » customer is kept like « Confirmer quand même »
  if (!order.isExchange && (order.confStatus === 'confirmed' || order.confStatus === 'no_stock')) await recordRiskConfirms(ctx, [order.id], me, db);
  ctx.emit({ type: 'orders' });
  // Affectation automatique: an order to call gets its agent at once (when the shop turned it on) — not inside the
  // caller's own transaction (a page left open, a restored order): the job every minute gives that one
  if (db === ctx.db && !input.isExchange && !order.agentId && (CONF_TODO as string[]).includes(order.confStatus)) {
    const r = await assignNow(ctx, 'conf', order.id);
    if (r?.assigned) return getOrder(ctx, order.id);
  }
  return order;
}

export const UpdateInput = OrderInput.partial().omit({ confirm: true }).extend({ id, version: z.number().int().min(1).optional() });

export async function updateOrder(ctx: Ctx, input: z.infer<typeof UpdateInput>): Promise<Order> {
  const order = await ctx.db.tx(async (tx) => {
    const cur = (await tx.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [input.id]))[0];
    if (!cur) throw notFound('Commande introuvable');
    if (input.version && num(cur.version) !== input.version) throw bad('Cette commande a été modifiée par quelqu’un d’autre. Rechargez-la.');
    const locked = cur.follow_status && FOLLOW_LOCKED.includes(cur.follow_status);
    if (locked && input.items) throw bad('Commande déjà partie : produits non modifiables');
    // the money and the place of a parcel a courier already has (API) or of a cashed order are frozen here: the
    // courier would still collect the old amount. Such changes go through « Modifier le colis » (sent to the company).
    const atCourier = !!cur.tracking && API_COURIER_KINDS.includes((await tx.query('SELECT kind FROM delivery_companies WHERE id = $1', [cur.company_id]))[0]?.kind ?? '');
    // a parcel that left with the shop's own livreur: he collects what the order said when it left; only the
    // administrator changes that amount afterwards (otherwise the cash « owed » could shrink after he collected it)
    const leftWithLivreur = !!cur.shipped_at && !ctx.session.isAdmin;
    if (atCourier || cur.cashed || leftWithLivreur) {
      const differs = (k: keyof typeof input, col: string, norm: (x: any) => any = (x) => x) => input[k] !== undefined && norm(input[k]) !== norm(cur[col]);
      const n = (x: any) => (x == null ? null : Number(x));
      const t = (x: any) => String(x ?? '').trim();
      // the form always sends the products: only a real change counts
      let itemsChanged = false;
      if (input.items) {
        const key = (l: { productId: number; variantId?: number | null; qty: number }) => `${l.productId}:${l.variantId ?? ''}:${l.qty}`;
        const now = (await tx.query('SELECT product_id, variant_id, qty FROM order_items WHERE order_id = $1', [input.id])).map((r: any) => key({ productId: num(r.product_id), variantId: numOrNull(r.variant_id), qty: num(r.qty) })).sort();
        itemsChanged = JSON.stringify(input.items.map(key).sort()) !== JSON.stringify(now);
      }
      const moneyOrPlace =
        itemsChanged || differs('discount', 'discount', n) || differs('deliveryFee', 'delivery_fee', n) || differs('wilayaId', 'wilaya_id', n) ||
        differs('commune', 'commune', t) || differs('isStopdesk', 'is_stopdesk', (x) => !!x) || differs('stopdeskId', 'stopdesk_id', n);
      if (moneyOrPlace)
        throw bad(
          cur.cashed ? 'Commande déjà encaissée : montant et adresse ne changent plus'
          : atCourier ? 'Colis déjà chez la société : changez le montant ou l’adresse avec « Modifier le colis »'
          : 'Colis déjà parti : seul l’administrateur change le montant ou l’adresse',
        );
    }
    const phone = input.phone !== undefined ? normalizePhone(input.phone) : cur.phone;
    if (!phone) throw bad('Numéro de téléphone algérien invalide');
    // the depot still holds this order: what it looked like before (for the red alert of the depot)
    const depotWatch = alertsDepot(ctx, cur.follow_status);
    const before = depotWatch
      ? { items: itemsText(await tx.query('SELECT name, variant_title, qty FROM order_items WHERE order_id = $1 ORDER BY id', [input.id])), company: cur.company_id ? ((await tx.query('SELECT name FROM delivery_companies WHERE id = $1', [cur.company_id]))[0]?.name ?? '') : '' }
      : null;
    // a bureau delivery needs its bureau (stop desk); going back home forgets it
    if (input.isStopdesk === true && !(input.stopdeskId ?? (input.stopdeskId === undefined ? cur.stopdesk_id : null))) throw bad('Livraison au bureau : choisissez le bureau.');
    if (input.isStopdesk === false && input.stopdeskId === undefined) input = { ...input, stopdeskId: null };

    let subtotal = num(cur.subtotal);
    let maxDiscount = Infinity;
    let priceCut = 0;
    // the products or the remise change: the upsell is worked out again
    const recount = !!input.items || input.discount !== undefined;
    const old = recount
      ? (await tx.query('SELECT id, product_id, variant_id, qty, unit_price, is_upsell FROM order_items WHERE order_id = $1 ORDER BY id', [input.id])).map((r: any) => ({ id: num(r.id), productId: num(r.product_id), variantId: numOrNull(r.variant_id), qty: num(r.qty), unitPrice: num(r.unit_price), isUpsell: !!r.is_upsell }))
      : [];
    let lines: OrderItem[] | null = null;
    if (input.items) {
      const priced = await priceItems(tx, input.items, !!cur.is_exchange, new Map(old.map((l) => [`${l.productId}:${l.variantId ?? ''}`, l.unitPrice])));
      lines = priced.lines;
      subtotal = priced.subtotal;
      maxDiscount = priced.maxDiscount;
      priceCut = priced.priceCut;
    } else if (input.discount !== undefined) {
      // only the discount changes: it is still capped by the products already in the order
      if (old.length) maxDiscount = (await priceItems(tx, old, true, new Map(), false)).maxDiscount;
    }
    const discount = input.discount ?? num(cur.discount);
    if (discount > maxDiscount) throw bad(`Remise trop élevée (maximum ${maxDiscount} DA)`);
    if (!ctx.session.isAdmin && priceCut + discount > maxDiscount)
      throw bad(`Prix trop bas : la baisse de prix et la remise dépassent la remise maximale (${maxDiscount} DA)`);
    // against what the customer first ordered (an order made before it was kept: its lines not marked upsell, now kept)
    const kept = readOrig(cur.orig_items);
    const orig = kept ?? origOf(old);
    const origDiscount = kept ? num(cur.orig_discount) : num(cur.discount);
    let up = { value: num(cur.upsell_value), flags: [] as boolean[] };
    if (recount) {
      const now: OrigLine[] = lines ?? old;
      up = upsellFor(!!cur.is_exchange, orig, origDiscount, now, discount);
      if (lines) {
        await tx.query('DELETE FROM order_items WHERE order_id = $1', [input.id]);
        await insertItems(tx, input.id, lines.map((l, k) => ({ ...l, isUpsell: up.flags[k] })));
      } else if (old.length) {
        await tx.query('UPDATE order_items i SET is_upsell = f.up FROM unnest($1::bigint[], $2::boolean[]) AS f(id, up) WHERE i.id = f.id', [old.map((l) => l.id), up.flags]);
      }
    }
    const fee = input.deliveryFee ?? num(cur.delivery_fee);
    const v = <T>(k: keyof typeof input, col: string): T => (input[k] !== undefined ? (input[k] as T) : cur[col]);
    // the company: a person changing it (when the Préférences allow it), the chosen bureau's, or Pilot again when the
    // place or the products change (until the products are picked; never on an order given by hand)
    const was = numOrNull(cur.company_id);
    const want = input.companyId !== undefined ? (input.companyId ?? null) : was;
    const nextIsDesk = !!v<boolean>('isStopdesk', 'is_stopdesk');
    const nextDesk = nextIsDesk ? numOrNull(v<number | null>('stopdeskId', 'stopdesk_id')) : null;
    let pick: Pick | null = null;
    if (want !== was) {
      const deskCo = nextDesk ? numOrNull((await tx.query('SELECT company_id FROM stopdesks WHERE id = $1', [nextDesk]))[0]?.company_id) : null;
      if (deskCo !== null && deskCo === want) pick = { companyId: want, by: 'bureau', rule: null, why: null };
      else {
        const why = await companyLock(ctx, tx, cur);
        if (why) throw bad(why);
        pick = { companyId: want, by: 'hand', rule: null, why: null };
      }
    } else {
      const ids = (ls: { productId: number | null }[]) => [...new Set(ls.map((l) => l.productId).filter(Boolean))].sort().join(',');
      const itemsMoved = !!lines && ids(lines) !== ids(old);
      const placeMoved =
        (input.wilayaId !== undefined && input.wilayaId !== numOrNull(cur.wilaya_id)) ||
        (input.commune !== undefined && String(input.commune ?? '').trim().toLowerCase() !== String(cur.commune ?? '').trim().toLowerCase()) ||
        (input.isStopdesk !== undefined && !!input.isStopdesk !== !!cur.is_stopdesk) ||
        (input.stopdeskId !== undefined && (input.stopdeskId ?? null) !== numOrNull(cur.stopdesk_id));
      if ((itemsMoved || placeMoved) && (await pilotMayRun(tx, cur))) {
        const pids = (await tx.query('SELECT DISTINCT product_id FROM order_items WHERE order_id = $1 AND product_id IS NOT NULL', [input.id])).map((r: any) => num(r.product_id));
        pick = await pilotPick(tx, { wilayaId: numOrNull(v('wilayaId', 'wilaya_id')), commune: v<string | null>('commune', 'commune') ?? null, isStopdesk: nextIsDesk, stopdeskId: nextDesk, productIds: pids });
      }
    }
    const companyNow = pick ? pick.companyId : want;
    await tx.query(
      `UPDATE orders SET customer_name=$2, phone=$3, phone2=$4, wilaya_id=$5, commune=$6, address=$7, is_stopdesk=$8, stopdesk_id=$9, company_id=$10,
         channel=$11, subtotal=$12, delivery_fee=$13, discount=$14, total=$15, customer_note=$16, delivery_note=$17, internal_note=$18,
         has_upsell = $19 > 0, upsell_value = $19, orig_items = COALESCE(orig_items, $20::jsonb),
         orig_discount = CASE WHEN orig_items IS NULL THEN $21 ELSE orig_discount END, updated_at=now(), version=version+1 WHERE id=$1`,
      [input.id, v('customerName', 'customer_name'), phone, input.phone2 !== undefined ? (input.phone2 ? normalizePhone(input.phone2) : null) : cur.phone2,
        v('wilayaId', 'wilaya_id'), v('commune', 'commune'), v('address', 'address'), v('isStopdesk', 'is_stopdesk'), v('stopdeskId', 'stopdesk_id'),
        companyNow, v('channel', 'channel'), subtotal, fee, discount, subtotal - discount + fee,
        v('customerNote', 'customer_note'), v('deliveryNote', 'delivery_note'), v('internalNote', 'internal_note'),
        up.value, JSON.stringify(orig), origDiscount],
    );
    if (pick) {
      const moved = pick.companyId !== was;
      await tx.query(
        'UPDATE orders SET pilot_by = $2, pilot_rule = $3, pilot_why = $4, livreur_id = CASE WHEN $5 THEN NULL ELSE livreur_id END WHERE id = $1',
        [input.id, pick.by, pick.rule, pick.why, moved],
      );
      const person = pick.by === 'hand' || pick.by === 'bureau';
      if (moved) await addEvent(tx, input.id, person ? ctx.session.profile.id : null, 'company', was ? String(was) : null, pick.companyId ? String(pick.companyId) : null, pick.by === 'bureau' ? 'Bureau choisi' : person ? null : 'Pilot');
    }
    // the history keeps what the money was and became (who lowered a total, and by how much)
    const newTotal = subtotal - discount + fee;
    const moneyNote = newTotal !== num(cur.total) ? `Total ${num(cur.total)} → ${newTotal} DA (remise ${num(cur.discount)} → ${discount}, livraison ${num(cur.delivery_fee)} → ${fee})` : null;
    await addEvent(tx, input.id, ctx.session.profile.id, 'edit', moneyNote ? String(num(cur.total)) : null, moneyNote ? String(newTotal) : null, moneyNote);
    const after = await getOrder(ctx, input.id, tx);
    if (before) {
      const place = (o: { wilayaId: number; commune: string; isStopdesk: boolean; stopdeskName?: string | null }) => `${String(o.wilayaId).padStart(2, '0')} · ${o.commune}${o.isStopdesk ? ` · bureau${o.stopdeskName ? ` ${o.stopdeskName}` : ''}` : ''}`;
      const was = { wilayaId: num(cur.wilaya_id), commune: String(cur.commune ?? ''), isStopdesk: !!cur.is_stopdesk, stopdeskName: cur.stopdesk_id ? ((await tx.query('SELECT name FROM stopdesks WHERE id = $1', [cur.stopdesk_id]))[0]?.name ?? null) : null };
      const nowCompany = after.companyId ? ((await tx.query('SELECT name FROM delivery_companies WHERE id = $1', [after.companyId]))[0]?.name ?? '') : '';
      const ch: DepotChange[] = [];
      const add = (field: DepotChange['field'], from: unknown, to: unknown) => {
        const f = String(from ?? '').trim();
        const tt = String(to ?? '').trim();
        if (f !== tt) ch.push({ field, from: f || '—', to: tt || '—' });
      };
      add('items', before.items, itemsText(after.items));
      add('customer', cur.customer_name, after.customerName);
      add('phone', cur.phone, after.phone);
      add('phone2', cur.phone2, after.phone2);
      add('place', place(was), place({ wilayaId: after.wilayaId, commune: after.commune, isStopdesk: after.isStopdesk, stopdeskName: after.stopdeskId ? ((await tx.query('SELECT name FROM stopdesks WHERE id = $1', [after.stopdeskId]))[0]?.name ?? null) : null }));
      add('address', cur.address, after.address);
      add('company', before.company, nowCompany);
      add('total', `${num(cur.total)} DA`, `${after.total} DA`);
      add('note', cur.delivery_note, after.deliveryNote);
      await addDepotAlert(tx, ctx, input.id, cur.follow_status, 'edit', ch);
    }
    return after;
  });
  ctx.emit({ type: 'order', id: order.id });
  return order;
}

// ---------------------------------------------------------------- statuses
export const ConfInput = z.object({
  ids,
  status: z.enum(CONF_STATUSES),
  note: z.string().max(1000).nullable().optional(),
  reason: z.string().max(200).nullable().optional(),
  nextCallAt: dateStr.nullable().optional(),
  clientId: z.string().min(8).max(64).optional(),
});

async function alreadyApplied(db: Db, clientId: string | undefined, userId: number) {
  if (!clientId) return false;
  const r = await db.query('INSERT INTO applied_actions (client_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING client_id', [clientId, userId]);
  return r.length === 0;
}

/** An admin or a manager may change an order another agent holds (to unblock it); an agent may not. */
export const mayOverrideHold = (ctx: Ctx) => ctx.session.isAdmin || ctx.session.roles.some((r) => r === 'agent_manager' || r === 'vendeur');

/** Keeps an order for this agent 10 minutes (opened from a list): his other held orders are given back. Held by another
 *  agent: nothing changes, and the answer says who has it. */
export async function holdOrder(ctx: Ctx, id: number): Promise<{ ok: boolean; by: string | null; until: string | null }> {
  const me = ctx.session.profile.id;
  return ctx.db.tx(async (tx) => {
    const got = await tx.query(
      `UPDATE orders SET locked_by = $2, locked_until = now() + interval '10 minutes'
        WHERE id = $1 AND conf_status = ANY($3) AND (locked_until IS NULL OR locked_until < now() OR locked_by = $2)${andSql(queueSql(ctx, 'conf', 'orders', { free: true }))}
       RETURNING id`,
      [id, me, CONF_TODO],
    );
    if (got[0]) {
      await tx.query(`UPDATE orders SET locked_by = NULL, locked_until = NULL WHERE locked_by = $1 AND id <> $2 AND conf_status = ANY($3)`, [me, id, CONF_TODO]);
      return { ok: true, by: null, until: null };
    }
    // not taken: another agent has it open, or it is given to another agent (an order no longer to call: nothing to keep)
    const r = (
      await tx.query(
        `SELECT CASE WHEN o.locked_until > now() AND o.locked_by <> $2 THEN o.locked_until END AS until,
                CASE WHEN o.locked_until > now() AND o.locked_by <> $2 THEN lp.name ELSE ap.name END AS name,
                (o.locked_until > now() AND o.locked_by <> $2) OR (o.agent_id IS NOT NULL AND o.agent_id <> $2) AS taken
           FROM orders o LEFT JOIN profiles lp ON lp.id = o.locked_by LEFT JOIN profiles ap ON ap.id = o.agent_id WHERE o.id = $1`,
        [id, me],
      )
    )[0];
    return r?.taken ? { ok: false, by: (r.name as string | null) ?? '', until: isoOrNull(r.until) } : { ok: true, by: null, until: null };
  });
}

export async function setConf(ctx: Ctx, input: z.infer<typeof ConfInput>) {
  if (CONF_NEEDS_DATE.includes(input.status) && !input.nextCallAt) throw bad('Choisissez la date du prochain appel');
  if (CONF_NEEDS_REASON.includes(input.status) && !input.reason) throw bad('Indiquez la raison');
  const me = ctx.session.profile.id;
  const calls = await getSetting(ctx.db, 'calls');
  const changed: number[] = [];
  /** confirmed « sans stock » (nothing left for one of their products) */
  const noStock: number[] = [];
  /** not confirmed: a product switched off, or we do not deliver there (several at once: the others go on) */
  const blocked: { id: number; ref: string; reason: string }[] = [];
  /** confirmed orders cancelled here: their pieces are free again for « sans stock » orders */
  const freed: number[] = [];
  /** cancelled with a parcel already created at a courier: cancelled there too, after this is saved */
  const ghosts: number[] = [];
  /** confirmed now (they were not): a « Risqué » customer among them is kept (« Confirmer quand même ») */
  const fresh: number[] = [];
  await ctx.db.tx(async (tx) => {
    if (await alreadyApplied(tx, input.clientId, me)) return;
    const notify = await notifyContext(tx);
    const landing = await landingSettings(tx);
    for (const oid of input.ids) {
      const cur = (await tx.query(`SELECT id, ref, customer_id, conf_status, follow_status, shipped_at, attempts, agent_id, phone, is_exchange, landing_id, commune, is_stopdesk, stopdesk_id,
         CASE WHEN locked_until > now() AND locked_by <> $2 THEN (SELECT p.name FROM profiles p WHERE p.id = locked_by) END AS held_by
         FROM orders WHERE id = $1 FOR UPDATE`, [oid, me]))[0];
      if (!cur) continue;
      // another agent has this order open (« Commande suivante » or opened from a list, 10 minutes): only he changes it
      // (an admin or a manager can still act on it)
      // an agent changes only his own orders and the ones nobody has yet (an agent manager, the owner: any he sees)
      if (!mayOverrideHold(ctx) && ctx.session.profile.agencyId == null && cur.agent_id != null && num(cur.agent_id) !== me) {
        const why = `${cur.ref} : cette commande est donnée à un autre agent`;
        if (input.ids.length === 1) throw bad(why);
        blocked.push({ id: oid, ref: cur.ref, reason: why });
        continue;
      }
      if (cur.held_by != null && !mayOverrideHold(ctx)) {
        const why = `${cur.ref} : ${cur.held_by || 'un autre agent'} est sur cette commande`;
        if (input.ids.length === 1) throw bad(why);
        blocked.push({ id: oid, ref: cur.ref, reason: why });
        continue;
      }
      if (cur.follow_status && !['to_prepare', 'prepared', 'cancelled'].includes(cur.follow_status) && input.status !== 'confirmed')
        throw bad('Commande déjà expédiée : changez plutôt le statut de livraison');
      let status = input.status;
      const isCallFail = status === 'no_answer' || status === 'busy';
      const attempts = num(cur.attempts) + (isCallFail ? 1 : 0);
      let note = input.note ?? null;
      if (isCallFail && calls.cancelAfterNoAnswer > 0 && attempts >= calls.cancelAfterNoAnswer) {
        status = 'cancelled';
        note = `Annulée automatiquement après ${attempts} appels sans réponse`;
      }
      // confirming (one or many at once): every product can go and we deliver there (also checked here, not only on
      // the screen). Blocked: refused (one order) or left as it is (several: the others go on). A product with nothing
      // left: confirmed « sans stock », it waits.
      if ((status === 'confirmed' || status === 'no_stock') && cur.conf_status !== status) {
        const chk = await checkOrder(tx, oid);
        let why = chk.blocker;
        // refused 2 parcels: only at the desk (lifted once they receive and pay one)
        if (!why && !cur.is_stopdesk && !cur.is_exchange && (await tx.query('SELECT stopdesk_only FROM customers WHERE id = $1', [cur.customer_id]))[0]?.stopdesk_only)
          why = `${cur.ref} : ce client a refusé 2 colis, il est livré au bureau (stop-desk) uniquement. Choisissez un stop-desk avant de confirmer.`;
        if (!why && status === 'confirmed' && chk.noStock) {
          status = 'no_stock';
          noStock.push(oid);
          if (cur.conf_status === 'no_stock') why = `${cur.ref} : toujours pas de stock, la commande reste « sans stock ».`;
        }
        if (why) {
          if (input.ids.length === 1) throw bad(why);
          if (cur.conf_status !== 'no_stock' || status !== 'no_stock') blocked.push({ id: oid, ref: cur.ref, reason: why });
          continue;
        }
      }
      const confirmed = status === 'confirmed';
      // « sans stock » is confirmed too: the agent's call is done, the order only waits for stock before the depot
      const stamped = confirmed || status === 'no_stock';
      if (stamped && cur.conf_status !== 'confirmed' && cur.conf_status !== 'no_stock') fresh.push(oid);
      const nowIso = new Date(ctx.now()).toISOString();
      await tx.query(
        `UPDATE orders SET conf_status=$2, attempts=$3,
           last_call_at = CASE WHEN $4 THEN $5::timestamptz ELSE last_call_at END,
           next_call_at = $6,
           agent_id = COALESCE(agent_id, $7), assigned_at = COALESCE(assigned_at, $5::timestamptz),
           confirmed_at = CASE WHEN $9 THEN COALESCE(confirmed_at, $5::timestamptz) ELSE confirmed_at END,
           follow_status = CASE WHEN $8 AND (follow_status IS NULL OR (follow_status = 'cancelled' AND shipped_at IS NULL)) THEN 'to_prepare'
                                WHEN $2 IN ('cancelled','duplicate','wrong_number','fake') AND follow_status IN ('to_prepare','prepared') THEN 'cancelled'
                                ELSE follow_status END,
           updated_at=now(), version=version+1
         WHERE id=$1`,
        [oid, status, attempts, isCallFail || stamped || CONF_NEEDS_DATE.includes(status), nowIso, CONF_NEEDS_DATE.includes(status) ? input.nextCallAt : null, me, confirmed, stamped],
      );
      await addEvent(tx, oid, me, 'conf_status', cur.conf_status, status, [input.reason, note].filter(Boolean).join(' — ') || null);
      // confirmed again after a cancel: back to the depot's « À préparer »
      if (confirmed && (!cur.follow_status || (cur.follow_status === 'cancelled' && !cur.shipped_at))) await addEvent(tx, oid, me, 'follow_status', cur.follow_status, 'to_prepare');
      // the depot was preparing it: red alert « annulée — ne l'envoyez pas »
      if (['cancelled', 'duplicate', 'wrong_number', 'fake'].includes(status) && alertsDepot(ctx, cur.follow_status)) await addDepotAlert(tx, ctx, oid, cur.follow_status, 'cancel', []);
      await onConfChange(tx, notify, cur, cur.conf_status, status, ctx.now());
      // Meta: an order from a landing page, confirmed by a person, is a real sale (never a blocked or fake one)
      await onLandingConf(tx, landing, cur, cur.conf_status, status, ctx.now(), input.reason ?? null, me);
      if (cur.conf_status === 'confirmed' && !confirmed && !cur.shipped_at) freed.push(oid);
      if (['cancelled', 'duplicate', 'wrong_number', 'fake'].includes(status) && cur.follow_status === 'prepared') ghosts.push(oid);
      changed.push(oid);
    }
    if (freed.length)
      await releaseNoStock(tx, me, (await tx.query('SELECT DISTINCT variant_id FROM order_items WHERE order_id = ANY($1) AND variant_id IS NOT NULL', [freed])).map((r: any) => num(r.variant_id)));
  });
  // a cancelled order's parcel at a courier: cancelled there by itself (or put on « À annuler à la main »)
  if (ghosts.length) await (await import('./dispatch')).cancelGhosts(ctx, ghosts);
  await recordRiskConfirms(ctx, fresh.filter((x) => changed.includes(x)), me);
  await sendInPreview(ctx);
  ctx.emit({ type: 'orders' });
  return { changed, noStock, blocked };
}

export const FollowInput = z.object({
  ids,
  status: z.enum(FOLLOW_STATUSES),
  note: z.string().max(1000).nullable().optional(),
  reason: z.string().max(200).nullable().optional(),
  /** the livreur's reason as a key (FAIL_REASONS / RETURN_REASONS): some send the parcel to Suivi › Alertes (Préférences) */
  reasonKey: z.string().max(40).nullable().optional(),
  tracking: z.string().max(80).nullable().optional(),
  livreurId: id.nullable().optional(),
  subStatus: z.string().max(40).nullable().optional(),
  clientId: z.string().min(8).max(64).optional(),
});

const MILESTONE: Partial<Record<FollowStatus, string>> = { prepared: 'prepared_at', shipped: 'shipped_at', delivered: 'delivered_at', returned: 'returned_at' };
/** Statuses that mean the parcel has physically left the depot (stock goes out on the first of them). */
const LEFT_DEPOT: FollowStatus[] = ['shipped', 'out_for_delivery', 'failed', 'alert', 'in_exchange', 'delivered', 'returning', 'exchanged', 'lost'];

/**
 * Why a delivery status change is not allowed (null = allowed).
 * - a delivered order whose money is already in a caisse cannot leave « Livrée » (cancel the versement first);
 * - a final status (livrée, retournée, échangée, perdue, annulée) is only changed by admin / suivi, with a reason;
 * - a parcel that has left the depot cannot go back to « À préparer » / « Préparée » (admin only).
 */
export function followBlock(ctx: Ctx, cur: any, to: FollowStatus, hasReason: boolean): string | null {
  const from: FollowStatus | null = cur.follow_status;
  if (!from || from === to) return null;
  const s = ctx.session;
  const office = s.isAdmin || s.roles.includes('suivi');
  if (from === 'delivered' && cur.cashed) return `${cur.ref} est livrée et déjà encaissée : annulez d’abord le versement`;
  if (FOLLOW_FINAL.includes(from) && from !== 'cancelled') {
    if (!office) return `${cur.ref} est terminée (${from}) : seul le suivi ou un administrateur peut la changer`;
    if (!hasReason) return `${cur.ref} est terminée : indiquez la raison du changement`;
  }
  if (cur.shipped_at && (to === 'to_prepare' || to === 'prepared') && !s.isAdmin) return `${cur.ref} est déjà partie du dépôt`;
  return null;
}

/**
 * The courier's fee for these parcels, from the company's tariff (home or bureau, by wilaya) + its « Surpoids » on the
 * weight declared (whole kilos). Set when the parcel leaves for every kind of company (not only those with an API), so
 * the caisse never counts the full COD as cash received. `force`: computed again (the place changed); otherwise only
 * where none was set yet.
 */
export async function setCourierCost(db: Db, orderIds: number[], force = false) {
  if (!orderIds.length) return;
  const rows = await db.query(
    `SELECT o.id, CASE WHEN o.is_stopdesk THEN f.desk ELSE f.home END AS tariff, co.kind, co.config,
       (SELECT coalesce(sum(p.weight_kg * it.qty), 0) FROM order_items it JOIN products p ON p.id = it.product_id WHERE it.order_id = o.id) AS kg
       FROM orders o JOIN delivery_fees f ON f.company_id = o.company_id AND f.wilaya_id = o.wilaya_id JOIN delivery_companies co ON co.id = o.company_id
      WHERE o.id = ANY($1) AND NOT o.cashed AND ($2 OR o.delivery_cost = 0)`,
    [orderIds, force],
  );
  if (!rows.length) return;
  const costs = rows.map((r: any) => num(r.tariff) + ruleFee(r.kind, weightRuleOf(r.kind, r.config), r.kg));
  await db.query('UPDATE orders o SET delivery_cost = v.c FROM unnest($1::bigint[], $2::int[]) AS v(id, c) WHERE o.id = v.id', [rows.map((r: any) => num(r.id)), costs]);
}

/**
 * A person gives orders a company (and our own livreur): the rules of « Pilot Auto Assign » leave them alone from then
 * on. `check`: the person must be allowed by the Préférences (who changes the company by hand, strict rules locked) —
 * the depot's own steps (« À attribuer », « Autre société », « Retirer ») are checked where they start.
 */
export async function assignCompanies(ctx: Ctx, i: { ids: number[]; companyId: number | null; livreurId?: number | null }, opts: { check?: boolean } = {}) {
  if (i.livreurId) {
    const l = (await ctx.db.query('SELECT roles, active FROM profiles WHERE id = $1', [i.livreurId]))[0];
    if (!l || !l.active || !(l.roles ?? []).includes('livreur')) throw bad('Ce livreur est introuvable');
  }
  const office = ctx.session.isAdmin || ctx.session.roles.includes('suivi') || ctx.session.roles.includes('depot');
  await ctx.db.tx(async (tx) => {
    for (const oid of i.ids) {
      const cur = (await tx.query('SELECT ref, company_id, livreur_id, follow_status, tracking, shipped_at, cashed, pilot_by FROM orders WHERE id=$1 FOR UPDATE', [oid]))[0];
      if (!cur) continue;
      if (cur.tracking && cur.company_id && num(cur.company_id) !== i.companyId) throw bad('Colis déjà envoyé à une société : annulez-le d’abord');
      // the livreur of a parcel decides who owes its cash: frozen once it is cashed or finished, and only the
      // depot / suivi move a parcel that already left
      const company = num(cur.company_id) !== (i.companyId ?? 0);
      const moves = company || num(cur.livreur_id) !== (i.livreurId ?? 0);
      if (moves && (cur.cashed || FOLLOW_FINAL.includes(cur.follow_status))) throw bad(`${cur.ref} est terminée ou encaissée : la société et le livreur ne changent plus`);
      if (moves && cur.shipped_at && !office) throw bad(`${cur.ref} est déjà partie du dépôt`);
      if (company && opts.check !== false) {
        const why = await companyLock(ctx, tx, cur);
        if (why) throw bad(`${cur.ref} : ${why}`);
      }
      await tx.query(
        `UPDATE orders SET company_id=$2, livreur_id=$3, updated_at=now(),
           pilot_by = CASE WHEN $4 THEN 'hand' ELSE pilot_by END, pilot_rule = CASE WHEN $4 THEN NULL ELSE pilot_rule END, pilot_why = CASE WHEN $4 THEN NULL ELSE pilot_why END
         WHERE id=$1`,
        [oid, i.companyId, i.livreurId ?? null, company],
      );
      await addEvent(tx, oid, ctx.session.profile.id, 'company', cur.company_id ? String(cur.company_id) : null, i.companyId ? String(i.companyId) : null);
    }
  });
  ctx.emit({ type: 'orders' });
  return { ok: true };
}

export async function setFollow(ctx: Ctx, input: z.infer<typeof FollowInput>, opts: { system?: boolean } = {}) {
  if (!canSetFollow(ctx.session.roles, input.status)) throw forbidden('Vous ne pouvez pas mettre ce statut de livraison');
  const me = ctx.session.profile.id;
  const own = onlyOwnDeliveries(ctx);
  // a livreur never chooses who carries the parcel (it would move his cash to someone else)
  const livreurId = own ? null : input.livreurId ?? null;
  if (livreurId) {
    const l = (await ctx.db.query('SELECT roles, active FROM profiles WHERE id = $1', [livreurId]))[0];
    if (!l || !l.active || !(l.roles ?? []).includes('livreur')) throw bad('Ce livreur est introuvable');
  }
  const changed: number[] = [];
  let livreurAlerts: string[] | null = null;
  await ctx.db.tx(async (tx) => {
    if (await alreadyApplied(tx, input.clientId, me)) return;
    const notify = await notifyContext(tx);
    const landing = await landingSettings(tx);
    for (const oid of input.ids) {
      const cur = (await tx.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [oid]))[0];
      if (!cur) continue;
      if (own && num(cur.livreur_id) !== me) throw forbidden();
      if (!['confirmed', 'no_stock'].includes(cur.conf_status) && input.status !== 'cancelled') throw bad(`${cur.ref} n’est pas confirmée`);
      const from: FollowStatus | null = cur.follow_status;
      let to: FollowStatus = input.status;
      // « Livraison privée »: what the livreur said may send the parcel to Suivi › Alertes first (Préférences)
      if ((to === 'failed' || to === 'returning') && input.reasonKey && cur.company_id && livreurAlerts === null)
        livreurAlerts = (await getPrefs(tx)).livreurAlerts;
      if ((to === 'failed' || to === 'returning') && input.reasonKey && livreurAlerts?.includes(`${to}:${input.reasonKey}`))
        if ((await tx.query('SELECT kind FROM delivery_companies WHERE id = $1', [cur.company_id]))[0]?.kind === 'own') to = 'alert';
      const block = followBlock(ctx, cur, to, !!(input.reason || input.note));
      if (block) {
        // the courier sync / payment import skips such parcels instead of failing the whole batch
        if (opts.system) continue;
        throw bad(block);
      }
      // our own livreurs: a parcel goes « En livraison » only by the livreur's own scan (« Ma tournée » › Prendre), so the
      // shelf (« Dispatchées ») shows who took what — nobody else puts a parcel in his hands (an admin still can)
      if (to === 'out_for_delivery' && !opts.system && !ctx.session.isAdmin && cur.company_id && ['to_prepare', 'prepared', 'shipped'].includes(String(from)))
        if ((await tx.query('SELECT kind FROM delivery_companies WHERE id = $1', [cur.company_id]))[0]?.kind === 'own')
          throw bad(`${cur.ref} : seul le livreur met le colis « En livraison », en le scannant dans « Ma tournée ».`);
      if (livreurId && cur.cashed) throw bad(`${cur.ref} est déjà encaissée : le livreur ne peut plus changer`);
      // the depot receives back a parcel that is coming back (or failed): never one « en livraison » or « livrée », else a
      // delivered parcel's cash would stop being owed and its goods would come back into stock on paper only
      if (!opts.system && to === 'returned' && from !== to && !ctx.session.isAdmin && !ctx.session.roles.includes('suivi') && !['shipped', 'returning', 'failed', 'alert', 'in_exchange'].includes(from ?? ''))
        throw bad(`${cur.ref} n’est pas en retour : le livreur ou le suivi doit d’abord la marquer « En retour » ou « Échec »`);
      // Stock leaves the depot on the first status that means the parcel left (not only « Expédiée »: the courier
      // can report « En livraison » or « Livrée » straight from « Préparée »), and comes back when returned.
      const leaves = LEFT_DEPOT.includes(to) && !cur.shipped_at;
      const back = to === 'returned' && cur.shipped_at && !cur.returned_at;
      // shipped_at is set below (on whichever status the parcel leaves with); returning_at when it starts coming back
      const ms = to === 'returning' ? 'returning_at' : MILESTONE[to] === 'shipped_at' ? undefined : MILESTONE[to];
      await tx.query(
        `UPDATE orders SET follow_status=$2, ${ms ? `${ms} = COALESCE(${ms}, now()),` : ''}
           shipped_at = CASE WHEN $9 THEN COALESCE(shipped_at, now()) ELSE shipped_at END,
           tracking = COALESCE($3, tracking), livreur_id = COALESCE($4, livreur_id),
           sub_status = CASE WHEN $8 THEN sub_status ELSE $5 END, follow_agent_id = CASE WHEN $6 AND ($2 IS DISTINCT FROM follow_status OR follow_agent_id IS NULL) THEN $7 ELSE follow_agent_id END,
           delivery_attempts = delivery_attempts + CASE WHEN $2 = 'failed' THEN 1 ELSE 0 END,
           updated_at=now(), version=version+1 WHERE id=$1`,
        [oid, to, input.tracking ?? null, livreurId, input.subStatus ?? null, ctx.session.roles.includes('suivi'), me,
          !!opts.system && input.subStatus === undefined, leaves],
      );
      if ((leaves || back) && cur.warehouse_id) {
        const items = await tx.query('SELECT variant_id, qty FROM order_items WHERE order_id = $1 AND variant_id IS NOT NULL', [oid]);
        for (const it of items) {
          const d = (leaves ? -1 : 1) * num(it.qty);
          const left = await tx.query(
            `INSERT INTO stock (variant_id, warehouse_id, qty) VALUES ($1,$2,$3)
             ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET qty = stock.qty + EXCLUDED.qty RETURNING qty`,
            [it.variant_id, cur.warehouse_id, d],
          );
          // shipped more than the stock shows: said on the order (the product also shows in the stock alerts)
          if (leaves && num(left[0]?.qty) < 0)
            await addEvent(tx, oid, me, 'note', null, 'event', `Attention : stock négatif après ce départ (${num(left[0].qty)} pour la variante n° ${num(it.variant_id)}) — vérifiez l’inventaire`);
          await tx.query('INSERT INTO stock_movements (variant_id, warehouse_id, delta, reason, order_id, user_id) VALUES ($1,$2,$3,$4,$5,$6)', [
            it.variant_id, cur.warehouse_id, d, leaves ? 'shipped' : 'returned', oid, me,
          ]);
        }
        // a parcel back in stock: the oldest « sans stock » orders it can serve go to « À préparer »
        if (back) await releaseNoStock(tx, me, items.map((it: any) => num(it.variant_id)));
      }
      if (leaves || to === 'delivered') await setCourierCost(tx, [oid]);
      // counted once per order, even if the status goes back and forth
      if (to === 'delivered' && from !== 'delivered' && !cur.delivered_at) await tx.query('UPDATE customers SET delivered = delivered + 1 WHERE id = $1', [cur.customer_id]);
      if (to === 'returned' && from !== 'returned' && !cur.returned_at) await tx.query('UPDATE customers SET returned = returned + 1 WHERE id = $1', [cur.customer_id]);
      await addEvent(tx, oid, me, 'follow_status', from, to, [input.reason, input.note].filter(Boolean).join(' — ') || null);
      // the customer's trust: refused → stop-desk only, then blacklist; delivered → forgiven
      if (from !== to && ['returning', 'returned', 'delivered', 'exchanged'].includes(to)) {
        const t = await applyTrust(tx, numOrNull(cur.customer_id));
        if (t) await addEvent(tx, oid, null, 'note', null, 'event', t);
      }
      // Delivery AI agent: shipped, with the livreur, at the desk, failed attempt, cancelled by the livreur, delivered
      await onFollowChange(tx, notify, cur, from, to, ctx.now());
      await onLandingFollow(tx, landing, cur, from, to, ctx.now());
      changed.push(oid);
    }
  });
  // SAV ticket parcels: delivered → ticket Livré, returned (scanned at the depot) → ticket Annulé
  if (['delivered', 'exchanged', 'returned'].includes(input.status) && (await settleTickets(ctx.db, me))) ctx.emit({ type: 'sav' });
  // cancelled with its parcel at a courier: cancelled there too (or put on « À annuler à la main »)
  if (input.status === 'cancelled' && changed.length) await (await import('./dispatch')).cancelGhosts(ctx, changed);
  await sendInPreview(ctx);
  ctx.emit({ type: 'orders' });
  return { changed };
}

// ---------------------------------------------------------------- counts for the menu and tabs
export async function orderCounts(ctx: Ctx) {
  const own = onlyOwnDeliveries(ctx);
  const me = ctx.session.profile.id;
  // a confirmation agency's agent: only the numbers of its agency's orders (nothing else of the store)
  const scope = agencyRowSql(ctx);
  if (scope) {
    const conf = await ctx.db.query<{ k: string; n: number }>(`SELECT conf_status AS k, count(*)::int AS n FROM sales o WHERE ${scope} GROUP BY 1`);
    const follow = await ctx.db.query<{ k: string; n: number }>(`SELECT follow_status AS k, count(*)::int AS n FROM sales o WHERE follow_status IS NOT NULL AND ${scope} GROUP BY 1`);
    const subs = await ctx.db.query<{ k: string; n: number }>(`SELECT sub_status AS k, count(*)::int AS n FROM sales o WHERE sub_status IS NOT NULL AND ${scope} GROUP BY 1`);
    const late = num((await ctx.db.query(`SELECT count(*)::int AS n FROM sales o WHERE conf_status = ANY($1) AND next_call_at IS NOT NULL AND next_call_at <= now() AND ${scope}`, [CONF_TODO]))[0]?.n);
    const all = num((await ctx.db.query(`SELECT count(*)::int AS n FROM sales o WHERE ${scope}`))[0]?.n);
    const obj = (rows: { k: string; n: number }[]) => Object.fromEntries(rows.map((r) => [r.k, num(r.n)]));
    return {
      conf: obj(conf),
      follow: obj(follow),
      sub: obj(subs),
      lateCalls: late,
      sav: 0,
      uncashed: 0,
      tickets: { toShip: 0, prepared: 0, onRoad: 0, uncashed: 0 },
      lowStock: 0,
      ai: { messages: 0, cm: 0, notify: 0 },
      landing: undefined as Awaited<ReturnType<typeof landingCounts>> | undefined,
      all,
    };
  }
  // the confirmation numbers of the store's own agents: the orders no agency handles (their lists show those)
  const q = queueSql(ctx, 'conf');
  const conf = await ctx.db.query<{ k: string; n: number }>(
    `SELECT conf_status AS k, count(*)::int AS n FROM sales o WHERE true${own ? ' AND livreur_id = $1' : ''}${andSql(q)} GROUP BY 1`,
    own ? [me] : [],
  );
  const follow = await ctx.db.query<{ k: string; n: number }>(
    `SELECT follow_status AS k, count(*)::int AS n FROM sales WHERE follow_status IS NOT NULL ${own ? 'AND livreur_id = $1' : ''} GROUP BY 1`,
    own ? [me] : [],
  );
  const lateCalls = num(
    (await ctx.db.query(`SELECT count(*)::int AS n FROM sales o WHERE conf_status = ANY($1) AND next_call_at IS NOT NULL AND next_call_at <= now()${andSql(q)}`, [CONF_TODO]))[0]?.n,
  );
  const sav = num((await ctx.db.query(`SELECT count(*)::int AS n FROM complaints WHERE status IN ('open','progress')`))[0]?.n);
  const uncashed = num((await ctx.db.query(`SELECT count(*)::int AS n FROM sales WHERE follow_status='delivered' AND NOT cashed`))[0]?.n);
  const subs = await ctx.db.query<{ k: string; n: number }>(`SELECT sub_status AS k, count(*)::int AS n FROM sales WHERE sub_status IS NOT NULL GROUP BY 1`);
  const lowStock = await lowStockCount(ctx.db);
  // SAV ticket parcels have their own counts (depot work, on the road, money not yet cashed)
  const tk = (
    await ctx.db.query(
      `SELECT count(*) FILTER (WHERE follow_status IN ('to_prepare','prepared'))::int AS to_ship,
              count(*) FILTER (WHERE follow_status = 'prepared')::int AS prepared,
              count(*) FILTER (WHERE follow_status IN ('shipped','out_for_delivery','failed','alert','in_exchange'))::int AS on_road,
              count(*) FILTER (WHERE follow_status = 'delivered' AND NOT cashed AND total > 0)::int AS uncashed
       FROM ticket_parcels ${own ? 'WHERE livreur_id = $1' : ''}`,
      own ? [me] : [],
    )
  )[0];
  const tickets = { toShip: num(tk?.to_ship), prepared: num(tk?.prepared), onRoad: num(tk?.on_road), uncashed: num(tk?.uncashed) };
  // Pilot AI: conversations waiting for a person or unread (Message AI agent), comments still to handle (CM AI agent),
  // delivery messages to send by hand or that failed in the last 3 days (Delivery AI agent)
  const aiRow = (
    await ctx.db.query(
      `SELECT (SELECT count(*) FROM conversations WHERE channel <> 'test' AND (mode = 'handoff' OR unread > 0))::int AS msgs,
              (SELECT count(*) FROM cm_comments WHERE status IN ('new','handoff','error'))::int AS cm,
              (SELECT count(*) FROM notifications WHERE status = 'manual' OR (status = 'failed' AND created_at > now() - interval '3 days'))::int AS notify`,
    )
  )[0];
  const ai = { messages: num(aiRow?.msgs), cm: num(aiRow?.cm), notify: num(aiRow?.notify) };
  const toObj = (rows: { k: string; n: number }[]) => Object.fromEntries(rows.map((r) => [r.k, num(r.n)]));
  // Landing pages (marketers and agents): blocked and abandoned orders to handle, products without a page
  const landing = hasRole(ctx.session, 'marketer', 'confirmation') ? await landingCounts(ctx.db, ctx.now()) : undefined;
  // only marketers make pages: an agent's badge counts the orders to handle, not the products without a page
  if (landing && !hasRole(ctx.session, 'marketer')) landing.noPage = 0;
  return { conf: toObj(conf), follow: toObj(follow), sub: toObj(subs), lateCalls, sav, uncashed, tickets, lowStock, ai, landing, all: num((await ctx.db.query('SELECT count(*)::int n FROM sales'))[0]?.n) };
}

// ---------------------------------------------------------------- order form, fees and the delivered report
/** Courier cost of one delivered / returned parcel: the company's price for the wilaya (home or desk) + overweight. */
interface CompanyRule {
  home: number | null;
  desk: number | null;
  ret: number | null;
  freeKg: number;
  perKg: number;
  onReturn: boolean;
}
async function companyRules(db: Db): Promise<{ fees: Map<string, CompanyRule>; over: Map<number, { freeKg: number; perKg: number; onReturn: boolean }>; ruled: Set<number> }> {
  const comps = await db.query('SELECT id, kind, config FROM delivery_companies');
  const over = new Map<number, { freeKg: number; perKg: number; onReturn: boolean }>();
  // the companies whose « Surpoids » is decided (typed, ZR's own, our livreurs): the Bilan does not ask for them
  const ruled = new Set<number>();
  // its own rule, else ZR's (50 DA a kg above 5 kg, also on a return)
  for (const c of comps) {
    over.set(num(c.id), weightRuleOf(c.kind, c.config));
    if (weightRuleSet(c.kind, c.config)) ruled.add(num(c.id));
  }
  const fees = new Map<string, CompanyRule>();
  for (const f of await db.query('SELECT company_id, wilaya_id, home, desk, return_fee FROM delivery_fees')) {
    const o = over.get(num(f.company_id)) ?? { freeKg: 0, perKg: 0, onReturn: true };
    fees.set(`${num(f.company_id)}:${num(f.wilaya_id)}`, { home: num(f.home), desk: num(f.desk), ret: num(f.return_fee), ...o });
  }
  return { fees, over, ruled };
}
function parcelFees(o: any, R: Awaited<ReturnType<typeof companyRules>>) {
  if (!o.company_id) return { liv: 0, ret: 0, extra: 0, extraRet: 0, kg: Number(o.kg) || 0, fromTariff: false, fromApi: false };
  const f = R.fees.get(`${num(o.company_id)}:${num(o.wilaya_id)}`);
  const rule = R.over.get(num(o.company_id)) ?? { freeKg: 0, perKg: 0, onReturn: true };
  const base = f ? (o.is_stopdesk ? f.desk : f.home) : null;
  // the courier's own numbers for this parcel (its API: its prices, the weight it counted, its weight fee) come first
  const api = apiFees(o.courier_fees);
  if (api) {
    const liv = api.delivery ?? base ?? (num(o.delivery_cost) || num(o.delivery_fee));
    return { liv, ret: api.ret ?? f?.ret ?? 0, extra: api.weight, extraRet: api.weightRet, kg: api.kg ?? (Number(o.kg) || 0), fromTariff: true, fromApi: true };
  }
  const kg = Number(o.kg) || 0;
  // its « Surpoids » on the weight declared, whole kilos like ZR (5 kg free → 6 kg 50 DA), on the delivery and — its
  // rule says so — on the return; a company whose API gives the weight fee: none guessed from the products
  const extra = ruleFee(o.company_kind, rule, kg);
  // no price list for this wilaya: the parcel's cost as kept (it already holds the weight fee)
  const liv = base ?? Math.max(0, (num(o.delivery_cost) || num(o.delivery_fee)) - (num(o.delivery_cost) ? extra : 0));
  return { liv, ret: f?.ret ?? 0, extra, extraRet: rule.onReturn ? extra : 0, kg, fromTariff: base !== null, fromApi: false };
}
const FEE_COLS = `o.id, o.ref, o.total, o.delivery_fee, o.delivery_cost, o.courier_fees, o.company_id, o.wilaya_id, o.is_stopdesk, o.cashed, co.name AS company, co.kind AS company_kind,
  (SELECT coalesce(sum(p.weight_kg * i.qty), 0) FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = o.id) AS kg`;

function orderExtraProcs() {
  return {
    /** Everything the order form needs: products (variants, stock, packs, linked), companies, stop desks, settings. */
    'orders.formData': proc(['confirmation', 'suivi', 'depot'], z.object({}), async (ctx) => {
      const prods = await ctx.db.query('SELECT id, name, sku, price, fixed_price, max_discount, packs, linked, active, is_service, fee_grid, weight_kg FROM products ORDER BY name');
      const vars = await ctx.db.query(
        `SELECT v.id, v.product_id, v.title, v.sku, v.price, v.active,
           coalesce((SELECT sum(s.qty) FROM stock s WHERE s.variant_id = v.id), 0) AS qty,
           coalesce((SELECT sum(i.qty) FROM order_items i JOIN orders o ON o.id = i.order_id
                     WHERE i.variant_id = v.id AND o.conf_status IN ('confirmed','no_stock') AND o.follow_status IN ('to_prepare','prepared')), 0) AS reserved
         FROM product_variants v ORDER BY v.product_id, v.id`,
      );
      const byP = new Map<number, any[]>();
      for (const v of vars) {
        const pid = num(v.product_id);
        if (!byP.has(pid)) byP.set(pid, []);
        byP.get(pid)!.push({ id: num(v.id), title: v.title, sku: v.sku, price: numOrNull(v.price), active: v.active, stock: num(v.qty) - num(v.reserved) });
      }
      const parse = (x: any) => (typeof x === 'string' ? JSON.parse(x) : x ?? []);
      const products = prods.map((p: any) => ({
        id: num(p.id), name: p.name, sku: p.sku, price: num(p.price), fixedPrice: !!p.fixed_price, maxDiscount: numOrNull(p.max_discount),
        packs: parse(p.packs).map((k: any) => ({ qty: num(k.qty), price: num(k.price) })) as { qty: number; price: number }[], linked: ((p.linked ?? []) as unknown[]).map(num), active: !!p.active, isService: !!p.is_service,
        variants: (byP.get(num(p.id)) ?? []) as { id: number; title: string; sku: string; price: number | null; active: boolean; stock: number }[],
      }));
      const companies = (await ctx.db.query('SELECT id, name, kind, active FROM delivery_companies ORDER BY name')).map((c: any) => ({ id: num(c.id), name: c.name, kind: c.kind, active: !!c.active }));
      const stopdesks = (await ctx.db.query('SELECT id, company_id, wilaya_id, commune, name, address FROM stopdesks ORDER BY name')).map((d: any) => ({
        id: num(d.id), companyId: num(d.company_id), wilayaId: num(d.wilaya_id), commune: d.commune, name: d.name, address: d.address,
      }));
      const shop = await getSetting(ctx.db, 'shop');
      return { products, companies, stopdesks, defaultCompanyId: shop.defaultCompanyId ?? null };
    }),

    /** Small lists used by the order screens: delivery companies (with kind), the shop name / WhatsApp template, and the
     *  shop's after-sales number (parcel labels). */
    'orders.lookups': proc(null, z.object({}), async (ctx) => {
      const companies = (await ctx.db.query('SELECT id, name, kind, active FROM delivery_companies ORDER BY name')).map((c: any) => ({ id: num(c.id), name: c.name as string, kind: c.kind as string, active: !!c.active }));
      const shop = await getSetting(ctx.db, 'shop');
      return { companies, shopName: shop.name, whatsappTemplate: shop.whatsappTemplate, defaultCompanyId: shop.defaultCompanyId ?? null, savPhone: shop.savPhone };
    }),

    /**
     * Delivery price the customer pays (client price grid of the products, the highest one, + weight above the limit),
     * whether the company serves the wilaya, and the maximum discount for these products.
     */
    'orders.quote': proc(
      ['confirmation', 'suivi', 'depot'],
      z.object({ wilayaId: z.number().int().min(1).max(69).nullable(), isStopdesk: z.boolean().default(false), companyId: id.nullable().optional(), items: z.array(z.object({ productId: id, qty: z.number().int().min(1).max(999) })).max(50).default([]) }),
      async (ctx, i) => {
        const pids = [...new Set(i.items.map((x) => x.productId))];
        const prods = pids.length ? await ctx.db.query('SELECT id, fee_grid, weight_kg, max_discount FROM products WHERE id = ANY($1)', [pids]) : [];
        const P = new Map(prods.map((p: any) => [num(p.id), p]));
        let weight = 0;
        let maxDiscount = 0;
        let unlimited = false;
        for (const it of i.items) {
          const p: any = P.get(it.productId);
          if (!p) continue;
          weight += Number(p.weight_kg) * it.qty;
          if (p.max_discount === null) unlimited = true;
          else maxDiscount += num(p.max_discount) * it.qty;
        }
        let fee: number | null = null;
        let grid: string | null = null;
        if (i.wilayaId) {
          const grids = [...new Set([...P.values()].map((p: any) => p.fee_grid as string | null))];
          if (!grids.length) grids.push(null);
          for (const g of grids) {
            const f = await clientFee(ctx.db, i.wilayaId, i.isStopdesk, g);
            if (f !== null && (fee === null || f > fee)) {
              fee = f;
              grid = g ?? (await getSetting(ctx.db, 'defaultFeeGrid'));
            }
          }
          if (fee !== null) {
            const wf = await getSetting(ctx.db, 'weightFees');
            if (weight > wf.fromKg) fee += Math.ceil(weight - wf.fromKg) * wf.perKg;
          }
        }
        let served = true;
        const companyId = i.companyId ?? (await getSetting(ctx.db, 'shop')).defaultCompanyId ?? null;
        let companyName: string | null = null;
        if (companyId && i.wilayaId) {
          const co = (await ctx.db.query('SELECT name, kind FROM delivery_companies WHERE id = $1', [companyId]))[0];
          companyName = co?.name ?? null;
          if (co && co.kind !== 'own' && co.kind !== 'manual') {
            const any = num((await ctx.db.query('SELECT count(*)::int AS n FROM delivery_fees WHERE company_id = $1', [companyId]))[0]?.n);
            const f = (await ctx.db.query('SELECT home, desk FROM delivery_fees WHERE company_id = $1 AND wilaya_id = $2', [companyId, i.wilayaId]))[0];
            if (any > 0) served = !!f && (i.isStopdesk ? num(f.desk) > 0 : num(f.home) > 0);
          }
        }
        return { fee, grid, weight: Math.round(weight * 10) / 10, maxDiscount: unlimited ? null : maxDiscount, served, companyId, companyName };
      },
    ),

    /** What the courier charges for these parcels (column "Frais société"). */
    'orders.companyFees': proc(['confirmation', 'suivi', 'depot'], z.object({ ids: z.array(id).max(500) }), async (ctx, { ids }) => {
      if (!ids.length) return {} as Record<string, { fee: number; extra: number; kg: number; fromTariff: boolean; fromApi: boolean }>;
      const R = await companyRules(ctx.db);
      const rows = await ctx.db.query(`SELECT ${FEE_COLS} FROM orders o LEFT JOIN delivery_companies co ON co.id = o.company_id WHERE o.id = ANY($1)`, [ids]);
      const out: Record<string, { fee: number; extra: number; kg: number; fromTariff: boolean; fromApi: boolean }> = {};
      for (const o of rows) {
        const x = parcelFees(o, R);
        out[String(num(o.id))] = { fee: o.company_id ? x.liv + x.extra : 0, extra: x.extra, kg: Math.round(x.kg * 10) / 10, fromTariff: x.fromTariff, fromApi: x.fromApi };
      }
      return out;
    }),

    /** "Bilan des livraisons": delivered in the period, cashed or not, courier fees, returns, net to receive — total and per company. */
    'orders.deliveredReport': proc(['suivi', 'depot'], z.object({ from: dateStr, to: dateStr }), (ctx, i) => deliveredReport(ctx, i)),
    /** Cancelled at the confirmation and returned parcels of a period: why, by whom, from which company, the cost. */
    'orders.cancelReport': proc(['suivi', 'depot', 'agent_manager'], z.object({ from: dateStr, to: dateStr }), (ctx, i) => cancelReport(ctx, i)),
    /** The reason given for these orders: why they were cancelled at the confirmation (conf) or came back (back). */
    'orders.reasons': proc(null, z.object({ ids: z.array(id).max(500), of: z.enum(['conf', 'back']) }), async (ctx, i) => {
      const out: Record<string, string | null> = {};
      if (!i.ids.length || noOrderAccess(ctx)) return out;
      const own = onlyOwnDeliveries(ctx);
      const rows = await ctx.db.query(`SELECT o.id, ${REASON_SQL[i.of]} AS reason FROM orders o WHERE o.id = ANY($1)${own ? ' AND o.livreur_id = $2' : ''}`, own ? [i.ids, ctx.session.profile.id] : [i.ids]);
      for (const r of rows) out[String(num(r.id))] = r.reason ?? null;
      return out;
    }),
  };
}

/** "Bilan des livraisons": delivered in the period, cashed or not, courier fees, returns, net to receive — total and per company.
 * Orders and SAV ticket parcels are counted apart (`sales` / `ticket_parcels`). */
export async function deliveredReport(ctx: Ctx, i: { from: string; to: string }, view: 'sales' | 'ticket_parcels' = 'sales') {
  const R = await companyRules(ctx.db);
  const base = `FROM ${view} o LEFT JOIN delivery_companies co ON co.id = o.company_id`;
  const D = await ctx.db.query(`SELECT ${FEE_COLS} ${base} WHERE o.follow_status = 'delivered' AND o.delivered_at >= $1 AND o.delivered_at < $2`, [i.from, i.to]);
  const B = await ctx.db.query(
    `SELECT ${FEE_COLS} ${base} WHERE o.follow_status IN ('returning','returned') AND coalesce(o.returned_at, o.returning_at, o.updated_at) >= $1 AND coalesce(o.returned_at, o.returning_at, o.updated_at) < $2`,
    [i.from, i.to],
  );
  type Agg = { companyId: number | null; name: string; kind: string | null; n: number; amount: number; cashed: number; cashedN: number; uncashed: number; uncashedN: number; fees: number; overweight: number; returns: number; returnFees: number; returnOverweight: number; netToReceive: number; noTariff: number };
  const empty = (companyId: number | null, name: string, kind: string | null): Agg => ({ companyId, name, kind, n: 0, amount: 0, cashed: 0, cashedN: 0, uncashed: 0, uncashedN: 0, fees: 0, overweight: 0, returns: 0, returnFees: 0, returnOverweight: 0, netToReceive: 0, noTariff: 0 });
  const M = new Map<number, Agg>();
  const T = empty(null, 'Total', null);
  const noRule = new Set<string>();
  const g = (o: any) => {
    const k = num(o.company_id);
    if (!M.has(k)) M.set(k, empty(o.company_id ? k : null, o.company ?? 'Sans société', o.company_kind ?? null));
    return M.get(k)!;
  };
  for (const o of D) {
    const x = parcelFees(o, R);
    const v = num(o.total);
    for (const z of [g(o), T]) {
      z.n++;
      z.amount += v;
      z.fees += x.liv;
      z.overweight += x.extra;
      if (o.cashed) {
        z.cashed += v;
        z.cashedN++;
      } else {
        z.uncashed += v;
        z.uncashedN++;
        z.netToReceive += v - x.liv - x.extra;
      }
      if (!x.fromTariff && o.company_id) z.noTariff++;
    }
    if (o.company_id && !R.ruled.has(num(o.company_id))) noRule.add(o.company ?? '—');
  }
  for (const o of B) {
    const x = parcelFees(o, R);
    for (const z of [g(o), T]) {
      z.returns++;
      z.returnFees += x.ret;
      z.returnOverweight += x.extraRet;
      z.netToReceive -= x.ret + x.extraRet;
    }
  }
  return { total: T, companies: [...M.values()].sort((a, b) => b.amount - a.amount), noOverweightRule: [...noRule] };
}

/** The reasons given, most frequent first; beyond the first six they are « others ». */
function topReasons(rows: { reason: string | null }[]) {
  const m = new Map<string, number>();
  let none = 0;
  for (const r of rows) {
    if (!r.reason) none++;
    else m.set(r.reason, (m.get(r.reason) ?? 0) + 1);
  }
  const all = [...m.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n);
  const others = all.slice(6).reduce((s, x) => s + x.n, 0);
  return { top: all.slice(0, 6), others, none };
}

/** What was lost over a period: orders cancelled at the confirmation (their status, the reason given, by which agent,
 *  out of every order decided) and parcels coming back (why, from which company, what that costs, out of the parcels
 *  that arrived). A cancelled order counts on its last change, a return on its return (or its last change). */
export async function cancelReport(ctx: Ctx, i: { from: string; to: string }) {
  const C = await ctx.db.query(
    `SELECT o.conf_status AS s, o.total, o.agent_id, p.name AS agent, ${REASON_SQL.conf} AS reason
     FROM sales o LEFT JOIN profiles p ON p.id = o.agent_id
     WHERE o.conf_status = ANY($1) AND o.updated_at >= $2 AND o.updated_at < $3`,
    [CONF_DONE_BAD, i.from, i.to],
  );
  const OK = await ctx.db.query<{ agent_id: unknown; agent: string | null; n: number }>(
    `SELECT o.agent_id, p.name AS agent, count(*)::int AS n FROM sales o LEFT JOIN profiles p ON p.id = o.agent_id
     WHERE o.confirmed_at >= $1 AND o.confirmed_at < $2 AND NOT (o.conf_status = ANY($3)) GROUP BY 1, 2`,
    [i.from, i.to, CONF_DONE_BAD],
  );
  const byStatus = Object.fromEntries(CONF_DONE_BAD.map((s) => [s, 0])) as Record<ConfStatus, number>;
  type Agent = { id: number | null; name: string | null; n: number; confirmed: number; rate: number | null };
  const A = new Map<number, Agent>();
  const agent = (id: unknown, name: string | null) => {
    const k = num(id);
    if (!A.has(k)) A.set(k, { id: id == null ? null : k, name, n: 0, confirmed: 0, rate: null });
    return A.get(k)!;
  };
  let amount = 0;
  for (const r of C) {
    byStatus[r.s as ConfStatus] = (byStatus[r.s as ConfStatus] ?? 0) + 1;
    amount += num(r.total);
    agent(r.agent_id, r.agent).n++;
  }
  let confirmed = 0;
  for (const r of OK) {
    confirmed += num(r.n);
    agent(r.agent_id, r.agent).confirmed += num(r.n);
  }
  const rate = (bad: number, good: number) => (bad + good > 0 ? bad / (bad + good) : null);
  const agents = [...A.values()]
    .map((a) => ({ ...a, rate: rate(a.n, a.confirmed) }))
    .filter((a) => a.n > 0)
    .sort((a, b) => b.n - a.n || (b.rate ?? 0) - (a.rate ?? 0));

  // the parcels coming back, their reason, and per company out of what it delivered (with what the returns cost)
  const B = await ctx.db.query(
    `SELECT o.follow_status AS s, o.total, ${REASON_SQL.back} AS reason
     FROM sales o WHERE o.follow_status IN ('returning','returned') AND coalesce(o.returned_at, o.returning_at, o.updated_at) >= $1 AND coalesce(o.returned_at, o.returning_at, o.updated_at) < $2`,
    [i.from, i.to],
  );
  const d = await deliveredReport(ctx, i);
  const companies = d.companies
    .filter((c) => c.returns > 0)
    .map((c) => ({ companyId: c.companyId, name: c.name, kind: c.kind, returns: c.returns, delivered: c.n, rate: rate(c.returns, c.n), fees: c.returnFees + c.returnOverweight }))
    .sort((a, b) => b.returns - a.returns);
  return {
    conf: { n: C.length, amount, confirmed, rate: rate(C.length, confirmed), byStatus, reasons: topReasons(C as any), agents },
    returns: {
      n: B.length,
      returning: B.filter((r: any) => r.s === 'returning').length,
      returned: B.filter((r: any) => r.s === 'returned').length,
      amount: B.reduce((s: number, r: any) => s + num(r.total), 0),
      fees: d.total.returnFees + d.total.returnOverweight,
      delivered: d.total.n,
      rate: rate(B.length, d.total.n),
      reasons: topReasons(B as any),
      companies,
    },
  };
}

// ---------------------------------------------------------------- the procedures
export const ordersProcs = {
  ...orderExtraProcs(),
  'orders.list': proc(null, ListInput, async (ctx, f) => {
    const p = await listOrders(ctx, f);
    return { ...p, rows: await withClientScores(ctx, p.rows) };
  }),
  'orders.counts': proc(null, z.object({}), (ctx) => orderCounts(ctx)),
  'orders.get': proc(null, z.object({ id }), async (ctx, { id }) => {
    const o = (await withClientScores(ctx, [await getOrder(ctx, id)]))[0];
    const row = (
      await ctx.db.query(
        `SELECT o.courier_fees, o.tracking, o.livreur_id, o.is_stopdesk, co.kind, co.config, f.home, f.desk, f.return_fee,
           (SELECT coalesce(sum(p.weight_kg * i.qty), 0) FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = o.id) AS kg
         FROM orders o LEFT JOIN delivery_companies co ON co.id = o.company_id LEFT JOIN delivery_fees f ON f.company_id = o.company_id AND f.wilaya_id = o.wilaya_id
         WHERE o.id = $1`,
        [id],
      )
    )[0];
    const fees = apiFees(row?.courier_fees);
    // with what Pilotix declared to the company (its products' weight): « ZR a pesé 7 kg (déclaré 4 kg) »
    let courierFees: Order['courierFees'] = fees
      ? { delivery: fees.delivery, ret: fees.ret, weight: fees.weight, weightRet: fees.weightRet, kg: wholeKg(fees.kg), declaredKg: declaredKg(row?.kg), exact: fees.exact }
      : null;
    // a company without its fees by API whose « Surpoids » is set (Tarifs): its price list + its weight fee on the weight
    // declared, on the delivery and — its rule says so — on the return
    if (!courierFees && row?.tracking && !row.livreur_id && row.home !== null && row.home !== undefined) {
      const rule = weightRuleOf(row.kind, row.config);
      if (rule.perKg > 0 && row.kind !== 'own' && !feesByApi(row.kind)) {
        const w = ruleFee(row.kind, rule, row.kg);
        const dk = declaredKg(row.kg);
        courierFees = { delivery: num(row.is_stopdesk ? row.desk : row.home), ret: num(row.return_fee), weight: w, weightRet: rule.onReturn ? w : 0, kg: dk, declaredKg: dk, exact: false, byRule: true };
      }
    }
    return { ...o, pay: await payOf(ctx.db, o), courierFees };
  }),
  'orders.events': proc(null, z.object({ id }), async (ctx, { id }) => {
    const o = await getOrder(ctx, id);
    let rows = await ctx.db.query(
      'SELECT e.*, p.name AS user_name FROM order_events e LEFT JOIN profiles p ON p.id = e.user_id WHERE e.order_id = $1 ORDER BY e.at, e.id',
      [id],
    );
    // Affectation automatique › « réinitialiser l'historique »: an agent given an order again sees it from his turn
    // (its creation and its notes stay); managers see everything
    const me = ctx.session.profile.id;
    if (!ctx.session.isAdmin && !hasRole(ctx.session, 'agent_manager', 'vendeur')) {
      const cfg = await getAssign(ctx.db);
      const mine = o.agentId === me && cfg.conf.hideHistory ? 'conf' : o.followAgentId === me && cfg.follow.hideHistory ? 'follow' : null;
      if (mine) {
        const since = (await ctx.db.query(`SELECT max(at) AS at FROM order_events WHERE order_id = $1 AND kind = 'assign' AND to_value = $2`, [id, String(me)]))[0]?.at;
        const before = rows.some((r: any) => r.kind === 'assign' && r.to_value !== String(me) && since && Date.parse(new Date(r.at).toISOString()) < Date.parse(new Date(since).toISOString()));
        if (since && before) rows = rows.filter((r: any) => r.kind === 'created' || (r.kind === 'note' && r.user_id === null) || Date.parse(new Date(r.at).toISOString()) >= Date.parse(new Date(since).toISOString()));
      }
    }
    return rows.map(
      (r: any): OrderEvent => ({ id: num(r.id), orderId: num(r.order_id), at: iso(r.at), userId: numOrNull(r.user_id), userName: r.user_name, kind: r.kind, fromValue: r.from_value, toValue: r.to_value, note: r.note }),
    );
  }),
  // the upsell is always counted by Pilotix: a mark sent by a screen is not taken (only Dellal, inside, marks what it sold in addition)
  'orders.create': proc(['confirmation', 'suivi', 'depot'], OrderInput, async (ctx, i) => {
    // an exchange leaves free (the customer only pays the delivery): it is made by the SAV (sav.exchange), from a real
    // ticket — never typed as a free order to anyone. Only the administrator may type one directly.
    if (i.isExchange && !ctx.session.isAdmin) throw forbidden('Un échange se fait depuis le SAV');
    const o = await createOrder(ctx, { ...i, items: i.items.map((x) => ({ ...x, isUpsell: false })) }, ctx.db, { guard: i.via === 'api' ? 'check' : 'note' });
    await sendInPreview(ctx);
    return o;
  }),
  'orders.update': proc(['confirmation', 'suivi', 'depot'], UpdateInput, (ctx, i) => updateOrder(ctx, i)),
  'orders.setConf': proc(['confirmation'], ConfInput, (ctx, i) => setConf(ctx, i)),
  'orders.setFollow': proc(['suivi', 'depot', 'livreur'], FollowInput, (ctx, i) => setFollow(ctx, i)),

  'orders.assignAgent': proc(['agent_manager', 'vendeur', 'confirmation'], z.object({ ids, agentId: id.nullable() }), async (ctx, { ids, agentId }) => {
    const manager = hasRole(ctx.session, 'agent_manager', 'vendeur');
    if (!manager && agentId !== ctx.session.profile.id) throw forbidden('Seul un manager peut assigner à quelqu’un d’autre');
    await ctx.db.tx(async (tx) => {
      for (const oid of ids) {
        const cur = (await tx.query('SELECT ref, agent_id, shipped_at FROM orders WHERE id=$1', [oid]))[0];
        if (!cur) continue;
        if (!manager && cur.agent_id && num(cur.agent_id) !== ctx.session.profile.id) throw forbidden();
        // the agent of an order that left is the one paid for it: only the administrator changes it then
        if (cur.shipped_at && !ctx.session.isAdmin) throw bad(`${cur.ref} est déjà partie : seul l’administrateur change son agent`);
        await tx.query('UPDATE orders SET agent_id=$2, assigned_at = CASE WHEN $2::bigint IS NULL THEN NULL ELSE now() END, updated_at=now() WHERE id=$1', [oid, agentId]);
        await addEvent(tx, oid, ctx.session.profile.id, 'assign', cur.agent_id ? String(cur.agent_id) : null, agentId ? String(agentId) : null);
      }
    });
    ctx.emit({ type: 'orders' });
    return { ok: true };
  }),

  'orders.assignCompany': proc(['depot', 'suivi', 'confirmation'], z.object({ ids, companyId: id.nullable(), livreurId: id.nullable().optional() }), (ctx, i) => assignCompanies(ctx, i)),

  'orders.note': proc(null, z.object({ id, note: z.string().min(1).max(1000), field: z.enum(['event', 'internal', 'delivery', 'customer']).default('event') }), async (ctx, i) => {
    await getOrder(ctx, i.id);
    const col = { internal: 'internal_note', delivery: 'delivery_note', customer: 'customer_note', event: null }[i.field];
    if (col) await ctx.db.query(`UPDATE orders SET ${col} = $2, updated_at = now() WHERE id = $1`, [i.id, i.note]);
    await addEvent(ctx.db, i.id, ctx.session.profile.id, 'note', null, i.field, i.note);
    ctx.emit({ type: 'order', id: i.id });
    return { ok: true };
  }),

  'orders.logCall': proc(['confirmation', 'suivi', 'livreur'], z.object({ id }), async (ctx, { id }) => {
    await getOrder(ctx, id); // a livreur logs calls on his own parcels only
    await addEvent(ctx.db, id, ctx.session.profile.id, 'call', null, null);
    return { ok: true };
  }),

  'orders.setTracking': proc(['depot', 'suivi'], z.object({ id, tracking: z.string().max(80).nullable() }), async (ctx, i) => {
    // removing the tracking of a parcel that left would unfreeze its amount (see updateOrder)
    const cur = (await ctx.db.query('SELECT tracking, shipped_at FROM orders WHERE id = $1', [i.id]))[0];
    if (!cur) throw notFound();
    if (cur.shipped_at && cur.tracking && !i.tracking?.trim() && !ctx.session.isAdmin) throw bad('Colis déjà parti : le numéro de suivi ne s’efface plus');
    await ctx.db.query('UPDATE orders SET tracking=$2, updated_at=now() WHERE id=$1', [i.id, i.tracking]);
    await addEvent(ctx.db, i.id, ctx.session.profile.id, 'edit', null, null, `Suivi : ${i.tracking ?? '—'}`);
    ctx.emit({ type: 'order', id: i.id });
    return { ok: true };
  }),

  'orders.setSub': proc(['suivi'], z.object({ id, sub: z.string().max(40).nullable(), note: z.string().max(1000).nullable().optional() }), async (ctx, i) => {
    const cur = (await ctx.db.query('SELECT sub_status FROM orders WHERE id=$1', [i.id]))[0];
    if (!cur) throw notFound();
    await ctx.db.query('UPDATE orders SET sub_status=$2, updated_at=now() WHERE id=$1', [i.id, i.sub]);
    await addEvent(ctx.db, i.id, ctx.session.profile.id, 'sub_status', cur.sub_status, i.sub, i.note);
    ctx.emit({ type: 'order', id: i.id });
    return { ok: true };
  }),

  /** The next order this agent should call: due callbacks first, then the oldest new ones. */
  'orders.next': proc(['confirmation'], z.object({ skip: z.array(id).max(200).default([]) }), async (ctx, { skip }) => {
    const me = ctx.session.profile.id;
    // picked and locked in one statement: two agents clicking at the same time never get the same customer
    const r = await ctx.db.query(
      `UPDATE orders SET locked_by = $2, locked_until = now() + interval '10 minutes'
        WHERE id = (SELECT id ${nextFrom(ctx)} LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING id`,
      [CONF_TODO, me, skip],
    );
    if (!r[0]) return { id: null };
    return { id: num(r[0].id) };
  }),

  /** "Supprimer" (admin): only orders still at the confirmation stage (not sent to the depot), not SAV parcels, without ticket or claim. */
  'orders.delete': proc([], z.object({ ids: z.array(id).min(1).max(500) }), async (ctx, { ids }) => {
    await ctx.db.tx(async (tx) => {
      const rows = await tx.query('SELECT id, ref, follow_status, is_exchange FROM orders WHERE id = ANY($1) FOR UPDATE', [ids]);
      for (const r of rows) {
        if (r.is_exchange) throw bad(`${r.ref} est un colis de ticket SAV : annulez le ticket`);
        if (r.follow_status && r.follow_status !== 'cancelled') throw bad(`${r.ref} est déjà au dépôt ou en livraison : elle ne peut plus être supprimée`);
      }
      const linked = (await tx.query('SELECT o.ref FROM orders o WHERE o.id = ANY($1) AND (EXISTS (SELECT 1 FROM complaints c WHERE c.order_id = o.id) OR EXISTS (SELECT 1 FROM claims c WHERE c.order_id = o.id) OR EXISTS (SELECT 1 FROM orders x WHERE x.original_order_id = o.id)) LIMIT 1', [ids]))[0];
      if (linked) throw bad(`${linked.ref} a un ticket, une réclamation ou un échange : elle ne peut pas être supprimée`);
      await tx.query('DELETE FROM order_events WHERE order_id = ANY($1)', [ids]);
      await tx.query('UPDATE stock_movements SET order_id = NULL WHERE order_id = ANY($1)', [ids]);
      await tx.query('UPDATE chat_messages SET order_id = NULL WHERE order_id = ANY($1)', [ids]);
      await tx.query('DELETE FROM orders WHERE id = ANY($1)', [ids]);
    });
    ctx.emit({ type: 'orders' });
    return { deleted: ids.length };
  }),
  'orders.duplicate': proc(['confirmation'], z.object({ ids }), async (ctx, { ids }) => {
    const out: number[] = [];
    for (const oid of ids) {
      const o = await getOrder(ctx, oid);
      const copy = await createOrder(ctx, {
        customerName: o.customerName, phone: o.phone, phone2: o.phone2, wilayaId: o.wilayaId, commune: o.commune, address: o.address,
        isStopdesk: o.isStopdesk, stopdeskId: o.stopdeskId, companyId: o.companyId, channel: o.channel, source: o.source,
        // a copy starts afresh: its lines are what its customer ordered (the upsell of the first order is not counted twice)
        items: o.items.map((i) => ({ productId: i.productId, variantId: i.variantId, qty: i.qty, unitPrice: i.unitPrice })),
        deliveryFee: o.deliveryFee, discount: o.discount, customerNote: o.customerNote, deliveryNote: o.deliveryNote,
        internalNote: `Copie de ${o.ref}`, confirm: false, isExchange: false,
      });
      out.push(copy.id);
    }
    await sendInPreview(ctx);
    return { ids: out };
  }),

  /** Actions made offline on a phone, replayed in order. */
  'orders.sync': proc(
    null,
    z.object({
      actions: z
        .array(z.object({ clientId: z.string().min(8).max(64), kind: z.enum(['conf', 'follow', 'note']), id, status: z.string().max(40).optional(), note: z.string().max(1000).optional(), nextCallAt: dateStr.nullable().optional(), reason: z.string().max(200).optional() }))
        .max(200),
    }),
    async (ctx, { actions }) => {
      const results: { clientId: string; ok: boolean; error?: string }[] = [];
      for (const a of actions) {
        try {
          // the same rights as the screens: only confirmation (and admin) changes a confirmation status,
          // and a note goes only on an order this user may open (a livreur: his own parcels)
          if (a.kind === 'conf') {
            if (!canSetConf(ctx.session.roles)) throw forbidden('Vous ne pouvez pas changer le statut de confirmation');
            await setConf(ctx, ConfInput.parse({ ids: [a.id], status: a.status, note: a.note, reason: a.reason, nextCallAt: a.nextCallAt, clientId: a.clientId }));
          } else if (a.kind === 'follow') await setFollow(ctx, FollowInput.parse({ ids: [a.id], status: a.status, note: a.note, reason: a.reason, clientId: a.clientId }));
          else {
            await getOrder(ctx, a.id);
            await addEvent(ctx.db, a.id, ctx.session.profile.id, 'note', null, 'event', a.note ?? '');
          }
          results.push({ clientId: a.clientId, ok: true });
        } catch (e: any) {
          results.push({ clientId: a.clientId, ok: false, error: e?.message ?? 'Erreur' });
        }
      }
      return { results };
    },
  ),
};
