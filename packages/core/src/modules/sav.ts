// SAV (after-sales tickets): the customer got the order and comes back with a problem.
// A ticket is "En attente"; it is settled by an exchange (same item, other variant, other product, parts) or a refund.
// The exchange order goes straight to the depot ("À préparer"); the ticket becomes "Livré" by itself once delivered.
import { EXCHANGE_KINDS, SAV_STATUSES, SAV_TYPES, SAV_WISHES } from '@pilotix/shared';
import type { Order, Page } from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, isoOrNull, num, numOrNull, Where } from '../db';
import { bad, Ctx, notFound, proc } from '../rpc';
import { addEvent, createOrder, deliveredReport, getOrder } from './orders';
import { savFee } from '../settings';
import { settleTickets } from './tickets';

const id = z.number().int().positive();
const SAV_ROLES = ['confirmation', 'suivi', 'depot'] as const;

export const SAV_VIEWS = ['todo', 'all', 'attente', 'depot', 'livraison', 'livres', 'annules'] as const;
export type SavView = (typeof SAV_VIEWS)[number];

export interface SavNote {
  at: string;
  userId: number | null;
  userName?: string | null;
  text: string;
  status?: string | null;
}

export interface SavTicket {
  id: number;
  ref: string;
  orderId: number | null;
  orderRef: string | null;
  customerName: string | null;
  phone: string | null;
  type: (typeof SAV_TYPES)[number];
  wish: (typeof SAV_WISHES)[number] | null;
  details: string;
  status: (typeof SAV_STATUSES)[number];
  assignedTo: number | null;
  assignedName: string | null;
  exchangeOrderId: number | null;
  exchangeRef: string | null;
  exchangeFollow: string | null;
  exchangeKind: string | null;
  notes: SavNote[];
  createdBy: number | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

const SELECT = `SELECT c.*, o.ref AS order_ref, ex.ref AS exchange_ref, ex.follow_status AS exchange_follow, a.name AS assigned_name, cb.name AS created_by_name
  FROM complaints c
  LEFT JOIN orders o ON o.id = c.order_id
  LEFT JOIN orders ex ON ex.id = c.exchange_order_id
  LEFT JOIN profiles a ON a.id = c.assigned_to
  LEFT JOIN profiles cb ON cb.id = c.created_by`;

function toTicket(r: any): SavTicket {
  const notes = typeof r.notes === 'string' ? JSON.parse(r.notes) : r.notes ?? [];
  return {
    id: num(r.id),
    ref: r.ref,
    orderId: numOrNull(r.order_id),
    orderRef: r.order_ref ?? null,
    customerName: r.customer_name ?? null,
    phone: r.phone ?? null,
    type: r.type,
    wish: r.wish ?? null,
    details: r.details ?? '',
    status: r.status,
    assignedTo: numOrNull(r.assigned_to),
    assignedName: r.assigned_name ?? null,
    exchangeOrderId: numOrNull(r.exchange_order_id),
    exchangeRef: r.exchange_ref ?? null,
    exchangeFollow: r.exchange_follow ?? null,
    exchangeKind: r.exchange_kind ?? null,
    notes,
    createdBy: numOrNull(r.created_by),
    createdByName: r.created_by_name ?? null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    resolvedAt: isoOrNull(r.resolved_at),
  };
}

const ACTIVE = `c.status IN ('open','progress')`;
// a parcel coming back ("Retour en cours") always goes back to the depot, where it is scanned
const AT_DEPOT = `ex.follow_status IN ('to_prepare','prepared','returning')`;
const ON_ROAD = `ex.follow_status IN ('shipped','out_for_delivery','failed','alert','in_exchange')`;

const settleDelivered = (db: Db, userId: number | null) => settleTickets(db, userId);

function viewWhere(w: Where, v: SavView) {
  switch (v) {
    case 'todo':
      w.add(ACTIVE);
      break;
    case 'attente':
      w.add(`${ACTIVE} AND (ex.id IS NULL OR ex.follow_status IS NULL OR ex.follow_status = 'cancelled')`);
      break;
    case 'depot':
      w.add(`${ACTIVE} AND ${AT_DEPOT}`);
      break;
    case 'livraison':
      w.add(`${ACTIVE} AND ${ON_ROAD}`);
      break;
    case 'livres':
      w.add(`c.status = 'resolved'`);
      break;
    case 'annules':
      w.add(`c.status = 'closed'`);
      break;
    case 'all':
      break;
  }
}

const ListInput = z.object({
  view: z.enum(SAV_VIEWS).default('todo'),
  q: z.string().max(100).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(500).default(100),
});

async function listTickets(ctx: Ctx, f: z.infer<typeof ListInput>): Promise<Page<SavTicket> & { counts: { todo: number; all: number } }> {
  await settleDelivered(ctx.db, ctx.session.profile.id);
  const w = new Where();
  viewWhere(w, f.view);
  if (f.q?.trim()) {
    const q = f.q.trim();
    const digits = q.replace(/\D/g, '');
    if (digits.length >= 4 && digits.length === q.replace(/[\s+.-]/g, '').length) w.add(`(c.phone LIKE '%' || ? || '%' OR c.ref ILIKE '%' || ? || '%')`, digits.slice(-9), digits);
    else w.add(`(c.ref ILIKE '%' || ? || '%' OR upper(o.ref) = upper(?) OR c.customer_name ILIKE '%' || ? || '%' OR o.tracking = ? OR upper(o.own_tracking) = upper(?))`, q, q, q, q, q);
  }
  const from = `FROM complaints c LEFT JOIN orders o ON o.id = c.order_id LEFT JOIN orders ex ON ex.id = c.exchange_order_id`;
  const total = num((await ctx.db.query(`SELECT count(*)::int AS n ${from} ${w.sql}`, w.params))[0]?.n);
  const lim = w.p(f.pageSize);
  const off = w.p((f.page - 1) * f.pageSize);
  const order = f.view === 'livres' || f.view === 'annules' ? 'c.updated_at DESC' : 'c.created_at DESC';
  const rows = await ctx.db.query(`${SELECT} ${w.sql} ORDER BY ${order}, c.id DESC LIMIT ${lim} OFFSET ${off}`, w.params);
  const c = (await ctx.db.query(`SELECT count(*) FILTER (WHERE ${ACTIVE})::int AS todo, count(*)::int AS all FROM complaints c`))[0];
  return { rows: rows.map(toTicket), total, page: f.page, pageSize: f.pageSize, counts: { todo: num(c.todo), all: num(c.all) } };
}

export async function getTicket(db: Db, tid: number): Promise<SavTicket> {
  const r = (await db.query(`${SELECT} WHERE c.id = $1`, [tid]))[0];
  if (!r) throw notFound('Ticket introuvable');
  const t = toTicket(r);
  const uids = [...new Set(t.notes.map((n) => n.userId).filter((x): x is number => !!x))];
  if (uids.length) {
    const names = new Map((await db.query('SELECT id, name FROM profiles WHERE id = ANY($1)', [uids])).map((p: any) => [num(p.id), p.name as string]));
    t.notes = t.notes.map((n) => ({ ...n, userName: n.userId ? names.get(n.userId) ?? null : null }));
  }
  return t;
}

export async function savKpis(ctx: Ctx) {
  await settleDelivered(ctx.db, ctx.session.profile.id);
  const r = (
    await ctx.db.query(
      `SELECT
         count(*) FILTER (WHERE ${ACTIVE} AND (ex.id IS NULL OR ex.follow_status IS NULL OR ex.follow_status = 'cancelled'))::int AS attente,
         count(*) FILTER (WHERE ${ACTIVE} AND (ex.id IS NULL OR ex.follow_status IS NULL OR ex.follow_status = 'cancelled') AND c.created_at < now() - interval '48 hours')::int AS attente_late,
         count(*) FILTER (WHERE ${ACTIVE} AND ex.follow_status = 'returning')::int AS returning,
         count(*) FILTER (WHERE c.status = 'closed' AND ex.follow_status = 'returned')::int AS annules_retour,
         count(*) FILTER (WHERE ${ACTIVE} AND ${AT_DEPOT})::int AS depot,
         count(*) FILTER (WHERE ${ACTIVE} AND ${ON_ROAD})::int AS livraison,
         count(*) FILTER (WHERE ${ACTIVE} AND c.created_at < now() - interval '48 hours')::int AS late,
         count(*) FILTER (WHERE c.status = 'resolved' AND c.resolved_at >= now() - interval '7 days')::int AS livres7,
         avg(extract(epoch FROM (c.resolved_at - c.created_at))) FILTER (WHERE c.status = 'resolved' AND c.resolved_at >= now() - interval '7 days') AS avg_s,
         count(*) FILTER (WHERE c.status = 'closed')::int AS annules,
         count(*) FILTER (WHERE c.status = 'resolved')::int AS livres
       FROM complaints c LEFT JOIN orders ex ON ex.id = c.exchange_order_id`,
    )
  )[0];
  return {
    attente: num(r.attente),
    depot: num(r.depot),
    livraison: num(r.livraison),
    late: num(r.late),
    attenteLate: num(r.attente_late),
    returning: num(r.returning),
    annulesRetour: num(r.annules_retour),
    livres7: num(r.livres7),
    avgMs: r.avg_s === null || r.avg_s === undefined ? null : Math.round(Number(r.avg_s) * 1000),
    livres: num(r.livres),
    annules: num(r.annules),
  };
}

const SAV_STATUS_FR: Record<string, string> = { open: 'En attente', progress: 'En traitement', resolved: 'Livré', closed: 'Annulé' };
const KIND_FR: Record<string, string> = { same: 'Même article (neuf)', variant: 'Autre couleur / taille', other_product: 'Autre produit', parts: 'Pièces seulement' };

async function pushNote(db: Db, tid: number, note: SavNote) {
  const cur = (await db.query('SELECT notes FROM complaints WHERE id = $1', [tid]))[0];
  const notes = (typeof cur?.notes === 'string' ? JSON.parse(cur.notes) : cur?.notes) ?? [];
  notes.push(note);
  await db.query('UPDATE complaints SET notes = $2, updated_at = now() WHERE id = $1', [tid, JSON.stringify(notes)]);
}

const CreateInput = z.object({
  orderId: id.nullable().optional(),
  customerName: z.string().trim().max(120).nullable().optional(),
  phone: z.string().trim().max(20).nullable().optional(),
  type: z.enum(SAV_TYPES),
  wish: z.enum(SAV_WISHES).nullable().optional(),
  details: z.string().max(2000).default(''),
  assignedTo: id.nullable().optional(),
});

const UpdateInput = z.object({
  id,
  status: z.enum(SAV_STATUSES).optional(),
  assignedTo: id.nullable().optional(),
  wish: z.enum(SAV_WISHES).nullable().optional(),
  note: z.string().max(2000).optional(),
});

const ExchangeInput = z.object({
  id,
  kind: z.enum(EXCHANGE_KINDS),
  /** the lines of the original order concerned (item ids) with the quantity to exchange */
  lines: z
    .array(
      z.object({
        itemId: id,
        qty: z.number().int().min(1).max(999),
        /** new variant (variant / other_product kinds) */
        variantId: id.nullable().optional(),
        /** new product (other_product kind) */
        productId: id.nullable().optional(),
      }),
    )
    .min(1)
    .max(50),
  /** parts to send (parts kind): names from the product's parts list */
  parts: z.array(z.object({ name: z.string().min(1).max(120), qty: z.number().int().min(1).max(99) })).max(30).default([]),
  /** delivery paid by the customer */
  deliveryFee: z.number().int().min(0).max(100_000).default(0),
  note: z.string().max(1000).nullable().optional(),
});

export async function createExchange(ctx: Ctx, input: z.infer<typeof ExchangeInput>) {
  const t = await getTicket(ctx.db, input.id);
  if (!t.orderId) throw bad('Ce ticket n’est lié à aucune commande');
  if (t.status === 'resolved' || t.status === 'closed') throw bad('Ticket déjà clôturé');
  if (t.exchangeOrderId && t.exchangeFollow !== 'cancelled') throw bad(`Un échange existe déjà : ${t.exchangeRef}`);
  const o: Order = await getOrder(ctx, t.orderId);
  const me = ctx.session.profile.id;
  const byId = new Map(o.items.map((i) => [i.id, i]));
  const items: { productId: number; variantId: number | null; qty: number; unitPrice: number }[] = [];
  for (const l of input.lines) {
    const it = byId.get(l.itemId);
    if (!it) throw bad('Ligne introuvable dans la commande d’origine');
    if (l.qty > it.qty) throw bad(`Quantité trop élevée pour ${it.name}`);
    if (input.kind === 'same') {
      items.push({ productId: it.productId, variantId: it.variantId, qty: l.qty, unitPrice: 0 });
    } else if (input.kind === 'parts') {
      // only parts leave: no variant, so the article's stock does not move
      items.push({ productId: it.productId, variantId: null, qty: 1, unitPrice: 0 });
    } else {
      const vid = l.variantId ?? null;
      let pid = input.kind === 'variant' ? it.productId : l.productId ?? null;
      if (vid) {
        const v = (await ctx.db.query('SELECT product_id FROM product_variants WHERE id = $1', [vid]))[0];
        if (!v) throw bad('Variante inconnue');
        if (input.kind === 'variant' && num(v.product_id) !== it.productId) throw bad('Choisissez une variante du même produit');
        pid = num(v.product_id);
      }
      if (!pid) throw bad('Choisissez le nouveau produit');
      if (input.kind === 'variant' && (!vid || vid === it.variantId)) throw bad('Choisissez une autre couleur / taille');
      const p = (await ctx.db.query('SELECT p.price, v.price AS vprice FROM products p LEFT JOIN product_variants v ON v.id = $2 WHERE p.id = $1', [pid, vid]))[0];
      if (!p) throw bad('Produit inconnu');
      const price = num(p.vprice ?? p.price);
      // the customer only pays the difference when the new item costs more
      items.push({ productId: pid, variantId: vid, qty: l.qty, unitPrice: Math.max(0, price - it.unitPrice) });
    }
  }
  if (input.kind === 'parts' && !input.parts.length) throw bad('Choisissez les pièces à envoyer');
  const partsText = input.parts.map((p) => `${p.qty} × ${p.name}`).join(', ');
  const kindText = KIND_FR[input.kind];
  const nowIso = new Date(ctx.now()).toISOString();

  const res = await ctx.db.tx(async (tx) => {
    const ex = await createOrder(
      ctx,
      {
        customerName: o.customerName,
        phone: o.phone,
        phone2: o.phone2,
        wilayaId: o.wilayaId,
        commune: o.commune,
        address: o.address,
        isStopdesk: o.isStopdesk,
        stopdeskId: o.stopdeskId,
        companyId: o.companyId,
        channel: o.channel,
        source: 'sav',
        items,
        deliveryFee: input.deliveryFee,
        discount: 0,
        customerNote: o.customerNote,
        deliveryNote: [input.kind === 'parts' ? `Pièces : ${partsText} (l’article reste chez le client)` : 'Échange : reprendre l’ancien article', input.note].filter(Boolean).join(' · '),
        internalNote: `SAV ${t.ref} — ${kindText}${partsText ? ` : ${partsText}` : ''}`,
        confirm: false,
        isExchange: true,
        originalOrderId: o.id,
      },
      tx,
    );
    // SAV exchanges skip the call queue: straight to the depot, "À préparer".
    await tx.query(
      `UPDATE orders SET conf_status='confirmed', confirmed_at=$2::timestamptz, agent_id=COALESCE(agent_id,$3), assigned_at=COALESCE(assigned_at,$2::timestamptz),
         follow_status='to_prepare', updated_at=now() WHERE id=$1`,
      [ex.id, nowIso, me],
    );
    await addEvent(tx, ex.id, me, 'conf_status', ex.confStatus, 'confirmed', `SAV ${t.ref} — ${kindText.toLowerCase()} envoyé au dépôt`);
    await addEvent(tx, ex.id, me, 'follow_status', null, 'to_prepare', `SAV ${t.ref}`);
    await addEvent(tx, o.id, me, 'note', null, 'event', `Échange ${ex.ref} créé (SAV ${t.ref} — ${kindText})`);
    await tx.query(`UPDATE complaints SET exchange_order_id=$2, exchange_kind=$3, status='progress', wish=COALESCE(wish, 'exchange'), updated_at=now() WHERE id=$1`, [t.id, ex.id, input.kind]);
    await pushNote(tx, t.id, { at: nowIso, userId: me, text: `${kindText} ${ex.ref} créé → Dépôt « À préparer »`, status: 'progress' });
    return ex.id;
  });
  ctx.emit({ type: 'sav', id: t.id });
  ctx.emit({ type: 'orders' });
  return { ticket: await getTicket(ctx.db, t.id), order: await getOrder(ctx, res) };
}

/** Orders by partial ref (PX12…), partial phone, tracking or name — newest first. */
export async function findOrders(ctx: Ctx, q: string, limit = 8, extra?: (w: Where) => void): Promise<Order[]> {
  const w = new Where();
  const digits = q.replace(/\D/g, '');
  if (digits.length >= 4 && digits.length === q.replace(/[\s+.-]/g, '').length) w.add(`(o.phone LIKE '%' || ? || '%' OR o.phone2 LIKE '%' || ? || '%' OR o.tracking ILIKE '%' || ? || '%')`, digits.slice(-9), digits.slice(-9), digits);
  else w.add(`(upper(o.ref) LIKE upper(?) || '%' OR o.tracking ILIKE ? || '%' OR o.customer_name ILIKE '%' || ? || '%')`, q.trim(), q.trim(), q.trim());
  extra?.(w);
  const rows = await ctx.db.query(`SELECT o.id FROM sales o ${w.sql} ORDER BY o.created_at DESC LIMIT ${w.p(limit)}`, w.params);
  const out: Order[] = [];
  for (const r of rows) out.push(await getOrder(ctx, num(r.id)));
  return out;
}


const dateStr = z.string().min(10).max(40);

/** SAV statistics, apart from orders: tickets (created, delivered, cancelled), their parcels (delivery rate, returns) and their money. */
export async function savStats(ctx: Ctx, from: string, to: string) {
  await settleDelivered(ctx.db, ctx.session.profile.id);
  const t = (
    await ctx.db.query(
      `SELECT count(*) FILTER (WHERE c.created_at >= $1 AND c.created_at < $2)::int AS created,
              count(*) FILTER (WHERE c.status = 'resolved' AND c.resolved_at >= $1 AND c.resolved_at < $2)::int AS delivered,
              count(*) FILTER (WHERE c.status = 'closed' AND COALESCE(c.resolved_at, c.updated_at) >= $1 AND COALESCE(c.resolved_at, c.updated_at) < $2)::int AS cancelled,
              count(*) FILTER (WHERE ${ACTIVE})::int AS open,
              avg(extract(epoch FROM (c.resolved_at - c.created_at))) FILTER (WHERE c.status = 'resolved' AND c.resolved_at >= $1 AND c.resolved_at < $2) AS avg_s
       FROM complaints c`,
      [from, to],
    )
  )[0];
  const byType = await ctx.db.query(`SELECT type AS k, count(*)::int AS n FROM complaints WHERE created_at >= $1 AND created_at < $2 GROUP BY 1 ORDER BY 2 DESC`, [from, to]);
  const byKind = await ctx.db.query(
    `SELECT COALESCE(c.exchange_kind, 'none') AS k, count(*)::int AS n FROM complaints c WHERE c.created_at >= $1 AND c.created_at < $2 GROUP BY 1 ORDER BY 2 DESC`,
    [from, to],
  );
  const p = (
    await ctx.db.query(
      `SELECT count(*) FILTER (WHERE shipped_at >= $1 AND shipped_at < $2)::int AS shipped,
              count(*) FILTER (WHERE follow_status = 'delivered' AND delivered_at >= $1 AND delivered_at < $2)::int AS delivered,
              count(*) FILTER (WHERE follow_status IN ('returning','returned') AND COALESCE(returned_at, updated_at) >= $1 AND COALESCE(returned_at, updated_at) < $2)::int AS returned,
              count(*) FILTER (WHERE follow_status = 'cancelled' AND updated_at >= $1 AND updated_at < $2)::int AS cancelled,
              count(*) FILTER (WHERE follow_status IN ('to_prepare','prepared'))::int AS at_depot,
              count(*) FILTER (WHERE follow_status IN ('shipped','out_for_delivery','failed','alert','in_exchange'))::int AS on_road,
              COALESCE(sum(delivery_fee) FILTER (WHERE follow_status = 'delivered' AND delivered_at >= $1 AND delivered_at < $2), 0)::bigint AS fees_paid,
              COALESCE(sum(subtotal) FILTER (WHERE follow_status = 'delivered' AND delivered_at >= $1 AND delivered_at < $2), 0)::bigint AS diff_paid,
              count(*) FILTER (WHERE follow_status = 'delivered' AND delivered_at >= $1 AND delivered_at < $2 AND total = 0)::int AS free
       FROM ticket_parcels`,
      [from, to],
    )
  )[0];
  const money = await deliveredReport(ctx, { from, to }, 'ticket_parcels');
  const delivered = num(p.delivered);
  const returned = num(p.returned);
  return {
    tickets: {
      created: num(t.created),
      delivered: num(t.delivered),
      cancelled: num(t.cancelled),
      open: num(t.open),
      avgMs: t.avg_s === null || t.avg_s === undefined ? null : Math.round(Number(t.avg_s) * 1000),
    },
    byType: byType.map((r: any) => ({ key: r.k as string, n: num(r.n) })),
    byKind: byKind.map((r: any) => ({ key: r.k as string, n: num(r.n) })),
    parcels: {
      shipped: num(p.shipped),
      delivered,
      returned,
      cancelled: num(p.cancelled),
      atDepot: num(p.at_depot),
      onRoad: num(p.on_road),
      deliveryRate: delivered + returned ? delivered / (delivered + returned) : null,
      free: num(p.free),
    },
    money: {
      collected: money.total.amount,
      feesPaid: num(p.fees_paid),
      diffPaid: num(p.diff_paid),
      courierFees: money.total.fees + money.total.overweight,
      returnFees: money.total.returnFees + money.total.returnOverweight,
      cashed: money.total.cashed,
      uncashed: money.total.uncashed,
      netToReceive: money.total.netToReceive,
      result: money.total.amount - (money.total.fees + money.total.overweight) - (money.total.returnFees + money.total.returnOverweight),
    },
    companies: money.companies.map((c) => ({ companyId: c.companyId, name: c.name, delivered: c.n, returns: c.returns, amount: c.amount, fees: c.fees + c.overweight + c.returnFees + c.returnOverweight })),
  };
}

export const savProcs = {
  'sav.list': proc([...SAV_ROLES], ListInput, (ctx, f) => listTickets(ctx, f)),
  'sav.kpis': proc([...SAV_ROLES], z.object({}), (ctx) => savKpis(ctx)),
  'sav.stats': proc([...SAV_ROLES, 'agent_manager', 'vendeur'], z.object({ from: dateStr, to: dateStr }), (ctx, i) => savStats(ctx, i.from, i.to)),

  'sav.get': proc([...SAV_ROLES], z.object({ id }), async (ctx, { id }) => {
    const t = await getTicket(ctx.db, id);
    const order = t.orderId ? await getOrder(ctx, t.orderId) : null;
    const exchange = t.exchangeOrderId ? await getOrder(ctx, t.exchangeOrderId) : null;
    // what the exchange form needs: variants of the products in the order, product parts
    const pids = order ? [...new Set(order.items.map((i) => i.productId))] : [];
    const parts = pids.length ? await ctx.db.query('SELECT id, parts FROM products WHERE id = ANY($1)', [pids]) : [];
    return {
      ticket: t,
      order,
      exchange,
      /** SAV tariff for the customer's wilaya (pre-filled on the exchange, editable) */
      suggestedFee: order ? (await savFee(ctx.db, order.wilayaId, order.isStopdesk)) ?? 0 : 0,
      parts: Object.fromEntries(parts.map((p: any) => [num(p.id), ((typeof p.parts === 'string' ? JSON.parse(p.parts) : p.parts) ?? []) as { name: string; max?: number }[]])),
    };
  }),

  /** Products and variants to pick a replacement from. */
  'sav.catalog': proc([...SAV_ROLES], z.object({}), async (ctx) => {
    const rows = await ctx.db.query(
      `SELECT v.id AS variant_id, v.title, p.id AS product_id, p.name, COALESCE(v.price, p.price) AS price FROM product_variants v JOIN products p ON p.id = v.product_id
       WHERE p.active AND v.active AND NOT p.is_service ORDER BY p.name, v.id`,
    );
    return rows.map((r: any) => ({ variantId: num(r.variant_id), productId: num(r.product_id), name: r.name as string, title: r.title as string, price: num(r.price) }));
  }),

  'sav.create': proc([...SAV_ROLES], CreateInput, async (ctx, i) => {
    const me = ctx.session.profile.id;
    let name = i.customerName ?? null;
    let phone = i.phone ?? null;
    if (i.orderId) {
      const o = await getOrder(ctx, i.orderId);
      name = o.customerName;
      phone = o.phone;
    } else if (!name && !phone) throw bad('Choisissez la commande, ou indiquez le nom ou le téléphone du client');
    const nowIso = new Date(ctx.now()).toISOString();
    const notes: SavNote[] = [{ at: nowIso, userId: me, text: 'Ticket créé', status: 'open' }];
    if (i.assignedTo) {
      const a = (await ctx.db.query('SELECT name FROM profiles WHERE id=$1', [i.assignedTo]))[0];
      if (!a) throw bad('Responsable introuvable');
      notes.push({ at: nowIso, userId: me, text: `Confié à ${a.name}` });
    }
    const tid = await ctx.db.tx(async (tx) => {
      const r = (
        await tx.query(
          `INSERT INTO complaints (ref, order_id, customer_name, phone, type, wish, details, status, assigned_to, created_by, notes, created_at, updated_at)
           VALUES ('SAV-' || lpad(nextval('complaint_ref_seq')::text, 4, '0'),$1,$2,$3,$4,$5,$6,'open',$7,$8,$9,$10,$10) RETURNING id, ref`,
          [i.orderId ?? null, name, phone, i.type, i.wish ?? null, i.details, i.assignedTo ?? null, me, JSON.stringify(notes), nowIso],
        )
      )[0];
      if (i.orderId) await addEvent(tx, i.orderId, me, 'note', null, 'event', `Ticket SAV ${r.ref} : ${i.details}`.slice(0, 200));
      return num(r.id);
    });
    ctx.emit({ type: 'sav', id: tid });
    return getTicket(ctx.db, tid);
  }),

  'sav.update': proc([...SAV_ROLES], UpdateInput, async (ctx, i) => {
    const t = await getTicket(ctx.db, i.id);
    const me = ctx.session.profile.id;
    const parts: string[] = [];
    if (i.status && i.status !== t.status) parts.push(`Statut : ${SAV_STATUS_FR[i.status]}`);
    if (i.assignedTo !== undefined && (i.assignedTo ?? null) !== t.assignedTo) {
      const a = i.assignedTo ? (await ctx.db.query('SELECT name FROM profiles WHERE id=$1', [i.assignedTo]))[0] : null;
      if (i.assignedTo && !a) throw bad('Responsable introuvable');
      parts.push(`Confié à ${a ? a.name : 'personne'}`);
    }
    if (i.wish !== undefined && (i.wish ?? null) !== t.wish) parts.push('Souhait du client modifié');
    if (i.note?.trim()) parts.push(i.note.trim());
    if (!parts.length) return t;
    await ctx.db.tx(async (tx) => {
      await tx.query(
        `UPDATE complaints SET status=$2, assigned_to=$3, wish=$4,
           resolved_at = CASE WHEN $2 IN ('resolved','closed') THEN COALESCE(resolved_at, now()) ELSE NULL END, updated_at=now() WHERE id=$1`,
        [i.id, i.status ?? t.status, i.assignedTo !== undefined ? i.assignedTo : t.assignedTo, i.wish !== undefined ? i.wish : t.wish],
      );
      await pushNote(tx, i.id, { at: new Date(ctx.now()).toISOString(), userId: me, text: parts.join(' · '), status: i.status ?? null });
    });
    ctx.emit({ type: 'sav', id: i.id });
    return getTicket(ctx.db, i.id);
  }),

  'sav.exchange': proc([...SAV_ROLES], ExchangeInput, (ctx, i) => createExchange(ctx, i)),

  /** Find the order of a new ticket (any status). */
  'sav.findOrder': proc([...SAV_ROLES], z.object({ q: z.string().min(2).max(100) }), (ctx, { q }) => findOrders(ctx, q)),
};
