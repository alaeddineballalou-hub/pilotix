// « ↶ Annuler » (undo): the last status change of an order goes back as if it had not been made.
// - Confirmation: confirmée → nouvelle, annulée → rouverte, a « pas de réponse » too many…
// - Delivery: préparée, expédiée, livrée, retournée, annulée au dépôt… by mistake.
// What the change did is put back: the order's fields, the stock, the depot's alert, the customer's numbers and the
// messages still waiting. The change leaves the history, and one « undo » line says who undid what.
// Who: the person who made it (24 h), a manager (agent manager, the owner; the Suivi for delivery steps; the depot's
// managers for the depot's own steps) or the administrator.
// Never: a status given by the delivery company (it would give it again), an SAV ticket parcel or a swap, money
// already in a caisse, a confirmation change once the parcel has left the depot, a parcel already in a pickup bag.
import { API_COURIER_KINDS, CONF_STATUSES, type ConfStatus } from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, num, numOrNull } from '../db';
import { bad, Ctx, hasRole, proc } from '../rpc';
import { asDepot, canAssign, dispatchOrders } from './dispatch';
import { addEvent, getOrder, releasePicked, setConf } from './orders';
import { applyTrust } from './trust';

const id = z.number().int().positive();
/** the person who made a change undoes it alone this long */
export const UNDO_HOURS = 24;
/** « ↶ » right after a change (the message at the bottom of the screen): the person's own changes this recent */
const JUST_NOW_MS = 10 * 60_000;
/** the depot's own steps (its managers undo them) */
const DEPOT_STEPS = ['to_prepare', 'prepared', 'shipped', 'returned', 'cancelled'];
/** steps that change the customer's record (refused, delivered) */
const TRUST = ['returning', 'returned', 'delivered', 'exchanged'];
const STAMPED = ['confirmed', 'no_stock'];
const API_COURIERS = API_COURIER_KINDS as readonly string[];

/** The order, and whether its parcel is in a pickup bag made at the courier (the bag would keep it). */
async function orderRow(db: Db, orderId: number) {
  return (
    await db.query(
      `SELECT o.*, c.kind AS company_kind,
              EXISTS (SELECT 1 FROM pickup_bag_parcels bp JOIN pickup_bags b ON b.id = bp.bag_id WHERE bp.order_id = o.id AND b.deleted_at IS NULL) AS in_bag
         FROM orders o LEFT JOIN delivery_companies c ON c.id = o.company_id WHERE o.id = $1`,
      [orderId],
    )
  )[0];
}

interface Ev {
  id: number;
  at: string;
  /** the time as the database keeps it (to the microsecond): what the change wrote at the same moment */
  atTxt: string;
  userId: number | null;
  kind: 'conf_status' | 'follow_status';
  from: string | null;
  to: string | null;
  note: string | null;
  data: any;
  name: string | null;
}
interface Action {
  /** the confirmation event of the change if it has one, else its delivery event */
  main: Ev;
  /** every status event the change wrote (a confirmation can move the delivery status too) */
  all: Ev[];
}

/** The last status change of an order. */
async function lastAction(db: Db, orderId: number): Promise<Action | null> {
  const rows = await db.query(
    `SELECT e.id, e.at, e.at::text AS at_txt, e.user_id, e.kind, e.from_value, e.to_value, e.note, e.data, p.name
       FROM order_events e LEFT JOIN profiles p ON p.id = e.user_id
      WHERE e.order_id = $1 AND e.kind IN ('conf_status', 'follow_status')
        AND e.at = (SELECT max(x.at) FROM order_events x WHERE x.order_id = $1 AND x.kind IN ('conf_status', 'follow_status'))
      ORDER BY e.id`,
    [orderId],
  );
  if (!rows.length) return null;
  const all: Ev[] = rows.map((r: any) => ({
    id: num(r.id),
    at: iso(r.at),
    atTxt: String(r.at_txt),
    userId: numOrNull(r.user_id),
    kind: r.kind,
    from: r.from_value ?? null,
    to: r.to_value ?? null,
    note: r.note ?? null,
    data: typeof r.data === 'string' ? JSON.parse(r.data) : (r.data ?? null),
    name: r.name ?? null,
  }));
  return { main: all.find((e) => e.kind === 'conf_status') ?? all[all.length - 1], all };
}

/** Why this person cannot undo it now (null: they can). */
export type UndoWhy = 'courier' | 'sav' | 'swap' | 'left' | 'cashed' | 'bag' | 'moved' | 'nothing' | 'held' | 'other' | 'old';

function whyNot(ctx: Ctx, o: any, act: Action, now: number): UndoWhy | null {
  const ev = act.main;
  // given by the delivery company: its next update would give it again
  if (act.all.some((e) => e.data?.courier || /^Statut |^Payé par la société/.test(e.note ?? ''))) return 'courier';
  if (o.is_exchange || ev.to === 'exchanged' || ev.from === 'exchanged') return 'sav';
  if (act.all.some((e) => e.data?.swap_to || e.data?.swap_from)) return 'swap';
  if (!ev.from) return 'nothing';
  if (ev.kind === 'conf_status') {
    if (o.conf_status !== ev.to) return 'moved';
    // once the parcel left, only its delivery status changes
    if (o.shipped_at) return 'left';
  } else {
    if (o.follow_status !== ev.to) return 'moved';
    if (o.cashed) return 'cashed';
    // in a pickup bag at the courier: taken out of the bag first (the bag at the courier would still have it)
    if (o.in_bag) return 'bag';
  }
  const s = ctx.session;
  if (s.isAdmin) return null;
  const office =
    hasRole(s, 'agent_manager', 'vendeur') || (ev.kind === 'follow_status' && (s.roles.includes('suivi') || (DEPOT_STEPS.includes(String(ev.to)) && canAssign(ctx))));
  if (office) return null;
  // another agent has the order open now (« Commande suivante »)
  if (o.locked_until && Date.parse(iso(o.locked_until)) > now && numOrNull(o.locked_by) !== s.profile.id) return 'held';
  if (ev.userId !== s.profile.id) return 'other';
  if (now - Date.parse(ev.at) > UNDO_HOURS * 3_600_000) return 'old';
  return null;
}

/** The refusal in words (French, as the server's other answers). */
function whyText(why: UndoWhy, by: string | null, holder: string | null): string {
  switch (why) {
    case 'courier':
      return 'Ce statut vient de la société de livraison : elle le redonnerait. Corrigez-le chez elle.';
    case 'sav':
      return 'Colis d’un ticket SAV : changez-le depuis le ticket.';
    case 'swap':
      return 'Colis swappé : changez-le depuis le Suivi.';
    case 'left':
      return 'Le colis est déjà parti du dépôt : changez plutôt son statut de livraison.';
    case 'cashed':
      return 'L’argent de cette commande est déjà en caisse : annulez d’abord le versement.';
    case 'bag':
      return 'Le colis est dans un sac de ramassage : retirez-le d’abord du sac (Dépôt › Dispatchées).';
    case 'moved':
      return 'La commande a changé depuis : rechargez-la.';
    case 'nothing':
      return 'Rien à remettre.';
    case 'held':
      return `${holder ?? 'Un autre agent'} est sur cette commande en ce moment.`;
    case 'other':
      return `Fait par ${by ?? 'quelqu’un d’autre'} : lui seul (pendant ${UNDO_HOURS} h) ou un responsable peut l’annuler.`;
    case 'old':
      return `Plus de ${UNDO_HOURS} h : demandez à un responsable.`;
  }
}

/** What the undo will do (shown before it is done). */
export type UndoEffect =
  | { k: 'back'; area: 'conf' | 'follow'; s: string }
  | { k: 'leavesDepot' | 'courierCancel' | 'toDepot' | 'call' | 'notDelivered' | 'alertClosed' | 'msgStopped' | 'repick' | 'resend' }
  | { k: 'stockBack' | 'stockOut'; n: number };

/** Back to « Préparée » (« En dispatch ») without a parcel at its company (the cancel removed it): made there again. */
const needsParcel = (o: any, back: string) => back === 'prepared' && !o.tracking && API_COURIERS.includes(String(o.company_kind ?? ''));

async function effectsOf(db: Db, o: any, act: Action): Promise<UndoEffect[]> {
  const ev = act.main;
  const at = ev.atTxt;
  const out: UndoEffect[] = [{ k: 'back', area: ev.kind === 'conf_status' ? 'conf' : 'follow', s: String(ev.from) }];
  if (ev.kind === 'conf_status') {
    const was = String(ev.to);
    const back = String(ev.from);
    if (STAMPED.includes(was) && !STAMPED.includes(back) && ['to_prepare', 'prepared'].includes(o.follow_status)) {
      out.push({ k: 'leavesDepot' });
      if (o.tracking && API_COURIERS.includes(String(o.company_kind ?? ''))) out.push({ k: 'courierCancel' });
    }
    if (!STAMPED.includes(was) && STAMPED.includes(back)) out.push({ k: 'toDepot' });
    if (was === 'no_answer' || was === 'busy' || (ev.note ?? '').includes('Annulée automatiquement')) out.push({ k: 'call' });
  } else {
    for (const m of await db.query(`SELECT reason, sum(delta)::int AS n FROM stock_movements WHERE order_id = $1 AND created_at = $2::timestamptz AND reason IN ('shipped', 'returned') GROUP BY 1`, [o.id, at]))
      out.push(m.reason === 'shipped' ? { k: 'stockBack', n: -num(m.n) } : { k: 'stockOut', n: num(m.n) });
    if (ev.to === 'delivered') out.push({ k: 'notDelivered' });
    // « Préparée » undone: its products are to take again (what was taken waits first in the depot's pool)
    if (ev.to === 'prepared' && ev.from === 'to_prepare') out.push({ k: 'repick' });
    if (needsParcel(o, String(ev.from))) out.push({ k: 'resend' });
    if ((await db.query(`SELECT 1 FROM depot_alerts WHERE order_id = $1 AND resolved_at IS NULL AND created_at = $2::timestamptz LIMIT 1`, [o.id, at]))[0]) out.push({ k: 'alertClosed' });
  }
  if ((await db.query(`SELECT 1 FROM notifications WHERE order_id = $1 AND status = 'queued' AND created_at = $2::timestamptz LIMIT 1`, [o.id, at]))[0]) out.push({ k: 'msgStopped' });
  return out;
}

async function holderName(db: Db, o: any): Promise<string | null> {
  return o.locked_by ? ((await db.query('SELECT name FROM profiles WHERE id = $1', [o.locked_by]))[0]?.name ?? null) : null;
}

/** A confirmation change undone: through setConf, which knows what leaving or coming back to the depot needs. */
async function undoConf(ctx: Ctx, o: any, act: Action) {
  const ev = act.main;
  const was = String(ev.to);
  const back = String(ev.from) as ConfStatus;
  if (!(CONF_STATUSES as readonly string[]).includes(back)) throw bad('Rien à remettre.');
  // the call it counted (« pas de réponse », « occupé », or the cancel after too many calls) is not counted any more
  const callFail = was === 'no_answer' || was === 'busy' || (ev.note ?? '').includes('Annulée automatiquement');
  // (its confirmation time is the app's clock of that moment: within seconds of the change, never an older one)
  const clearConfirmedAt =
    STAMPED.includes(was) &&
    !STAMPED.includes(back) &&
    (await ctx.db.query(`SELECT abs(extract(epoch FROM confirmed_at - $2::timestamptz)) < 5 AS c FROM orders WHERE id = $1`, [o.id, ev.atTxt]))[0]?.c === true;
  // the delivery status the change moved (null → À préparer, À préparer → Annulé…): as it was before it
  const fe = act.all.find((e) => e.kind === 'follow_status');
  // (written with the change since « ↶ » exists; older changes: one call less)
  const att = typeof ev.data?.att === 'number' ? ev.data.att : Math.max(0, num(o.attempts) - (callFail ? 1 : 0));
  // back to « à rappeler » / « reportée »: at the time it had (now if that time passed)
  const nca = typeof ev.data?.nca === 'string' && Date.parse(ev.data.nca) > ctx.now() ? ev.data.nca : null;
  const r = await setConf(ctx, { ids: [num(o.id)], status: back, nextCallAt: nca } as any, {
    undo: {
      eventIds: act.all.map((e) => e.id),
      attempts: att,
      clearConfirmedAt,
      follow: fe ? fe.from : undefined,
      line: { what: was, by: ev.name, at: ev.atTxt },
    },
  });
  if (!r.changed.length) throw bad(r.blocked[0]?.reason ?? 'La commande a changé depuis : rechargez-la.');
}

/** A delivery change undone: the order's fields, the stock, the customer's numbers, the depot's alert, as before it. */
async function undoFollow(ctx: Ctx, o: any, act: Action) {
  const ev = act.main;
  const me = ctx.session.profile.id;
  const was = String(ev.to);
  const back = String(ev.from);
  const at = ev.atTxt;
  // what the change replaced (written with every person's change since « ↶ » exists; older ones: the status only).
  // The tracking is never taken away: a parcel may have been made at the company since.
  const p = ev.data?.prev ?? null;
  const negative: string[] = [];
  await ctx.db.tx(async (tx) => {
    const cur = (await tx.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [o.id]))[0];
    const again = await lastAction(tx, num(o.id));
    if (!cur || cur.follow_status !== was || !again || again.main.id !== ev.id) throw bad('La commande a changé depuis : rechargez-la.');
    const f = (await tx.query('SELECT delivered_at = $2::timestamptz AS d, returned_at = $2::timestamptz AS r FROM orders WHERE id = $1', [o.id, at]))[0];
    await tx.query(
      `UPDATE orders SET follow_status = $2,
         shipped_at = CASE WHEN shipped_at = $3::timestamptz THEN NULL ELSE shipped_at END,
         prepared_at = CASE WHEN prepared_at = $3::timestamptz THEN NULL ELSE prepared_at END,
         delivered_at = CASE WHEN delivered_at = $3::timestamptz THEN NULL ELSE delivered_at END,
         returned_at = CASE WHEN returned_at = $3::timestamptz THEN NULL ELSE returned_at END,
         returning_at = CASE WHEN returning_at = $3::timestamptz THEN NULL ELSE returning_at END,
         delivery_attempts = GREATEST(0, delivery_attempts - CASE WHEN $4 = 'failed' THEN 1 ELSE 0 END),
         sub_status = CASE WHEN $5 THEN $6 ELSE sub_status END,
         follow_agent_id = CASE WHEN $5 THEN $7 ELSE follow_agent_id END,
         livreur_id = CASE WHEN $5 THEN $8 ELSE livreur_id END,
         cancel_by_hand = CASE WHEN $5 THEN $9 WHEN $4 = 'cancelled' THEN false ELSE cancel_by_hand END,
         updated_at = now(), version = version + 1
       WHERE id = $1`,
      [o.id, back, at, was, !!p, p?.sub ?? null, p?.fa ?? null, p?.lv ?? null, !!p?.cbh],
    );
    // a return the depot then put in the broken stock (« Cassé »): out of the broken stock first, as it came
    for (const m of await tx.query(`SELECT id, variant_id, warehouse_id, delta, broken_delta FROM stock_movements WHERE order_id = $1 AND reason = 'broken_return' AND created_at >= $2::timestamptz`, [o.id, at])) {
      await tx.query('UPDATE stock SET qty = qty - $3, broken = broken - $4 WHERE variant_id = $1 AND warehouse_id = $2', [m.variant_id, m.warehouse_id, num(m.delta), num(m.broken_delta)]);
      await tx.query('DELETE FROM stock_movements WHERE id = $1', [m.id]);
    }
    // the stock this change moved (the parcel left, or came back): as if it had not
    const moves = await tx.query(`SELECT id, variant_id, warehouse_id, delta FROM stock_movements WHERE order_id = $1 AND created_at = $2::timestamptz AND reason IN ('shipped', 'returned')`, [o.id, at]);
    for (const m of moves) {
      const left = await tx.query('UPDATE stock SET qty = qty - $3 WHERE variant_id = $1 AND warehouse_id = $2 RETURNING qty', [m.variant_id, m.warehouse_id, num(m.delta)]);
      await tx.query('DELETE FROM stock_movements WHERE id = $1', [m.id]);
      if (left[0] && num(left[0].qty) < 0) negative.push(`${num(left[0].qty)} pour la variante n° ${num(m.variant_id)}`);
    }
    // « Préparée » by mistake: back to « À préparer » with its products to take again — else, all taken, it would go
    // straight back to « En dispatch ». What was taken waits in the pool (used first by the next « J'ai pris »).
    if (was === 'prepared' && back === 'to_prepare') await releasePicked(tx, num(o.id));
    // the customer's numbers (counted once, when it first became so)
    if (was === 'delivered' && f?.d) await tx.query('UPDATE customers SET delivered = GREATEST(0, delivered - 1) WHERE id = $1', [cur.customer_id]);
    if (was === 'returned' && f?.r) await tx.query('UPDATE customers SET returned = GREATEST(0, returned - 1) WHERE id = $1', [cur.customer_id]);
    // the depot's red alert this change raised (a cancel): closed; its messages still waiting: not sent
    await tx.query('UPDATE depot_alerts SET resolved_at = now(), resolved_by = $3 WHERE order_id = $1 AND resolved_at IS NULL AND created_at = $2::timestamptz', [o.id, at, me]);
    await tx.query(`UPDATE notifications SET status = 'skipped', error = 'Changement annulé' WHERE order_id = $1 AND status = 'queued' AND created_at = $2::timestamptz`, [o.id, at]);
    await tx.query('DELETE FROM order_events WHERE order_id = $1 AND id = ANY($2)', [o.id, act.all.map((e) => e.id)]);
    await addEvent(tx, num(o.id), me, 'undo', was, back, null, { area: 'follow', by: ev.name, at });
    if (negative.length) await addEvent(tx, num(o.id), me, 'note', null, 'event', `Attention : stock négatif après l’annulation (${negative.join(', ')}) — vérifiez l’inventaire`);
    // refused / delivered: the customer's trust is worked out again
    if (TRUST.includes(was) || TRUST.includes(back)) {
      const t = await applyTrust(tx, numOrNull(cur.customer_id));
      if (t) await addEvent(tx, num(o.id), null, 'note', null, 'event', t);
    }
  });
  // back in « En dispatch » but its parcel was cancelled at the company: made there again (a refusal stays in
  // « En dispatch » with « Renvoyer », as for any parcel)
  const now = await orderRow(ctx.db, num(o.id));
  if (now && now.follow_status === back && needsParcel(now, back)) await dispatchOrders(asDepot(ctx), [num(o.id)]).catch(() => undefined);
}

/**
 * Undoes the last status change of one order. `eventId`: the change the person saw (refused if the order changed
 * since); none: their own change of the last 10 minutes (the « ↶ » of the message after a change).
 */
export async function undoOrder(ctx: Ctx, orderId: number, eventId: number | null) {
  await getOrder(ctx, orderId);
  const act = await lastAction(ctx.db, orderId);
  if (!act) throw bad('Aucun changement à annuler.');
  const ev = act.main;
  const now = ctx.now();
  if (eventId !== null && ev.id !== eventId) throw bad('La commande a changé depuis : rechargez-la.');
  if (eventId === null && (ev.userId !== ctx.session.profile.id || now - Date.parse(ev.at) > JUST_NOW_MS)) throw bad('Rien à annuler de votre part sur cette commande.');
  // (the « ↶ » of an older message after a change already undone: never the change before it as well)
  if (eventId === null && (await ctx.db.query(`SELECT 1 FROM order_events WHERE order_id = $1 AND kind = 'undo' AND at > $2::timestamptz LIMIT 1`, [orderId, ev.atTxt]))[0])
    throw bad('Ce changement est déjà annulé : rechargez la commande.');
  const o = await orderRow(ctx.db, orderId);
  const why = whyNot(ctx, o, act, now);
  if (why) throw bad(whyText(why, ev.name, await holderName(ctx.db, o)));
  if (ev.kind === 'conf_status') await undoConf(ctx, o, act);
  else await undoFollow(ctx, o, act);
  ctx.emit({ type: 'orders' });
  return { id: orderId, area: ev.kind === 'conf_status' ? ('conf' as const) : ('follow' as const), back: ev.from, was: ev.to };
}

export const undoProcs = {
  /** The last status change of an order: who made it, when, whether this person may undo it, and what it would do. */
  'orders.lastChange': proc(null, z.object({ id }), async (ctx, { id: orderId }) => {
    await getOrder(ctx, orderId);
    const act = await lastAction(ctx.db, orderId);
    if (!act) return null;
    const ev = act.main;
    const o = await orderRow(ctx.db, orderId);
    const why = whyNot(ctx, o, act, ctx.now());
    return {
      eventId: ev.id,
      area: ev.kind === 'conf_status' ? ('conf' as const) : ('follow' as const),
      from: ev.from,
      to: ev.to,
      at: ev.at,
      by: ev.name,
      mine: ev.userId === ctx.session.profile.id,
      why,
      holder: why === 'held' ? await holderName(ctx.db, o) : null,
      effects: why ? [] : await effectsOf(ctx.db, o, act),
    };
  }),

  /** « ↶ Annuler »: the last status change of this order goes back. */
  'orders.undo': proc(null, z.object({ id, eventId: id.optional() }), (ctx, i) => undoOrder(ctx, i.id, i.eventId ?? null)),

  /** « ↶ » after a change of many orders at once: each one's change by this person in the last 10 minutes goes back. */
  'orders.undoMany': proc(null, z.object({ ids: z.array(id).min(1).max(300) }), async (ctx, { ids }) => {
    const done: number[] = [];
    const refused: { id: number; why: string }[] = [];
    for (const oid of [...new Set(ids)]) {
      try {
        await undoOrder(ctx, oid, null);
        done.push(oid);
      } catch (e) {
        refused.push({ id: oid, why: (e as Error)?.message ?? String(e) });
      }
    }
    return { done, refused };
  }),
};
