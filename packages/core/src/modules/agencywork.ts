// A partner's space works for its sellers: one seller at a time (the picker at the top of the page), or all of them
// together. Each action runs inside the store, as the person's own account there (agencies.ts opens those accounts),
// with the limits of agencyscope.ts: an agency's orders only (the person's products only, when the chief chose some),
// the confirmation and suivi work only; a marketer's ad sets only, the ads work only. « Tous les vendeurs » asks every
// store and puts the answers together (counts added up, lists merged in their order, the next order to call taken
// from the store whose customer waits the most, every ad set of every seller).
import type { AgencySeller } from '@pilotix/shared';
import { z } from 'zod';
import { num } from '../db';
import { bad, Ctx, forbidden, hasRole, makeSession, proc } from '../rpc';
import { loadShop, platformSettings, shopCtx, shopStatus } from '../platform/shops';
import { LINK_SQL, Link, toLink } from './agencies';
import { FANOUT, fanOut, nextAcross, Runner } from './fanout';
import { profileById } from './users';
import { getSetting } from '../settings';

export type { Runner } from './fanout';

/** One seller the person works for now, and their account in that store. */
interface Work {
  L: Link;
  profileId: number;
}

const sellerOf = (L: Link): AgencySeller => ({ id: L.info.store.id, name: L.info.store.name, code: L.info.store.code, linkId: L.info.id, tasks: L.info.tasks, owner: L.info.store.owner ?? null });

/**
 * The sellers this person of the agency works for now: contracts in force (the agency checked by Pilotix, not
 * suspended; the store open) where they have an open account — `only`: that one store.
 */
export async function sellerWork(ctx: Ctx, only?: number): Promise<Work[]> {
  const t = ctx.t;
  if (!t || (ctx.shop?.kind !== 'agency' && ctx.shop?.kind !== 'marketer')) throw forbidden('Réservé aux agences de confirmation et aux marketers');
  const agencyId = ctx.shop.id;
  const email = ctx.session.profile.email.toLowerCase();
  const rows = await t.platform.query(`${LINK_SQL} WHERE l.agency_id = $1 AND l.status = 'active'${only ? ' AND l.store_id = $2' : ''} ORDER BY s.name, l.id`, only ? [agencyId, only] : [agencyId]);
  const out: Work[] = [];
  for (const L of rows.map(toLink)) {
    if (!L.agencyOk || !L.storeOk) continue;
    const p = (await t.shop(L.storeSchema).query('SELECT id FROM profiles WHERE lower(email) = $1 AND agency_id = $2 AND active', [email, agencyId]))[0];
    if (p) out.push({ L, profileId: num(p.id) });
  }
  return out;
}

/** The sellers of the picker at the top of the agency's space. */
export async function sellersOf(ctx: Ctx): Promise<AgencySeller[]> {
  return (await sellerWork(ctx)).map((w) => sellerOf(w.L));
}

/**
 * The person's ctx inside one of their stores (the server's own, else made here). A store Pilotix locked waits. A
 * confirmation agency's chief and its chefs d'équipe lead its people there (agencyscope.ts: agencyLead): read from
 * their roles in the agency, as they are now.
 */
async function storeCtx(ctx: Ctx, w: Work, action?: string): Promise<Ctx> {
  const c = await storeCtxOf(ctx, w);
  if (ctx.shop?.kind !== 'agency') return c;
  const next = { ...c, session: { ...c.session, profile: { ...c.session.profile, agencyLead: hasRole(ctx.session, 'agent_manager') } } };
  if (action === 'suivi.stats' || action === 'suivi.statsOn') {
    const teams = await getSetting(ctx.db,'teams');
    const admin = ctx.session.isAdmin || ctx.session.roles.includes('vendeur');
    const own = admin ? teams : teams.filter(t=>t.managerId===ctx.session.profile.id);
    const members = await c.db.query('SELECT id,agency_profile_id FROM profiles WHERE agency_id=$1 AND active',[ctx.shop.id]);
    const mapped = own.map(t=>({id:t.id,name:t.name,agentIds:members.filter(m=>t.agentIds.includes(Number(m.agency_profile_id))||t.managerId===Number(m.agency_profile_id)).map(m=>num(m.id))}));
    // Agency admins may see all of their agency's assigned orders; team managers only their own team.
    return {...next,deliveryStatsTeams: mapped, ...(admin ? {} : {deliveryStatsRestricted:true})};
  }
  return next;
}

async function storeCtxOf(ctx: Ctx, w: Work): Promise<Ctx> {
  const locked = () => bad(`${w.L.info.store.name} est bloquée par Pilotix pour le moment`);
  if (ctx.otherShop) {
    const c = await ctx.otherShop(w.L.info.store.id, w.profileId);
    if (c.shop?.locked) throw locked();
    return c;
  }
  const t = ctx.t!;
  const s = await loadShop(t, { id: w.L.info.store.id });
  if (!s) throw bad('Vendeur introuvable');
  const set = await platformSettings(t);
  const st = shopStatus(s, ctx.now(), set.trial.graceDays);
  if (st.locked) throw locked();
  const db = t.shop(s.schema);
  const p = await profileById(db, w.profileId);
  if (!p?.active) throw forbidden('Vous ne travaillez plus pour ce vendeur');
  return { db, session: makeSession(p), shop: shopCtx(s, st, set.soon.features), now: ctx.now, emit: () => {}, t };
}

/** The procedures of the seller picker's « Tous les vendeurs » (the others need one seller). */
export const FANOUT_PROCS = new Set([...Object.keys(FANOUT), 'orders.next']);

/**
 * An action of a seller's work from the agency's space: in the chosen store, as the person's account there; with
 * « Tous les vendeurs », in each store and put together.
 */
export async function sellerCall(name: string, ctx: Ctx, input: unknown, run: Runner): Promise<unknown> {
  const seller = ctx.seller;
  if (seller === undefined) throw bad('Choisissez un vendeur en haut de la page');
  if (seller !== 'all') {
    const w = (await sellerWork(ctx, seller))[0];
    if (!w) throw forbidden('Vous ne travaillez pas pour ce vendeur');
    return run(await storeCtx(ctx, w, name), name, input);
  }
  const targets = (await sellerWork(ctx)).map((w) => ({ source: { id: w.L.info.store.id, name: w.L.info.store.name }, ctx: () => storeCtx(ctx, w, name) }));
  if (name === 'orders.next') return nextAcross(targets, input, run);
  const fan = FANOUT[name];
  if (!fan) throw bad('Choisissez un vendeur en haut de la page pour cette action');
  return fanOut(name, fan, input, targets, run);
}

/** One of the agency's confirmation agents, and their account in each seller's store (« Attribuer », every seller). */
export interface GivePerson {
  /** the person in the agency (their id there; the e-mail when the store does not know it yet) */
  key: string;
  name: string;
  /** seller (store) id → their account there */
  at: Record<number, number>;
}

export const agencyWorkProcs = {
  /** The sellers this person works for now (the picker at the top of the agency's space). */
  'agency.sellers': proc(null, z.object({}), (ctx) => sellersOf(ctx)),

  /**
   * « Attribuer » in « Tous les vendeurs » (the agency's chief and its chefs d'équipe): the agency's confirmation
   * agents, each with their account in every seller's store the chief works for — an order goes to that store's one.
   */
  'agency.givePeople': proc(['agent_manager'], z.object({}), async (ctx) => {
    if (ctx.shop?.kind !== 'agency') throw forbidden('Réservé aux agences de confirmation');
    // one person, one e-mail: the agency keeps it the same in every store (agencies.ts: syncLink)
    const people = new Map<string, GivePerson>();
    for (const w of await sellerWork(ctx)) {
      if (!w.L.info.tasks.includes('confirmation')) continue;
      const rows = await ctx.t!.shop(w.L.storeSchema).query(
        `SELECT id, name, agency_profile_id, lower(email) AS email FROM profiles WHERE active AND agency_id = $1 AND 'confirmation' = ANY(roles) ORDER BY name, id`,
        [ctx.shop.id],
      );
      for (const r of rows as any[]) {
        const email = String(r.email);
        const p = people.get(email) ?? { key: r.agency_profile_id ? String(num(r.agency_profile_id)) : email, name: String(r.name), at: {} };
        p.at[w.L.info.store.id] = num(r.id);
        people.set(email, p);
      }
    }
    return [...people.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  }),
};
