// A partner's space works for its sellers: one seller at a time (the picker at the top of the page), or all of them
// together. Each action runs inside the store, as the person's own account there (agencies.ts opens those accounts),
// with the limits of agencyscope.ts: an agency's orders only (the person's products only, when the chief chose some),
// the confirmation and suivi work only; a marketer's ad sets only, the ads work only. « Tous les vendeurs » asks every
// store and puts the answers together (counts added up, lists merged in their order, the next order to call taken
// from the store whose customer waits the most, every ad set of every seller).
import type { AgencySeller } from '@pilotix/shared';
import { z } from 'zod';
import { num } from '../db';
import { bad, Ctx, forbidden, makeSession, proc } from '../rpc';
import { loadShop, platformSettings, shopCtx, shopStatus } from '../platform/shops';
import { LINK_SQL, Link, toLink } from './agencies';
import { FANOUT, fanOut, nextAcross, Runner } from './fanout';
import { profileById } from './users';

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

/** The person's ctx inside one of their stores (the server's own, else made here). A store Pilotix locked waits. */
async function storeCtx(ctx: Ctx, w: Work): Promise<Ctx> {
  const locked = () => bad(`${w.L.info.store.name} est bloquée par Pilotix pour le moment`);
  if (ctx.otherShop) {
    const c = await ctx.otherShop(w.L.info.store.id, w.profileId);
    if (c.shop?.locked) throw locked();
    return c;
  }
  const t = ctx.t!;
  const s = await loadShop(t, { id: w.L.info.store.id });
  if (!s) throw bad('Vendeur introuvable');
  const st = shopStatus(s, ctx.now(), (await platformSettings(t)).trial.graceDays);
  if (st.locked) throw locked();
  const db = t.shop(s.schema);
  const p = await profileById(db, w.profileId);
  if (!p?.active) throw forbidden('Vous ne travaillez plus pour ce vendeur');
  return { db, session: makeSession(p), shop: shopCtx(s, st), now: ctx.now, emit: () => {}, t };
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
    return run(await storeCtx(ctx, w), name, input);
  }
  const targets = (await sellerWork(ctx)).map((w) => ({ source: { id: w.L.info.store.id, name: w.L.info.store.name }, ctx: () => storeCtx(ctx, w) }));
  if (name === 'orders.next') return nextAcross(targets, input, run);
  const fan = FANOUT[name];
  if (!fan) throw bad('Choisissez un vendeur en haut de la page pour cette action');
  return fanOut(name, fan, input, targets, run);
}

export const agencyWorkProcs = {
  /** The sellers this person works for now (the picker at the top of the agency's space). */
  'agency.sellers': proc(null, z.object({}), (ctx) => sellersOf(ctx)),
};
