// Confirmation › « Bloquer jusqu'à l'appel » (owner's ask, 22 Nov 2026): a new order given to a store's plain confirmation
// agent covers his whole Pilotix (the order card, design 3) and rings until he taps « Appeler »; it lets him go only
// once he has saved a result for it (Confirmée, Pas de réponse, À rappeler…). Pilotix cannot hear the call itself: the
// tap on « Appeler » is counted (orders.logCall), and the result is what unlocks.
//  - one order at a time, the oldest first, only during the shop's calling hours (never at night);
//  - never in the middle of another order: while he has another order open (kept for him, hold.tsx), it waits;
//  - the managers (agent managers, the owner, the administrators) switch it on or off for the whole shop; off in a new
//    shop; they are never blocked themselves; a confirmation agency's people are not blocked (not yet).
// While Pilotix is not open in front of him, his devices get a notification (Web Push, « Activer les notifications »):
// at once, then again every 5 minutes, 6 times at most, as long as the order waits for him.
import { CONF_TODO, Order, slotAt, WILAYAS } from '@pilotix/shared';
import { z } from 'zod';
import { Db, num } from '../db';
import { Ctx, forbidden, hasRole, proc } from '../rpc';
import { getSetting, setSetting, SettingsMap } from '../settings';
import { agencyLead, agencyOf, andSql, queueSql } from './agencyscope';
import { getOrder, withClientScores } from './orders';
import { sendPush } from './push';

/** a notification again after this long while the order still waits for him */
export const RING_AGAIN_MS = 5 * 60_000;
/** at most this many notifications for one order (the first one + 5 reminders) */
export const RINGS_MAX = 6;

/** A store's own plain confirmation agent: blocked (not a manager, the owner nor an administrator; not an agency's person). */
export function plainAgent(ctx: Ctx): boolean {
  const s = ctx.session;
  if (s.isAdmin || !s.roles.includes('confirmation')) return false;
  if (s.roles.includes('agent_manager') || s.roles.includes('vendeur')) return false;
  return agencyOf(ctx) === null && !agencyLead(ctx);
}

/** The people who switch it on or off: the shop's managers (agent managers, the owner) and its administrators. */
const canSwitch = (ctx: Ctx) => agencyOf(ctx) === null && (ctx.session.isAdmin || hasRole(ctx.session, 'agent_manager', 'vendeur'));

/** What the notification says (French, like the other notifications of the server). */
function ringText(r: { id: unknown; ref: string; customer_name: string; wilaya_id: unknown; items: string | null }, before: number) {
  const where = WILAYAS[num(r.wilaya_id) - 1] ?? '';
  const what = [r.customer_name, r.items, where].filter(Boolean).join(' · ');
  return {
    title: before ? `📞 ${r.ref} attend toujours votre appel` : '📞 Nouvelle commande à appeler',
    body: `${what} — ouvrez Pilotix pour appeler`,
    tag: `conf-new-${num(r.id)}`,
    url: '#/confirmation/nouvelles',
    alarm: true,
  };
}

const BlockSet = z.object({ on: z.boolean() });

export const confBlockProcs = {
  /** The switch: on or off, who changed it last, and whether this person may change it. */
  'confirmation.blockGet': proc(['confirmation'], z.object({}), async (ctx) => {
    const b = await getSetting(ctx.db, 'confBlock');
    return { on: !!b.on, by: b.by ?? null, at: b.at ?? null, canSwitch: canSwitch(ctx) };
  }),

  /** On or off, for the whole shop: the managers only. Off: nothing waits to ring any more. */
  'confirmation.blockSet': proc(['confirmation'], BlockSet, async (ctx, i) => {
    if (!canSwitch(ctx)) throw forbidden('Seuls les managers allument ou éteignent le blocage des nouvelles commandes');
    const v: SettingsMap['confBlock'] = { on: i.on, by: ctx.session.profile.name, at: new Date(ctx.now()).toISOString() };
    await setSetting(ctx.db, 'confBlock', v, ctx.session.profile.id);
    if (!i.on) await setSetting(ctx.db, 'confRings', {}, ctx.session.profile.id);
    ctx.emit({ type: 'settings' });
    return { on: v.on, by: v.by, at: v.at };
  }),

  /**
   * For a plain agent: the new order that blocks his screen now (null: none), whether he already tapped « Appeler » on
   * it, and how many more new orders of his come after it. `wait`: one is there, but he is busy with another order.
   */
  'confirmation.blocking': proc(['confirmation'], z.object({}), async (ctx) => {
    const none = { on: false, order: null as Order | null, called: false, queue: 0, wait: false };
    if (!plainAgent(ctx)) return none;
    if (!(await getSetting(ctx.db, 'confBlock')).on) return none;
    const on = { ...none, on: true };
    // never at night: only while the shop calls its customers
    if (!slotAt(ctx.now(), await getSetting(ctx.db, 'calls')).open) return on;
    const me = ctx.session.profile.id;
    const rows = await ctx.db.query(
      `SELECT o.id FROM sales o
        WHERE o.conf_status = 'new' AND o.agent_id = $1${andSql(queueSql(ctx, 'conf'))}
          AND (o.locked_by IS NULL OR o.locked_by = $1 OR o.locked_until < now())
        ORDER BY o.created_at, o.id LIMIT 100`,
      [me],
    );
    if (!rows.length) return on;
    const first = num(rows[0].id);
    // in the middle of another order (open on his screen, kept for him): it waits until he has finished that one
    const busy = await ctx.db.query('SELECT 1 FROM orders WHERE locked_by = $1 AND locked_until > now() AND id <> $2 AND conf_status = ANY($3) LIMIT 1', [me, first, CONF_TODO]);
    if (busy.length) return { ...on, queue: rows.length, wait: true };
    const order = (await withClientScores(ctx, [await getOrder(ctx, first)]))[0];
    const called = (await ctx.db.query(`SELECT 1 FROM order_events WHERE order_id = $1 AND user_id = $2 AND kind = 'call' LIMIT 1`, [first, me])).length > 0;
    return { ...on, order, called, queue: rows.length - 1 };
  }),

  /**
   * Every 30 seconds (scheduled job): the agents away from Pilotix with a new order waiting for them get a notification
   * on their devices — at once, then every 5 minutes, 6 times at most. Someone in Pilotix right now hears it ring there.
   */
  'confirmation.pushRun': proc([], z.object({}), async (ctx) => {
    const rings = await getSetting(ctx.db, 'confRings');
    const keep = async (next: SettingsMap['confRings']) => {
      if (JSON.stringify(next) !== JSON.stringify(rings)) await setSetting(ctx.db, 'confRings', next);
    };
    if (!(await getSetting(ctx.db, 'confBlock')).on) {
      await keep({});
      return { sent: 0, waiting: 0 };
    }
    const now = ctx.now();
    // the store's own orders given to its plain agents (not a manager, the owner nor an administrator)
    const rows = await ctx.db.query(
      `SELECT o.id, o.ref, o.customer_name, o.wilaya_id, o.agent_id,
              (SELECT string_agg(CASE WHEN i.qty > 1 THEN i.qty || ' × ' ELSE '' END || i.name, ' + ' ORDER BY i.id) FROM order_items i WHERE i.order_id = o.id) AS items
         FROM sales o JOIN profiles p ON p.id = o.agent_id
        WHERE o.conf_status = 'new' AND o.conf_agency_id IS NULL AND p.active AND p.agency_id IS NULL
          AND 'confirmation' = ANY(p.roles) AND NOT (p.roles && '{admin,agent_manager,vendeur}'::text[])
        ORDER BY o.created_at, o.id`,
    );
    // never at night: what waits keeps its count, nothing rings
    if (!slotAt(now, await getSetting(ctx.db, 'calls')).open) {
      const left: SettingsMap['confRings'] = {};
      for (const r of rows) if (rings[String(r.id)]) left[String(r.id)] = rings[String(r.id)];
      await keep(left);
      return { sent: 0, waiting: rows.length };
    }
    const agents = [...new Set(rows.map((r: any) => num(r.agent_id)))];
    const away = new Set(
      agents.length
        ? (await ctx.db.query(`SELECT id FROM profiles WHERE id = ANY($1) AND (last_seen_at IS NULL OR last_seen_at < now() - interval '75 seconds' OR presence = 'idle')`, [agents])).map((r: any) => num(r.id))
        : [],
    );
    const next: SettingsMap['confRings'] = {};
    let sent = 0;
    for (const r of rows) {
      const key = String(r.id);
      const agent = num(r.agent_id);
      // given to someone else since: his count starts again
      const prev = rings[key] && rings[key].a === agent ? rings[key] : null;
      const due = !prev || (now - prev.at >= RING_AGAIN_MS && prev.n < RINGS_MAX);
      if (due && away.has(agent)) {
        sent += await sendPush(ctx, [agent], ringText(r, prev?.n ?? 0)).catch(() => 0);
        next[key] = { a: agent, at: now, n: (prev?.n ?? 0) + 1 };
      } else if (prev) next[key] = prev;
    }
    await keep(next);
    return { sent, waiting: rows.length };
  }),
};

/**
 * The Claude demo only (the Pilotix artifact, lib/backend.ts): on, and Rania (a plain agent) has two new orders to call,
 * so her « Essayer » link (#essayer-rania---confirmation--nouvelles) shows it at once; Yacine (a manager) sees the switch.
 */
export async function seedBlockDemo(db: Db) {
  await setSetting(db, 'confBlock', { on: true, by: 'Yacine', at: new Date().toISOString() });
  const r = (await db.query(`SELECT id FROM profiles WHERE email = 'rania@demo.pilotix.dz'`))[0];
  if (!r) return;
  const rania = num(r.id);
  await db.query('UPDATE orders SET locked_by = NULL, locked_until = NULL WHERE locked_by = $1', [rania]);
  if ((await db.query(`SELECT 1 FROM orders WHERE agent_id = $1 AND conf_status = 'new' LIMIT 1`, [rania]))[0]) return;
  await db.query(
    `UPDATE orders SET agent_id = $1, assigned_at = now(), locked_by = NULL, locked_until = NULL
      WHERE id IN (SELECT id FROM orders WHERE conf_status = 'new' AND agent_id IS NULL AND conf_agency_id IS NULL AND NOT is_exchange ORDER BY created_at DESC LIMIT 2)`,
    [rania],
  );
}
