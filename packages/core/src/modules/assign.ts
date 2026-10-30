// Affectation automatique: who gets a new order (Confirmation) or a new alert (Suivi), without anyone choosing.
//  - Modes: « Manuel » (nobody is given anything: the agents take with « Commande / Alerte suivante »), « Tour de rôle »
//    (one each in turn, kept per sales channel / product / for all; an agent ×2 gets two in a row), « Moins chargé »
//    (the agent with the fewest open items; the statuses chosen do not count) and « Smart » (the most likely to succeed).
//  - Only agents who are on line now (seen in the last 3 minutes), in their hours, not taken out of the split by the
//    manager, under their maximum, allowed on that channel / product, and — for a confirmation agency's agents — on
//    their agency's orders and products. A fresh item goes first to someone not already on a call.
//  - A known customer goes back to the agent who has his other open order.
//  - An agent not seen for « offlineMin » minutes gives back what he got automatically and never touched.
import { algiersHour, CONF_TODO } from '@pilotix/shared';
import { z } from 'zod';
import { Db, num, numOrNull } from '../db';
import { bad, Ctx, proc } from '../rpc';
import { AssignAgent, AssignArea, DEFAULT_SETTINGS, getSetting, setSetting, SettingsMap } from '../settings';
import { addEvent } from './orders';

export type Area = 'conf' | 'follow';
type Assign = SettingsMap['autoAssign'];

const ROLE: Record<Area, string> = { conf: 'confirmation', follow: 'suivi' };
const COL: Record<Area, string> = { conf: 'agent_id', follow: 'follow_agent_id' };
const AGENCY_COL: Record<Area, string> = { conf: 'conf_agency_id', follow: 'follow_agency_id' };
const ONLINE_MS = 3 * 60_000;
export const MODE_FR: Record<AssignArea['mode'], string> = { manual: 'manuel', turn: 'tour de rôle', load: 'moins chargé', smart: 'smart' };

export const AGENT_DEFAULT: AssignAgent = { out: false, weight: 1, channels: [], products: [], from: null, to: null, langs: [], senior: false };

/** The shop's choices, every missing one filled with the default (a choice added later starts there). */
export async function getAssign(db: Db): Promise<Assign> {
  const s = await getSetting(db, 'autoAssign');
  const d = DEFAULT_SETTINGS.autoAssign;
  const agents: Record<string, AssignAgent> = {};
  for (const [k, v] of Object.entries(s.agents ?? {})) agents[k] = { ...AGENT_DEFAULT, ...v };
  return { conf: { ...d.conf, ...(s.conf ?? {}) }, follow: { ...d.follow, ...(s.follow ?? {}) }, agents, order: s.order ?? [] };
}

export interface Agent {
  id: number;
  name: string;
  agencyId: number | null;
  agencyProducts: number[] | null;
  presence: string;
  online: boolean;
  /** on line and not on a call */
  free: boolean;
  cfg: AssignAgent;
  load: number;
  /** when he was last given something (ms), to break ties */
  lastAt: number;
}

/** The agents of an area with their state now: on line, free, open items, last item given. */
export async function agentsOf(db: Db, area: Area, cfg: Assign, now: number): Promise<Agent[]> {
  const a = cfg[area];
  const loadSql =
    area === 'conf'
      ? `(SELECT count(*)::int FROM orders o WHERE o.agent_id = p.id AND NOT (o.conf_status = ANY($2)) AND o.shipped_at IS NULL)`
      : `(SELECT count(*)::int FROM orders o WHERE o.follow_agent_id = p.id AND o.follow_status = 'alert' AND NOT (o.follow_status = ANY($2)))`;
  const rows = await db.query(
    `SELECT p.id, p.name, p.agency_id, p.agency_products, p.presence, p.last_seen_at, ${loadSql} AS load,
            (SELECT max(e.at) FROM order_events e WHERE e.kind = 'assign' AND e.user_id IS NULL AND e.to_value = p.id::text AND e.at > now() - interval '2 days') AS last_at
       FROM profiles p WHERE p.active AND $1 = ANY(p.roles) ORDER BY p.id`,
    [ROLE[area], a.excluded],
  );
  return rows.map((r: any) => {
    const seen = r.last_seen_at ? Date.parse(new Date(r.last_seen_at).toISOString()) : 0;
    const online = now - seen < ONLINE_MS && r.presence !== 'idle';
    return {
      id: num(r.id),
      name: String(r.name),
      agencyId: numOrNull(r.agency_id),
      agencyProducts: Array.isArray(r.agency_products) ? r.agency_products.map(num) : null,
      presence: String(r.presence ?? ''),
      online,
      free: online && r.presence !== 'call',
      cfg: { ...AGENT_DEFAULT, ...(cfg.agents[String(r.id)] ?? {}) },
      load: num(r.load),
      lastAt: r.last_at ? Date.parse(new Date(r.last_at).toISOString()) : 0,
    };
  });
}

/** In his hours now (Algiers time); « 22 → 6 » goes over midnight. */
export function inHours(c: AssignAgent, now: number): boolean {
  if (c.from === null || c.to === null) return true;
  const h = algiersHour(now);
  return c.from <= c.to ? h >= c.from && h < c.to : h >= c.from || h < c.to;
}

export interface Item {
  id: number;
  phone: string;
  channel: string;
  agencyId: number | null;
  productIds: number[];
  routeProduct: number | null;
  total: number;
  wilayaId: number | null;
}

/** Why an agent cannot get this item now (null: he can). */
export function cannot(a: Agent, item: Item, area: AssignArea, now: number): string | null {
  if (a.cfg.out) return 'hors répartition';
  if (!a.online) return 'pas en ligne';
  if (!inHours(a.cfg, now)) return 'hors de ses heures';
  if (item.agencyId === null ? a.agencyId !== null : a.agencyId !== item.agencyId) return 'pas son agence';
  if (a.agencyProducts && item.routeProduct !== null && !a.agencyProducts.includes(item.routeProduct)) return 'produit de l’agence non donné';
  if (area.respectAccess) {
    if (a.cfg.channels.length && !a.cfg.channels.includes(item.channel)) return 'canal non autorisé';
    if (a.cfg.products.length && !item.productIds.some((p) => a.cfg.products.includes(p))) return 'produit non autorisé';
  }
  if (area.max > 0 && a.load >= area.max) return 'au maximum';
  return null;
}

const scopeOf = (area: Area, by: AssignArea['by'], item: Item) => `${area}:${by === 'channel' ? `c:${item.channel}` : by === 'product' ? `p:${item.routeProduct ?? item.productIds[0] ?? 0}` : 'all'}`;

/**
 * The agent for this item (null: nobody can take it now — it waits). `turns` is read and updated (Tour de rôle).
 * `prev`: the agent of the customer's other open order, `skip`: agents it must not go to (rotation).
 */
export function pickAgent(
  list: Agent[],
  item: Item,
  area: Area,
  cfg: Assign,
  turns: SettingsMap['autoAssignTurn'],
  now: number,
  o: { prev?: number | null; skip?: number[]; score?: (a: Agent) => number } = {},
): { agent: Agent; why: string } | null {
  const a = cfg[area];
  let ok = list.filter((x) => !o.skip?.includes(x.id) && cannot(x, item, a, now) === null);
  if (!ok.length) return null;
  if (a.sameClient && o.prev) {
    const same = ok.find((x) => x.id === o.prev);
    if (same) return { agent: same, why: 'même client' };
  }
  let why = MODE_FR[a.mode];
  if (a.speedFirst && ok.some((x) => x.free)) {
    if (ok.some((x) => !x.free)) why += ' · libre';
    ok = ok.filter((x) => x.free);
  }
  if (a.mode === 'turn') {
    const key = scopeOf(area, a.by, item);
    const st = turns[key] ?? { last: null, n: 0 };
    const order = [...list].sort((x, y) => {
      const ix = cfg.order.indexOf(x.id);
      const iy = cfg.order.indexOf(y.id);
      return (ix < 0 ? 1e6 + x.id : ix) - (iy < 0 ? 1e6 + y.id : iy);
    });
    // an agent ×2 gets two in a row
    const last = ok.find((x) => x.id === st.last);
    if (last && st.n < Math.max(1, last.cfg.weight)) {
      turns[key] = { last: last.id, n: st.n + 1 };
      return { agent: last, why };
    }
    const start = Math.max(-1, order.findIndex((x) => x.id === st.last));
    for (let k = 1; k <= order.length; k++) {
      const c = order[(start + k + order.length) % order.length];
      const hit = ok.find((x) => x.id === c.id);
      if (hit) {
        turns[key] = { last: hit.id, n: 1 };
        return { agent: hit, why };
      }
    }
    return null;
  }
  if (a.mode === 'smart' && o.score) {
    const best = [...ok].sort((x, y) => o.score!(y) - o.score!(x) || x.load - y.load || x.lastAt - y.lastAt)[0];
    return { agent: best, why };
  }
  // moins chargé: the fewest open items, then the one given something the longest ago
  const best = [...ok].sort((x, y) => x.load - y.load || x.lastAt - y.lastAt || x.id - y.id)[0];
  return { agent: best, why };
}

/** The items waiting for an agent, oldest first. */
async function waiting(db: Db, area: Area, ids?: number[]): Promise<Item[]> {
  const where =
    area === 'conf'
      ? `o.agent_id IS NULL AND o.conf_status = ANY($1) AND NOT o.is_exchange AND o.created_at > now() - interval '30 days'`
      : `o.follow_agent_id IS NULL AND o.follow_status = 'alert' AND $1::text[] IS NOT NULL`;
  const rows = await db.query(
    `SELECT o.id, o.phone, o.channel, o.${AGENCY_COL[area]} AS agency, o.route_product_id, o.total, o.wilaya_id,
            ARRAY(SELECT DISTINCT i.product_id FROM order_items i WHERE i.order_id = o.id AND i.product_id IS NOT NULL) AS products
       FROM orders o WHERE ${where} ${ids ? 'AND o.id = ANY($2)' : ''} ORDER BY o.created_at LIMIT 300`,
    ids ? [CONF_TODO, ids] : [CONF_TODO],
  );
  return rows.map((r: any) => ({
    id: num(r.id),
    phone: String(r.phone ?? ''),
    channel: String(r.channel ?? ''),
    agencyId: numOrNull(r.agency),
    productIds: (r.products ?? []).map(num),
    routeProduct: numOrNull(r.route_product_id),
    total: num(r.total),
    wilayaId: numOrNull(r.wilaya_id),
  }));
}

/** The agent of the customer's other open item (same phone), if any. */
async function prevAgent(db: Db, area: Area, item: Item): Promise<number | null> {
  const r =
    area === 'conf'
      ? await db.query(`SELECT agent_id FROM orders WHERE phone = $1 AND id <> $2 AND agent_id IS NOT NULL AND conf_status = ANY($3) ORDER BY created_at DESC LIMIT 1`, [item.phone, item.id, CONF_TODO])
      : await db.query(`SELECT agent_id FROM orders WHERE id = $1`, [item.id]);
  return numOrNull(r[0]?.agent_id);
}

/** Gives the item to the agent (only if it still has none) and writes it in the history. */
export async function giveTo(db: Db, area: Area, itemId: number, agentId: number, why: string): Promise<boolean> {
  const r = await db.query(
    area === 'conf'
      ? `UPDATE orders SET agent_id = $2, assigned_at = now(), updated_at = now() WHERE id = $1 AND agent_id IS NULL RETURNING id`
      : `UPDATE orders SET follow_agent_id = $2, updated_at = now() WHERE id = $1 AND follow_agent_id IS NULL RETURNING id`,
    [itemId, agentId],
  );
  if (!r[0]) return false;
  await addEvent(db, itemId, null, 'assign', null, String(agentId), `Affectation automatique (${area === 'conf' ? 'confirmation' : 'suivi'}) · ${why}`);
  return true;
}

/** What an agent not seen for « offlineMin » minutes got automatically and never touched goes back to the queue. */
async function giveBack(db: Db, area: Area, a: AssignArea, list: Agent[], now: number): Promise<number> {
  const gone = list.filter((x) => !x.online && x.lastAt > 0).map((x) => x.id);
  if (!gone.length) return 0;
  const cutoff = new Date(now - a.offlineMin * 60_000).toISOString();
  const rows =
    area === 'conf'
      ? await db.query(
          `UPDATE orders o SET agent_id = NULL, assigned_at = NULL, updated_at = now()
            WHERE o.agent_id = ANY($1) AND o.conf_status IN ('new', 'to_check') AND o.attempts = 0 AND o.last_call_at IS NULL
              AND EXISTS (SELECT 1 FROM profiles p WHERE p.id = o.agent_id AND (p.last_seen_at IS NULL OR p.last_seen_at < $2::timestamptz))
              AND EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.kind = 'assign' AND e.user_id IS NULL AND e.to_value = o.agent_id::text)
              AND NOT EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.user_id = o.agent_id AND e.at >= o.assigned_at)
            RETURNING o.id`,
          [gone, cutoff],
        )
      : await db.query(
          `UPDATE orders o SET follow_agent_id = NULL, updated_at = now()
            WHERE o.follow_agent_id = ANY($1) AND o.follow_status = 'alert'
              AND EXISTS (SELECT 1 FROM profiles p WHERE p.id = o.follow_agent_id AND (p.last_seen_at IS NULL OR p.last_seen_at < $2::timestamptz))
              AND EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.kind = 'assign' AND e.user_id IS NULL AND e.to_value = o.follow_agent_id::text)
              AND NOT EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.user_id = o.follow_agent_id
                                AND e.at >= (SELECT max(x.at) FROM order_events x WHERE x.order_id = o.id AND x.kind = 'assign'))
            RETURNING o.id`,
          [gone, cutoff],
        );
  for (const r of rows) await addEvent(db, num(r.id), null, 'note', null, 'event', `Rendue à la file : agent absent depuis plus de ${a.offlineMin} min`);
  return rows.length;
}

/** One run for an area: gives back what absent agents never touched, then gives the waiting items. */
export async function runArea(ctx: Ctx, area: Area, ids?: number[], cfgIn?: Assign) {
  const cfg = cfgIn ?? (await getAssign(ctx.db));
  const a = cfg[area];
  if (a.mode === 'manual') return { assigned: 0, back: 0, waiting: 0 };
  const now = ctx.now();
  const list = await agentsOf(ctx.db, area, cfg, now);
  const back = ids ? 0 : await giveBack(ctx.db, area, a, list, now);
  const items = await waiting(ctx.db, area, ids);
  const turns = { ...(await getSetting(ctx.db, 'autoAssignTurn')) };
  const score = a.mode === 'smart' ? await smartScorer(ctx.db, area) : undefined;
  let assigned = 0;
  for (const it of items) {
    const prev = a.sameClient ? await prevAgent(ctx.db, area, it) : null;
    const pick = pickAgent(list, it, area, cfg, turns, now, { prev, score: score ? (x) => score(x, it) : undefined });
    if (!pick) continue;
    if (await giveTo(ctx.db, area, it.id, pick.agent.id, pick.why)) {
      pick.agent.load++;
      pick.agent.lastAt = now;
      assigned++;
    }
  }
  if (a.mode === 'turn') await setSetting(ctx.db, 'autoAssignTurn', turns);
  if (assigned || back) ctx.emit({ type: 'orders' });
  return { assigned, back, waiting: items.length - assigned };
}

/** « Smart »: filled in by assignsmart.ts (piece C); until then the least busy. */
export let smartScorer = async (_db: Db, _area: Area): Promise<(a: Agent, item: Item) => number> => (a) => -a.load;
export function setSmartScorer(f: typeof smartScorer) {
  smartScorer = f;
}

/** Right after an order is created: its agent at once (the job every minute does the rest). */
export async function assignNow(ctx: Ctx, area: Area, id: number) {
  try {
    return await runArea(ctx, area, [id]);
  } catch {
    return null;
  }
}

const AreaIn = z.object({
  mode: z.enum(['manual', 'turn', 'load', 'smart']),
  by: z.enum(['all', 'channel', 'product']),
  excluded: z.array(z.string().max(40)).max(40),
  max: z.number().int().min(0).max(500),
  offlineMin: z.number().int().min(5).max(240),
  sameClient: z.boolean(),
  respectAccess: z.boolean(),
  hideHistory: z.boolean(),
  speedFirst: z.boolean(),
});
const AgentIn = z.object({
  out: z.boolean(),
  weight: z.number().int().min(1).max(3),
  channels: z.array(z.string().max(30)).max(20),
  products: z.array(z.number().int().positive()).max(200),
  from: z.number().min(0).max(24).nullable(),
  to: z.number().min(0).max(24).nullable(),
  langs: z.array(z.string().max(10)).max(5),
  senior: z.boolean(),
});

export const assignProcs = {
  /** The settings and every agent of both areas with their state now (on line, open items, his own settings). */
  'assign.get': proc(['agent_manager', 'vendeur'], z.object({}), async (ctx) => {
    const cfg = await getAssign(ctx.db);
    const now = ctx.now();
    const [conf, follow] = await Promise.all([agentsOf(ctx.db, 'conf', cfg, now), agentsOf(ctx.db, 'follow', cfg, now)]);
    const waitingNow = {
      conf: num((await ctx.db.query(`SELECT count(*)::int AS n FROM orders WHERE agent_id IS NULL AND conf_status = ANY($1) AND NOT is_exchange AND created_at > now() - interval '30 days'`, [CONF_TODO]))[0]?.n),
      follow: num((await ctx.db.query(`SELECT count(*)::int AS n FROM orders WHERE follow_agent_id IS NULL AND follow_status = 'alert'`))[0]?.n),
    };
    const pub = (x: Agent) => ({ id: x.id, name: x.name, online: x.online, free: x.free, presence: x.presence, load: x.load, agency: x.agencyId !== null, inHours: inHours(x.cfg, now) });
    return { cfg, conf: conf.map(pub), follow: follow.map(pub), waiting: waitingNow };
  }),

  'assign.set': proc(
    ['agent_manager', 'vendeur'],
    z.object({ conf: AreaIn, follow: AreaIn, agents: z.record(AgentIn), order: z.array(z.number().int().positive()).max(500) }),
    async (ctx, i) => {
      for (const [k, v] of Object.entries(i.agents)) if (v.from !== null && v.to !== null && v.from === v.to) throw bad(`Agent ${k} : l’heure de début et de fin sont pareilles`);
      await setSetting(ctx.db, 'autoAssign', i, ctx.session.profile.id);
      return { ok: true };
    },
  ),

  /** « Répartir maintenant », and the job every minute: both areas. */
  'assign.run': proc(['agent_manager', 'vendeur'], z.object({}), async (ctx) => {
    const cfg = await getAssign(ctx.db);
    return { conf: await runArea(ctx, 'conf', undefined, cfg), follow: await runArea(ctx, 'follow', undefined, cfg) };
  }),
};
