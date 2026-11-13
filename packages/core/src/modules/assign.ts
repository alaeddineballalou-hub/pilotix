// Affectation automatique: who gets a new order (Confirmation) or a new alert (Suivi), without anyone choosing.
//  - Modes: « Manuel » (nobody is given anything: the agents take with « Commande / Alerte suivante »), « Tour de rôle »
//    (one each in turn, kept per sales channel / product / for all; an agent ×2 gets two in a row), « Moins chargé »
//    (the agent with the fewest open items; the statuses chosen do not count) and « Smart » (the most likely to succeed).
//  - Only agents who are on line now (seen in the last 3 minutes), in their hours, not taken out of the split by the
//    manager, under their maximum, allowed on that channel / product, and — for a confirmation agency's agents — on
//    their agency's orders and products. A fresh item goes first to someone not already on a call.
//  - A known customer goes back to the agent who has his other open order.
//  - An agent not seen for « offlineMin » minutes gives back what he got automatically and never touched.
import { addWorkMinutes, algiersHour, CONF_STATUSES, CONF_TODO, isWomanName } from '@pilotix/shared';
import { z } from 'zod';
import { Db, num, numOrNull } from '../db';
import { bad, Ctx, forbidden, proc } from '../rpc';
import { can } from './rights';
import { AssignAgent, AssignArea, AssignRotation, DEFAULT_SETTINGS, getSetting, setSetting, SettingsMap } from '../settings';
import { addEvent } from './orders';
import { loadShop } from '../platform/shops';

export type Area = 'conf' | 'follow';
type Assign = SettingsMap['autoAssign'];

export const ROLE: Record<Area, string> = { conf: 'confirmation', follow: 'suivi' };
const COL: Record<Area, string> = { conf: 'agent_id', follow: 'follow_agent_id' };
const AGENCY_COL: Record<Area, string> = { conf: 'conf_agency_id', follow: 'follow_agency_id' };
export const ONLINE_MS = 3 * 60_000;
export const MODE_FR: Record<AssignArea['mode'], string> = { manual: 'manuel', turn: 'tour de rôle', load: 'moins chargé', smart: 'smart' };

export const AGENT_DEFAULT: AssignAgent = { out: false, weight: 1, channels: [], products: [], from: null, to: null, langs: [], senior: false, shops: [], woman: false };

/** The shop's choices, every missing one filled with the default (a choice added later starts there). */
export async function getAssign(db: Db): Promise<Assign> {
  const s = await getSetting(db, 'autoAssign');
  const d = DEFAULT_SETTINGS.autoAssign;
  const agents: Record<string, AssignAgent> = {};
  for (const [k, v] of Object.entries(s.agents ?? {})) agents[k] = { ...AGENT_DEFAULT, ...v };
  // the rotation is merged on its own (settings saved before it existed, or with some of its fields)
  const area = (k: 'conf' | 'follow') => ({ ...d[k], ...(s[k] ?? {}), rotation: { ...d[k].rotation, ...((s[k] as Partial<AssignArea> | undefined)?.rotation ?? {}) } });
  return { conf: area('conf'), follow: area('follow'), agents, order: s.order ?? [], womenProducts: s.womenProducts ?? [] };
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
  email: string;
  load: number;
  /** of `load`: his open items in the owner's other boutiques (one maximum for all) */
  elsewhere: number;
  /** he gets nothing from this boutique (his « boutiques » leave it out) */
  notHere: boolean;
  /** when he was last given something (ms), to break ties */
  lastAt: number;
}

/** An agent's open items (p: his profile, $2: the statuses that do not count). */
export const loadOf = (area: Area) =>
  area === 'conf'
    ? `(SELECT count(*)::int FROM orders o WHERE o.agent_id = p.id AND NOT (o.conf_status = ANY($2)) AND o.shipped_at IS NULL)`
    : `(SELECT count(*)::int FROM orders o WHERE o.follow_agent_id = p.id AND o.follow_status = 'alert' AND NOT (o.follow_status = ANY($2)))`;

/** The agents of an area with their state now: on line, free, open items, last item given. */
export async function agentsOf(db: Db, area: Area, cfg: Assign, now: number): Promise<Agent[]> {
  const a = cfg[area];
  const rows = await db.query(
    `SELECT p.id, p.name, p.email, p.agency_id, p.agency_products, p.presence, p.last_seen_at, ${loadOf(area)} AS load,
            (SELECT max(e.at) FROM order_events e WHERE e.kind IN ('assign', 'rotate') AND e.user_id IS NULL AND e.to_value = p.id::text AND e.at > now() - interval '2 days') AS last_at
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
      email: String(r.email ?? '').toLowerCase(),
      load: num(r.load),
      elsewhere: 0,
      notHere: false,
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
  /** a woman customer (her first name, or a product for women) */
  woman?: boolean;
  name?: string;
  phone: string;
  channel: string;
  agencyId: number | null;
  productIds: number[];
  routeProduct: number | null;
  total: number;
  wilayaId: number | null;
  /** Suivi: the parcel is in alert now */
  alert?: boolean;
}

/** Why an agent cannot get this item now (null: he can). */
export function cannot(a: Agent, item: Item, area: AssignArea, now: number): string | null {
  if (a.cfg.out) return 'hors répartition';
  if (a.notHere) return 'pas cette boutique';
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
  if (o.prev) {
    const same = ok.find((x) => x.id === o.prev);
    if (same) return { agent: same, why: area === 'follow' && a.toConfirmer ? 'a confirmé la commande' : 'même client' };
  }
  let why = MODE_FR[a.mode];
  // « femmes avec femmes »: a woman customer to a woman agent, when one can take her (else as usual)
  if (a.womenToWomen && item.woman && ok.some((x) => x.cfg.woman)) {
    ok = ok.filter((x) => x.cfg.woman);
    why += ' · cliente → agente';
  }
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
      : // every parcel on the road with no agent, alerts first (« Dès l'expédition » takes them all, « Sur alerte » the alerts)
        `o.follow_agent_id IS NULL AND o.follow_status = ANY('{shipped,out_for_delivery,failed,alert,in_exchange}'::text[]) AND $1::text[] IS NOT NULL`;
  // (an order an agent has open right now — « Commande suivante », « Alerte suivante » — is his: never given to another)
  const free = `(o.locked_until IS NULL OR o.locked_until < now())`;
  const rows = await db.query(
    `SELECT o.id, o.phone, o.customer_name, o.channel, o.${AGENCY_COL[area]} AS agency, o.route_product_id, o.total, o.wilaya_id, o.follow_status,
            ARRAY(SELECT DISTINCT i.product_id FROM order_items i WHERE i.order_id = o.id AND i.product_id IS NOT NULL) AS products
       FROM orders o WHERE ${where} AND ${free} ${ids ? 'AND o.id = ANY($2)' : ''} ORDER BY ${area === 'follow' ? "(o.follow_status = 'alert') DESC, " : ''}o.created_at LIMIT 300`,
    ids ? [CONF_TODO, ids] : [CONF_TODO],
  );
  return rows.map((r: any) => ({
    id: num(r.id),
    phone: String(r.phone ?? ''),
    name: String(r.customer_name ?? ''),
    channel: String(r.channel ?? ''),
    agencyId: numOrNull(r.agency),
    productIds: (r.products ?? []).map(num),
    routeProduct: numOrNull(r.route_product_id),
    total: num(r.total),
    wilayaId: numOrNull(r.wilaya_id),
    alert: r.follow_status === 'alert',
  }));
}

/**
 * The agent the item should go back to, if he can take it: Confirmation, the agent of the customer's other open order;
 * Suivi, the agent who confirmed it (« à celui qui a confirmé »), else the Suivi agent of the customer's other parcel.
 */
async function prevAgent(db: Db, area: Area, item: Item, a: AssignArea): Promise<number | null> {
  if (area === 'conf') {
    if (!a.sameClient) return null;
    const r = await db.query(`SELECT agent_id FROM orders WHERE phone = $1 AND id <> $2 AND agent_id IS NOT NULL AND conf_status = ANY($3) ORDER BY created_at DESC LIMIT 1`, [item.phone, item.id, CONF_TODO]);
    return numOrNull(r[0]?.agent_id);
  }
  if (a.toConfirmer) {
    const r = await db.query(`SELECT agent_id FROM orders WHERE id = $1`, [item.id]);
    if (r[0]?.agent_id) return numOrNull(r[0].agent_id);
  }
  if (!a.sameClient) return null;
  const r = await db.query(
    `SELECT follow_agent_id FROM orders WHERE phone = $1 AND id <> $2 AND follow_agent_id IS NOT NULL AND follow_status = ANY('{shipped,out_for_delivery,failed,alert,in_exchange}'::text[]) ORDER BY created_at DESC LIMIT 1`,
    [item.phone, item.id],
  );
  return numOrNull(r[0]?.follow_agent_id);
}

/** Gives the item to the agent (only if it still has none) and writes it in the history. */
export async function giveTo(db: Db, area: Area, itemId: number, agentId: number, why: string): Promise<boolean> {
  const r = await db.query(
    area === 'conf'
      ? `UPDATE orders SET agent_id = $2, assigned_at = now(), updated_at = now() WHERE id = $1 AND agent_id IS NULL AND (locked_until IS NULL OR locked_until < now() OR locked_by = $2) RETURNING id`
      : `UPDATE orders SET follow_agent_id = $2, updated_at = now() WHERE id = $1 AND follow_agent_id IS NULL AND (locked_until IS NULL OR locked_until < now() OR locked_by = $2) RETURNING id`,
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

// ---------------------------------------------------------------- the owner's other boutiques
/** A boutique of the same owner (each has its own data; a person may have an account in several). */
export interface Sister {
  id: number;
  name: string;
  schema: string;
  current: boolean;
}

/** The boutiques of this store's owner, this one included ([] alone, in the browser preview, or for an agency). */
export async function sisterShops(ctx: Ctx): Promise<Sister[]> {
  const t = ctx.t;
  if (!t || !ctx.shop) return [];
  const rows = await t.platform.query(
    `SELECT s.id, s.name, s.schema_name FROM platform.shops s
      WHERE s.kind = 'store' AND s.status NOT IN ('archived', 'deleted') AND s.owner_account_id IS NOT NULL
        AND s.owner_account_id = (SELECT owner_account_id FROM platform.shops WHERE id = $1) ORDER BY s.id`,
    [ctx.shop.id],
  );
  if (rows.length < 2) return [];
  return rows.map((r: any) => ({ id: num(r.id), name: String(r.name), schema: String(r.schema_name), current: num(r.id) === ctx.shop!.id }));
}

/** Each person's accounts in the other boutiques: e-mail → [shop id, his profile id there, his open items there]. */
async function sisterAccounts(ctx: Ctx, area: Area, sisters: Sister[], emails: string[], excluded: string[]) {
  const out = new Map<string, { shop: number; profile: number; load: number }[]>();
  if (!emails.length) return out;
  for (const sh of sisters) {
    if (sh.current) continue;
    const rows = await ctx
      .t!.shop(sh.schema)
      .query(`SELECT p.id, lower(p.email) AS email, ${loadOf(area)} AS load FROM profiles p WHERE p.active AND lower(p.email) = ANY($1)`, [emails, excluded])
      .catch(() => []);
    for (const r of rows as any[]) out.set(r.email, [...(out.get(r.email) ?? []), { shop: sh.id, profile: num(r.id), load: num(r.load) }]);
  }
  return out;
}

/**
 * Agents who also work in the owner's other boutiques: one maximum for all (their open items there count here), and
 * nothing from this boutique when their « boutiques » leave it out.
 */
export async function withSisters(ctx: Ctx, area: Area, list: Agent[], a: AssignArea, sisters?: Sister[]) {
  const sis = sisters ?? (await sisterShops(ctx));
  const here = sis.find((x) => x.current)?.id;
  const acc = sis.length ? await sisterAccounts(ctx, area, sis, list.map((x) => x.email).filter(Boolean), a.excluded) : new Map();
  for (const x of list) {
    const want = x.cfg.shops;
    x.notHere = !!here && want.length > 0 && !want.includes(here);
    x.elsewhere = (acc.get(x.email) ?? []).filter((o: { shop: number }) => !want.length || want.includes(o.shop)).reduce((n: number, o: { load: number }) => n + o.load, 0);
    x.load += x.elsewhere;
  }
  return { sisters: sis, accounts: acc };
}

/** Gives the items to the agents of `list` under `cfg` (one run); the agents' loads are kept up to date. */
async function giveItems(ctx: Ctx, area: Area, items: Item[], list: Agent[], cfg: Assign, turns: SettingsMap['autoAssignTurn'], now: number) {
  const a = cfg[area];
  const score = a.mode === 'smart' ? await smartScorer(ctx.db, area) : undefined;
  const forWomen = new Set(cfg.womenProducts);
  let assigned = 0;
  for (const it of items) {
    // « Sur alerte »: a parcel with no alert waits for one
    if (area === 'follow' && a.when !== 'shipped' && !it.alert) continue;
    it.woman = isWomanName(it.name) || it.productIds.some((p) => forWomen.has(p));
    const prev = await prevAgent(ctx.db, area, it, a);
    const pick = pickAgent(list, it, area, cfg, turns, now, { prev, score: score ? (x) => score(x, it) : undefined });
    if (!pick) continue;
    if (await giveTo(ctx.db, area, it.id, pick.agent.id, pick.why)) {
      pick.agent.load++;
      pick.agent.lastAt = now;
      assigned++;
    }
  }
  return assigned;
}

/**
 * A confirmation agency's own « Affectation » for its orders in this store (null: it has none, or it is on Manuel):
 * its settings and its people as the agency sees them (on line in the agency's space), as their accounts in this store.
 */
async function agencyPlan(ctx: Ctx, area: Area, agencyId: number, now: number): Promise<{ cfg: Assign; list: Agent[]; adb: Db } | null> {
  const t = ctx.t;
  if (!t) return null;
  const s = await loadShop(t, { id: agencyId }).catch(() => null);
  if (!s || s.kind !== 'agency') return null;
  const adb = t.shop(s.schema);
  const cfg = await getAssign(adb);
  if (cfg[area].mode === 'manual') return null;
  const team = await adb.query(`SELECT id, lower(email) AS email, presence, last_seen_at FROM profiles WHERE active AND $1 = ANY(roles)`, [ROLE[area]]);
  const byEmail = new Map<string, any>(team.map((r: any) => [String(r.email), r]));
  const rows = await ctx.db.query(
    `SELECT p.id, p.name, lower(p.email) AS email, p.agency_products, ${loadOf(area)} AS load,
            (SELECT max(e.at) FROM order_events e WHERE e.kind IN ('assign', 'rotate') AND e.user_id IS NULL AND e.to_value = p.id::text AND e.at > now() - interval '2 days') AS last_at
       FROM profiles p WHERE p.active AND p.agency_id = $1 ORDER BY p.id`,
    [agencyId, cfg[area].excluded],
  );
  const list: Agent[] = [];
  for (const r of rows as any[]) {
    const me = byEmail.get(String(r.email));
    if (!me) continue;
    const seen = me.last_seen_at ? Date.parse(new Date(me.last_seen_at).toISOString()) : 0;
    const online = now - seen < ONLINE_MS && me.presence !== 'idle';
    const c = { ...AGENT_DEFAULT, ...(cfg.agents[String(me.id)] ?? {}) };
    list.push({
      id: num(r.id),
      name: String(r.name),
      agencyId,
      agencyProducts: Array.isArray(r.agency_products) ? r.agency_products.map(num) : null,
      presence: String(me.presence ?? ''),
      online,
      free: online && me.presence !== 'call',
      cfg: c,
      email: String(r.email),
      load: num(r.load),
      elsewhere: 0,
      notHere: !!ctx.shop && c.shops.length > 0 && !c.shops.includes(ctx.shop.id),
      lastAt: r.last_at ? Date.parse(new Date(r.last_at).toISOString()) : 0,
    });
  }
  // the order of the turns: the agency's people, as their accounts here
  const ids = new Map(list.map((x) => [x.email, x.id]));
  const here = (aid: number | null) => (aid ? (ids.get(String(team.find((m: any) => num(m.id) === aid)?.email ?? '')) ?? null) : null);
  const order = cfg.order.map(here).filter((x): x is number => !!x);
  const a = cfg[area];
  return { cfg: { ...cfg, order, [area]: { ...a, rotation: { ...a.rotation, target: here(a.rotation.target) } } }, list, adb };
}

/**
 * One run for an area: the store's own orders under the store's settings, an agency's orders under the agency's own
 * (Facturation › Affectation in its space); gives back what absent agents never touched, then gives the waiting items.
 */
export async function runArea(ctx: Ctx, area: Area, ids?: number[], cfgIn?: Assign, only?: { agency: number }) {
  const cfg = cfgIn ?? (await getAssign(ctx.db));
  const a = cfg[area];
  const now = ctx.now();
  const items = (await waiting(ctx.db, area, ids)).filter((x) => !only || x.agencyId === only.agency);
  let assigned = 0;
  let back = 0;
  let moved = 0;
  // the store's own orders
  const own = items.filter((x) => x.agencyId === null);
  if (a.mode !== 'manual' && !only) {
    const list = (await agentsOf(ctx.db, area, cfg, now)).filter((x) => x.agencyId === null);
    await withSisters(ctx, area, list, a);
    if (!ids) back += await giveBack(ctx.db, area, a, list, now);
    const turns = { ...(await getSetting(ctx.db, 'autoAssignTurn')) };
    if (!ids) moved += await rotate(ctx, area, list, cfg, turns, now, null);
    assigned += await giveItems(ctx, area, own, list, cfg, turns, now);
    if (a.mode === 'turn') await setSetting(ctx.db, 'autoAssignTurn', turns);
  }
  // each agency's orders, under the agency's own settings
  const agencies = [...new Set(items.map((x) => x.agencyId).filter((x): x is number => x !== null))];
  if (only && !agencies.includes(only.agency)) agencies.push(only.agency);
  if (!ids && ctx.t && !only) {
    // an agency with nothing waiting may still have to take back what an absent agent never touched
    const more = await ctx.db.query(`SELECT DISTINCT agency_id FROM profiles WHERE active AND agency_id IS NOT NULL`).catch(() => []);
    for (const r of more as any[]) if (!agencies.includes(num(r.agency_id))) agencies.push(num(r.agency_id));
  }
  for (const ag of agencies) {
    const plan = await agencyPlan(ctx, area, ag, now).catch(() => null);
    if (!plan) continue;
    if (!ids) back += await giveBack(ctx.db, area, plan.cfg[area], plan.list, now);
    const turns = { ...(await getSetting(plan.adb, 'autoAssignTurn')) };
    if (!ids) moved += await rotate(ctx, area, plan.list, plan.cfg, turns, now, ag);
    const mine = items.filter((x) => x.agencyId === ag);
    if (mine.length) assigned += await giveItems(ctx, area, mine, plan.list, plan.cfg, turns, now);
    if (plan.cfg[area].mode === 'turn') await setSetting(plan.adb, 'autoAssignTurn', turns);
  }
  if (assigned || back || moved) ctx.emit({ type: 'orders' });
  return { assigned, back, moved, waiting: items.length - assigned };
}

// ---------------------------------------------------------------- rotation (piece B)
/** What its agent did not act on in time, ready to move: the item, who has it and since when. */
interface Overdue extends Item {
  cur: number;
  got: number;
  status: string;
}
const ON_ROAD_ALERT = `o.follow_status = 'alert' AND COALESCE(o.sub_status, '') <> 'alert_traitee'`;
/** what counts as acting on an item: a call, a status, a note, a Suivi outcome */
const ACTED = `('call','conf_status','follow_status','note','sub_status','suivi_motif','edit')`;

/** When an item given at `got` is due to move: `minutes` of the shop's call hours later (the night does not count). */
async function dueAt(db: Db, got: number, minutes: number): Promise<number> {
  return addWorkMinutes(got, minutes, await getSetting(db, 'calls'));
}

/** The items of a scope (the store's own, or one agency's) that waited too long with the same agent. */
async function overdue(db: Db, area: Area, rot: AssignRotation, now: number, agencyId: number | null): Promise<Overdue[]> {
  const cutoff = new Date(now - rot.minutes * 60_000).toISOString();
  // built into SQL: only a whole positive number goes there
  if (agencyId !== null && (!Number.isSafeInteger(agencyId) || agencyId <= 0)) return [];
  const scope = agencyId === null ? `o.${AGENCY_COL[area]} IS NULL` : `o.${AGENCY_COL[area]} = ${agencyId}`;
  const cols = `o.id, o.phone, o.customer_name, o.channel, o.${AGENCY_COL[area]} AS agency, o.route_product_id, o.total, o.wilaya_id, o.conf_status AS status,
    ARRAY(SELECT DISTINCT i.product_id FROM order_items i WHERE i.order_id = o.id AND i.product_id IS NOT NULL) AS products`;
  const rows =
    area === 'conf'
      ? await db.query(
          `SELECT ${cols}, o.agent_id AS cur, o.assigned_at AS got FROM orders o
            WHERE o.agent_id IS NOT NULL AND NOT o.is_exchange AND o.conf_status = ANY($1) AND o.assigned_at IS NOT NULL AND o.assigned_at < $2
              AND o.created_at > now() - interval '30 days' AND (o.locked_until IS NULL OR o.locked_until < now()) AND ${scope}
              AND ($3::boolean IS NOT TRUE OR NOT EXISTS (SELECT 1 FROM order_events x WHERE x.order_id = o.id AND x.user_id = o.agent_id AND x.at >= o.assigned_at AND x.kind IN ${ACTED}))
            ORDER BY o.assigned_at LIMIT 200`,
          [rot.statuses, cutoff, rot.noCall],
        )
      : await db.query(
          `SELECT ${cols}, o.follow_agent_id AS cur, g.at AS got FROM orders o
            CROSS JOIN LATERAL (SELECT GREATEST(
              (SELECT max(e.at) FROM order_events e WHERE e.order_id = o.id AND e.kind IN ('assign', 'rotate') AND e.to_value = o.follow_agent_id::text),
              (SELECT max(e.at) FROM order_events e WHERE e.order_id = o.id AND e.kind = 'follow_status' AND e.to_value = 'alert')) AS at) g
            WHERE o.follow_agent_id IS NOT NULL AND ${ON_ROAD_ALERT} AND g.at IS NOT NULL AND g.at < $1
              AND (o.locked_until IS NULL OR o.locked_until < now()) AND ${scope}
              AND ($2::boolean IS NOT TRUE OR NOT EXISTS (SELECT 1 FROM order_events x WHERE x.order_id = o.id AND x.user_id = o.follow_agent_id AND x.at > g.at AND x.kind IN ${ACTED}))
            ORDER BY g.at LIMIT 200`,
          [cutoff, rot.noCall],
        );
  const calls = await getSetting(db, 'calls');
  return rows
    .map((r: any) => ({
      id: num(r.id),
      phone: String(r.phone ?? ''),
      name: String(r.customer_name ?? ''),
      channel: String(r.channel ?? ''),
      agencyId: numOrNull(r.agency),
      productIds: (r.products ?? []).map(num),
      routeProduct: numOrNull(r.route_product_id),
      total: num(r.total),
      wilayaId: numOrNull(r.wilaya_id),
      cur: num(r.cur),
      got: Date.parse(new Date(r.got).toISOString()),
      status: String(r.status ?? ''),
    }))
    // (the clock time above is the first sieve; what counts is the time inside the call hours)
    .filter((x: Overdue) => addWorkMinutes(x.got, rot.minutes, calls) <= now);
}

/**
 * The supervisors on line who may get an item after its moves: the agent's own team manager first, then the agent
 * managers of the scope (an agency's: its people with the role, as their accounts in this store).
 */
async function leadsFor(ctx: Ctx, cur: number, agencyId: number | null, now: number): Promise<number[]> {
  const since = new Date(now - ONLINE_MS).toISOString();
  const seen = `p.last_seen_at > $1::timestamptz AND COALESCE(p.presence, '') <> 'idle'`;
  if (agencyId === null) {
    const rows = await ctx.db.query(`SELECT p.id FROM profiles p WHERE p.active AND p.agency_id IS NULL AND 'agent_manager' = ANY(p.roles) AND ${seen} ORDER BY p.id`, [since]);
    const ids = rows.map((r: any) => num(r.id));
    const team = (await getSetting(ctx.db, 'teams')).find((t) => t.agentIds.includes(cur));
    const mgr = team?.managerId ?? null;
    return mgr && ids.includes(mgr) ? [mgr, ...ids.filter((x) => x !== mgr)] : ids;
  }
  if (!ctx.t) return [];
  const s = await loadShop(ctx.t, { id: agencyId }).catch(() => null);
  if (!s) return [];
  const leads = await ctx.t.shop(s.schema).query(`SELECT p.id, lower(p.email) AS email FROM profiles p WHERE p.active AND 'agent_manager' = ANY(p.roles) AND ${seen}`, [since]);
  if (!leads.length) return [];
  const rows = await ctx.db.query(`SELECT id FROM profiles WHERE active AND agency_id = $1 AND (agency_profile_id = ANY($2) OR lower(email) = ANY($3)) ORDER BY id`, [
    agencyId,
    leads.map((l: any) => num(l.id)),
    leads.map((l: any) => String(l.email)),
  ]);
  return rows.map((r: any) => num(r.id));
}

/**
 * Rotation of a scope: each item its agent did not act on in time goes to another one — never back to someone who had
 * it, to a supervisor after `toLeadAfter` moves (then it stays with him), to the chosen agent or by the split; an item
 * open on someone's screen (locked) waits; with nobody to take it, it stays where it is.
 */
async function rotate(ctx: Ctx, area: Area, list: Agent[], cfg: Assign, turns: SettingsMap['autoAssignTurn'], now: number, agencyId: number | null): Promise<number> {
  const rot = cfg[area].rotation;
  if (!rot?.on) return 0;
  let moved = 0;
  const late = await overdue(ctx.db, area, rot, now, agencyId);
  if (!late.length) return 0;
  const score = cfg[area].mode === 'smart' ? await smartScorer(ctx.db, area) : undefined;
  const forWomen = new Set(cfg.womenProducts);
  const setStatus = area === 'conf' && rot.setStatus && (CONF_TODO as string[]).includes(rot.setStatus) ? rot.setStatus : '';
  for (const it of late) {
    it.woman = isWomanName(it.name) || it.productIds.some((p) => forWomen.has(p));
    const hist = await ctx.db.query(`SELECT from_value, to_value, data FROM order_events WHERE order_id = $1 AND kind = 'rotate' AND data->>'area' = $2`, [it.id, area]);
    // with a supervisor already, or moved many times: it stays
    if (hist.some((h: any) => h.data?.lead) || hist.length >= 10) continue;
    const tried = new Set<number>([it.cur, ...hist.flatMap((h: any) => [num(h.from_value), num(h.to_value)])]);
    let to: number | null = null;
    let why = '';
    let lead = false;
    if (rot.toLeadAfter > 0 && hist.length >= rot.toLeadAfter) {
      const l = (await leadsFor(ctx, it.cur, agencyId, now)).find((x) => x !== it.cur);
      if (l) {
        to = l;
        lead = true;
        why = 'superviseur';
      }
    }
    if (to === null && rot.target && !tried.has(rot.target)) {
      const a = list.find((x) => x.id === rot.target);
      if (a && cannot(a, it, cfg[area], now) === null) {
        to = a.id;
        why = 'agent choisi';
      }
    }
    if (to === null) {
      const pick = pickAgent(list, it, area, cfg, turns, now, { skip: [...tried], score: score ? (x) => score(x, it) : undefined });
      if (pick) {
        to = pick.agent.id;
        why = pick.why;
      }
    }
    if (to === null) continue;
    const r =
      area === 'conf'
        ? await ctx.db.query(
            `UPDATE orders SET agent_id = $3, assigned_at = now(), conf_status = CASE WHEN $4 <> '' THEN $4 ELSE conf_status END, updated_at = now(), version = version + 1
              WHERE id = $1 AND agent_id = $2 AND (locked_until IS NULL OR locked_until < now()) RETURNING id`,
            [it.id, it.cur, to, setStatus],
          )
        : await ctx.db.query(
            `UPDATE orders SET follow_agent_id = $3, updated_at = now(), version = version + 1
              WHERE id = $1 AND follow_agent_id = $2 AND (locked_until IS NULL OR locked_until < now()) RETURNING id`,
            [it.id, it.cur, to],
          );
    if (!r[0]) continue;
    const how = rot.noCall ? 'sans action' : 'sans avancer';
    await addEvent(ctx.db, it.id, null, 'rotate', String(it.cur), String(to), `Rotation (${area === 'conf' ? 'confirmation' : 'suivi'}) · ${rot.minutes} min ${how} · ${why}`, { area, lead });
    if (setStatus && setStatus !== it.status) await addEvent(ctx.db, it.id, null, 'conf_status', it.status, setStatus, 'Rotation');
    const from = list.find((x) => x.id === it.cur);
    if (from) from.load = Math.max(0, from.load - 1);
    const dest = list.find((x) => x.id === to);
    if (dest) {
      dest.load++;
      dest.lastAt = now;
    }
    moved++;
  }
  return moved;
}

/**
 * When each item will move if nobody acts (the countdown on the order): the store's own rotation, or its agency's.
 * Items that will not move (rotation off, the status not in it, the agent already acted, with a supervisor) are absent.
 */
export async function rotateTimes(ctx: Ctx, area: Area, ids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!ids.length) return out;
  const rows =
    area === 'conf'
      ? await ctx.db.query(
          `SELECT o.id, o.agent_id AS cur, o.assigned_at AS got, o.conf_status AS status, o.conf_agency_id AS agency,
                  EXISTS (SELECT 1 FROM order_events x WHERE x.order_id = o.id AND x.user_id = o.agent_id AND x.at >= o.assigned_at AND x.kind IN ${ACTED}) AS acted,
                  EXISTS (SELECT 1 FROM order_events x WHERE x.order_id = o.id AND x.kind = 'rotate' AND x.data->>'area' = 'conf' AND (x.data->>'lead')::boolean) AS with_lead
             FROM orders o WHERE o.id = ANY($1) AND o.agent_id IS NOT NULL AND o.assigned_at IS NOT NULL`,
          [ids],
        )
      : await ctx.db.query(
          `SELECT o.id, o.follow_agent_id AS cur, g.at AS got, 'alert' AS status, o.follow_agency_id AS agency,
                  EXISTS (SELECT 1 FROM order_events x WHERE x.order_id = o.id AND x.user_id = o.follow_agent_id AND x.at > g.at AND x.kind IN ${ACTED}) AS acted,
                  EXISTS (SELECT 1 FROM order_events x WHERE x.order_id = o.id AND x.kind = 'rotate' AND x.data->>'area' = 'follow' AND (x.data->>'lead')::boolean) AS with_lead
             FROM orders o CROSS JOIN LATERAL (SELECT GREATEST(
              (SELECT max(e.at) FROM order_events e WHERE e.order_id = o.id AND e.kind IN ('assign', 'rotate') AND e.to_value = o.follow_agent_id::text),
              (SELECT max(e.at) FROM order_events e WHERE e.order_id = o.id AND e.kind = 'follow_status' AND e.to_value = 'alert')) AS at) g
            WHERE o.id = ANY($1) AND o.follow_agent_id IS NOT NULL AND ${ON_ROAD_ALERT} AND g.at IS NOT NULL`,
          [ids],
        );
  const cfgs = new Map<string, Assign | null>();
  const cfgOf = async (agency: number | null) => {
    const k = String(agency);
    if (!cfgs.has(k)) {
      if (agency === null) cfgs.set(k, await getAssign(ctx.db));
      else {
        const s = ctx.t ? await loadShop(ctx.t, { id: agency }).catch(() => null) : null;
        cfgs.set(k, s ? await getAssign(ctx.t!.shop(s.schema)) : null);
      }
    }
    return cfgs.get(k)!;
  };
  for (const r of rows as any[]) {
    const cfg = await cfgOf(numOrNull(r.agency));
    const rot = cfg?.[area].rotation;
    if (!cfg || !rot?.on || cfg[area].mode === 'manual' || r.with_lead) continue;
    if (area === 'conf' && !(rot.statuses as string[]).includes(String(r.status))) continue;
    if (rot.noCall && r.acted) continue;
    out.set(num(r.id), await dueAt(ctx.db, Date.parse(new Date(r.got).toISOString()), rot.minutes));
  }
  return out;
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

/** An agent's « boutiques » are the same everywhere: written in his account of each of the owner's boutiques. */
async function shareShops(ctx: Ctx, agents: Record<string, AssignAgent>) {
  const sis = (await sisterShops(ctx)).filter((x) => !x.current);
  const ids = Object.keys(agents).map(Number);
  if (!sis.length || !ids.length) return;
  const rows = await ctx.db.query('SELECT id, lower(email) AS email FROM profiles WHERE id = ANY($1)', [ids]);
  const byEmail = new Map<string, number[]>(rows.map((r: any) => [String(r.email), agents[String(r.id)].shops]));
  for (const sh of sis) {
    const db = ctx.t!.shop(sh.schema);
    const there = await db.query('SELECT id, lower(email) AS email FROM profiles WHERE lower(email) = ANY($1)', [[...byEmail.keys()]]).catch(() => []);
    if (!there.length) continue;
    const cur = await getSetting(db, 'autoAssign');
    const next = { ...cur, agents: { ...(cur.agents ?? {}) } };
    for (const r of there as any[]) next.agents[String(r.id)] = { ...AGENT_DEFAULT, ...(next.agents[String(r.id)] ?? {}), shops: byEmail.get(String(r.email)) ?? [] };
    await setSetting(db, 'autoAssign', next);
  }
}

/** Settings to save: a screen that did not send the rotation keeps the one already saved. */
export async function withRotation<T extends { conf: { rotation?: unknown }; follow: { rotation?: unknown } }>(db: Db, i: T): Promise<Assign> {
  const cur = await getAssign(db);
  return { ...i, conf: { ...i.conf, rotation: i.conf.rotation ?? cur.conf.rotation }, follow: { ...i.follow, rotation: i.follow.rotation ?? cur.follow.rotation } } as unknown as Assign;
}

export const AreaIn = z.object({
  mode: z.enum(['manual', 'turn', 'load', 'smart']),
  by: z.enum(['all', 'channel', 'product']),
  excluded: z.array(z.string().max(40)).max(40),
  max: z.number().int().min(0).max(500),
  offlineMin: z.number().int().min(5).max(240),
  sameClient: z.boolean(),
  respectAccess: z.boolean(),
  hideHistory: z.boolean(),
  speedFirst: z.boolean(),
  womenToWomen: z.boolean().default(false),
  when: z.enum(['alert', 'shipped']).default('alert'),
  toConfirmer: z.boolean().default(false),
  rotation: z
    .object({
      on: z.boolean(),
      // only « à traiter » statuses: a confirmed or cancelled order never moves, and a move never confirms or cancels
      statuses: z
        .array(z.enum(CONF_STATUSES))
        .max(20)
        .transform((a) => a.filter((x) => CONF_TODO.includes(x))),
      minutes: z.number().int().min(5).max(7 * 24 * 60),
      noCall: z.boolean(),
      toLeadAfter: z.number().int().min(0).max(10),
      setStatus: z.union([z.literal(''), z.enum(CONF_STATUSES)]).transform((x) => (x && CONF_TODO.includes(x) ? x : '')),
      target: z.number().int().positive().nullable(),
    })
    .optional(),
});
export const AgentIn = z.object({
  out: z.boolean(),
  weight: z.number().int().min(1).max(3),
  channels: z.array(z.string().max(30)).max(20),
  products: z.array(z.number().int().positive()).max(200),
  from: z.number().min(0).max(24).nullable(),
  to: z.number().min(0).max(24).nullable(),
  langs: z.array(z.string().max(10)).max(5),
  senior: z.boolean(),
  shops: z.array(z.number().int().positive()).max(50).default([]),
  woman: z.boolean().default(false),
});

/** Administrators, and the roles or people given it « en plus » (Utilisateurs › Rôles: « Affectation »). */
async function needAffect(ctx: Ctx) {
  if (!(await can(ctx, 'x:affect'))) throw forbidden('Seul l’administrateur (ou une personne qu’il a choisie) règle l’affectation');
}

export const assignProcs = {
  /** The settings and every agent of both areas with their state now (on line, open items, his own settings). */
  'assign.get': proc(null, z.object({}), async (ctx) => {
    await needAffect(ctx);
    const cfg = await getAssign(ctx.db);
    const now = ctx.now();
    const [conf, follow] = await Promise.all([agentsOf(ctx.db, 'conf', cfg, now), agentsOf(ctx.db, 'follow', cfg, now)]);
    const sisters = await sisterShops(ctx);
    const sc = await withSisters(ctx, 'conf', conf, cfg.conf, sisters);
    const sf = await withSisters(ctx, 'follow', follow, cfg.follow, sisters);
    const here = sisters.find((x) => x.current)?.id;
    const shopsOf = (x: Agent) => (here ? [here, ...[...(sc.accounts.get(x.email) ?? []), ...(sf.accounts.get(x.email) ?? [])].map((o) => o.shop)] : []);
    const waitingNow = {
      conf: num((await ctx.db.query(`SELECT count(*)::int AS n FROM orders WHERE agent_id IS NULL AND conf_status = ANY($1) AND NOT is_exchange AND created_at > now() - interval '30 days'`, [CONF_TODO]))[0]?.n),
      follow: num((await ctx.db.query(`SELECT count(*)::int AS n FROM orders WHERE follow_agent_id IS NULL AND follow_status = ANY($1)`, [cfg.follow.when === 'shipped' ? ['shipped', 'out_for_delivery', 'failed', 'alert', 'in_exchange'] : ['alert']]))[0]?.n),
    };
    const pub = (x: Agent) => ({ id: x.id, name: x.name, online: x.online, free: x.free, presence: x.presence, load: x.load, agency: x.agencyId !== null, inHours: inHours(x.cfg, now), elsewhere: x.elsewhere, shops: [...new Set(shopsOf(x))] });
    return { cfg, conf: conf.map(pub), follow: follow.map(pub), waiting: waitingNow, shops: sisters.map((x) => ({ id: x.id, name: x.name, current: x.current })) };
  }),

  'assign.set': proc(
    null,
    z.object({ conf: AreaIn, follow: AreaIn, agents: z.record(AgentIn), order: z.array(z.number().int().positive()).max(500), womenProducts: z.array(z.number().int().positive()).max(500).default([]) }),
    async (ctx, i) => {
      await needAffect(ctx);
      for (const [k, v] of Object.entries(i.agents)) if (v.from !== null && v.to !== null && v.from === v.to) throw bad(`Agent ${k} : l’heure de début et de fin sont pareilles`);
      await setSetting(ctx.db, 'autoAssign', await withRotation(ctx.db, i), ctx.session.profile.id);
      await shareShops(ctx, i.agents);
      return { ok: true };
    },
  ),

  /** « Répartir maintenant », and the job every minute: both areas. */
  'assign.run': proc(null, z.object({}), async (ctx) => {
    await needAffect(ctx);
    const cfg = await getAssign(ctx.db);
    return { conf: await runArea(ctx, 'conf', undefined, cfg), follow: await runArea(ctx, 'follow', undefined, cfg) };
  }),
};
