// Dépôt: from « À préparer » to « En dispatch ».
//  - An order whose products are all picked goes to « En dispatch » by itself when it has a company (its parcel is
//    created at the courier, its label ready) — or our own delivery with its livreur. No « Envoyer au dispatch » click.
//  - The others wait in « À attribuer »: no company yet, or « Livraison privée » without a livreur. Only managers (people
//    ticked in Utilisateurs) and admins choose there; the order then goes to « En dispatch » by itself.
//  - A parcel the courier refuses stays in « En dispatch » with the reason, and « Renvoyer » / « Autre société ».
//  - A cancelled order whose parcel is at a courier: Pilotix cancels it there by itself; a courier whose system cannot
//    cancel puts it on « À annuler à la main » (the depot cancels it in the courier's space, then « C'est fait »).
//  - A parcel still « En dispatch » after 24 h is late (the courier did not take it).
import { algiersDayStart, API_COURIER_KINDS } from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, num } from '../db';
import { bad, Ctx, forbidden, proc } from '../rpc';
import { autoSettings } from '../settings';
import { cancelParcel, sendOrders } from './delivery';
import { checkedInToday, tellLivreur } from './livreur';
import { addEvent, assignCompanies, getOrder, setFollow } from './orders';
import { privateBackupRun } from './pilot';

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
export const asDepot = (ctx: Ctx): Ctx => (ctx.session.roles.includes('depot') ? ctx : { ...ctx, session: { ...ctx.session, roles: [...ctx.session.roles, 'depot'] } });

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
    if (list.length) await assignCompanies(ctx, { ids: list, companyId }, { check: false });
  }
  const pick = async (sql: string, ...more: unknown[]) => (list.length ? (await ctx.db.query(sql, [list, ...more])).map((r: any) => num(r.id)) : []);
  // only confirmed orders leave the depot (one sent back to be called again never goes out)
  const toMove = await pick(`SELECT id FROM orders WHERE id = ANY($1) AND follow_status = 'to_prepare' AND (conf_status = 'confirmed' OR is_exchange)`);
  const moved = toMove.length ? (await setFollow(ctx, { ids: toMove, status: 'prepared' })).changed.length : 0;
  // out of « À attribuer »: its waiting time starts again if it ever comes back
  if (toMove.length) await ctx.db.query('UPDATE orders SET assign_wait_since = NULL WHERE id = ANY($1) AND follow_status = \'prepared\'', [toMove]);
  const toSend = await pick(
    `SELECT o.id FROM orders o JOIN delivery_companies c ON c.id = o.company_id
     WHERE o.id = ANY($1) AND o.follow_status = 'prepared' AND (o.conf_status = 'confirmed' OR o.is_exchange) AND o.tracking IS NULL AND c.kind = ANY($2)`,
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

/**
 * « Envoyer au dispatch » and « Société… » (the depot's own buttons): an order leaves « À préparer » only once all its
 * products are picked, and with a company (our own delivery: with its livreur). Choosing the company of an order still
 * in « À préparer » is « À attribuer »'s job: managers and admins only. « Autre société » in « En dispatch » stays the
 * depot's (a refused parcel), but never to our own delivery without a livreur.
 */
export async function checkDispatch(ctx: Ctx, ids: number[], companyId?: number) {
  const target = companyId ? (await ctx.db.query('SELECT kind, active FROM delivery_companies WHERE id = $1', [companyId]))[0] : null;
  if (companyId && (!target || !target.active)) throw bad('Société introuvable');
  const rows = await ctx.db.query(
    `SELECT o.id, o.ref, o.follow_status, o.company_id, o.livreur_id, c.kind, (${READY_SQL}) AS ready
       FROM orders o LEFT JOIN delivery_companies c ON c.id = o.company_id WHERE o.id = ANY($1)`,
    [ids],
  );
  for (const r of rows) {
    if (r.follow_status !== 'to_prepare' && r.follow_status !== 'prepared') continue;
    const kind = companyId ? target.kind : r.kind;
    // (a new company forgets the livreur: our own delivery then needs « À attribuer »)
    if (kind === 'own' && (companyId ? num(r.company_id) !== companyId || !r.livreur_id : !r.livreur_id))
      throw bad(`${r.ref} : Livraison privée sans livreur — choisissez-le dans « À attribuer »`);
    if (r.follow_status !== 'to_prepare') continue;
    if (!r.ready) throw bad(`${r.ref} : tous ses produits ne sont pas encore pris (« J’ai pris »)`);
    if (companyId && num(r.company_id) !== companyId && !canAssign(ctx)) throw forbidden('Seuls les managers et les admins choisissent la société (« À attribuer »)');
    if (!companyId && !r.company_id) throw bad(`${r.ref} : pas encore de société — elle se choisit dans « À attribuer »`);
  }
}

/** A parcel the courier refused: the reason stays on the order (shown in « En dispatch ») and in its history. */
export async function keepRefusal(db: Db, orderId: number, error: string, userId: number | null) {
  const had = (await db.query('SELECT send_error FROM orders WHERE id = $1', [orderId]))[0]?.send_error;
  await db.query('UPDATE orders SET send_error = $2, send_error_at = now() WHERE id = $1', [orderId, error.slice(0, 500)]);
  if (had !== error) await addEvent(db, orderId, userId, 'note', null, 'event', `Colis refusé par la société : ${error}`);
}

/** A livreur's parcels today: those he still has to deliver (or bring back), and those he finished today. */
const OPEN_OWN = ['prepared', 'shipped', 'out_for_delivery', 'failed', 'alert', 'in_exchange', 'returning'];

/** The livreurs who said « Je travaille aujourd'hui » (when), with their parcels today (`n`) and those in hand now
 *  (`hands`: still to deliver or bring back), fewest first, and the « Livraison privée » they belong to (none: any). */
export async function livreursToday(
  db: Db,
  now: number,
): Promise<{ id: number; name: string; at: string; n: number; hands: number; companyId: number | null }[]> {
  const inToday = await checkedInToday(db, now);
  if (!inToday.size) return [];
  const people = await db.query(`SELECT id, name, livreur_company_id FROM profiles WHERE active AND 'livreur' = ANY(roles) AND id = ANY($1)`, [[...inToday.keys()]]);
  const n = new Map<number, number>();
  const hands = new Map<number, number>();
  for (const r of await db.query(
    `SELECT livreur_id, count(*)::int AS n, count(*) FILTER (WHERE follow_status = ANY($2))::int AS hands FROM orders
      WHERE livreur_id = ANY($1) AND (follow_status = ANY($2) OR delivered_at >= $3 OR returned_at >= $3) GROUP BY 1`,
    [people.map((p: any) => num(p.id)), OPEN_OWN, new Date(algiersDayStart(now)).toISOString()],
  )) {
    n.set(num(r.livreur_id), num(r.n));
    hands.set(num(r.livreur_id), num(r.hands));
  }
  return people
    .map((p: any) => ({
      id: num(p.id),
      name: String(p.name),
      at: inToday.get(num(p.id))!,
      n: n.get(num(p.id)) ?? 0,
      hands: hands.get(num(p.id)) ?? 0,
      companyId: p.livreur_company_id ? num(p.livreur_company_id) : null,
    }))
    .sort((a: { n: number; at: string }, b: { n: number; at: string }) => a.n - b.n || Date.parse(a.at) - Date.parse(b.at));
}

/** Ready « Livraison privée » orders still without a livreur. */
export async function ownWaiting(db: Db): Promise<number[]> {
  return (
    await db.query(`SELECT o.id FROM orders o JOIN delivery_companies c ON c.id = o.company_id WHERE ${READY_SQL} AND c.kind = 'own' AND c.active AND o.livreur_id IS NULL ORDER BY o.id`)
  ).map((r: any) => num(r.id));
}

/**
 * Pilot Automations' « Livreur automatique »: ready « Livraison privée » orders with no livreur go, oldest first, to
 * the livreur who said « Je travaille aujourd'hui » with the fewest parcels today — one at a time, so a batch is shared
 * out; equal: the first who checked in. Only a livreur of the order's « Livraison privée » (or of none), and under the
 * shop's maximum in hand. Nobody checked in (or all at their maximum): they wait in « À attribuer » (then the backup
 * company), and the job gives them as soon as one checks in or delivers.
 * Returns each livreur given orders, with how many (his notification comes after the dispatch).
 */
async function giveToLivreurs(ctx: Ctx, rows: { id: number; companyId: number }[], max: number): Promise<{ id: number; name: string; n: number }[]> {
  if (!rows.length) return [];
  const today = await livreursToday(ctx.db, ctx.now());
  if (!today.length) return [];
  const load = new Map<number, number>(today.map((l) => [l.id, l.n]));
  const hands = new Map<number, number>(today.map((l) => [l.id, l.hands]));
  const names = new Map<number, string>(today.map((l) => [l.id, l.name]));
  const since = new Map<number, string>(today.map((l) => [l.id, l.at]));
  const company = new Map<number, number | null>(today.map((l) => [l.id, l.companyId]));
  const first = (a: number, b: number) => load.get(a)! - load.get(b)! || Date.parse(since.get(a)!) - Date.parse(since.get(b)!) || a - b;
  const groups = new Map<string, number[]>();
  const given = new Map<number, number>();
  for (const r of [...rows].sort((a, b) => a.id - b.id)) {
    const l = [...load.keys()].filter((x) => (company.get(x) === null || company.get(x) === r.companyId) && (!max || hands.get(x)! < max)).sort(first)[0];
    if (l === undefined) continue;
    load.set(l, load.get(l)! + 1);
    hands.set(l, hands.get(l)! + 1);
    given.set(l, (given.get(l) ?? 0) + 1);
    groups.set(`${r.companyId}:${l}`, [...(groups.get(`${r.companyId}:${l}`) ?? []), r.id]);
  }
  for (const [k, list] of groups) {
    const [companyId, livreurId] = k.split(':').map(Number);
    await assignCompanies(asDepot(ctx), { ids: list, companyId, livreurId }, { check: false });
    for (const oid of list) await addEvent(ctx.db, oid, null, 'note', null, 'event', `Livreur automatique : ${names.get(livreurId)}`);
  }
  return [...given].map(([lid, n]) => ({ id: lid, name: names.get(lid)!, n }));
}

/**
 * Orders just picked whole (or any ready ones): with a company — or own delivery with its livreur — to « En dispatch ».
 * Pilot Automations' « Dispatch automatique » switched off: they all wait in « À attribuer » for a manager. With its
 * « Livreur automatique » on, « Livraison privée » ones get their livreur first (giveToLivreurs).
 */
export async function autoDispatch(ctx: Ctx, ids?: number[]) {
  const rows = await ctx.db.query(
    `SELECT o.id, o.company_id, o.livreur_id, c.kind, c.active FROM orders o LEFT JOIN delivery_companies c ON c.id = o.company_id
      WHERE ${READY_SQL} ${ids ? 'AND o.id = ANY($1)' : ''}`,
    ids ? [ids] : [],
  );
  const auto = await autoSettings(ctx.db);
  const by = auto.autoDispatch;
  let livreurs: { id: number; name: string; n: number }[] = [];
  if (by && auto.livreurAuto) {
    const own = rows.filter((r: any) => r.company_id && r.active && r.kind === 'own' && !r.livreur_id);
    livreurs = await giveToLivreurs(ctx, own.map((r: any) => ({ id: num(r.id), companyId: num(r.company_id) })), auto.livreurMax);
    if (livreurs.length) {
      const now = (await ctx.db.query(`SELECT id, livreur_id FROM orders WHERE id = ANY($1)`, [own.map((r: any) => num(r.id))])) as any[];
      for (const r of rows) {
        const x = now.find((y) => num(y.id) === num(r.id));
        if (x) r.livreur_id = x.livreur_id;
      }
      await ctx.db.query(`INSERT INTO auto_log (kind, at, data, n) VALUES ('livreur', $1, $2, $3)`, [
        new Date(ctx.now()).toISOString(),
        JSON.stringify({ livreurs: livreurs.map((l) => ({ name: l.name, n: l.n })) }),
        livreurs.reduce((a, l) => a + l.n, 0),
      ]);
    }
  }
  const go = by ? rows.filter((r: any) => r.company_id && r.active && (r.kind !== 'own' || r.livreur_id)).map((r: any) => num(r.id)) : [];
  // the others start waiting for a person in « À attribuer » (« Livraison privée » ones go to the backup company after a while)
  const wait = rows.map((r: any) => num(r.id)).filter((x: number) => !go.includes(x));
  if (wait.length) await ctx.db.query('UPDATE orders SET assign_wait_since = now() WHERE id = ANY($1) AND assign_wait_since IS NULL', [wait]);
  const r = go.length ? await dispatchOrders(asDepot(ctx), go) : { moved: 0, sent: 0, failed: [] };
  // each livreur given orders hears it on his phone (« Passez au dépôt et scannez-les »)
  for (const l of livreurs) await tellLivreur(ctx, l.id, l.n);
  return { dispatched: r.moved, failed: r.failed, toAssign: rows.length - go.length };
}

/** « À attribuer »: ready orders without a company, or « Livraison privée » without a livreur (every ready order when
 *  Pilot Automations' « Dispatch automatique » is off). */
async function toAssignList(ctx: Ctx) {
  const all = !(await autoSettings(ctx.db)).autoDispatch;
  const rows = await ctx.db.query(
    `SELECT o.id FROM orders o LEFT JOIN delivery_companies c ON c.id = o.company_id
      WHERE ${READY_SQL}${all ? '' : ` AND (o.company_id IS NULL OR NOT c.active OR (c.kind = 'own' AND o.livreur_id IS NULL))`}
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
    await privateBackupRun(asDepot(ctx));
    return { canAct: canAssign(ctx), rows: await toAssignList(ctx) };
  }),

  /** « Drop off » (managers and admins): the ticked orders go back to « À préparer »; their products go back on the shelf. */
  'depot.dropOff': proc(['depot'], z.object({ ids: z.array(id).min(1).max(300) }), async (ctx, i) => {
    if (!canAssign(ctx)) throw forbidden('Seuls les managers et les admins changent les commandes à attribuer');
    const ready = (await ctx.db.query(`SELECT o.id FROM orders o WHERE o.id = ANY($1) AND ${READY_SQL}`, [i.ids])).map((r: any) => num(r.id));
    if (!ready.length) throw bad('Ces commandes ne sont plus à attribuer');
    await ctx.db.tx(async (tx) => {
      await tx.query('UPDATE order_items SET picked_qty = 0 WHERE order_id = ANY($1)', [ready]);
      await tx.query('UPDATE orders SET assign_wait_since = NULL WHERE id = ANY($1)', [ready]);
      for (const oid of ready) await addEvent(tx, oid, ctx.session.profile.id, 'note', null, 'event', 'Remise à préparer (Drop off) : produits reposés en rayon');
    });
    ctx.emit({ type: 'orders' });
    return { done: ready.length };
  }),

  /** « Annuler » (managers and admins): the ticked orders go to Annulé, with the reason; their products go back on the shelf. */
  'depot.assignCancel': proc(['depot'], z.object({ ids: z.array(id).min(1).max(300), reason: z.string().trim().min(1).max(200) }), async (ctx, i) => {
    if (!canAssign(ctx)) throw forbidden('Seuls les managers et les admins changent les commandes à attribuer');
    const ready = (await ctx.db.query(`SELECT o.id FROM orders o WHERE o.id = ANY($1) AND ${READY_SQL}`, [i.ids])).map((r: any) => num(r.id));
    if (!ready.length) throw bad('Ces commandes ne sont plus à attribuer');
    // the people who choose here may cancel these (not yet with any company)
    const c = ctx.session.roles.includes('suivi') ? ctx : { ...ctx, session: { ...ctx.session, roles: [...ctx.session.roles, 'suivi' as const] } };
    await setFollow(c as Ctx, { ids: ready, status: 'cancelled', reason: i.reason });
    ctx.emit({ type: 'orders' });
    return { done: ready.length };
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
    await assignCompanies(dctx, { ids: ready, companyId: i.companyId, livreurId: c.kind === 'own' ? (i.livreurId ?? null) : null }, { check: false });
    const r = await dispatchOrders(dctx, ready);
    // our own livreur: a notification on his phone (checked in today or not)
    if (c.kind === 'own' && i.livreurId) await tellLivreur(ctx, i.livreurId, ready.length);
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
