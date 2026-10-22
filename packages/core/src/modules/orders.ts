import {
  canSetFollow,
  CONF_NEEDS_DATE,
  CONF_NEEDS_REASON,
  CONF_STATUSES,
  CONF_TODO,
  ConfStatus,
  FOLLOW_LOCKED,
  FOLLOW_STATUSES,
  FollowStatus,
  normalizePhone,
  Order,
  OrderEvent,
  OrderItem,
  OrigLine,
  origOf,
  upsellOf,
  Page,
  SALES_CHANNELS,
} from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, isoOrNull, num, numOrNull, Where } from '../db';
import { bad, Ctx, forbidden, hasRole, notFound, proc } from '../rpc';
import { clientFee, getSetting } from '../settings';
import { notifyContext, onConfChange, onFollowChange, onOrderCreated, sendInPreview } from './notify';
import { settleTickets } from './tickets';

// ---------------------------------------------------------------- reading
const ORDER_COLS = `o.*,
  (SELECT coalesce(json_agg(json_build_object('id', i.id, 'productId', i.product_id, 'variantId', i.variant_id, 'name', i.name,
     'variantTitle', i.variant_title, 'qty', i.qty, 'unitPrice', i.unit_price, 'purchasePrice', i.purchase_price, 'isUpsell', i.is_upsell) ORDER BY i.id), '[]')
   FROM order_items i WHERE i.order_id = o.id) AS items_json,
  ag.name AS agent_name, fa.name AS follow_agent_name, co.name AS company_name, lv.name AS livreur_name,
  CASE WHEN o.is_exchange THEN (SELECT k.ref FROM complaints k WHERE k.exchange_order_id = o.id ORDER BY k.id DESC LIMIT 1) END AS sav_ref,
  c.blacklisted AS c_blacklisted, c.delivered AS c_delivered, c.returned AS c_returned,
  EXISTS (SELECT 1 FROM sales d WHERE d.phone = o.phone AND d.id <> o.id AND d.conf_status = ANY('{to_check,new,no_answer,busy,callback,postponed,confirmed,no_stock}')
          AND (d.follow_status IS NULL OR d.follow_status IN ('to_prepare','prepared')) AND d.created_at > o.created_at - interval '15 days') AS possible_dup`;

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
    agentName: r.agent_name ?? null,
    followAgentName: r.follow_agent_name ?? null,
    companyName: r.company_name ?? null,
    livreurName: r.livreur_name ?? null,
    subStatus: r.sub_status ?? null,
    lastCallAt: isoOrNull(r.last_call_at),
    version: num(r.version),
  };
}

const onlyOwnDeliveries = (ctx: Ctx) => {
  const s = ctx.session;
  return !s.isAdmin && s.roles.includes('livreur') && !s.roles.some((r) => ['confirmation', 'suivi', 'depot'].includes(r));
};

export async function getOrder(ctx: Ctx, id: number, db: Db = ctx.db): Promise<Order> {
  const r = (await db.query(`SELECT ${ORDER_COLS} ${ORDER_FROM} WHERE o.id = $1`, [id]))[0];
  if (!r) throw notFound('Commande introuvable');
  const o = toOrder(r);
  if (onlyOwnDeliveries(ctx) && o.livreurId !== ctx.session.profile.id) throw forbidden();
  return o;
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

export const ListInput = z.object({
  conf: z.array(z.enum(CONF_STATUSES)).optional(),
  follow: z.array(z.enum([...FOLLOW_STATUSES, 'none'] as const)).optional(),
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
  /** only these orders (selection export / print) */
  ids: z.array(id).max(3000).optional(),
  dateField: z.enum(['created_at', 'confirmed_at', 'shipped_at', 'delivered_at', 'returned_at', 'updated_at']).default('created_at'),
  from: dateStr.optional(),
  to: dateStr.optional(),
  sort: z
    .enum(['created_at', 'confirmed_at', 'next_call_at', 'updated_at', 'total', 'customer_name', 'wilaya_id', 'shipped_at', 'delivered_at', 'ref', 'conf_status', 'follow_status'])
    .default('created_at'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(3000).default(50),
});
export type ListInput = z.infer<typeof ListInput>;

export async function listOrders(ctx: Ctx, f: ListInput): Promise<Page<Order>> {
  const w = new Where();
  if (onlyOwnDeliveries(ctx)) w.add('o.livreur_id = ?', ctx.session.profile.id);
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
  if (f.ids?.length) w.add('o.id = ANY(?)', f.ids);
  if (f.from) w.add(`o.${f.dateField} >= ?`, f.from);
  if (f.to) w.add(`o.${f.dateField} < ?`, f.to);
  if (f.q?.trim()) {
    const q = f.q.trim();
    const phone = normalizePhone(q);
    const digits = q.replace(/\D/g, '');
    if (phone) w.add('(o.phone = ? OR o.phone2 = ?)', phone, phone);
    else if (digits.length >= 4 && digits.length === q.replace(/[\s+.-]/g, '').length) w.add("o.phone LIKE '%' || ? || '%'", digits.slice(-9));
    else w.add("(upper(o.ref) = upper(?) OR o.tracking = ? OR upper(o.own_tracking) = upper(?) OR o.customer_name ILIKE '%' || ? || '%')", q, q, q, q);
  }
  const nulls = f.sort === 'next_call_at' ? (f.dir === 'asc' ? 'NULLS FIRST' : 'NULLS LAST') : f.dir === 'desc' ? 'NULLS LAST' : 'NULLS FIRST';
  const total = num((await ctx.db.query(`SELECT count(*)::int AS n FROM orders o ${w.sql}`, w.params))[0]?.n);
  const limit = w.p(f.pageSize);
  const offset = w.p((f.page - 1) * f.pageSize);
  const rows = await ctx.db.query(`SELECT ${ORDER_COLS} ${ORDER_FROM} ${w.sql} ORDER BY o.${f.sort} ${f.dir} ${nulls}, o.id DESC LIMIT ${limit} OFFSET ${offset}`, w.params);
  return { rows: rows.map(toOrder), total, page: f.page, pageSize: f.pageSize };
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
  confirm: z.boolean().default(false),
  isExchange: z.boolean().default(false),
  originalOrderId: id.nullable().optional(),
  utm: z.record(z.string()).nullable().optional(),
});
export type OrderInput = z.infer<typeof OrderInput>;

/** Prices the items from the catalog; returns lines, subtotal and the maximum allowed discount. */
async function priceItems(db: Db, items: z.infer<typeof ItemInput>[], freePrice = false) {
  const pids = [...new Set(items.map((i) => i.productId))];
  const prods = await db.query('SELECT id, name, price, cost, fixed_price, max_discount, active, fee_grid, weight_kg FROM products WHERE id = ANY($1)', [pids]);
  const vids = items.map((i) => i.variantId).filter((v): v is number => !!v);
  const vars = vids.length ? await db.query('SELECT id, product_id, title, price FROM product_variants WHERE id = ANY($1)', [vids]) : [];
  const P = new Map(prods.map((p: any) => [num(p.id), p]));
  const V = new Map(vars.map((v: any) => [num(v.id), v]));
  let maxDiscount = 0;
  let unlimited = false;
  let weight = 0;
  let grid: string | null = null;
  const lines: OrderItem[] = items.map((i) => {
    const p: any = P.get(i.productId);
    if (!p) throw bad(`Produit inconnu (${i.productId})`);
    const v: any = i.variantId ? V.get(i.variantId) : null;
    if (i.variantId && (!v || num(v.product_id) !== i.productId)) throw bad(`Variante inconnue pour ${p.name}`);
    const listPrice = v?.price ?? p.price;
    // An exchange may be priced freely (often 0: the customer only pays the delivery).
    const unit = i.unitPrice === undefined || (p.fixed_price && !freePrice) ? listPrice : i.unitPrice;
    if (p.max_discount === null) unlimited = true;
    else maxDiscount += num(p.max_discount) * i.qty;
    weight += Number(p.weight_kg) * i.qty;
    grid = grid ?? p.fee_grid;
    return { productId: i.productId, variantId: i.variantId ?? null, name: p.name, variantTitle: v?.title ?? '', qty: i.qty, unitPrice: num(unit), purchasePrice: num(p.cost), isUpsell: !!i.isUpsell };
  });
  const subtotal = lines.reduce((s, l) => s + l.unitPrice * l.qty, 0);
  return { lines, subtotal, maxDiscount: unlimited ? subtotal : maxDiscount, weight, grid };
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

async function insertItems(db: Db, orderId: number, lines: OrderItem[]) {
  for (const l of lines) {
    await db.query(
      'INSERT INTO order_items (order_id, product_id, variant_id, name, variant_title, qty, unit_price, purchase_price, is_upsell) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [orderId, l.productId, l.variantId, l.name, l.variantTitle, l.qty, l.unitPrice, l.purchasePrice, l.isUpsell],
    );
  }
}

export async function createOrder(ctx: Ctx, input: OrderInput, db: Db = ctx.db, opts: { /** taken in this Message AI agent conversation */ conversationId?: number | null } = {}): Promise<Order> {
  const phone = normalizePhone(input.phone);
  if (!phone) throw bad('Numéro de téléphone algérien invalide');
  const phone2 = input.phone2 ? normalizePhone(input.phone2) : null;
  if (input.confirm && !hasRole(ctx.session, 'confirmation')) throw forbidden();
  const me = ctx.session.profile.id;

  const order = await db.tx(async (tx) => {
    const priced = await priceItems(tx, input.items, input.isExchange);
    if (input.discount > priced.maxDiscount) throw bad(`Remise trop élevée (maximum ${priced.maxDiscount} DA)`);
    const fee = input.deliveryFee ?? (await deliveryFeeFor(tx, input.wilayaId, input.isStopdesk, priced.grid, priced.weight));
    const total = priced.subtotal - input.discount + fee;
    // what the customer orders is kept: the upsell is counted against it (lines marked upsell while typing a call are sold in addition)
    const orig = origOf(priced.lines);
    const up = upsellFor(input.isExchange, orig, input.discount, priced.lines, input.discount);
    const lines = priced.lines.map((l, k) => ({ ...l, isUpsell: up.flags[k] }));
    const cust = (
      await tx.query(
        `INSERT INTO customers (phone, name, wilaya_id, orders, last_order_at) VALUES ($1,$2,$3,1,now())
         ON CONFLICT (phone) DO UPDATE SET orders = customers.orders + 1, name = EXCLUDED.name, wilaya_id = EXCLUDED.wilaya_id, last_order_at = now()
         RETURNING id, blacklisted`,
        [phone, input.customerName, input.wilayaId],
      )
    )[0];
    const conf: ConfStatus = input.confirm ? 'confirmed' : cust.blacklisted ? 'to_check' : 'new';
    const ref = (await tx.query(`SELECT 'PX' || nextval('order_ref_seq') AS r`))[0].r;
    const wh = (await tx.query('SELECT id FROM warehouses WHERE active ORDER BY is_default DESC, id LIMIT 1'))[0];
    const defCompany = input.companyId ?? (await getSetting(tx, 'shop')).defaultCompanyId ?? null;
    const row = (
      await tx.query(
        `INSERT INTO orders (ref, created_by, customer_id, customer_name, phone, phone2, wilaya_id, commune, address, is_stopdesk, stopdesk_id, channel, source, utm,
           conf_status, agent_id, assigned_at, confirmed_at, follow_status, company_id, warehouse_id, subtotal, delivery_fee, discount, total,
           customer_note, delivery_note, internal_note, is_exchange, original_order_id, has_upsell, upsell_value, orig_items, orig_discount, conversation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35) RETURNING id`,
        [ref, me, cust.id, input.customerName, phone, phone2, input.wilayaId, input.commune, input.address, input.isStopdesk, input.stopdeskId ?? null,
          input.channel, input.source ?? null, input.utm ? JSON.stringify(input.utm) : null,
          conf, input.confirm ? me : null, input.confirm ? new Date(ctx.now()).toISOString() : null, input.confirm ? new Date(ctx.now()).toISOString() : null,
          input.confirm ? 'to_prepare' : null, defCompany, wh?.id ?? null, priced.subtotal, fee, input.discount, total,
          input.customerNote ?? null, input.deliveryNote ?? null, input.internalNote ?? null, input.isExchange, input.originalOrderId ?? null,
          up.value > 0, up.value, JSON.stringify(orig), input.discount, opts.conversationId ?? null],
      )
    )[0];
    const oid = num(row.id);
    await insertItems(tx, oid, lines);
    await addEvent(tx, oid, me, 'created', null, conf, input.isExchange ? `Échange de la commande #${input.originalOrderId}` : null);
    if (input.confirm) await addEvent(tx, oid, me, 'follow_status', null, 'to_prepare');
    // Delivery AI agent: "we received your order" (or "confirmed")
    await onOrderCreated(tx, { id: oid, phone, conf_status: conf, is_exchange: input.isExchange }, ctx.now());
    return getOrder(ctx, oid, tx);
  });
  ctx.emit({ type: 'orders' });
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
    const phone = input.phone !== undefined ? normalizePhone(input.phone) : cur.phone;
    if (!phone) throw bad('Numéro de téléphone algérien invalide');
    // a bureau delivery needs its bureau (stop desk); going back home forgets it
    if (input.isStopdesk === true && !(input.stopdeskId ?? (input.stopdeskId === undefined ? cur.stopdesk_id : null))) throw bad('Livraison au bureau : choisissez le bureau.');
    if (input.isStopdesk === false && input.stopdeskId === undefined) input = { ...input, stopdeskId: null };

    let subtotal = num(cur.subtotal);
    let maxDiscount = Infinity;
    // the products or the remise change: the upsell is worked out again
    const recount = !!input.items || input.discount !== undefined;
    const old = recount
      ? (await tx.query('SELECT id, product_id, variant_id, qty, unit_price, is_upsell FROM order_items WHERE order_id = $1 ORDER BY id', [input.id])).map((r: any) => ({ id: num(r.id), productId: num(r.product_id), variantId: numOrNull(r.variant_id), qty: num(r.qty), unitPrice: num(r.unit_price), isUpsell: !!r.is_upsell }))
      : [];
    let lines: OrderItem[] | null = null;
    if (input.items) {
      const priced = await priceItems(tx, input.items, !!cur.is_exchange);
      lines = priced.lines;
      subtotal = priced.subtotal;
      maxDiscount = priced.maxDiscount;
    } else if (input.discount !== undefined) {
      // only the discount changes: it is still capped by the products already in the order
      if (old.length) maxDiscount = (await priceItems(tx, old, true)).maxDiscount;
    }
    const discount = input.discount ?? num(cur.discount);
    if (discount > maxDiscount) throw bad(`Remise trop élevée (maximum ${maxDiscount} DA)`);
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
    await tx.query(
      `UPDATE orders SET customer_name=$2, phone=$3, phone2=$4, wilaya_id=$5, commune=$6, address=$7, is_stopdesk=$8, stopdesk_id=$9, company_id=$10,
         channel=$11, subtotal=$12, delivery_fee=$13, discount=$14, total=$15, customer_note=$16, delivery_note=$17, internal_note=$18,
         has_upsell = $19 > 0, upsell_value = $19, orig_items = COALESCE(orig_items, $20::jsonb),
         orig_discount = CASE WHEN orig_items IS NULL THEN $21 ELSE orig_discount END, updated_at=now(), version=version+1 WHERE id=$1`,
      [input.id, v('customerName', 'customer_name'), phone, input.phone2 !== undefined ? (input.phone2 ? normalizePhone(input.phone2) : null) : cur.phone2,
        v('wilayaId', 'wilaya_id'), v('commune', 'commune'), v('address', 'address'), v('isStopdesk', 'is_stopdesk'), v('stopdeskId', 'stopdesk_id'),
        v('companyId', 'company_id'), v('channel', 'channel'), subtotal, fee, discount, subtotal - discount + fee,
        v('customerNote', 'customer_note'), v('deliveryNote', 'delivery_note'), v('internalNote', 'internal_note'),
        up.value, JSON.stringify(orig), origDiscount],
    );
    await addEvent(tx, input.id, ctx.session.profile.id, 'edit', null, null);
    return getOrder(ctx, input.id, tx);
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

export async function setConf(ctx: Ctx, input: z.infer<typeof ConfInput>) {
  if (CONF_NEEDS_DATE.includes(input.status) && !input.nextCallAt) throw bad('Choisissez la date du prochain appel');
  if (CONF_NEEDS_REASON.includes(input.status) && !input.reason) throw bad('Indiquez la raison');
  const me = ctx.session.profile.id;
  const calls = await getSetting(ctx.db, 'calls');
  const changed: number[] = [];
  await ctx.db.tx(async (tx) => {
    if (await alreadyApplied(tx, input.clientId, me)) return;
    const notify = await notifyContext(tx);
    for (const oid of input.ids) {
      const cur = (await tx.query('SELECT id, conf_status, follow_status, attempts, agent_id, phone, is_exchange FROM orders WHERE id = $1 FOR UPDATE', [oid]))[0];
      if (!cur) continue;
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
      const confirmed = status === 'confirmed';
      const nowIso = new Date(ctx.now()).toISOString();
      await tx.query(
        `UPDATE orders SET conf_status=$2, attempts=$3,
           last_call_at = CASE WHEN $4 THEN $5::timestamptz ELSE last_call_at END,
           next_call_at = $6,
           agent_id = COALESCE(agent_id, $7), assigned_at = COALESCE(assigned_at, $5::timestamptz),
           confirmed_at = CASE WHEN $8 THEN COALESCE(confirmed_at, $5::timestamptz) ELSE confirmed_at END,
           follow_status = CASE WHEN $8 AND follow_status IS NULL THEN 'to_prepare'
                                WHEN $2 IN ('cancelled','duplicate','wrong_number','fake') AND follow_status IN ('to_prepare','prepared') THEN 'cancelled'
                                ELSE follow_status END,
           updated_at=now(), version=version+1
         WHERE id=$1`,
        [oid, status, attempts, isCallFail || confirmed || CONF_NEEDS_DATE.includes(status), nowIso, CONF_NEEDS_DATE.includes(status) ? input.nextCallAt : null, me, confirmed],
      );
      await addEvent(tx, oid, me, 'conf_status', cur.conf_status, status, [input.reason, note].filter(Boolean).join(' — ') || null);
      if (confirmed && !cur.follow_status) await addEvent(tx, oid, me, 'follow_status', null, 'to_prepare');
      await onConfChange(tx, notify, cur, cur.conf_status, status, ctx.now());
      changed.push(oid);
    }
  });
  await sendInPreview(ctx);
  ctx.emit({ type: 'orders' });
  return { changed };
}

export const FollowInput = z.object({
  ids,
  status: z.enum(FOLLOW_STATUSES),
  note: z.string().max(1000).nullable().optional(),
  reason: z.string().max(200).nullable().optional(),
  tracking: z.string().max(80).nullable().optional(),
  livreurId: id.nullable().optional(),
  subStatus: z.string().max(40).nullable().optional(),
  clientId: z.string().min(8).max(64).optional(),
});

const MILESTONE: Partial<Record<FollowStatus, string>> = { prepared: 'prepared_at', shipped: 'shipped_at', delivered: 'delivered_at', returned: 'returned_at' };

export async function setFollow(ctx: Ctx, input: z.infer<typeof FollowInput>) {
  if (!canSetFollow(ctx.session.roles, input.status)) throw forbidden('Vous ne pouvez pas mettre ce statut de livraison');
  const me = ctx.session.profile.id;
  const changed: number[] = [];
  await ctx.db.tx(async (tx) => {
    if (await alreadyApplied(tx, input.clientId, me)) return;
    const notify = await notifyContext(tx);
    for (const oid of input.ids) {
      const cur = (await tx.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [oid]))[0];
      if (!cur) continue;
      if (onlyOwnDeliveries(ctx) && num(cur.livreur_id) !== me) throw forbidden();
      if (!['confirmed', 'no_stock'].includes(cur.conf_status) && input.status !== 'cancelled') throw bad(`${cur.ref} n’est pas confirmée`);
      const from: FollowStatus | null = cur.follow_status;
      const to = input.status;
      const ms = MILESTONE[to];
      await tx.query(
        `UPDATE orders SET follow_status=$2, ${ms ? `${ms} = COALESCE(${ms}, now()),` : ''}
           tracking = COALESCE($3, tracking), livreur_id = COALESCE($4, livreur_id),
           sub_status = $5, follow_agent_id = CASE WHEN $6 THEN $7 ELSE follow_agent_id END,
           delivery_attempts = delivery_attempts + CASE WHEN $2 = 'failed' THEN 1 ELSE 0 END,
           updated_at=now(), version=version+1 WHERE id=$1`,
        [oid, to, input.tracking ?? null, input.livreurId ?? null, input.subStatus ?? null, ctx.session.roles.includes('suivi'), me],
      );
      // Stock leaves the depot when shipped and comes back when returned.
      const leaves = to === 'shipped' && !cur.shipped_at;
      const back = to === 'returned' && cur.shipped_at && !cur.returned_at;
      if ((leaves || back) && cur.warehouse_id) {
        const items = await tx.query('SELECT variant_id, qty FROM order_items WHERE order_id = $1 AND variant_id IS NOT NULL', [oid]);
        for (const it of items) {
          const d = (leaves ? -1 : 1) * num(it.qty);
          await tx.query(
            `INSERT INTO stock (variant_id, warehouse_id, qty) VALUES ($1,$2,$3)
             ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET qty = stock.qty + EXCLUDED.qty`,
            [it.variant_id, cur.warehouse_id, d],
          );
          await tx.query('INSERT INTO stock_movements (variant_id, warehouse_id, delta, reason, order_id, user_id) VALUES ($1,$2,$3,$4,$5,$6)', [
            it.variant_id, cur.warehouse_id, d, leaves ? 'shipped' : 'returned', oid, me,
          ]);
        }
      }
      if (to === 'delivered' && from !== 'delivered') await tx.query('UPDATE customers SET delivered = delivered + 1 WHERE id = $1', [cur.customer_id]);
      if (to === 'returned' && from !== 'returned') await tx.query('UPDATE customers SET returned = returned + 1 WHERE id = $1', [cur.customer_id]);
      await addEvent(tx, oid, me, 'follow_status', from, to, [input.reason, input.note].filter(Boolean).join(' — ') || null);
      // Delivery AI agent: shipped, with the livreur, at the desk, failed attempt, cancelled by the livreur, delivered
      await onFollowChange(tx, notify, cur, from, to, ctx.now());
      changed.push(oid);
    }
  });
  // SAV ticket parcels: delivered → ticket Livré, returned (scanned at the depot) → ticket Annulé
  if (['delivered', 'exchanged', 'returned'].includes(input.status) && (await settleTickets(ctx.db, me))) ctx.emit({ type: 'sav' });
  await sendInPreview(ctx);
  ctx.emit({ type: 'orders' });
  return { changed };
}

// ---------------------------------------------------------------- counts for the menu and tabs
export async function orderCounts(ctx: Ctx) {
  const own = onlyOwnDeliveries(ctx);
  const me = ctx.session.profile.id;
  const conf = await ctx.db.query<{ k: string; n: number }>(
    `SELECT conf_status AS k, count(*)::int AS n FROM sales ${own ? 'WHERE livreur_id = $1' : ''} GROUP BY 1`,
    own ? [me] : [],
  );
  const follow = await ctx.db.query<{ k: string; n: number }>(
    `SELECT follow_status AS k, count(*)::int AS n FROM sales WHERE follow_status IS NOT NULL ${own ? 'AND livreur_id = $1' : ''} GROUP BY 1`,
    own ? [me] : [],
  );
  const lateCalls = num(
    (await ctx.db.query(`SELECT count(*)::int AS n FROM sales WHERE conf_status = ANY($1) AND next_call_at IS NOT NULL AND next_call_at <= now()`, [CONF_TODO]))[0]?.n,
  );
  const sav = num((await ctx.db.query(`SELECT count(*)::int AS n FROM complaints WHERE status IN ('open','progress')`))[0]?.n);
  const uncashed = num((await ctx.db.query(`SELECT count(*)::int AS n FROM sales WHERE follow_status='delivered' AND NOT cashed`))[0]?.n);
  const subs = await ctx.db.query<{ k: string; n: number }>(`SELECT sub_status AS k, count(*)::int AS n FROM sales WHERE sub_status IS NOT NULL GROUP BY 1`);
  const lowStock = num((await ctx.db.query(`SELECT count(*)::int AS n FROM stock WHERE alert_qty > 0 AND qty <= alert_qty`))[0]?.n);
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
  return { conf: toObj(conf), follow: toObj(follow), sub: toObj(subs), lateCalls, sav, uncashed, tickets, lowStock, ai, all: num((await ctx.db.query('SELECT count(*)::int n FROM sales'))[0]?.n) };
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
async function companyRules(db: Db): Promise<{ fees: Map<string, CompanyRule>; over: Map<number, { freeKg: number; perKg: number; onReturn: boolean }> }> {
  const comps = await db.query('SELECT id, config FROM delivery_companies');
  const over = new Map<number, { freeKg: number; perKg: number; onReturn: boolean }>();
  for (const c of comps) {
    const cfg = typeof c.config === 'string' ? JSON.parse(c.config) : c.config ?? {};
    const w = cfg.overweight ?? cfg.weight ?? {};
    over.set(num(c.id), { freeKg: Number(w.freeKg ?? w.free_kg ?? 0) || 0, perKg: Number(w.perKg ?? w.per_kg ?? 0) || 0, onReturn: w.onReturn !== false && w.on_return !== false });
  }
  const fees = new Map<string, CompanyRule>();
  for (const f of await db.query('SELECT company_id, wilaya_id, home, desk, return_fee FROM delivery_fees')) {
    const o = over.get(num(f.company_id)) ?? { freeKg: 0, perKg: 0, onReturn: true };
    fees.set(`${num(f.company_id)}:${num(f.wilaya_id)}`, { home: num(f.home), desk: num(f.desk), ret: num(f.return_fee), ...o });
  }
  return { fees, over };
}
function parcelFees(o: any, R: Awaited<ReturnType<typeof companyRules>>) {
  if (!o.company_id) return { liv: 0, ret: 0, extra: 0, extraRet: 0, kg: Number(o.kg) || 0, fromTariff: false };
  const f = R.fees.get(`${num(o.company_id)}:${num(o.wilaya_id)}`);
  const rule = R.over.get(num(o.company_id)) ?? { freeKg: 0, perKg: 0, onReturn: true };
  const base = f ? (o.is_stopdesk ? f.desk : f.home) : null;
  const liv = base ?? (num(o.delivery_cost) || num(o.delivery_fee));
  const kg = Number(o.kg) || 0;
  const over = rule.perKg > 0 && kg > rule.freeKg ? Math.ceil(kg - rule.freeKg - 1e-9) : 0;
  const extra = over * rule.perKg;
  return { liv, ret: f?.ret ?? 0, extra, extraRet: rule.onReturn ? extra : 0, kg, fromTariff: base !== null };
}
const FEE_COLS = `o.id, o.ref, o.total, o.delivery_fee, o.delivery_cost, o.company_id, o.wilaya_id, o.is_stopdesk, o.cashed, co.name AS company, co.kind AS company_kind,
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

    /** Small lists used by the order screens: delivery companies (with kind) and the shop name / WhatsApp template. */
    'orders.lookups': proc(null, z.object({}), async (ctx) => {
      const companies = (await ctx.db.query('SELECT id, name, kind, active FROM delivery_companies ORDER BY name')).map((c: any) => ({ id: num(c.id), name: c.name as string, kind: c.kind as string, active: !!c.active }));
      const shop = await getSetting(ctx.db, 'shop');
      return { companies, shopName: shop.name, whatsappTemplate: shop.whatsappTemplate, defaultCompanyId: shop.defaultCompanyId ?? null };
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
      if (!ids.length) return {} as Record<string, { fee: number; extra: number; kg: number; fromTariff: boolean }>;
      const R = await companyRules(ctx.db);
      const rows = await ctx.db.query(`SELECT ${FEE_COLS} FROM orders o LEFT JOIN delivery_companies co ON co.id = o.company_id WHERE o.id = ANY($1)`, [ids]);
      const out: Record<string, { fee: number; extra: number; kg: number; fromTariff: boolean }> = {};
      for (const o of rows) {
        const x = parcelFees(o, R);
        out[String(num(o.id))] = { fee: o.company_id ? x.liv + x.extra : 0, extra: x.extra, kg: Math.round(x.kg * 10) / 10, fromTariff: x.fromTariff };
      }
      return out;
    }),

    /** "Bilan des livraisons": delivered in the period, cashed or not, courier fees, returns, net to receive — total and per company. */
    'orders.deliveredReport': proc(['suivi', 'depot'], z.object({ from: dateStr, to: dateStr }), (ctx, i) => deliveredReport(ctx, i)),
  };
}

/** "Bilan des livraisons": delivered in the period, cashed or not, courier fees, returns, net to receive — total and per company.
 * Orders and SAV ticket parcels are counted apart (`sales` / `ticket_parcels`). */
export async function deliveredReport(ctx: Ctx, i: { from: string; to: string }, view: 'sales' | 'ticket_parcels' = 'sales') {
  const R = await companyRules(ctx.db);
  const base = `FROM ${view} o LEFT JOIN delivery_companies co ON co.id = o.company_id`;
  const D = await ctx.db.query(`SELECT ${FEE_COLS} ${base} WHERE o.follow_status = 'delivered' AND o.delivered_at >= $1 AND o.delivered_at < $2`, [i.from, i.to]);
  const B = await ctx.db.query(
    `SELECT ${FEE_COLS} ${base} WHERE o.follow_status IN ('returning','returned') AND coalesce(o.returned_at, o.updated_at) >= $1 AND coalesce(o.returned_at, o.updated_at) < $2`,
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
    if (o.company_id && !(R.over.get(num(o.company_id))?.perKg)) noRule.add(o.company ?? '—');
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

// ---------------------------------------------------------------- the procedures
export const ordersProcs = {
  ...orderExtraProcs(),
  'orders.list': proc(null, ListInput, (ctx, f) => listOrders(ctx, f)),
  'orders.counts': proc(null, z.object({}), (ctx) => orderCounts(ctx)),
  'orders.get': proc(null, z.object({ id }), (ctx, { id }) => getOrder(ctx, id)),
  'orders.events': proc(null, z.object({ id }), async (ctx, { id }) => {
    await getOrder(ctx, id);
    const rows = await ctx.db.query(
      'SELECT e.*, p.name AS user_name FROM order_events e LEFT JOIN profiles p ON p.id = e.user_id WHERE e.order_id = $1 ORDER BY e.at, e.id',
      [id],
    );
    return rows.map(
      (r: any): OrderEvent => ({ id: num(r.id), orderId: num(r.order_id), at: iso(r.at), userId: numOrNull(r.user_id), userName: r.user_name, kind: r.kind, fromValue: r.from_value, toValue: r.to_value, note: r.note }),
    );
  }),
  // the upsell is always counted by Pilotix: a mark sent by a screen is not taken (only Dellal, inside, marks what it sold in addition)
  'orders.create': proc(['confirmation', 'suivi', 'depot'], OrderInput, async (ctx, i) => {
    const o = await createOrder(ctx, { ...i, items: i.items.map((x) => ({ ...x, isUpsell: false })) });
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
        const cur = (await tx.query('SELECT agent_id FROM orders WHERE id=$1', [oid]))[0];
        if (!cur) continue;
        if (!manager && cur.agent_id && num(cur.agent_id) !== ctx.session.profile.id) throw forbidden();
        await tx.query('UPDATE orders SET agent_id=$2, assigned_at = CASE WHEN $2::bigint IS NULL THEN NULL ELSE now() END, updated_at=now() WHERE id=$1', [oid, agentId]);
        await addEvent(tx, oid, ctx.session.profile.id, 'assign', cur.agent_id ? String(cur.agent_id) : null, agentId ? String(agentId) : null);
      }
    });
    ctx.emit({ type: 'orders' });
    return { ok: true };
  }),

  'orders.assignCompany': proc(['depot', 'suivi', 'confirmation'], z.object({ ids, companyId: id.nullable(), livreurId: id.nullable().optional() }), async (ctx, i) => {
    await ctx.db.tx(async (tx) => {
      for (const oid of i.ids) {
        const cur = (await tx.query('SELECT company_id, follow_status, tracking FROM orders WHERE id=$1', [oid]))[0];
        if (!cur) continue;
        if (cur.tracking && cur.company_id && num(cur.company_id) !== i.companyId) throw bad('Colis déjà envoyé à une société : annulez-le d’abord');
        await tx.query('UPDATE orders SET company_id=$2, livreur_id=$3, updated_at=now() WHERE id=$1', [oid, i.companyId, i.livreurId ?? null]);
        await addEvent(tx, oid, ctx.session.profile.id, 'company', cur.company_id ? String(cur.company_id) : null, i.companyId ? String(i.companyId) : null);
      }
    });
    ctx.emit({ type: 'orders' });
    return { ok: true };
  }),

  'orders.note': proc(null, z.object({ id, note: z.string().min(1).max(1000), field: z.enum(['event', 'internal', 'delivery', 'customer']).default('event') }), async (ctx, i) => {
    await getOrder(ctx, i.id);
    const col = { internal: 'internal_note', delivery: 'delivery_note', customer: 'customer_note', event: null }[i.field];
    if (col) await ctx.db.query(`UPDATE orders SET ${col} = $2, updated_at = now() WHERE id = $1`, [i.id, i.note]);
    await addEvent(ctx.db, i.id, ctx.session.profile.id, 'note', null, i.field, i.note);
    ctx.emit({ type: 'order', id: i.id });
    return { ok: true };
  }),

  'orders.logCall': proc(['confirmation', 'suivi', 'livreur'], z.object({ id }), async (ctx, { id }) => {
    await addEvent(ctx.db, id, ctx.session.profile.id, 'call', null, null);
    return { ok: true };
  }),

  'orders.setTracking': proc(['depot', 'suivi'], z.object({ id, tracking: z.string().max(80).nullable() }), async (ctx, i) => {
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
    const r = await ctx.db.query(
      `SELECT id FROM orders WHERE conf_status = ANY($1) AND (agent_id IS NULL OR agent_id = $2) AND NOT (id = ANY($3))
         AND (next_call_at IS NULL OR next_call_at <= now()) AND (locked_until IS NULL OR locked_until < now() OR locked_by = $2)
       ORDER BY (next_call_at IS NOT NULL) DESC, next_call_at ASC, created_at ASC LIMIT 1`,
      [CONF_TODO, me, skip],
    );
    if (!r[0]) return { id: null };
    await ctx.db.query(`UPDATE orders SET locked_by=$2, locked_until=now() + interval '10 minutes' WHERE id=$1`, [r[0].id, me]);
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
          if (a.kind === 'conf') await setConf(ctx, ConfInput.parse({ ids: [a.id], status: a.status, note: a.note, reason: a.reason, nextCallAt: a.nextCallAt, clientId: a.clientId }));
          else if (a.kind === 'follow') await setFollow(ctx, FollowInput.parse({ ids: [a.id], status: a.status, note: a.note, reason: a.reason, clientId: a.clientId }));
          else await addEvent(ctx.db, a.id, ctx.session.profile.id, 'note', null, 'event', a.note ?? '');
          results.push({ clientId: a.clientId, ok: true });
        } catch (e: any) {
          results.push({ clientId: a.clientId, ok: false, error: e?.message ?? 'Erreur' });
        }
      }
      return { results };
    },
  ),
};
