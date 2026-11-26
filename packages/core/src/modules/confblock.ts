// Confirmation › « Bloquer jusqu'à l'appel » (owner's ask, 22 Nov 2026): a new order given to a store's plain confirmation
// agent rings his phone and covers Pilotix there (the order card, design 3) until he taps « Appeler »; it lets him go
// only once he has saved a result for it (Confirmée, Pas de réponse, À rappeler…). Pilotix cannot hear the call itself:
// the tap on « Appeler » is counted (orders.logCall), and the result is what unlocks.
//  - his PHONE (owner's choice, 22 Nov 2026: the Pilotix app installed from Chrome): his computer is never blocked for an
//    order, it shows a line « PX… attend votre appel »;
//  - but in his work time neither his computer nor his phone works until his phone is ready to ring (owner's ask, same
//    day): notifications on in the Pilotix app, a test ring that reached the phone (its worker said so, sw.js) and the
//    agent tapped « Je l'ai entendu » with the volume up — at the start of each shift. Notifications turned off, or a
//    ring the phone does not answer for 3 minutes: everything is blocked again until it is fixed (`gate`). A website
//    cannot see the phone's volume nor turn it up: the agent says he heard it (the Android app will check it);
//  - his work time: the shift the managers typed for him (Confirmation, under their switch), else the shop's calling
//    hours (Réglages › Appels); never at night;
//  - one order at a time, the newest first (owner's rule « last in, first out », 22 Nov 2026) — but the new order on his
//    screen (kept for him, hold.tsx) or the one he called and has not saved a result for stays his until its result is
//    saved; then the newest of the others rings at once. Never in the middle of another order (while he has another,
//    not new, order open, it waits);
//  - the phone rings with a notification (Web Push) as soon as the order is his, then again every 2 minutes until he
//    calls, whether he is in Pilotix on his computer or not; Pilotix open on the phone rings there itself;
//  - the managers (agent managers, the owner, the administrators) switch it on or off for the whole shop; off in a new
//    shop; they are never blocked themselves; a confirmation agency's people are not blocked (not yet). Under their
//    switch: each agent's shift and whether his phone is ready.
import { algiersDayStart, CONF_TODO, Order, slotAt, WILAYAS } from '@pilotix/shared';
import { z } from 'zod';
import { Db, num } from '../db';
import { bad, Ctx, forbidden, hasRole, proc } from '../rpc';
import { getSetting, setSetting, SettingsMap } from '../settings';
import { agencyLead, agencyOf, andSql, queueSql } from './agencyscope';
import { getOrder, withClientScores } from './orders';
import { canPush, phoneSql, ringPhones } from './push';

/** the phone rings again after this long while the order still waits for his call */
export const RING_AGAIN_MS = 2 * 60_000;
/** a ring the phone has not answered after this long: it does not ring (off, no internet, notifications off) */
export const ACK_WAIT_MS = 3 * 60_000;
/** « Je l'ai entendu » counts only right after a test ring that reached the phone */
const HEARD_AFTER_MS = 15 * 60_000;

/** The store's own plain confirmation agents (SQL on profiles `p`): blocked, never a manager, the owner, an administrator nor an agency's person. */
const PLAIN_SQL = `p.active AND p.agency_id IS NULL AND 'confirmation' = ANY(p.roles) AND NOT (p.roles && '{admin,agent_manager,vendeur}'::text[])`;

/** A store's own plain confirmation agent: blocked (not a manager, the owner nor an administrator; not an agency's person). */
export function plainAgent(ctx: Ctx): boolean {
  const s = ctx.session;
  // his own roles: a community manager confirms the orders she makes from her chats (her role includes Confirmation),
  // nothing is given to her to ring for, and her chats stay open on her computer (26 Nov 2026)
  if (s.isAdmin || !s.profile.roles.includes('confirmation')) return false;
  if (s.roles.includes('agent_manager') || s.roles.includes('vendeur')) return false;
  return agencyOf(ctx) === null && !agencyLead(ctx);
}

/** The people who switch it on or off: the shop's managers (agent managers, the owner) and its administrators. */
const canSwitch = (ctx: Ctx) => agencyOf(ctx) === null && (ctx.session.isAdmin || hasRole(ctx.session, 'agent_manager', 'vendeur'));

type Shift = { from: number; to: number };
type Calls = SettingsMap['calls'];

/**
 * His work time now: his shift (minutes after midnight, Algiers) when the managers typed one, else the shop's calling
 * hours. `start`: when this shift began today — the test ring must come after it (the calling hours: their first slot).
 */
export function workAt(now: number, calls: Calls, shift: Shift | undefined): { open: boolean; start: number } {
  const day = algiersDayStart(now);
  if (shift) {
    const from = day + shift.from * 60_000;
    return { open: now >= from && now < day + shift.to * 60_000, start: from };
  }
  return { open: slotAt(now, calls).open, start: day + (calls.slots[0]?.from ?? 0) * 3_600_000 };
}

/** What stops him from working while his phone is not ready: no phone, the test ring of this shift, « je l'ai entendu », or a phone that stopped answering. */
export type Gate = 'none' | 'test' | 'heard' | 'silent';

type PhoneRow = { id: unknown; endpoint: string; p256dh: string; auth: string; ack_code: string | null; asked_at: unknown; ack_at: unknown; heard_at: unknown };
const ms = (v: unknown) => (v ? new Date(v as string).getTime() : 0);

/** His phones (notifications on in the Pilotix app of a phone or a tablet). */
const phonesOf = (db: Db, ids: number[]): Promise<(PhoneRow & { profile_id: unknown })[]> =>
  ids.length ? db.query(`SELECT id, profile_id, endpoint, p256dh, auth, ack_code, asked_at, ack_at, heard_at FROM push_subs WHERE profile_id = ANY($1) AND ${phoneSql()} ORDER BY id`, [ids]) : Promise.resolve([]);

/** Ready (null) when one of his phones rang since the shift began, answers, and he heard it; else what is missing. */
export function gateOf(rows: PhoneRow[], since: number, now: number): Gate | null {
  if (!rows.length) return 'none';
  const silent = (r: PhoneRow) => !!r.asked_at && now - ms(r.asked_at) > ACK_WAIT_MS;
  if (rows.some((r) => !silent(r) && ms(r.ack_at) >= since && ms(r.heard_at) >= since)) return null;
  if (rows.some((r) => !silent(r) && ms(r.ack_at) >= since)) return 'heard';
  return rows.some(silent) ? 'silent' : 'test';
}

/**
 * His order now, among his new orders (newest first): the new order he has open (kept for him: on his phone's card, or
 * opened from the list), else the one he called and has not saved a result for, else the newest. null: another of his
 * orders (not a new one) is open — it waits until he has finished that one.
 */
export function pickOrder<T extends { id: unknown; called?: unknown }>(mine: T[], held: Set<number>): T | null {
  const open = mine.find((r) => held.has(num(r.id)));
  if (open) return open;
  const ids = new Set(mine.map((r) => num(r.id)));
  if ([...held].some((id) => !ids.has(id))) return null;
  return mine.find((r) => !!r.called) ?? mine[0] ?? null;
}

/** What the notification says (French, like the other notifications of the server). */
function ringText(r: { id: unknown; ref: string; customer_name: string; wilaya_id: unknown; items: string | null }, before: number, more: number) {
  const where = WILAYAS[num(r.wilaya_id) - 1] ?? '';
  const what = [r.customer_name, r.items, where].filter(Boolean).join(' · ');
  return {
    title: before ? `📞 ${r.ref} attend toujours votre appel` : `📞 Nouvelle commande à appeler · ${r.ref}`,
    body: `${what}${more ? ` · +${more} après` : ''} — ouvrez Pilotix pour appeler`,
    tag: `conf-new-${num(r.id)}`,
    url: '#/confirmation/nouvelles',
    alarm: true,
    // the phone's worker (sw.js): Pilotix open on its screen rings there itself, no notification on top
    conf: true,
    // the Android app (PilotixMessagingService): its loud ring, even on a silent phone, over the locked screen
    ring: true,
  };
}

/** For the managers: each plain agent, his shift, and whether his phone is ready now (`work` false: not his work time). */
async function agentList(ctx: Ctx) {
  const now = ctx.now();
  const calls = await getSetting(ctx.db, 'calls');
  const shifts = await getSetting(ctx.db, 'confShifts');
  const people = await ctx.db.query(`SELECT p.id, p.name FROM profiles p WHERE ${PLAIN_SQL} ORDER BY p.name, p.id`);
  const phones = await phonesOf(ctx.db, people.map((p: any) => num(p.id)));
  return people.map((p: any) => {
    const id = num(p.id);
    const shift: Shift | null = shifts[String(id)] ?? null;
    const w = workAt(now, calls, shift ?? undefined);
    const rows = phones.filter((r) => num(r.profile_id) === id);
    return { id, name: String(p.name), shift, work: w.open, phone: (gateOf(rows, w.start, now) ?? 'ok') as Gate | 'ok' };
  });
}

/** Minutes after midnight from « HH:MM ». */
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const ShiftSet = z.object({ agentId: z.number().int().positive(), from: HHMM.nullable(), to: HHMM.nullable() });
const BlockSet = z.object({ on: z.boolean() });
const Endpoint = z.object({ endpoint: z.string().url().max(1000) });

/** This phone of this agent (the Pilotix app on it turned notifications on: push.subscribe). */
async function myPhone(ctx: Ctx, endpoint: string): Promise<PhoneRow | null> {
  const r = await ctx.db.query(`SELECT id, endpoint, p256dh, auth, ack_code, asked_at, ack_at, heard_at FROM push_subs WHERE endpoint = $1 AND profile_id = $2 AND ${phoneSql()}`, [endpoint, ctx.session.profile.id]);
  return (r[0] as PhoneRow) ?? null;
}

export const confBlockProcs = {
  /** The switch: on or off, who changed it last, whether this person may change it; for the managers, the agents. */
  'confirmation.blockGet': proc(['confirmation'], z.object({}), async (ctx) => {
    const b = await getSetting(ctx.db, 'confBlock');
    const can = canSwitch(ctx);
    return { on: !!b.on, by: b.by ?? null, at: b.at ?? null, canSwitch: can, agents: can ? await agentList(ctx) : null };
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

  /** An agent's shift (the managers only): « 09:00 » to « 15:00 »; both empty: the shop's calling hours again. */
  'confirmation.shiftSet': proc(['confirmation'], ShiftSet, async (ctx, i) => {
    if (!canSwitch(ctx)) throw forbidden('Seuls les managers changent les horaires des agents');
    const who = await ctx.db.query(`SELECT p.id FROM profiles p WHERE p.id = $1 AND ${PLAIN_SQL}`, [i.agentId]);
    if (!who.length) throw bad('Agent introuvable');
    const shifts = { ...(await getSetting(ctx.db, 'confShifts')) };
    if (!i.from && !i.to) delete shifts[String(i.agentId)];
    else {
      if (!i.from || !i.to) throw bad('Indiquez le début et la fin du service');
      const s = { from: minutes(i.from), to: minutes(i.to) };
      if (s.to <= s.from) throw bad('La fin du service doit venir après le début');
      shifts[String(i.agentId)] = s;
    }
    await setSetting(ctx.db, 'confShifts', shifts, ctx.session.profile.id);
    ctx.emit({ type: 'settings' });
    return { ok: true, shift: shifts[String(i.agentId)] ?? null };
  }),

  /**
   * For a plain agent: whether he may work now (`gate`: null, else what his phone still needs in his work time), the new
   * order that blocks his phone now (null: none), whether he already tapped « Appeler » on it, and how many more new
   * orders of his come after it. `wait`: one is there, but he is busy with another order. `work`: his work time now
   * (his shift, else the shop's calling hours). `shift`: his shift, if the managers typed one.
   */
  'confirmation.blocking': proc(['confirmation'], z.object({}), async (ctx) => {
    const none = { on: false, work: false, gate: null as Gate | null, shift: null as Shift | null, order: null as Order | null, called: false, queue: 0, wait: false };
    if (!plainAgent(ctx)) return none;
    if (!(await getSetting(ctx.db, 'confBlock')).on) return none;
    const me = ctx.session.profile.id;
    const now = ctx.now();
    const shift: Shift | null = (await getSetting(ctx.db, 'confShifts'))[String(me)] ?? null;
    const w = workAt(now, await getSetting(ctx.db, 'calls'), shift ?? undefined);
    const on = { ...none, on: true, shift };
    // outside his work time: nothing (never at night)
    if (!w.open) return on;
    const at = { ...on, work: true, gate: gateOf(await phonesOf(ctx.db, [me]), w.start, now) };
    // newest first (« last in, first out »); called: he tapped « Appeler » on it already
    const rows = await ctx.db.query(
      `SELECT o.id, EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.user_id = $1 AND e.kind = 'call') AS called
         FROM sales o
        WHERE o.conf_status = 'new' AND o.agent_id = $1${andSql(queueSql(ctx, 'conf'))}
          AND (o.locked_by IS NULL OR o.locked_by = $1 OR o.locked_until < now())
        ORDER BY o.created_at DESC, o.id DESC LIMIT 100`,
      [me],
    );
    if (!rows.length) return at;
    // the orders open on his screens (kept for him)
    const held = new Set((await ctx.db.query('SELECT id FROM orders WHERE locked_by = $1 AND locked_until > now() AND conf_status = ANY($2)', [me, CONF_TODO])).map((r: any) => num(r.id)));
    const first = pickOrder(rows, held);
    // in the middle of another order: it waits until he has finished that one
    if (!first) return { ...at, queue: rows.length, wait: true };
    const order = (await withClientScores(ctx, [await getOrder(ctx, num(first.id))]))[0];
    return { ...at, order, called: !!first.called, queue: rows.length - 1 };
  }),

  /**
   * The test ring of the shift (the agent's phone, from its Pilotix app): a notification to this phone; its worker says
   * when it arrived (push.ack). Without a push service (the browser preview, the Claude demo) it counts as arrived.
   */
  'confirmation.phoneTest': proc(['confirmation'], Endpoint, async (ctx, i) => {
    const phone = await myPhone(ctx, i.endpoint);
    if (!canPush(ctx.server)) {
      // nothing can ring here: this « phone » is the demo's, it answers at once
      if (!phone)
        await ctx.db.query(
          `INSERT INTO push_subs (profile_id, endpoint, p256dh, auth, ua) VALUES ($1, $2, 'BDEMO-PHONE-KEY-0000', 'DEMO-AUTH', 'Mozilla/5.0 (Linux; Android 14) Mobile (Pilotix demo)')
           ON CONFLICT (endpoint) DO UPDATE SET profile_id = $1`,
          [ctx.session.profile.id, i.endpoint],
        );
      await ctx.db.query('UPDATE push_subs SET ack_at = now(), asked_at = NULL, ack_code = NULL WHERE endpoint = $1', [i.endpoint]);
      return { sent: 1 };
    }
    if (!phone) throw bad('Activez d’abord les notifications de Pilotix sur ce téléphone');
    const sent = await ringPhones(ctx, [phone], {
      title: '🔔 Test de la sonnerie Pilotix',
      body: 'Si vous entendez ce son, revenez dans Pilotix et touchez « Je l’ai entendu ».',
      tag: 'conf-test',
      url: '#/confirmation/nouvelles',
      alarm: true,
      // the Android app: the same loud ring as a new order's
      ring: true,
    });
    return { sent };
  }),

  /** « Je l'ai entendu » (the volume up): only right after a test ring that reached this phone. */
  'confirmation.phoneHeard': proc(['confirmation'], Endpoint, async (ctx, i) => {
    const phone = await myPhone(ctx, i.endpoint);
    if (!phone || ctx.now() - ms(phone.ack_at) > HEARD_AFTER_MS) throw bad('Faites d’abord sonner ce téléphone (sonnerie test)');
    await ctx.db.query('UPDATE push_subs SET heard_at = now() WHERE id = $1', [phone.id]);
    return { ok: true };
  }),

  /**
   * Every 30 seconds (scheduled job): in each plain agent's work time, his order now (pickOrder: newest first) rings his phones — at once,
   * then every 2 minutes until he taps « Appeler » — whether he works in Pilotix on his computer or not. Never while he
   * is busy with another order. Each ring asks the phone to answer (ringPhones): a phone that does not answer blocks him.
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
    const calls = await getSetting(ctx.db, 'calls');
    const shifts = await getSetting(ctx.db, 'confShifts');
    // the store's own orders given to its plain agents, not kept by someone else; called: he tapped « Appeler » already
    const rows = await ctx.db.query(
      `SELECT o.id, o.ref, o.customer_name, o.wilaya_id, o.agent_id,
              (SELECT string_agg(CASE WHEN i.qty > 1 THEN i.qty || ' × ' ELSE '' END || i.name, ' + ' ORDER BY i.id) FROM order_items i WHERE i.order_id = o.id) AS items,
              EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.user_id = o.agent_id AND e.kind = 'call') AS called
         FROM sales o JOIN profiles p ON p.id = o.agent_id
        WHERE o.conf_status = 'new' AND o.conf_agency_id IS NULL AND ${PLAIN_SQL}
          AND (o.locked_by IS NULL OR o.locked_by = o.agent_id OR o.locked_until < now())
        ORDER BY o.created_at DESC, o.id DESC`,
    );
    // each agent's new orders, newest first
    const mine = new Map<number, any[]>();
    for (const r of rows) {
      const a = num(r.agent_id);
      mine.set(a, [...(mine.get(a) ?? []), r]);
    }
    const agents = [...mine.keys()];
    // the orders open on their screens (kept for them)
    const held = agents.length ? await ctx.db.query('SELECT id, locked_by FROM orders WHERE locked_by = ANY($1) AND locked_until > now() AND conf_status = ANY($2)', [agents, CONF_TODO]) : [];
    const phones = await phonesOf(ctx.db, agents);
    const next: SettingsMap['confRings'] = {};
    let sent = 0;
    for (const [agent, list] of mine) {
      const r = pickOrder(list, new Set(held.filter((h: any) => num(h.locked_by) === agent).map((h: any) => num(h.id))));
      // in the middle of another order: nothing rings, what waits keeps its count
      if (!r) {
        for (const x of list) if (rings[String(x.id)]?.a === agent) next[String(x.id)] = rings[String(x.id)];
        continue;
      }
      const key = String(r.id);
      // given to someone else since: his count starts again
      const prev = rings[key] && rings[key].a === agent ? rings[key] : null;
      // outside his work time (his shift, else the calling hours): nothing rings, what waits keeps its count
      const work = workAt(now, calls, shifts[String(agent)]).open;
      const due = work && !r.called && (!prev || now - prev.at >= RING_AGAIN_MS);
      const his = phones.filter((x) => num(x.profile_id) === agent);
      if (due && his.length) {
        sent += await ringPhones(ctx, his, ringText(r, prev?.n ?? 0, list.length - 1)).catch(() => 0);
        next[key] = { a: agent, at: now, n: (prev?.n ?? 0) + 1 };
      } else if (prev) next[key] = prev;
    }
    await keep(next);
    return { sent, waiting: rows.length };
  }),
};

/**
 * The Claude demo only (the Pilotix artifact, lib/backend.ts): on, and Rania (a plain agent) has two new orders to call,
 * so her « Essayer » link (#essayer-rania---confirmation--nouvelles) shows it at once. The plain agents' phones are
 * ready (they rang and were heard just now), so on a computer they only get the line — except Imane's: no phone yet,
 * her computer shows « Connectez votre téléphone ». Yacine (a manager) sees the switch, the shifts and the phones.
 */
export async function seedBlockDemo(db: Db) {
  await setSetting(db, 'confBlock', { on: true, by: 'Yacine', at: new Date().toISOString() });
  const ua = 'Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
  await db.query(
    `INSERT INTO push_subs (profile_id, endpoint, p256dh, auth, ua, ack_at, heard_at)
     SELECT p.id, 'https://fcm.googleapis.com/fcm/send/demo-phone-' || p.id, 'BDEMO-PHONE-KEY-0000', 'DEMO-AUTH', $1, now(), now()
       FROM profiles p WHERE ${PLAIN_SQL} AND p.email <> 'imane@demo.pilotix.dz'
     ON CONFLICT (endpoint) DO UPDATE SET ack_at = now(), heard_at = now(), asked_at = NULL, ack_code = NULL`,
    [ua],
  );
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
