// Who works an order (owner's rule, 26 Nov 2026 — « each user has their own order », « for agency they get from canal not
// product »):
// - an order a person typed (a call, a chat, « Dupliquer ») stays that person's: on his side (the store's team, or his
//   agency), with him as its agent when he confirms (a Community manager confirms her own orders);
// - one that came by itself goes by its channel: a landing page's (its form, a number left on it, one brought back from
//   Bloquées or from the unsent forms) to the boutique's confirmation agency; a chat Dellal answered to the person in
//   charge of that chat (none: the store's team, its manager gives it); the others (the site, a Meta form, a Google Sheet)
//   to the store's own team. The product no longer decides.
// - Suivi and SAV stay with the side that confirmed the order; an agency doing Suivi (or SAV) without the confirmation
//   follows the landing pages' orders.
// - One agency per task in a boutique (agencies.ts: clash). The seller gives an order to the agency, or takes it back,
//   from « Assigner un agent » (orders.ts: orders.giveAgency, orders.assignAgent).
// Orders made before this rule keep the side they had.
import type { OrderCame } from '@pilotix/shared';
import { Db, num, numOrNull } from '../db';
import { Ctx, hasRole } from '../rpc';

export type RouteTask = 'confirmation' | 'suivi' | 'sav';

/** How a landing page's orders come: its form, a number left on it (Pilotix, or a person), one restored from Bloquées. */
export const LANDING_CAME: readonly OrderCame[] = ['form', 'abandoned', 'recovered', 'restored'];
/** The orders Dellal takes in a chat (answered, or made by itself when the customer went quiet). */
const CHAT_CAME: readonly OrderCame[] = ['chat', 'chat_auto'];
/** Typed by a person of the boutique (a call, a message, a visit), or a copy of another order. */
const TYPED_CAME: readonly OrderCame[] = ['hand', 'copy'];

/** The agency doing this task in the boutique (null: the store's own team). */
export async function taskAgency(db: Db, task: RouteTask): Promise<number | null> {
  const r = (await db.query('SELECT agency_id FROM agency_routes WHERE task = $1 ORDER BY (product_id IS NULL) DESC, agency_id LIMIT 1', [task]))[0];
  return r ? num(r.agency_id) : null;
}

/** SQL (an orders row `o`): is it a landing page's order? */
export const landingSql = (o: string) => `(${o}.landing_id IS NOT NULL OR ${o}.came IN (${LANDING_CAME.map((c) => `'${c}'`).join(', ')}))`;

/**
 * SQL (an orders row `o`): the agency following the order for Suivi or SAV — the agency that confirms it when it does
 * that task too; for a landing page's order, an agency doing that task without the confirmation; else null (the
 * store's own team).
 */
export const sideSql = (task: 'suivi' | 'sav', o: string) => `(CASE
  WHEN ${o}.conf_agency_id IS NOT NULL AND EXISTS (SELECT 1 FROM agency_routes sr WHERE sr.task = '${task}' AND sr.agency_id = ${o}.conf_agency_id) THEN ${o}.conf_agency_id
  WHEN ${landingSql(o)} THEN (SELECT sr.agency_id FROM agency_routes sr WHERE sr.task = '${task}'
    AND NOT EXISTS (SELECT 1 FROM agency_routes sc WHERE sc.task = 'confirmation' AND sc.agency_id = sr.agency_id) ORDER BY sr.agency_id LIMIT 1)
  END)`;

/** The same in code, for a new order (its confirmation side and whether a landing page sent it). */
async function sideOf(db: Db, task: 'suivi' | 'sav', confAgencyId: number | null, landing: boolean): Promise<number | null> {
  if (confAgencyId !== null && (await db.query('SELECT 1 FROM agency_routes WHERE task = $1 AND agency_id = $2 LIMIT 1', [task, confAgencyId])).length) return confAgencyId;
  if (!landing) return null;
  const r = (await db.query(
    `SELECT r.agency_id FROM agency_routes r WHERE r.task = $1
       AND NOT EXISTS (SELECT 1 FROM agency_routes c WHERE c.task = 'confirmation' AND c.agency_id = r.agency_id) ORDER BY r.agency_id LIMIT 1`,
    [task],
  ))[0];
  return r ? num(r.agency_id) : null;
}

export interface NewOrderWork {
  /** the agency confirming it (null: the store's own team) */
  confAgencyId: number | null;
  /** its confirmation agent from the start (null: its team gives it — a manager, an agency's chief, the Affectation) */
  agentId: number | null;
  /** the agency following it in Suivi (null: the store's own team) */
  followAgencyId: number | null;
}

/** Who works a new order (not an exchange parcel of the SAV: those stay with the store's team). */
export async function newOrderWork(db: Db, ctx: Ctx, o: { came: OrderCame; conversationId: number | null; stamped: boolean; landing: boolean }): Promise<NewOrderWork> {
  const me = ctx.session.profile.id;
  const mySide = ctx.session.profile.agencyId ?? null;
  let confAgencyId: number | null = null;
  let agentId: number | null = null;
  if (o.stamped) {
    // made already confirmed (a person who ticked « Confirmer », the AI seller): its maker confirmed it
    confAgencyId = mySide;
    agentId = me;
  } else if (TYPED_CAME.includes(o.came)) {
    // typed by a person: his, always — on his side, with him as its agent when he confirms
    confAgencyId = mySide;
    if (hasRole(ctx.session, 'confirmation')) agentId = me;
  } else if (o.landing) {
    confAgencyId = await taskAgency(db, 'confirmation');
  } else if (CHAT_CAME.includes(o.came) && o.conversationId) {
    // Dellal took it in a chat: the person in charge of that chat (who took it over), on her side
    const p = (await db.query(
      `SELECT p.id, p.agency_id FROM conversations c JOIN profiles p ON p.id = c.assigned_to
        WHERE c.id = $1 AND p.active AND p.roles && '{cm,confirmation,agent_manager,vendeur,admin}'::text[]`,
      [o.conversationId],
    ))[0];
    if (p) {
      agentId = num(p.id);
      confAgencyId = numOrNull(p.agency_id);
    }
  }
  // the site, a Meta form, a Google Sheet, a test: the store's own team
  return { confAgencyId, agentId, followAgencyId: await sideOf(db, 'suivi', confAgencyId, o.landing) };
}

/**
 * Orders whose confirmation side just changed (given to the agency, taken back): their Suivi follows it, while no
 * parcel left yet (a new side has no agent yet).
 */
export async function followConfSide(db: Db, ids: number[]) {
  if (!ids.length) return;
  await db.query(
    `UPDATE orders o SET follow_agency_id = s.side, follow_agent_id = NULL
     FROM (SELECT x.id, ${sideSql('suivi', 'x')} AS side FROM orders x WHERE x.id = ANY($1)) s
     WHERE o.id = s.id AND o.shipped_at IS NULL AND o.follow_agency_id IS DISTINCT FROM s.side`,
    [ids],
  );
}
