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

export const SAV_VIEWS = ['todo', 'all', 'attente', 'depot', 'livraison', 'livres', 'annules', 'satisfaction', 'termines'] as const;
/** How the customer felt: 1 Pas content · 2 Moyen · 3 Content · 4 Très content (1 and 2 come with the reason). */
export const SAV_SETTLE = ['explain', 'gesture', 'changed', 'other'] as const;
const SETTLE_FR: Record<string, string> = { explain: 'Explication / conseil', gesture: 'Geste commercial', changed: 'Le client a changé d’avis', other: 'Autre' };
const SAT_FR = ['', 'Pas content', 'Moyen', 'Content', 'Très content'];
/** after this many calls without an answer, the ticket stops asking */
export const SAT_MAX_TRIES = 3;
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
  /** 'phone': settled during the call, no parcel */
  resolution: string | null;
  settleReason: string | null;
  satisfaction: number | null;
  satisfactionNote: string | null;
  satisfactionAt: string | null;
  satTries: number;
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
    resolution: r.resolution ?? null,
    settleReason: r.settle_reason ?? null,
    satisfaction: numOrNull(r.satisfaction),
    satisfactionNote: r.satisfaction_note ?? null,
    satisfactionAt: isoOrNull(r.satisfaction_at),
    satTries: num(r.sat_tries ?? 0),
  };
}

const ACTIVE = `c.status IN ('open','progress')`;
// a parcel coming back ("Retour en cours") always goes back to the depot, where it is scanned
const AT_DEPOT = `ex.follow_status IN ('to_prepare','prepared','returning')`;
const ON_ROAD = `ex.follow_status IN ('shipped','out_for_delivery','failed','alert','in_exchange')`;

// delivered tickets whose customer has not been asked yet how it went
// (tickets finished more than 30 days ago are not asked any more)
const SAT_WAIT = `c.status = 'resolved' AND c.satisfaction IS NULL AND c.sat_tries < ${SAT_MAX_TRIES} AND c.resolved_at >= now() - interval '30 days'`;
const DONE = `(c.status = 'closed' OR (c.status = 'resolved' AND NOT (${SAT_WAIT})))`;

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
    case 'satisfaction':
      w.add(SAT_WAIT);
      break;
    case 'termines':
      w.add(DONE);
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
  /** me: the tickets I am responsible for · none: nobody's yet */
  owner: z.enum(['all', 'me', 'none']).default('all'),
});

async function listTickets(ctx: Ctx, f: z.infer<typeof ListInput>): Promise<Page<SavTicket> & { counts: { todo: number; all: number; mine: number; nobody: number; view: number } }> {
  await settleDelivered(ctx.db, ctx.session.profile.id);
  const me = ctx.session.profile.id;
  const w = new Where();
  viewWhere(w, f.view);
  if (f.q?.trim()) {
    const q = f.q.trim();
    const digits = q.replace(/\D/g, '');
    if (digits.length >= 4 && digits.length === q.replace(/[\s+.-]/g, '').length) w.add(`(c.phone LIKE '%' || ? || '%' OR c.ref ILIKE '%' || ? || '%')`, digits.slice(-9), digits);
    else w.add(`(c.ref ILIKE '%' || ? || '%' OR upper(o.ref) = upper(?) OR c.customer_name ILIKE '%' || ? || '%' OR o.tracking = ? OR upper(o.own_tracking) = upper(?))`, q, q, q, q, q);
  }
  const from = `FROM complaints c LEFT JOIN orders o ON o.id = c.order_id LEFT JOIN orders ex ON ex.id = c.exchange_order_id`;
  // Moi / Personne / Tous, counted on the same view and search
  const oc = (await ctx.db.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE c.assigned_to = ${Number(me)})::int AS mine, count(*) FILTER (WHERE c.assigned_to IS NULL)::int AS nobody ${from} ${w.sql}`, w.params))[0];
  if (f.owner === 'me') w.add('c.assigned_to = ?', me);
  if (f.owner === 'none') w.add('c.assigned_to IS NULL');
  const total = num((await ctx.db.query(`SELECT count(*)::int AS n ${from} ${w.sql}`, w.params))[0]?.n);
  const lim = w.p(f.pageSize);
  const off = w.p((f.page - 1) * f.pageSize);
  const order = f.view === 'livres' || f.view === 'annules' || f.view === 'termines' ? 'c.updated_at DESC' : f.view === 'satisfaction' ? 'c.resolved_at ASC NULLS LAST' : 'c.created_at DESC';
  const rows = await ctx.db.query(`${SELECT} ${w.sql} ORDER BY ${order}, c.id DESC LIMIT ${lim} OFFSET ${off}`, w.params);
  const c = (await ctx.db.query(`SELECT count(*) FILTER (WHERE ${ACTIVE})::int AS todo, count(*)::int AS all FROM complaints c`))[0];
  return { rows: rows.map(toTicket), total, page: f.page, pageSize: f.pageSize, counts: { todo: num(c.todo), all: num(c.all), mine: num(oc.mine), nobody: num(oc.nobody), view: num(oc.n) } };
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
         count(*) FILTER (WHERE c.status = 'resolved')::int AS livres,
         count(*) FILTER (WHERE ${SAT_WAIT})::int AS satisfaction,
         count(*) FILTER (WHERE ${DONE})::int AS termines
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
    satisfaction: num(r.satisfaction),
    termines: num(r.termines),
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
  /** settled during the call: no parcel, the ticket is born finished */
  settle: z
    .object({ reason: z.enum(SAV_SETTLE), note: z.string().trim().max(1000).default(''), satisfaction: z.number().int().min(1).max(4), satisfactionNote: z.string().trim().max(1000).default('') })
    .optional(),
});

const SatInput = z.object({ satisfaction: z.number().int().min(1).max(4), satisfactionNote: z.string().trim().max(1000).default('') });
/** Pas content / Moyen: the reason is required */
function checkSat(s: { satisfaction: number; satisfactionNote: string }) {
  if (s.satisfaction <= 2 && !s.satisfactionNote.trim()) throw bad('Client pas satisfait : écrivez pourquoi');
}
const satText = (s: { satisfaction: number; satisfactionNote: string }) => `Satisfaction : ${SAT_FR[s.satisfaction]}${s.satisfactionNote.trim() ? ` — ${s.satisfactionNote.trim()}` : ''}`;

/** "Réglé au téléphone" on an open ticket. */
async function settleTicket(ctx: Ctx, tx: Db, tid: number, s: { reason: string; note: string; satisfaction: number; satisfactionNote: string }) {
  const me = ctx.session.profile.id;
  const nowIso = new Date(ctx.now()).toISOString();
  await tx.query(
    `UPDATE complaints SET status='resolved', resolution='phone', settle_reason=$2, resolved_at=$3::timestamptz,
       satisfaction=$4, satisfaction_note=NULLIF($5,''), satisfaction_at=$3::timestamptz, satisfaction_by=$6, updated_at=now() WHERE id=$1`,
    [tid, s.reason, nowIso, s.satisfaction, s.satisfactionNote.trim(), me],
  );
  await pushNote(tx, tid, { at: nowIso, userId: me, text: `Réglé au téléphone (${SETTLE_FR[s.reason]})${s.note.trim() ? ` : ${s.note.trim()}` : ''} · ${satText(s)}`, status: 'resolved' });
}

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
export async function findOrders(ctx: Ctx, q: string, limit = 8, extra?: (w: Where) => void, orderBy = 'o.created_at DESC'): Promise<Order[]> {
  const w = new Where();
  const digits = q.replace(/\D/g, '');
  if (digits.length >= 4 && digits.length === q.replace(/[\s+.-]/g, '').length) w.add(`(o.phone LIKE '%' || ? || '%' OR o.phone2 LIKE '%' || ? || '%' OR o.tracking ILIKE '%' || ? || '%')`, digits.slice(-9), digits.slice(-9), digits);
  else w.add(`(upper(o.ref) LIKE upper(?) || '%' OR o.tracking ILIKE ? || '%' OR o.customer_name ILIKE '%' || ? || '%')`, q.trim(), q.trim(), q.trim());
  extra?.(w);
  const rows = await ctx.db.query(`SELECT o.id FROM sales o ${w.sql} ORDER BY ${orderBy} LIMIT ${w.p(limit)}`, w.params);
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
  // satisfaction: what the customers answered in the period, before (same length) to compare, by agent, by ending
  const span = Date.parse(to) - Date.parse(from);
  const prevFrom = new Date(Date.parse(from) - span).toISOString();
  const sat = (
    await ctx.db.query(
      `SELECT count(*) FILTER (WHERE satisfaction = 1)::int AS s1, count(*) FILTER (WHERE satisfaction = 2)::int AS s2,
              count(*) FILTER (WHERE satisfaction = 3)::int AS s3, count(*) FILTER (WHERE satisfaction = 4)::int AS s4
       FROM complaints WHERE satisfaction IS NOT NULL AND satisfaction_at >= $1 AND satisfaction_at < $2`,
      [from, to],
    )
  )[0];
  const prev = (await ctx.db.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE satisfaction >= 3)::int AS ok FROM complaints WHERE satisfaction IS NOT NULL AND satisfaction_at >= $1 AND satisfaction_at < $2`, [prevFrom, from]))[0];
  const satAgents = await ctx.db.query(
    `SELECT p.id, p.name, count(*)::int AS n, count(*) FILTER (WHERE c.satisfaction >= 3)::int AS ok FROM complaints c
     JOIN profiles p ON p.id = COALESCE(c.assigned_to, c.created_by)
     WHERE c.satisfaction IS NOT NULL AND c.satisfaction_at >= $1 AND c.satisfaction_at < $2 GROUP BY p.id, p.name ORDER BY n DESC LIMIT 20`,
    [from, to],
  );
  const satEnd = await ctx.db.query(
    `SELECT CASE WHEN resolution = 'phone' THEN 'phone' ELSE 'exchange' END AS k, count(*)::int AS n, count(*) FILTER (WHERE satisfaction >= 3)::int AS ok
     FROM complaints WHERE satisfaction IS NOT NULL AND satisfaction_at >= $1 AND satisfaction_at < $2 GROUP BY 1`,
    [from, to],
  );
  const satReasons = await ctx.db.query(
    `SELECT c.ref, c.satisfaction, c.satisfaction_note, c.satisfaction_at, c.customer_name FROM complaints c
     WHERE c.satisfaction <= 2 AND c.satisfaction_at >= $1 AND c.satisfaction_at < $2 ORDER BY c.satisfaction_at DESC LIMIT 10`,
    [from, to],
  );
  const satN = num(sat.s1) + num(sat.s2) + num(sat.s3) + num(sat.s4);
  const prevN = num(prev.n);
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
    satisfaction: {
      n: satN,
      counts: [num(sat.s1), num(sat.s2), num(sat.s3), num(sat.s4)],
      rate: satN ? (num(sat.s3) + num(sat.s4)) / satN : null,
      prevRate: prevN ? num(prev.ok) / prevN : null,
      agents: satAgents.map((r: any) => ({ id: num(r.id), name: r.name as string, n: num(r.n), rate: num(r.n) ? num(r.ok) / num(r.n) : 0 })),
      ends: satEnd.map((r: any) => ({ key: r.k as string, n: num(r.n), rate: num(r.n) ? num(r.ok) / num(r.n) : 0 })),
      unhappy: satReasons.map((r: any) => ({ ref: r.ref as string, satisfaction: num(r.satisfaction), note: (r.satisfaction_note as string) ?? '', at: iso(r.satisfaction_at), customerName: (r.customer_name as string) ?? '' })),
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
    if (i.settle) checkSat(i.settle);
    const nowIso = new Date(ctx.now()).toISOString();
    const notes: SavNote[] = [{ at: nowIso, userId: me, text: i.details.trim() ? `Ticket créé : ${i.details.trim()}` : 'Ticket créé', status: 'open' }];
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
      if (i.settle) await settleTicket(ctx, tx, num(r.id), i.settle);
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

  /** "Réglé au téléphone": the problem was solved by talking, no parcel; the customer's satisfaction comes with it. */
  'sav.settle': proc(
    [...SAV_ROLES],
    z.object({ id, reason: z.enum(SAV_SETTLE), note: z.string().trim().max(1000).default('') }).merge(SatInput),
    async (ctx, i) => {
      checkSat(i);
      const t = await getTicket(ctx.db, i.id);
      if (t.status === 'resolved' || t.status === 'closed') throw bad('Ticket déjà clôturé');
      if (t.exchangeOrderId && t.exchangeFollow !== 'cancelled') throw bad(`Un échange est en cours : ${t.exchangeRef}`);
      await ctx.db.tx((tx) => settleTicket(ctx, tx, i.id, i));
      ctx.emit({ type: 'sav', id: i.id });
      return getTicket(ctx.db, i.id);
    },
  ),

  /** After the exchange was delivered: the customer's satisfaction, "Pas répondu", or reopen the ticket (not satisfied). */
  'sav.rate': proc(
    [...SAV_ROLES],
    z.object({
      id,
      satisfaction: z.number().int().min(1).max(4).nullable().default(null),
      satisfactionNote: z.string().trim().max(1000).default(''),
      noAnswer: z.boolean().default(false),
      reopen: z.boolean().default(false),
    }),
    async (ctx, i) => {
      const t = await getTicket(ctx.db, i.id);
      const me = ctx.session.profile.id;
      const nowIso = new Date(ctx.now()).toISOString();
      if (t.status !== 'resolved') throw bad('Le ticket n’est pas terminé');
      await ctx.db.tx(async (tx) => {
        if (i.noAnswer) {
          const n = t.satTries + 1;
          await tx.query('UPDATE complaints SET sat_tries = $2, updated_at = now() WHERE id = $1', [i.id, n]);
          await pushNote(tx, i.id, { at: nowIso, userId: me, text: n >= SAT_MAX_TRIES ? `Pas répondu (${n}e appel) — on ne demande plus` : `Appel satisfaction : pas répondu (${n}e appel)` });
          return;
        }
        if (!i.satisfaction) throw bad('Choisissez la satisfaction du client');
        const s = { satisfaction: i.satisfaction, satisfactionNote: i.satisfactionNote };
        checkSat(s);
        if (i.reopen) {
          // not satisfied: the ticket starts again (a new exchange can be made); the answer stays in the history
          await tx.query(
            `UPDATE complaints SET status='open', resolved_at=NULL, resolution=NULL, settle_reason=NULL, exchange_order_id=NULL,
               satisfaction=NULL, satisfaction_note=NULL, satisfaction_at=NULL, satisfaction_by=NULL, sat_tries=0, updated_at=now() WHERE id=$1`,
            [i.id],
          );
          await pushNote(tx, i.id, { at: nowIso, userId: me, text: `${satText(s)} · ticket rouvert`, status: 'open' });
          return;
        }
        await tx.query(`UPDATE complaints SET satisfaction=$2, satisfaction_note=NULLIF($3,''), satisfaction_at=$4::timestamptz, satisfaction_by=$5, updated_at=now() WHERE id=$1`, [
          i.id,
          s.satisfaction,
          s.satisfactionNote.trim(),
          nowIso,
          me,
        ]);
        await pushNote(tx, i.id, { at: nowIso, userId: me, text: satText(s) });
      });
      ctx.emit({ type: 'sav', id: i.id });
      return getTicket(ctx.db, i.id);
    },
  ),

  /** Find the order of a new ticket (any status). */
  'sav.findOrder': proc([...SAV_ROLES], z.object({ q: z.string().min(2).max(100), deliveredFirst: z.boolean().default(false) }), (ctx, { q, deliveredFirst }) =>
    // the call: what the customer received comes first (SAV is after delivery), newest first
    deliveredFirst ? findOrders(ctx, q, 12, undefined, `COALESCE(o.follow_status IN ('delivered','exchanged'), false) DESC, (o.shipped_at IS NOT NULL) DESC, o.created_at DESC`) : findOrders(ctx, q),
  ),
};
