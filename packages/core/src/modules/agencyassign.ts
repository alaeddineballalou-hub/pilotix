// A confirmation agency's own « Affectation » (its space, Facturation › Affectation): the agency's orders in every
// store it works for (orders whose agency is this one) go to the agency's own agents — Manuel, Tour de rôle, Moins
// chargé, with the same rules as a store's. The settings live in the agency's space; each store applies them to the
// agency's orders (assign.ts: agencyPlan), on line meaning on line in the agency's space.
import { CONF_TODO } from '@pilotix/shared';
import { z } from 'zod';
import { num } from '../db';
import { bad, Ctx, forbidden, proc } from '../rpc';
import { setSetting } from '../settings';
import { loadShop, platformSettings, shopCtx, shopStatus } from '../platform/shops';
import { LINK_SQL, toLink } from './agencies';
import { AGENT_DEFAULT, AgentIn, AreaIn, getAssign, inHours, loadOf, ONLINE_MS, ROLE, runArea, withRotation, type Area } from './assign';

function needAgency(ctx: Ctx) {
  if (!ctx.t || ctx.shop?.kind !== 'agency') throw forbidden('Réservé aux agences de confirmation');
}

/** The stores the agency works for now (contracts in force, store still open). */
async function stores(ctx: Ctx) {
  const rows = await ctx.t!.platform.query(`${LINK_SQL} WHERE l.agency_id = $1 AND l.status = 'active' ORDER BY s.name, l.id`, [ctx.shop!.id]);
  return rows
    .map(toLink)
    .filter((L: any) => L.storeOk)
    .map((L: any) => ({ id: L.info.store.id as number, name: L.info.store.name as string, schema: L.storeSchema as string }));
}

export const agencyAssignProcs = {
  /** The agency's settings, its agents (on line in its space, open orders in every store) and what waits. */
  'agency.assign.get': proc([], z.object({}), async (ctx) => {
    needAgency(ctx);
    const cfg = await getAssign(ctx.db);
    const now = ctx.now();
    const sts = await stores(ctx);
    const agencyId = ctx.shop!.id;
    const waiting = { conf: 0, follow: 0 };
    // e-mail → open items per area, and the stores where the person has an account
    const load: Record<Area, Map<string, number>> = { conf: new Map(), follow: new Map() };
    const where = new Map<string, number[]>();
    for (const s of sts) {
      const db = ctx.t!.shop(s.schema);
      try {
        waiting.conf += num((await db.query(`SELECT count(*)::int AS n FROM orders WHERE conf_agency_id = $1 AND agent_id IS NULL AND conf_status = ANY($2) AND NOT is_exchange AND created_at > now() - interval '30 days'`, [agencyId, CONF_TODO]))[0]?.n);
        waiting.follow += num((await db.query(`SELECT count(*)::int AS n FROM orders WHERE follow_agency_id = $1 AND follow_agent_id IS NULL AND follow_status = ANY($2)`, [agencyId, cfg.follow.when === 'shipped' ? ['shipped', 'out_for_delivery', 'failed', 'alert', 'in_exchange'] : ['alert']]))[0]?.n);
        for (const area of ['conf', 'follow'] as const) {
          const rows = await db.query(`SELECT lower(p.email) AS email, ${loadOf(area)} AS load FROM profiles p WHERE p.active AND p.agency_id = $1`, [agencyId, cfg[area].excluded]);
          for (const r of rows as any[]) {
            load[area].set(r.email, (load[area].get(r.email) ?? 0) + num(r.load));
            if (area === 'conf') where.set(r.email, [...(where.get(r.email) ?? []), s.id]);
          }
        }
      } catch {
        // a store being moved or repaired: counted next time
      }
    }
    const people = async (area: Area) =>
      (await ctx.db.query(`SELECT id, name, lower(email) AS email, presence, last_seen_at FROM profiles WHERE active AND $1 = ANY(roles) ORDER BY id`, [ROLE[area]])).map((r: any) => {
        const seen = r.last_seen_at ? Date.parse(new Date(r.last_seen_at).toISOString()) : 0;
        const online = now - seen < ONLINE_MS && r.presence !== 'idle';
        const c = { ...AGENT_DEFAULT, ...(cfg.agents[String(r.id)] ?? {}) };
        return { id: num(r.id), name: String(r.name), online, free: online && r.presence !== 'call', presence: String(r.presence ?? ''), load: load[area].get(r.email) ?? 0, agency: true, inHours: inHours(c, now), elsewhere: 0, shops: where.get(r.email) ?? [] };
      });
    return { cfg, conf: await people('conf'), follow: await people('follow'), waiting, shops: sts.map((s) => ({ id: s.id, name: s.name, current: false })), agencyMode: true as const };
  }),

  'agency.assign.set': proc(
    [],
    z.object({ conf: AreaIn, follow: AreaIn, agents: z.record(AgentIn), order: z.array(z.number().int().positive()).max(500), womenProducts: z.array(z.number().int().positive()).max(500).default([]) }),
    async (ctx, i) => {
      needAgency(ctx);
      for (const [k, v] of Object.entries(i.agents)) if (v.from !== null && v.to !== null && v.from === v.to) throw bad(`Agent ${k} : l’heure de début et de fin sont pareilles`);
      await setSetting(ctx.db, 'autoAssign', await withRotation(ctx.db, i), ctx.session.profile.id);
      return { ok: true };
    },
  ),

  /** « Répartir maintenant »: the agency's waiting orders in every store, now (the stores also do it every minute). */
  'agency.assign.run': proc([], z.object({}), async (ctx) => {
    needAgency(ctx);
    const t = ctx.t!;
    const grace = (await platformSettings(t)).trial.graceDays;
    const out = { conf: { assigned: 0, back: 0, moved: 0, waiting: 0 }, follow: { assigned: 0, back: 0, moved: 0, waiting: 0 } };
    for (const s of await stores(ctx)) {
      const shop = await loadShop(t, { id: s.id });
      if (!shop) continue;
      const st = shopStatus(shop, ctx.now(), grace);
      if (st.locked) continue;
      const sctx: Ctx = { db: t.shop(s.schema), session: ctx.session, shop: shopCtx(shop, st), now: ctx.now, emit: ctx.emit, t };
      for (const area of ['conf', 'follow'] as const) {
        const r = await runArea(sctx, area, undefined, undefined, { agency: ctx.shop!.id }).catch(() => null);
        if (r) for (const k of ['assigned', 'back', 'moved', 'waiting'] as const) out[area][k] += r[k];
      }
    }
    return out;
  }),
};
