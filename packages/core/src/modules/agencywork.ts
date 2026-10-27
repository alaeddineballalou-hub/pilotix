// A confirmation agency's space works on its sellers' orders: one seller at a time (the picker at the top of the
// page), or all of them together. Each action runs inside the store, as the person's own account there (agencies.ts
// opens those accounts), with the limits of agencyscope.ts: the agency's orders only (the person's products only, when
// the chief chose some), the confirmation and suivi work only. « Tous les vendeurs » asks every store and puts the
// answers together (counts added up, lists merged in their order, the next order to call taken from the store whose
// customer waits the most).
import type { AgencySeller } from '@pilotix/shared';
import { z } from 'zod';
import { num } from '../db';
import { bad, Ctx, forbidden, makeSession, proc } from '../rpc';
import { loadShop, platformSettings, shopCtx, shopStatus } from '../platform/shops';
import { LINK_SQL, Link, toLink } from './agencies';
import { DEFAULT_SORT } from './confirmation';
import { peekNext } from './orders';
import { profileById } from './users';

/** Runs one action in a shop's ctx (index.ts: the registry, the gates). */
export type Runner = (ctx: Ctx, name: string, input: unknown) => Promise<unknown>;

/** One seller the person works for now, and their account in that store. */
interface Work {
  L: Link;
  profileId: number;
}

const sellerOf = (L: Link): AgencySeller => ({ id: L.info.store.id, name: L.info.store.name, code: L.info.store.code, linkId: L.info.id, tasks: L.info.tasks });

/**
 * The sellers this person of the agency works for now: contracts in force (the agency checked by Pilotix, not
 * suspended; the store open) where they have an open account — `only`: that one store.
 */
export async function sellerWork(ctx: Ctx, only?: number): Promise<Work[]> {
  const t = ctx.t;
  if (!t || ctx.shop?.kind !== 'agency') throw forbidden('Réservé aux agences de confirmation');
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

// ---------------------------------------------------------------- « Tous les vendeurs »: answers put together
type Part = { seller: AgencySeller; out: any };

/** Numbers add up, objects key by key (counts of every store). */
function sumDeep(vals: any[]): any {
  const first = vals.find((v) => v !== undefined && v !== null);
  if (typeof first === 'number') return vals.reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    const keys = [...new Set(vals.flatMap((v) => (v && typeof v === 'object' ? Object.keys(v) : [])))];
    return Object.fromEntries(keys.map((k) => [k, sumDeep(vals.map((v) => v?.[k]))]));
  }
  return first ?? null;
}

type Key = (r: any) => number | string | null;
/** Merges the rows of every store in one order (nulls last), then cuts the page asked. */
function mergeRows(parts: Part[], key: Key, dir: 'asc' | 'desc', page: number, pageSize: number, add: (r: any, p: Part) => any = (r) => r) {
  const rows = parts.flatMap((p) => (p.out?.rows ?? []).map((r: any) => ({ ...add(r, p), seller: { id: p.seller.id, name: p.seller.name } })));
  const s = dir === 'desc' ? -1 : 1;
  rows.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x === y) return String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) || a.id - b.id;
    if (x === null) return 1;
    if (y === null) return -1;
    return (typeof x === 'string' ? x.localeCompare(String(y)) : x - (y as number)) * s;
  });
  const total = parts.reduce((n, p) => n + num(p.out?.total), 0);
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize };
}

const CONF_KEY: Record<string, Key> = {
  deadline: (r) => {
    const d = r.deadline;
    return d ? (d.m === 'start' ? d.e ?? d.t : d.t) : null;
  },
  created_at: (r) => r.createdAt ?? null,
  confirmed_at: (r) => r.confirmedAt ?? null,
  next_call_at: (r) => r.nextCallAt ?? null,
  total: (r) => r.total ?? null,
  customer_name: (r) => (r.customerName ? String(r.customerName).toLowerCase() : null),
};
const SUIVI_SORT: Record<string, { key: Key; dir: 'asc' | 'desc' }> = {
  alertes: { key: (r) => r.updatedAt ?? null, dir: 'asc' },
  traites: { key: (r) => r.updatedAt ?? null, dir: 'desc' },
  livres: { key: (r) => r.deliveredAt ?? null, dir: 'desc' },
  annules: { key: (r) => r.updatedAt ?? null, dir: 'desc' },
  swap: { key: (r) => r.updatedAt ?? null, dir: 'desc' },
  swapped: { key: (r) => r.updatedAt ?? null, dir: 'desc' },
};

interface Fan {
  /** what each store is asked (a list: its first rows, up to the page asked) */
  input?: (i: any) => any;
  merge: (parts: Part[], i: any) => any;
}
const sum: Fan = { merge: (parts) => sumDeep(parts.map((p) => p.out)) };
const FANOUT: Record<string, Fan> = {
  'orders.counts': sum,
  'confirmation.counts': sum,
  'confirmation.mine': sum,
  'suivi.counts': sum,
  'confirmation.list': {
    input: (i) => ({ ...i, page: 1, pageSize: Math.min(3000, (i?.page ?? 1) * (i?.pageSize ?? 50)) }),
    merge: (parts, i) => {
      const sub = (i?.sub ?? 'nouvelles') as keyof typeof DEFAULT_SORT;
      const def = DEFAULT_SORT[sub] ?? DEFAULT_SORT.nouvelles;
      let sort: string = i?.sort ?? def.sort;
      if (sort === 'deadline' && sub !== 'nouvelles' && sub !== 'attente') sort = 'created_at';
      const dir = i?.dir ?? (i?.sort ? (i.sort === 'total' ? 'desc' : 'asc') : def.dir);
      return mergeRows(parts, CONF_KEY[sort] ?? CONF_KEY.created_at, dir, i?.page ?? 1, i?.pageSize ?? 50);
    },
  },
  'suivi.list': {
    input: (i) => ({ ...i, page: 1, pageSize: Math.min(500, (i?.page ?? 1) * (i?.pageSize ?? 300)) }),
    merge: (parts, i) => {
      const o = SUIVI_SORT[i?.tab] ?? SUIVI_SORT.alertes;
      // each row carries its store's extra details (ids repeat from one store to another)
      const out = mergeRows(parts, o.key, o.dir, i?.page ?? 1, i?.pageSize ?? 300, (r, p) => ({ ...r, extra: p.out?.extra?.[r.id] ?? null }));
      return { ...out, extra: {} };
    },
  },
};

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
  if (name === 'orders.next') return nextAll(ctx, input, run);
  const fan = FANOUT[name];
  if (!fan) throw bad('Choisissez un vendeur en haut de la page pour cette action');
  const work = await sellerWork(ctx);
  const asked = fan.input ? fan.input(input) : input;
  const done = await Promise.allSettled(work.map(async (w) => ({ seller: sellerOf(w.L), out: await run(await storeCtx(ctx, w), name, asked) })));
  const parts = done.flatMap((d) => (d.status === 'fulfilled' ? [d.value] : []));
  // a store that cannot answer (locked, a task it does not give) is left out; all of them: the first reason
  if (!parts.length && done.length) throw (done[0] as PromiseRejectedResult).reason;
  return fan.merge(parts, input);
}

/**
 * « Commande suivante » over every seller: the store whose customer waits the most gives its next order (callbacks
 * due first, then the oldest new orders), taken there as usual. `skipAll`: orders passed already, with their store.
 */
async function nextAll(ctx: Ctx, input: any, run: Runner): Promise<{ id: number | null; seller: number | null }> {
  const skipAll: { s: number; id: number }[] = Array.isArray(input?.skipAll)
    ? input.skipAll.filter((k: any) => Number.isSafeInteger(k?.s) && Number.isSafeInteger(k?.id)).slice(-400)
    : [];
  const cands: { sc: Ctx; store: number; skip: number[]; due: boolean; at: string }[] = [];
  for (const w of await sellerWork(ctx)) {
    const sc = await storeCtx(ctx, w).catch(() => null);
    if (!sc || !sc.session.roles.includes('confirmation')) continue;
    const store = w.L.info.store.id;
    const skip = skipAll.filter((k) => k.s === store).map((k) => k.id).slice(-200);
    const c = await peekNext(sc, skip);
    if (c) cands.push({ sc, store, skip, due: c.nextCallAt !== null, at: c.nextCallAt ?? c.createdAt });
  }
  cands.sort((a, b) => Number(b.due) - Number(a.due) || a.at.localeCompare(b.at));
  for (const c of cands) {
    const r = (await run(c.sc, 'orders.next', { skip: c.skip })) as { id: number | null };
    if (r.id) return { id: r.id, seller: c.store };
  }
  return { id: null, seller: null };
}

export const agencyWorkProcs = {
  /** The sellers this person works for now (the picker at the top of the agency's space). */
  'agency.sellers': proc(null, z.object({}), (ctx) => sellersOf(ctx)),
};
