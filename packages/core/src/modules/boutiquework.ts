// « Toutes les boutiques »: someone who works in several of a seller's boutiques (the owner, or an agent of two of them)
// sees the orders and the numbers of all of them together, from the boutique open now. Each boutique answers as the
// person's own account there (their roles there), and the answers are put together as for a partner's « Tous les
// vendeurs » (fanout.ts). The « Boutique » filter keeps some of them (`shops`), and what is not the same thing in every
// boutique (a person, a product, a company: each boutique has its own ids) is given boutique by boutique (`byShop`; null:
// that boutique has none, it is left out). From the same screens, an order of another boutique opens and its work runs
// inside that boutique.
import { z } from 'zod';
import { num } from '../db';
import { bad, Ctx, forbidden, makeSession, notFound } from '../rpc';
import { loadShop, platformSettings, shopCtx, shopStatus } from '../platform/shops';
import { FANOUT, Fan, fanOut, nextAcross, ORDERS_FAN, Part, Runner, sum, sumDeep, Target } from './fanout';
import type { FilterOptions } from './filters';
import { profileById } from './users';

/** One of the person's boutiques (a store where they have their own account), and their account there. */
export interface MyBoutique {
  id: number;
  name: string;
  profileId: number;
}

/** The stores the person works in (their own account there, the store open), the open one included. */
export async function boutiqueWork(ctx: Ctx): Promise<MyBoutique[]> {
  const t = ctx.t;
  if (!t || !ctx.shop || (ctx.shop.kind ?? 'store') !== 'store') return [];
  const { storeChoices } = await import('../platform/signup');
  const list = await storeChoices(t, ctx.session.profile.email, ctx.now());
  return list.filter((s) => (s.kind ?? 'store') === 'store' && (!s.locked || s.id === ctx.shop!.id)).map((s) => ({ id: s.id, name: s.name, profileId: s.profileId }));
}

/** The person's ctx in one of their boutiques (the server's own, else made here). A locked boutique waits. */
async function boutiqueCtx(ctx: Ctx, b: MyBoutique): Promise<Ctx> {
  if (b.id === ctx.shop?.id) return { ...ctx, boutique: undefined };
  const locked = () => bad(`« ${b.name} » est bloquée pour le moment (abonnement)`);
  if (ctx.otherShop) {
    const c = await ctx.otherShop(b.id, b.profileId);
    if (c.shop?.locked) throw locked();
    return c;
  }
  const t = ctx.t!;
  const s = await loadShop(t, { id: b.id });
  if (!s) throw notFound('Boutique introuvable');
  const st = shopStatus(s, ctx.now(), (await platformSettings(t)).trial.graceDays);
  if (st.locked) throw locked();
  const db = t.shop(s.schema);
  const p = await profileById(db, b.profileId);
  if (!p?.active) throw forbidden(`Votre compte n’est plus actif dans « ${b.name} »`);
  return { db, session: makeSession(p), shop: shopCtx(s, st), now: ctx.now, emit: () => {}, t };
}

/** What runs inside another of the person's boutiques from the open one: the work on an order of that boutique. */
const OTHER_BOUTIQUE =
  /^(orders|confirmation|suivi|sav|parcel|customers|filters|undo|delivery|stats)\.[a-zA-Z0-9.]+$|^(users\.list|pilot\.get|prefs\.get|catalog\.(search|guide|guides|guideFacts|assigned))$/;

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
/** each boutique's own answer next to the total (the « Par boutique » table) */
const byBoutique = (parts: Part[]) => parts.map((p) => ({ id: p.seller.id, name: p.seller.name, ...p.out }));

/** What « Toutes les boutiques » puts together. */
export const BOUTIQUE_FANOUT: Record<string, Fan> = {
  'orders.list': ORDERS_FAN,
  'orders.counts': FANOUT['orders.counts'],
  'confirmation.counts': FANOUT['confirmation.counts'],
  'confirmation.mine': FANOUT['confirmation.mine'],
  'confirmation.list': FANOUT['confirmation.list'],
  'suivi.counts': FANOUT['suivi.counts'],
  'suivi.list': FANOUT['suivi.list'],
  'catalog.guides': FANOUT['catalog.guides'],
  'catalog.assigned': FANOUT['catalog.assigned'],
  // Accueil › Maintenant: added up, and boutique by boutique
  'stats.now': { merge: (parts, i) => ({ ...sum.merge(parts, i), byBoutique: byBoutique(parts) }) },
  // Accueil › Période: added up (the rates from the totals), and boutique by boutique
  'stats.overview': {
    merge: (parts) => {
      const s = sumDeep(parts.map((p) => p.out)) ?? {};
      return {
        ...s,
        confRate: ratio(s.confirmed ?? 0, (s.confirmed ?? 0) + (s.cancelled ?? 0)),
        deliveryRate: ratio(s.delivered ?? 0, (s.delivered ?? 0) + (s.returned ?? 0)),
        byBoutique: byBoutique(parts),
      };
    },
  },
  // the lists of the filter bars, boutique by boutique
  'filters.options': { merge: (parts) => ({ boutiques: parts.map((p) => ({ id: p.seller.id, name: p.seller.name, options: p.out })) }) },
};
export const BOUTIQUE_FANOUT_PROCS = new Set([...Object.keys(BOUTIQUE_FANOUT), 'orders.next']);

const Scope = z.object({
  /** the « Boutique » filter: these boutiques only */
  shops: z.array(z.number().int().positive()).max(100).optional(),
  /** each boutique's own values (its person, product, company…); null: it has none, left out */
  byShop: z.record(z.string().regex(/^\d{1,10}$/), z.record(z.string(), z.unknown()).nullable()).optional(),
});

/** Numbers to zero, lists emptied: the answer when the filters leave no boutique. */
function nothing(out: any): any {
  if (Array.isArray(out)) return [];
  if (out && typeof out === 'object') {
    if (Array.isArray(out.rows)) return { ...out, rows: [], total: 0, ...(out.extra ? { extra: {} } : {}) };
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, nothing(v)]));
  }
  return typeof out === 'number' ? 0 : out;
}

/**
 * The filter lists of every boutique, boutique by boutique. A person working in several of them gets one key (their
 * e-mail stays here): the « Agent » filter shows them once.
 */
async function optionsAcross(targets: Target[], base: unknown, run: Runner) {
  const done = await Promise.allSettled(
    targets.map(async (tg) => {
      const sc = await tg.ctx();
      const out = (await run(sc, 'filters.options', tg.input ?? base)) as FilterOptions;
      const ids = [...out.agents.map((a) => a.id), ...out.livreurs.map((l) => l.id)];
      const mails = ids.length ? await sc.db.query('SELECT id, lower(email) AS e FROM profiles WHERE id = ANY($1)', [ids]) : [];
      return { tg, out, mail: new Map(mails.map((r: any) => [num(r.id), String(r.e ?? '')])) };
    }),
  );
  const keys = new Map<string, string>();
  const keyOf = (shop: number, id: number, mail: string | undefined) => {
    const k = mail || `#${shop}:${id}`;
    if (!keys.has(k)) keys.set(k, `p${keys.size + 1}`);
    return keys.get(k)!;
  };
  const parts = done.flatMap((d) => (d.status === 'fulfilled' ? [d.value] : []));
  return {
    boutiques: parts.map(({ tg, out, mail }) => ({
      id: tg.source.id,
      name: tg.source.name,
      options: {
        ...out,
        agents: out.agents.map((a) => ({ ...a, key: keyOf(tg.source.id, a.id, mail.get(a.id)) })),
        livreurs: out.livreurs.map((l) => ({ ...l, key: keyOf(tg.source.id, l.id, mail.get(l.id)) })),
      },
    })),
  };
}

/** An action with the boutique scope of the screen (index.ts). */
export async function boutiqueCall(name: string, ctx: Ctx, input: unknown, run: Runner): Promise<unknown> {
  const scope = ctx.boutique!;
  const here = ctx.shop?.id;
  const mine = await boutiqueWork(ctx);
  if (!mine.some((b) => b.id === here)) throw forbidden('« Toutes les boutiques » : réservé aux boutiques où vous avez votre compte');
  if (scope !== 'all') {
    const b = mine.find((x) => x.id === scope);
    if (!b) throw forbidden('Vous n’avez pas de compte dans cette boutique');
    if (b.id === here) return run({ ...ctx, boutique: undefined }, name, input);
    if (!OTHER_BOUTIQUE.test(name)) throw bad(`Ouvrez « ${b.name} » pour cette action`);
    return run(await boutiqueCtx(ctx, b), name, input);
  }
  const raw = (input ?? {}) as Record<string, unknown>;
  const sc = Scope.safeParse({ shops: raw.shops, byShop: raw.byShop });
  if (!sc.success) throw bad('Filtre « Boutique » invalide');
  const { shops: _s, byShop: _b, ...base } = raw;
  const { shops, byShop } = sc.data;
  const chosen = shops ? mine.filter((b) => shops.includes(b.id)) : mine;
  const targets: Target[] = chosen
    .filter((b) => !(byShop && String(b.id) in byShop && byShop[String(b.id)] === null))
    .map((b) => ({ source: { id: b.id, name: b.name }, ctx: () => boutiqueCtx(ctx, b), input: { ...base, ...(byShop?.[String(b.id)] ?? {}) } }));
  if (name === 'orders.next') return nextAcross(targets, base, run);
  if (name === 'filters.options') return optionsAcross(targets, base, run);
  const fan = BOUTIQUE_FANOUT[name];
  if (!fan) throw bad('Choisissez une boutique pour cette action');
  // the filters leave no boutique: this one's answer, empty
  if (!targets.length) return nothing(await run({ ...ctx, boutique: undefined }, name, base));
  return fanOut(name, fan, base, targets, run);
}
