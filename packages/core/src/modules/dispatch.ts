// Dépôt: from « À préparer » to « En dispatch ».
//  - An order whose products are all picked goes to « En dispatch » by itself when it has a company (its parcel is
//    created at the courier, its label ready) — or our own delivery with its livreur. No « Envoyer au dispatch » click.
//  - The others wait in « À attribuer »: no company yet, or « Livraison privée » without a livreur. Only managers (people
//    ticked in Utilisateurs) and admins choose there; the order then goes to « En dispatch » by itself.
//  - A parcel the courier refuses stays in « En dispatch » with the reason, and « Renvoyer » / « Autre société ».
//  - A cancelled order whose parcel is at a courier: Pilotix cancels it there by itself; a courier whose system cannot
//    cancel puts it on « À annuler à la main » (the depot cancels it in the courier's space, then « C'est fait »).
//  - A parcel still « En dispatch » after 24 h is late (the courier did not take it).
import { API_COURIER_KINDS } from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, num } from '../db';
import { bad, Ctx, forbidden, proc } from '../rpc';
import { cancelParcel, sendOrders } from './delivery';
import { addEvent, getOrder, ordersProcs, setFollow } from './orders';

const id = z.number().int().positive();
const API_COURIERS = API_COURIER_KINDS as readonly string[];
const LATE_MS = 24 * 3_600_000;

/** Orders still to prepare that have every product picked (services aside). */
export const READY_SQL = `o.conf_status = 'confirmed' AND o.follow_status = 'to_prepare'
  AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id)
  AND NOT EXISTS (SELECT 1 FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = o.id AND NOT p.is_service AND i.picked_qty < i.qty)`;

/** Who chooses in « À attribuer »: admins, and the people ticked in Utilisateurs. */
export const canAssign = (ctx: Ctx) => ctx.session.isAdmin || !!ctx.session.profile.canAssign;

/** The depot's own hands for a step the person was allowed to start (a manager choosing in « À attribuer »). */
const asDepot = (ctx: Ctx): Ctx => (ctx.session.roles.includes('depot') ? ctx : { ...ctx, session: { ...ctx.session, roles: [...ctx.session.roles, 'depot'] } });

/**
 * To « En dispatch »: optionally to another company first (its parcel elsewhere is cancelled), then « Préparée », then
 * the parcel created at an API courier. A refusal keeps the order in « En dispatch » with the reason.
 */
export async function dispatchOrders(ctx: Ctx, ids: number[], companyId?: number) {
  const failed: { id: number; ref: string; error: string }[] = [];
  const fail = (oid: number, ref: string, e: unknown) => failed.push({ id: oid, ref, error: (e as Error)?.message || 'Erreur' });
  let list = ids;
  if (companyId) {
    const moving = await ctx.db.query(
      `SELECT o.id, o.ref FROM orders o JOIN delivery_companies c ON c.id = o.company_id
       WHERE o.id = ANY($1) AND o.tracking IS NOT NULL AND o.company_id <> $2 AND c.kind = ANY($3)`,
      [list, companyId, API_COURIERS],
    );
    for (const r of moving) await cancelParcel(ctx, num(r.id)).catch((e) => fail(num(r.id), r.ref, e));
    list = list.filter((x) => !failed.some((f) => f.id === x));
    if (list.length) await ordersProcs['orders.assignCompany'].run(ctx, { ids: list, companyId });
  }
  const pick = async (sql: string, ...more: unknown[]) => (list.length ? (await ctx.db.query(sql, [list, ...more])).map((r: any) => num(r.id)) : []);
  const toMove = await pick(`SELECT id FROM orders WHERE id = ANY($1) AND follow_status = 'to_prepare'`);
  const moved = toMove.length ? (await setFollow(ctx, { ids: toMove, status: 'prepared' })).changed.length : 0;
  const toSend = await pick(
    `SELECT o.id FROM orders o JOIN delivery_companies c ON c.id = o.company_id
     WHERE o.id = ANY($1) AND o.follow_status = 'prepared' AND o.tracking IS NULL AND c.kind = ANY($2)`,
    API_COURIERS,
  );
  let sent = 0;
  if (toSend.length) {
    try {
      const r = await sendOrders(ctx, toSend);
      sent = r.sent;
      for (const x of r.results)
        if (!x.ok) {
          fail(x.id, x.ref, new Error(x.error));
          await keepRefusal(ctx.db, x.id, x.error ?? 'Erreur', ctx.session.profile.id);
        }
    } catch (e) {
      for (const r of await ctx.db.query('SELECT id, ref FROM orders WHERE id = ANY($1)', [toSend])) {
        fail(num(r.id), r.ref, e);
        await keepRefusal(ctx.db, num(r.id), (e as Error)?.message || 'Erreur', ctx.session.profile.id);
      }
    }
  }
  return { moved, sent, failed };
}

/** A parcel the courier refused: the reason stays on the order (shown in « En dispatch ») and in its history. */
export async function keepRefusal(db: Db, orderId: number, error: string, userId: number | null) {
  const had = (await db.query('SELECT send_error FROM orders WHERE id = $1', [orderId]))[0]?.send_error;
  await db.query('UPDATE orders SET send_error = $2, send_error_at = now() WHERE id = $1', [orderId, error.slice(0, 500)]);
  if (had !== error) await addEvent(db, orderId, userId, 'note', null, 'event', `Colis refusé par la société : ${error}`);
}

/** Orders just picked whole (or any ready ones): with a company — or own delivery with its livreur — to « En dispatch ». */
export async function autoDispatch(ctx: Ctx, ids?: number[]) {
  const rows = await ctx.db.query(
    `SELECT o.id, o.company_id, o.livreur_id, c.kind, c.active FROM orders o LEFT JOIN delivery_companies c ON c.id = o.company_id
      WHERE ${READY_SQL} ${ids ? 'AND o.id = ANY($1)' : ''}`,
    ids ? [ids] : [],
  );
  const go = rows.filter((r: any) => r.company_id && r.active && (r.kind !== 'own' || r.livreur_id)).map((r: any) => num(r.id));
  const r = go.length ? await dispatchOrders(asDepot(ctx), go) : { moved: 0, sent: 0, failed: [] };
  return { dispatched: r.moved, failed: r.failed, toAssign: rows.length - go.length };
}

/** « À attribuer »: ready orders without a company, or « Livraison privée » without a livreur. */
async function toAssignList(ctx: Ctx) {
  const rows = await ctx.db.query(
    `SELECT o.id FROM orders o LEFT JOIN delivery_companies c ON c.id = o.company_id
      WHERE ${READY_SQL} AND (o.company_id IS NULL OR NOT c.active OR (c.kind = 'own' AND o.livreur_id IS NULL))
      ORDER BY o.confirmed_at NULLS LAST, o.created_at, o.id LIMIT 300`,
  );
  return Promise.all(rows.map((r: any) => getOrder(ctx, num(r.id))));
}

/** « En dispatch » problems: parcels refused by the courier, parcels to cancel by hand, parcels waiting over 24 h. */
async function dispatchAlerts(ctx: Ctx) {
  const late = new Date(ctx.now() - LATE_MS).toISOString();
  const rows = await ctx.db.query(
    `SELECT o.id, o.ref, o.customer_name, o.wilaya_id, o.tracking, o.send_error, o.send_error_at, o.prepared_at, o.cancel_by_hand,
            o.follow_status, c.name AS company_name, c.id AS company_id
       FROM orders o LEFT JOIN delivery_companies c ON c.id = o.company_id
      WHERE (o.follow_status = 'prepared' AND (o.send_error IS NOT NULL OR o.prepared_at <= $1::timestamptz)) OR o.cancel_by_hand
      ORDER BY o.cancel_by_hand DESC, (o.send_error IS NULL), o.prepared_at NULLS LAST, o.id LIMIT 300`,
    [late],
  );
  const one = (r: any) => ({
    id: num(r.id),
    ref: r.ref as string,
    customerName: r.customer_name as string,
    wilayaId: num(r.wilaya_id),
    tracking: (r.tracking as string | null) ?? null,
    companyId: r.company_id ? num(r.company_id) : null,
    companyName: (r.company_name as string | null) ?? null,
    error: (r.send_error as string | null) ?? null,
    since: r.prepared_at ? iso(r.prepared_at) : null,
  });
  return {
    refused: rows.filter((r: any) => r.follow_status === 'prepared' && r.send_error).map(one),
    byHand: rows.filter((r: any) => r.cancel_by_hand).map(one),
    late: rows.filter((r: any) => r.follow_status === 'prepared' && !r.send_error && !r.cancel_by_hand).map(one),
  };
}

/**
 * A cancelled order whose parcel is at a courier and never left the depot: cancelled there by Pilotix; a courier that
 * cannot (or a refusal) puts it on « À annuler à la main ». Runs after the change is saved.
 */
export async function cancelGhosts(ctx: Ctx, ids: number[]) {
  if (!ids.length) return;
  const rows = await ctx.db.query(
    `SELECT o.id FROM orders o JOIN delivery_companies c ON c.id = o.company_id
      WHERE o.id = ANY($1) AND o.follow_status = 'cancelled' AND o.tracking IS NOT NULL AND o.shipped_at IS NULL AND c.kind = ANY($2)`,
    [ids, API_COURIERS],
  );
  for (const r of rows) {
    const oid = num(r.id);
    try {
      await cancelParcel(ctx, oid);
    } catch (e) {
      await ctx.db.query('UPDATE orders SET cancel_by_hand = true WHERE id = $1', [oid]);
      await addEvent(ctx.db, oid, ctx.session.profile.id, 'note', null, 'event', `À annuler à la main chez la société : ${(e as Error)?.message || 'refusé'}`);
    }
  }
}

export const dispatchProcs = {
  /** « À attribuer » (the depot sees it; managers and admins choose). Ready orders with a company go first to « En dispatch ». */
  'depot.toAssign': proc(['depot'], z.object({}), async (ctx) => {
    await autoDispatch(ctx);
    return { canAct: canAssign(ctx), rows: await toAssignList(ctx) };
  }),

  /** A manager or an admin gives these orders a company (or our own delivery and its livreur): to « En dispatch ». */
  'depot.assign': proc(['depot'], z.object({ ids: z.array(id).min(1).max(300), companyId: id, livreurId: id.nullable().optional() }), async (ctx, i) => {
    if (!canAssign(ctx)) throw forbidden('Seuls les managers et les admins attribuent les commandes');
    const c = (await ctx.db.query('SELECT kind, active FROM delivery_companies WHERE id = $1', [i.companyId]))[0];
    if (!c || !c.active) throw bad('Société introuvable');
    if (c.kind === 'own' && !i.livreurId) throw bad('Choisissez le livreur');
    const ready = (await ctx.db.query(`SELECT o.id FROM orders o WHERE o.id = ANY($1) AND ${READY_SQL}`, [i.ids])).map((r: any) => num(r.id));
    if (!ready.length) throw bad('Ces commandes ne sont plus à attribuer');
    const dctx = asDepot(ctx);
    await ordersProcs['orders.assignCompany'].run(dctx, { ids: ready, companyId: i.companyId, livreurId: c.kind === 'own' ? (i.livreurId ?? null) : null });
    const r = await dispatchOrders(dctx, ready);
    ctx.emit({ type: 'orders' });
    return { assigned: ready.length, ...r };
  }),

  /** « En dispatch »: refused parcels, parcels to cancel by hand, parcels waiting over 24 h. */
  'depot.dispatchAlerts': proc(['depot'], z.object({}), (ctx) => dispatchAlerts(ctx)),

  /** « Renvoyer »: the refused parcels sent again to their company. */
  'depot.resend': proc(['depot'], z.object({ ids: z.array(id).min(1).max(300) }), async (ctx, i) => {
    const r = await dispatchOrders(ctx, i.ids);
    ctx.emit({ type: 'orders' });
    return r;
  }),

  /** « C'est fait »: the parcel was cancelled in the courier's own space. */
  'depot.cancelDone': proc(['depot'], z.object({ id }), async (ctx, i) => {
    const o = (await ctx.db.query('UPDATE orders SET cancel_by_hand = false WHERE id = $1 AND cancel_by_hand RETURNING id', [i.id]))[0];
    if (o) await addEvent(ctx.db, i.id, ctx.session.profile.id, 'note', null, 'event', 'Colis annulé à la main chez la société');
    ctx.emit({ type: 'orders' });
    return { ok: !!o };
  }),
};
