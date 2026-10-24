// Caisse: money of delivered parcels not received yet (by company or livreur), versements (cash_handovers),
// the livreurs' cash (their share per parcel, what they must hand over) and the chat between livreurs and the office.
import { FOLLOW_ON_ROAD } from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, isoOrNull, num, numOrNull } from '../db';
import { bad, Ctx, forbidden, notFound, proc } from '../rpc';
import { getSetting } from '../settings';
import { addEvent } from './orders';
import { livreurOnly } from './delivery';

const id = z.number().int().positive();
const ids = z.array(id).min(1).max(3000);
const dateStr = z.string().min(10).max(40);

export interface CashOrder {
  id: number;
  ref: string;
  tracking: string | null;
  deliveredAt: string | null;
  customerName: string;
  phone: string;
  wilayaId: number;
  commune: string;
  products: string;
  variants: string;
  total: number;
  deliveryCost: number;
  net: number;
  companyId: number | null;
  companyName: string | null;
  companyKind: string | null;
  livreurId: number | null;
  livreurName: string | null;
  cashed: boolean;
  cashedAt: string | null;
  handoverId: number | null;
  /** livreur's share for this parcel (own livreurs) */
  share: number;
  heavy: boolean;
  /** SAV ticket parcel (its money is kept apart from orders) */
  ticket: boolean;
  savRef: string | null;
}

const COLS = `o.id, o.ref, COALESCE(o.tracking, o.own_tracking) AS tracking, o.delivered_at, o.customer_name, o.phone, o.wilaya_id, o.commune, o.total, o.delivery_cost, o.company_id,
  o.livreur_id, o.cashed, o.cashed_at, o.handover_id, o.follow_status, o.address, o.is_exchange,
  CASE WHEN o.is_exchange THEN (SELECT k.ref FROM complaints k WHERE k.exchange_order_id = o.id ORDER BY k.id DESC LIMIT 1) END AS sav_ref, c.name AS company_name, c.kind AS company_kind, lv.name AS livreur_name,
  (SELECT string_agg(CASE WHEN i.qty > 1 THEN i.qty || ' × ' ELSE '' END || i.name, ' + ' ORDER BY i.id)
     FROM order_items i WHERE i.order_id = o.id) AS products,
  (SELECT CASE WHEN bool_or(i.variant_title <> '') THEN string_agg(CASE WHEN i.variant_title <> '' THEN i.variant_title ELSE '—' END, ' + ' ORDER BY i.id) END
     FROM order_items i WHERE i.order_id = o.id) AS variants,
  (SELECT coalesce(max(p.weight_kg), 0) FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = o.id) AS max_kg`;
const FROM = `FROM orders o LEFT JOIN delivery_companies c ON c.id = o.company_id LEFT JOIN profiles lv ON lv.id = o.livreur_id`;

type Pay = { light: number; heavy: number; heavyFromKg: number };

function toCash(r: any, pay: Pay): CashOrder {
  const own = r.company_kind === 'own' || !!r.livreur_id;
  const heavy = Number(r.max_kg) >= pay.heavyFromKg;
  const share = own && r.follow_status === 'delivered' ? (heavy ? pay.heavy : pay.light) : 0;
  const total = num(r.total);
  // our own livreurs hand over the whole amount (their share is paid separately); couriers keep their fee
  const cost = own ? 0 : num(r.delivery_cost);
  return {
    id: num(r.id),
    ref: r.ref,
    tracking: r.tracking,
    deliveredAt: isoOrNull(r.delivered_at),
    customerName: r.customer_name,
    phone: r.phone,
    wilayaId: num(r.wilaya_id),
    commune: r.commune ?? '',
    products: r.products ?? '',
    variants: r.variants ?? '',
    total,
    deliveryCost: cost,
    net: total - cost,
    companyId: numOrNull(r.company_id),
    companyName: r.company_name ?? null,
    companyKind: r.company_kind ?? null,
    livreurId: numOrNull(r.livreur_id),
    livreurName: r.livreur_name ?? null,
    cashed: !!r.cashed,
    cashedAt: isoOrNull(r.cashed_at),
    handoverId: numOrNull(r.handover_id),
    share,
    heavy,
    ticket: !!r.is_exchange,
    savRef: r.sav_ref ?? null,
  };
}

const payOf = async (db: Db): Promise<Pay> => (await getSetting(db, 'payPlans')).livreur;

/** A caisse: 'main' (the owner's), 'bank', 'u<profile id>' (an employee's) or 'c<id>' (one the owner created). */
export const CaisseKey = z.string().regex(/^(main|bank|u\d+|c\d+)$/);
export const CAISSE_KEY_RE = /^(main|bank|u\d+|c\d+)$/;
export async function checkCaisse(db: Db, key: string) {
  if (key === 'main') return key;
  if (key === 'bank') {
    if ((await getSetting(db, 'caisses')).bankHidden) throw bad('La banque a été supprimée des caisses');
    return key;
  }
  if (key.startsWith('c')) {
    const c = (await db.query('SELECT id FROM caisses WHERE id = $1 AND removed_at IS NULL', [Number(key.slice(1))]))[0];
    if (!c) throw bad('Caisse inconnue ou supprimée');
    return key;
  }
  const p = (await db.query('SELECT id FROM profiles WHERE id = $1', [Number(key.slice(1))]))[0];
  if (!p) throw bad('Caisse inconnue');
  return key;
}
/** The name of any caisse key (removed caisses keep their name in the history). */
export async function caisseLabelOf(db: Db, key: string | null): Promise<string | null> {
  if (!key) return null;
  if (key === 'main') return 'Caisse principale';
  if (key === 'bank') return 'Banque';
  if (key.startsWith('c')) return ((await db.query('SELECT name FROM caisses WHERE id = $1', [Number(key.slice(1))]))[0]?.name as string) ?? key;
  return ((await db.query('SELECT name FROM profiles WHERE id = $1', [Number(key.slice(1))]))[0]?.name as string) ?? key;
}

/** Marks orders as cashed and records one versement per company / livreur, into the caisse that received the money. */
/** `fix`: the courier's own figure for the money paid (its statement): one versement whose net is that amount. */
export async function receive(ctx: Ctx, orderIds: number[], note: string | null, livreurShare: boolean, into = 'main', fix?: { net: number }) {
  await checkCaisse(ctx.db, into);
  const pay = await payOf(ctx.db);
  const me = ctx.session.profile.id;
  const created: number[] = [];
  await ctx.db.tx(async (tx) => {
    const rows = (await tx.query(`SELECT ${COLS} ${FROM} WHERE o.id = ANY($1) FOR UPDATE OF o`, [orderIds])).map((r: any) => toCash(r, pay));
    const bad_ = rows.find((r) => r.cashed);
    if (bad_) throw bad(`${bad_.ref} est déjà encaissée`);
    const notDelivered = (await tx.query(`SELECT ref FROM orders WHERE id = ANY($1) AND follow_status <> 'delivered'`, [orderIds]))[0];
    if (notDelivered) throw bad(`${notDelivered.ref} n’est pas livrée`);
    const groups = new Map<string, CashOrder[]>();
    for (const r of rows) {
      const k = fix ? 'all' : `${r.ticket ? 't' : ''}${r.livreurId ? `l${r.livreurId}` : `c${r.companyId ?? 0}`}`;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    for (const list of groups.values()) {
      const collected = list.reduce((s, o) => s + o.total, 0);
      const fees = fix ? collected - fix.net : livreurShare || list[0].livreurId ? list.reduce((s, o) => s + o.share, 0) : list.reduce((s, o) => s + o.deliveryCost, 0);
      const h = await tx.query(
        'INSERT INTO cash_handovers (company_id, livreur_id, orders, collected, fees, net, note, created_by, received_into) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
        [list[0].companyId, list[0].livreurId, list.map((o) => o.id), collected, fees, collected - fees, note, me, into],
      );
      const hid = num(h[0].id);
      created.push(hid);
      await tx.query('UPDATE orders SET cashed = true, cashed_at = now(), handover_id = $2, updated_at = now() WHERE id = ANY($1)', [list.map((o) => o.id), hid]);
      for (const o of list) await addEvent(tx, o.id, me, 'cashed', null, 'cashed', `Argent reçu (versement n° ${hid})`);
    }
  });
  ctx.emit({ type: 'orders' });
  return { handovers: created, orders: orderIds.length };
}

/** The livreurs' cash: per livreur, parcels in hand, delivered (cashed or not), their share and what they must hand over. */
export async function livreursCash(ctx: Ctx, f: { livreurId?: number; from?: string; to?: string }) {
  const pay = await payOf(ctx.db);
  const own = livreurOnly(ctx.session);
  const only = own ? ctx.session.profile.id : f.livreurId;
  const people = await ctx.db.query(`SELECT id, name, phone FROM profiles WHERE 'livreur' = ANY(roles) ${only ? 'AND id = $1' : ''} ORDER BY name`, only ? [only] : []);
  const pIds = people.map((p: any) => num(p.id));
  const params: unknown[] = [pIds];
  let period = '';
  if (f.from) {
    params.push(f.from);
    period += ` AND o.delivered_at >= $${params.length}`;
  }
  if (f.to) {
    params.push(f.to);
    period += ` AND o.delivered_at < $${params.length}`;
  }
  const inHand = (await ctx.db.query(`SELECT ${COLS} ${FROM} WHERE o.livreur_id = ANY($1) AND o.follow_status = ANY($2) ORDER BY o.updated_at DESC`, [pIds, FOLLOW_ON_ROAD])).map((r: any) => toCash(r, pay));
  // not cashed: whatever the period (money still owed); cashed: in the period
  const delivered = (
    await ctx.db.query(`SELECT ${COLS} ${FROM} WHERE o.livreur_id = ANY($1) AND o.follow_status = 'delivered' AND (NOT o.cashed OR (true ${period})) ORDER BY o.delivered_at DESC`, params)
  ).map((r: any) => toCash(r, pay));
  const returning = (await ctx.db.query(`SELECT ${COLS} ${FROM} WHERE o.livreur_id = ANY($1) AND o.follow_status = 'returning' ORDER BY o.updated_at DESC`, [pIds])).map((r: any) => toCash(r, pay));
  const handovers = await ctx.db.query(
    `SELECT h.*, cardinality(h.orders) AS n FROM cash_handovers h WHERE h.livreur_id = ANY($1) AND h.cancelled_at IS NULL ORDER BY h.created_at DESC LIMIT 200`,
    [pIds],
  );
  // taux de livraison: delivered ÷ (delivered + returned), parcels finished in the last 30 days (or the period asked)
  const rateFrom = f.from ?? new Date(ctx.now() - 30 * 86_400_000).toISOString();
  const rates = new Map<number, { d: number; r: number }>();
  for (const r of await ctx.db.query(
    `SELECT livreur_id, count(*) FILTER (WHERE follow_status = 'delivered' AND delivered_at >= $2) AS d,
            count(*) FILTER (WHERE follow_status IN ('returning', 'returned') AND COALESCE(returned_at, updated_at) >= $2) AS r
     FROM orders WHERE livreur_id = ANY($1) GROUP BY livreur_id`,
    [pIds, rateFrom],
  ))
    rates.set(num(r.livreur_id), { d: num(r.d), r: num(r.r) });
  const livreurs = people.map((p: any) => {
    const pid = num(p.id);
    const rt = rates.get(pid) ?? { d: 0, r: 0 };
    const hand = inHand.filter((o) => o.livreurId === pid);
    const del = delivered.filter((o) => o.livreurId === pid);
    const notCashed = del.filter((o) => !o.cashed);
    const cashed = del.filter((o) => o.cashed);
    const share = notCashed.reduce((s, o) => s + o.share, 0);
    const sum = (l: CashOrder[]) => l.reduce((s, o) => s + o.total, 0);
    return {
      id: pid,
      name: p.name as string,
      phone: (p.phone ?? null) as string | null,
      inHand: hand.length,
      inHandValue: sum(hand),
      delivered: del.length,
      cashed: cashed.length,
      cashedAmount: sum(cashed),
      notCashed: notCashed.length,
      notCashedAmount: sum(notCashed),
      share,
      shareAll: del.reduce((s, o) => s + o.share, 0),
      net: sum(notCashed) - share,
      returning: returning.filter((o) => o.livreurId === pid).length,
      /** SAV exchange parcels he carries now */
      exchanges: hand.filter((o) => o.ticket).length,
      /** delivered ÷ (delivered + returned), 0–1, null when nothing finished yet */
      rate: rt.d + rt.r ? rt.d / (rt.d + rt.r) : null,
      lastHandover: (handovers.find((h: any) => num(h.livreur_id) === pid)?.created_at ? iso(handovers.find((h: any) => num(h.livreur_id) === pid).created_at) : null) as string | null,
    };
  });
  return {
    pay,
    livreurs,
    inHand,
    delivered,
    returning,
    handovers: handovers.map((h: any) => ({ id: num(h.id), livreurId: numOrNull(h.livreur_id), at: iso(h.created_at), orders: num(h.n), collected: num(h.collected), fees: num(h.fees), net: num(h.net) })),
  };
}

// ---------------------------------------------------------------- chat
async function chatList(ctx: Ctx, livreurId: number, limit: number) {
  const rows = await ctx.db.query(
    `SELECT m.*, p.name AS user_name, o.ref AS order_ref FROM chat_messages m LEFT JOIN profiles p ON p.id = m.user_id LEFT JOIN orders o ON o.id = m.order_id
     WHERE m.livreur_id = $1 ORDER BY m.created_at DESC, m.id DESC LIMIT $2`,
    [livreurId, limit],
  );
  // what the other side wrote is now read
  await ctx.db.query('UPDATE chat_messages SET read_at = now() WHERE livreur_id = $1 AND read_at IS NULL AND user_id <> $2', [livreurId, ctx.session.profile.id]);
  return rows.reverse().map((r: any) => ({
    id: num(r.id),
    livreurId: num(r.livreur_id),
    userId: num(r.user_id),
    userName: (r.user_name ?? '') as string,
    mine: num(r.user_id) === ctx.session.profile.id,
    fromLivreur: num(r.user_id) === livreurId,
    orderId: numOrNull(r.order_id),
    orderRef: (r.order_ref ?? null) as string | null,
    body: r.body as string,
    at: iso(r.created_at),
    readAt: isoOrNull(r.read_at),
  }));
}

/** A livreur only talks in his own conversation; the office picks the livreur. */
function chatTarget(ctx: Ctx, wanted?: number) {
  const s = ctx.session;
  const staff = s.isAdmin || s.roles.includes('suivi') || s.roles.includes('agent_manager');
  if (!staff) {
    if (wanted && wanted !== s.profile.id) throw forbidden();
    return s.profile.id;
  }
  if (!wanted) {
    if (s.roles.includes('livreur')) return s.profile.id;
    throw bad('Choisissez un livreur');
  }
  return wanted;
}

// ---------------------------------------------------------------- procedures
export const cashProcs = {
  /** "À recevoir": delivered and not cashed, grouped by company (own livreurs by livreur). Net = paid by the customer − company fee. */
  'cash.due': proc([], z.object({}), async (ctx) => {
    const pay = await payOf(ctx.db);
    const rows = (await ctx.db.query(`SELECT ${COLS} ${FROM} WHERE o.follow_status = 'delivered' AND NOT o.cashed ORDER BY o.delivered_at ASC NULLS FIRST, o.id`)).map((r: any) => toCash(r, pay));
    // orders and SAV tickets are counted apart: a ticket parcel with nothing to collect (free exchange) is not money to receive
    const build = (list: CashOrder[], prefix: string) => {
      const groups = new Map<string, { key: string; companyId: number | null; livreurId: number | null; name: string; kind: string | null; orders: CashOrder[] }>();
      for (const o of list) {
        const key = `${prefix}${o.livreurId ? `l${o.livreurId}` : `c${o.companyId ?? 0}`}`;
        if (!groups.has(key))
          groups.set(key, { key, companyId: o.companyId, livreurId: o.livreurId, name: o.livreurId ? `${o.livreurName ?? '?'}${o.companyName ? ` · ${o.companyName}` : ''}` : o.companyName ?? 'Sans société', kind: o.companyKind, orders: [] });
        groups.get(key)!.orders.push(o);
      }
      const out = [...groups.values()].map((g) => ({
        ...g,
        count: g.orders.length,
        collected: g.orders.reduce((s, o) => s + o.total, 0),
        net: g.orders.reduce((s, o) => s + o.net, 0),
      }));
      out.sort((a, b) => b.net - a.net);
      return out;
    };
    const orders = rows.filter((o) => !o.ticket);
    const tickets = rows.filter((o) => o.ticket && o.total > 0);
    const groups = build(orders, '');
    const ticketGroups = build(tickets, 't');
    return {
      groups,
      total: groups.reduce((s, g) => s + g.net, 0),
      count: orders.length,
      tickets: { groups: ticketGroups, total: ticketGroups.reduce((s, g) => s + g.net, 0), count: tickets.length },
    };
  }),

  /** "Argent reçu": one versement per company / livreur, orders marked cashed. */
  'cash.receive': proc([], z.object({ ids, note: z.string().max(300).nullable().optional(), into: CaisseKey.default('main') }), async (ctx, i) => receive(ctx, i.ids, i.note ?? null, false, i.into)),

  /** "Déjà reçu": versements (not cancelled) with their orders. */
  'cash.history': proc([], z.object({ from: dateStr.optional(), to: dateStr.optional(), limit: z.number().int().min(1).max(500).default(100) }), async (ctx, i) => {
    const pay = await payOf(ctx.db);
    const params: unknown[] = [i.limit];
    let w = 'h.cancelled_at IS NULL';
    if (i.from) w += ` AND h.created_at >= $${params.push(i.from)}`;
    if (i.to) w += ` AND h.created_at < $${params.push(i.to)}`;
    const hs = await ctx.db.query(
      `SELECT h.*, c.name AS company_name, lv.name AS livreur_name, u.name AS by_name FROM cash_handovers h
       LEFT JOIN delivery_companies c ON c.id = h.company_id LEFT JOIN profiles lv ON lv.id = h.livreur_id LEFT JOIN profiles u ON u.id = h.created_by
       WHERE ${w} ORDER BY h.created_at DESC LIMIT $1`,
      params,
    );
    const allIds = hs.flatMap((h: any) => (Array.isArray(h.orders) ? h.orders : []).map(num));
    const orders = allIds.length ? (await ctx.db.query(`SELECT ${COLS} ${FROM} WHERE o.id = ANY($1)`, [allIds])).map((r: any) => toCash(r, pay)) : [];
    return hs.map((h: any) => ({
      id: num(h.id),
      at: iso(h.created_at),
      companyId: numOrNull(h.company_id),
      livreurId: numOrNull(h.livreur_id),
      name: h.livreur_id ? `${h.livreur_name ?? '?'}` : h.company_name ?? 'Sans société',
      byName: (h.by_name ?? null) as string | null,
      collected: num(h.collected),
      fees: num(h.fees),
      net: num(h.net),
      note: (h.note ?? null) as string | null,
      orders: orders.filter((o) => (h.orders ?? []).map(num).includes(o.id)),
      tickets: orders.some((o) => (h.orders ?? []).map(num).includes(o.id)) && orders.filter((o) => (h.orders ?? []).map(num).includes(o.id)).every((o) => o.ticket),
    }));
  }),

  /** "Annuler ce versement": the orders go back to not cashed. */
  'cash.cancel': proc([], z.object({ handoverId: id }), async (ctx, { handoverId }) => {
    await ctx.db.tx(async (tx) => {
      const h = (await tx.query('SELECT * FROM cash_handovers WHERE id=$1 FOR UPDATE', [handoverId]))[0];
      if (!h) throw notFound('Versement introuvable');
      if (h.cancelled_at) throw bad('Versement déjà annulé');
      await tx.query('UPDATE cash_handovers SET cancelled_at = now() WHERE id=$1', [handoverId]);
      const oids = (h.orders ?? []).map(num);
      await tx.query('UPDATE orders SET cashed=false, cashed_at=NULL, handover_id=NULL, updated_at=now() WHERE handover_id=$1 OR (id = ANY($2) AND handover_id IS NULL)', [handoverId, oids]);
      for (const o of oids) await addEvent(tx, o, ctx.session.profile.id, 'cashed', 'cashed', null, `Versement n° ${handoverId} annulé`);
    });
    ctx.emit({ type: 'orders' });
    return { ok: true };
  }),

  /** Livreurs cash module (a livreur sees only himself). */
  'cash.livreurs': proc(['livreur', 'suivi'], z.object({ livreurId: id.optional(), from: dateStr.optional(), to: dateStr.optional() }), (ctx, i) => livreursCash(ctx, i)),

  /** "Encaisser la sélection" / "Tout encaisser" (allIds of one livreur): money received from a livreur, his share kept. */
  'cash.livreurCollect': proc([], z.object({ livreurId: id, ids: z.array(id).max(3000).optional(), all: z.boolean().optional(), into: CaisseKey.default('main') }), async (ctx, i) => {
    let list = i.ids ?? [];
    if (i.all) list = (await ctx.db.query(`SELECT id FROM orders WHERE livreur_id=$1 AND follow_status='delivered' AND NOT cashed`, [i.livreurId])).map((r: any) => num(r.id));
    if (!list.length) throw bad('Rien à encaisser');
    const other = (await ctx.db.query('SELECT ref FROM orders WHERE id = ANY($1) AND (livreur_id IS NULL OR livreur_id <> $2) LIMIT 1', [list, i.livreurId]))[0];
    if (other) throw bad(`${other.ref} n’est pas un colis de ce livreur`);
    return receive(ctx, list, null, true, i.into);
  }),

  /** Chat between a livreur and the office (admin, managers, suivi). */
  'cash.chat': proc(['livreur', 'suivi', 'agent_manager'], z.object({ livreurId: id.optional(), limit: z.number().int().min(1).max(500).default(100) }), async (ctx, i) => chatList(ctx, chatTarget(ctx, i.livreurId), i.limit)),

  'cash.chatSend': proc(['livreur', 'suivi', 'agent_manager'], z.object({ livreurId: id.optional(), body: z.string().trim().min(1).max(2000), orderId: id.nullable().optional() }), async (ctx, i) => {
    const lid = chatTarget(ctx, i.livreurId);
    const lv = (await ctx.db.query(`SELECT id FROM profiles WHERE id=$1 AND 'livreur' = ANY(roles)`, [lid]))[0];
    if (!lv) throw notFound('Livreur introuvable');
    if (i.orderId && livreurOnly(ctx.session)) {
      const o = (await ctx.db.query('SELECT livreur_id FROM orders WHERE id=$1', [i.orderId]))[0];
      if (!o || num(o.livreur_id) !== lid) throw forbidden();
    }
    await ctx.db.query('INSERT INTO chat_messages (livreur_id, user_id, order_id, body) VALUES ($1,$2,$3,$4)', [lid, ctx.session.profile.id, i.orderId ?? null, i.body]);
    if (i.orderId) await addEvent(ctx.db, i.orderId, ctx.session.profile.id, 'chat', null, null, i.body.slice(0, 500));
    ctx.emit({ type: 'chat', id: lid });
    return { ok: true };
  }),

  /** Office side: one line per livreur with the last message and unread count. */
  'cash.chatThreads': proc(['suivi', 'agent_manager'], z.object({}), async (ctx) => {
    const rows = await ctx.db.query(
      `SELECT p.id, p.name,
         (SELECT body FROM chat_messages m WHERE m.livreur_id = p.id ORDER BY created_at DESC, id DESC LIMIT 1) AS last_body,
         (SELECT created_at FROM chat_messages m WHERE m.livreur_id = p.id ORDER BY created_at DESC, id DESC LIMIT 1) AS last_at,
         (SELECT count(*)::int FROM chat_messages m WHERE m.livreur_id = p.id AND m.user_id = p.id AND m.read_at IS NULL) AS unread
       FROM profiles p WHERE 'livreur' = ANY(p.roles) AND p.active ORDER BY last_at DESC NULLS LAST, p.name`,
    );
    return rows.map((r: any) => ({ livreurId: num(r.id), name: r.name as string, lastBody: (r.last_body ?? null) as string | null, lastAt: isoOrNull(r.last_at), unread: num(r.unread) }));
  }),
};
