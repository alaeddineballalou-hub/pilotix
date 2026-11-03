// Answers of several shops put together: a partner's « Tous les vendeurs » (agencywork.ts) and a seller's « Toutes les
// boutiques » (boutiquework.ts). Each shop answers as the person's own account there; counts add up, lists are merged
// in their order and the page asked is cut, the next order to call is taken from the shop whose customer waits the most.
import { z } from 'zod';
import { num } from '../db';
import { bad, Ctx } from '../rpc';
import { DEFAULT_SORT } from './confirmation';
import { peekNext } from './orders';

/** Runs one action in a shop's ctx (index.ts: the registry, the gates). */
export type Runner = (ctx: Ctx, name: string, input: unknown) => Promise<unknown>;

/** The shop an answer came from: each row of a merged list says it (`seller`). */
export interface Source {
  id: number;
  name: string;
}
export type Part = { seller: Source; out: any };

/** One shop to ask: where its answer comes from, its ctx (made when asked), and its own input (default: the one asked). */
export interface Target {
  source: Source;
  ctx: () => Promise<Ctx>;
  input?: unknown;
}

/** Numbers add up, objects key by key (counts of every shop). */
export function sumDeep(vals: any[]): any {
  const first = vals.find((v) => v !== undefined && v !== null);
  if (typeof first === 'number') return vals.reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    const keys = [...new Set(vals.flatMap((v) => (v && typeof v === 'object' ? Object.keys(v) : [])))];
    return Object.fromEntries(keys.map((k) => [k, sumDeep(vals.map((v) => v?.[k]))]));
  }
  return first ?? null;
}

export type Key = (r: any) => number | string | null;
/** Merges the rows of every shop in one order (nulls last), then cuts the page asked. */
export function mergeRows(parts: Part[], key: Key, dir: 'asc' | 'desc', page: number, pageSize: number, add: (r: any, p: Part) => any = (r) => r) {
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
  enlivraison: { key: (r) => r.shippedAt ?? null, dir: 'asc' },
  bloques: { key: (r) => r.shippedAt ?? null, dir: 'asc' },
  alertes: { key: (r) => r.updatedAt ?? null, dir: 'asc' },
  alertes_new: { key: (r) => r.updatedAt ?? null, dir: 'asc' },
  alertes_encours: { key: (r) => r.updatedAt ?? null, dir: 'asc' },
  traites: { key: (r) => r.updatedAt ?? null, dir: 'desc' },
  livres: { key: (r) => r.deliveredAt ?? null, dir: 'desc' },
  annules: { key: (r) => r.updatedAt ?? null, dir: 'desc' },
  swap: { key: (r) => r.updatedAt ?? null, dir: 'desc' },
  swapped: { key: (r) => r.updatedAt ?? null, dir: 'desc' },
};
/** Commandes: the columns the list sorts on. */
const ORDER_KEY: Record<string, Key> = {
  created_at: (r) => r.createdAt ?? null,
  confirmed_at: (r) => r.confirmedAt ?? null,
  next_call_at: (r) => r.nextCallAt ?? null,
  updated_at: (r) => r.updatedAt ?? null,
  shipped_at: (r) => r.shippedAt ?? null,
  delivered_at: (r) => r.deliveredAt ?? null,
  total: (r) => r.total ?? null,
  wilaya_id: (r) => r.wilayaId ?? null,
  customer_name: (r) => (r.customerName ? String(r.customerName).toLowerCase() : null),
  ref: (r) => (r.ref ? String(r.ref) : null),
  conf_status: (r) => r.confStatus ?? null,
  follow_status: (r) => r.followStatus ?? null,
};

export interface Fan {
  /** what each shop is asked (a list: its first rows, up to the page asked) */
  input?: (i: any) => any;
  /** Read enough pages from each shop for the requested merged page, even beyond its own page limit. */
  paged?: { defaultSize: number; max: number };
  merge: (parts: Part[], i: any) => any;
}
export const sum: Fan = { merge: (parts) => sumDeep(parts.map((p) => p.out)) };

/** A marketer's ad sets in every seller's store, in one list (the most spent first), each with its seller. */
const mkAll: Fan = {
  merge: (parts) => {
    const rows = parts.flatMap((p) => (p.out?.rows ?? []).map((r: any) => ({ ...r, seller: { id: p.seller.id, name: p.seller.name } })));
    rows.sort((a, b) => (b.sp ?? 0) - (a.sp ?? 0));
    const first = parts[0]?.out ?? {};
    return {
      ...first,
      owner: false,
      admin: false,
      from: parts.map((p) => p.out?.from).filter(Boolean).sort()[0] ?? first.from,
      to: parts.map((p) => p.out?.to).filter(Boolean).sort().pop() ?? first.to,
      fxMissing: [...new Set(parts.flatMap((p) => p.out?.fxMissing ?? []))].sort(),
      marketers: parts.flatMap((p) => p.out?.marketers ?? []).filter((m: any, i: number, a: any[]) => a.findIndex((x) => x.id === m.id && x.name === m.name) === i),
      rows,
      // each seller's own rules (they judge the ad sets « réussi »)
      sellers: parts.map((p) => ({ id: p.seller.id, name: p.seller.name, rules: p.out?.rules ?? null })),
    };
  },
};

export const FANOUT: Record<string, Fan> = {
  // Produits & stock › Guide de vente: every shop's products in one list, by name
  'catalog.guides': { merge: (parts) => mergeRows(parts, (r) => String(r.name).toLowerCase(), 'asc', 1, 3000) },
  'catalog.assigned': {
    paged: { defaultSize: 50, max: 3000 },
    input: (i) => ({ ...i, page: 1, pageSize: Math.min(3000, (i?.page ?? 1) * (i?.pageSize ?? 50)) }),
    merge: (parts, i) => mergeRows(parts, (r) => String(r.name).toLowerCase(), 'asc', i?.page ?? 1, i?.pageSize ?? 50),
  },
  'orders.counts': sum,
  'confirmation.counts': sum,
  'confirmation.mine': sum,
  'suivi.counts': sum,
  'mk.overview': mkAll,
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
    paged: { defaultSize: 300, max: 500 },
    input: (i) => ({ ...i, page: 1, pageSize: Math.min(500, (i?.page ?? 1) * (i?.pageSize ?? 300)) }),
    merge: (parts, i) => {
      const o = SUIVI_SORT[i?.tab] ?? SUIVI_SORT.alertes;
      // each row carries its shop's extra details (ids repeat from one shop to another)
      const out = mergeRows(parts, o.key, o.dir, i?.page ?? 1, i?.pageSize ?? 300, (r, p) => ({ ...r, extra: p.out?.extra?.[r.id] ?? null }));
      return { ...out, extra: {} };
    },
  },
};

/** Commandes over several shops, in the order asked. */
export const ORDERS_FAN: Fan = {
  paged: { defaultSize: 50, max: 3000 },
  input: (i) => ({ ...i, page: 1, pageSize: Math.min(3000, (i?.page ?? 1) * (i?.pageSize ?? 50)) }),
  merge: (parts, i) => mergeRows(parts, ORDER_KEY[i?.sort ?? 'created_at'] ?? ORDER_KEY.created_at, i?.dir ?? 'desc', i?.page ?? 1, i?.pageSize ?? 50),
};

/** Asks every shop, then puts the answers together; a shop that cannot answer is left out (none can: the first reason). */
export async function fanOut(name: string, fan: Fan, raw: unknown, targets: Target[], run: Runner): Promise<unknown> {
  if (fan.paged && !z.object({ page: z.number().int().positive().optional(), pageSize: z.number().int().positive().max(fan.paged.max).optional() }).safeParse(raw ?? {}).success)
    throw bad('Pagination invalide');
  const done = await Promise.allSettled(
    targets.map(async (tg) => {
      const sc = await tg.ctx();
      const own = tg.input ?? raw;
      const asked = fan.input ? fan.input(own) : own;
      let out: any = await run(sc, name, asked);
      if (fan.paged) {
        const r = raw as any;
        const wanted = (r?.page ?? 1) * (r?.pageSize ?? fan.paged.defaultSize);
        let nextPage = 2;
        while (out.rows.length < Math.min(wanted, out.total)) {
          const more: any = await run(sc, name, { ...(asked as any), page: nextPage++ });
          if (!more.rows.length) break;
          out = { ...out, rows: [...out.rows, ...more.rows], extra: { ...out.extra, ...more.extra } };
        }
      }
      return { seller: tg.source, out };
    }),
  );
  const parts = done.flatMap((d) => (d.status === 'fulfilled' ? [d.value] : []));
  if (!parts.length && done.length) throw (done[0] as PromiseRejectedResult).reason;
  return fan.merge(parts, raw);
}

/**
 * « Commande suivante » over several shops: the shop whose customer waits the most gives its next order (callbacks due
 * first, then the oldest new orders), taken there as usual. `skipAll`: orders passed already, with their shop.
 */
export async function nextAcross(targets: Target[], input: any, run: Runner): Promise<{ id: number | null; seller: number | null }> {
  const skipAll: { s: number; id: number }[] = Array.isArray(input?.skipAll)
    ? input.skipAll.filter((k: any) => Number.isSafeInteger(k?.s) && Number.isSafeInteger(k?.id)).slice(-400)
    : [];
  const cands: { sc: Ctx; store: number; skip: number[]; due: boolean; at: string }[] = [];
  for (const tg of targets) {
    const sc = await tg.ctx().catch(() => null);
    if (!sc || !sc.session.roles.includes('confirmation')) continue;
    const store = tg.source.id;
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
