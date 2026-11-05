// « Toutes les boutiques »: someone who works in several of a seller's boutiques (the owner, or an agent of two of them)
// sees the orders and the numbers of all of them together, from the boutique open now. Each boutique answers as the
// person's own account there (their roles there), and the answers are put together as for a partner's « Tous les
// vendeurs » (fanout.ts). The « Boutique » filter keeps some of them (`shops`), and what is not the same thing in every
// boutique (a person, a product, a company: each boutique has its own ids) is given boutique by boutique (`byShop`; null:
// that boutique has none, it is left out). From the same screens, an order of another boutique opens and its work runs
// inside that boutique.
import { z } from 'zod';
import { num } from '../db';
import { bad, Ctx, forbidden, makeSession, notFound, proc } from '../rpc';
import { attachProfile } from '../platform/accounts';
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
  const { accountByEmail, passwordOpens } = await import('../platform/accounts');
  const list = await storeChoices(t, ctx.session.profile.email, ctx.now());
  // a password a store's admin chose opens that seller's stores only (platform/accounts.ts)
  const acc = await accountByEmail(t, ctx.session.profile.email);
  const out: MyBoutique[] = [];
  for (const s of list)
    if ((s.kind ?? 'store') === 'store' && (!s.locked || s.id === ctx.shop!.id) && (!acc || s.id === ctx.shop!.id || (await passwordOpens(t, acc, s.id))))
      out.push({ id: s.id, name: s.name, profileId: s.profileId });
  return out;
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

/**
 * What runs inside another of the person's boutiques from the open one: the work on an order of that boutique (the
 * depot's too: « J'ai pris » for its orders, received back, taken off its company, sent again… — never its stock, its
 * settings or its caisse).
 */
const OTHER_BOUTIQUE =
  /^(orders|confirmation|suivi|sav|parcel|customers|filters|undo|delivery|stats)\.[a-zA-Z0-9.]+$|^(users\.list|pilot\.get|prefs\.get|catalog\.(search|guide|guides|guideFacts|assigned)|depot\.(find|pick|receiveReturn|unassign|resend|cancelDone|companies))$/;

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
  // Dépôt: what waits at each stage, added up, and boutique by boutique
  'depot.counts': { merge: (parts, i) => ({ ...sum.merge(parts, i), byBoutique: byBoutique(parts) }) },
  // Dépôt › a code scanned or typed: the orders of every boutique that have it, each with its boutique
  'depot.find': { merge: (parts) => withSeller(parts) },
  // Dépôt › À prendre: the products every boutique's orders still need, each with its boutique (the screen puts the
  // same product of several boutiques together: the depot takes them all at once)
  'depot.pickList': { merge: (parts) => withSeller(parts) },
  // Caisse › Vue d'ensemble: the money of every boutique, added up, and boutique by boutique
  'caisse.overview': { merge: (parts) => caisseAcross(parts) },
};

/** Each boutique's list in one, every row with its boutique. */
function withSeller(parts: Part[]) {
  return parts.flatMap((p) => ((p.out ?? []) as any[]).map((o) => ({ ...o, seller: { id: p.seller.id, name: p.seller.name } })));
}

/** The caisses of several boutiques: each one's money in short (its caisses, what is outside), and the totals. */
function caisseAcross(parts: Part[]) {
  const total = (xs: any[] | undefined, k: string) => (xs ?? []).reduce((a, x) => a + (Number(x?.[k]) || 0), 0);
  const rows = parts.map((p) => {
    const o: any = p.out ?? {};
    return {
      id: p.seller.id,
      name: p.seller.name,
      main: Number(o.main?.balance) || 0,
      today: Number(o.main?.today) || 0,
      bank: o.bank ? Number(o.bank.balance) || 0 : null,
      own: total(o.caisses, 'balance'),
      companies: total(o.companies, 'net'),
      livreurs: total(o.livreurs, 'net'),
      employees: total(o.employees, 'balance'),
      outside: Number(o.outside) || 0,
      tickets: Number(o.tickets?.total) || 0,
    };
  });
  const add = (k: keyof (typeof rows)[number]) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  return {
    main: add('main'),
    today: add('today'),
    bank: rows.some((r) => r.bank !== null) ? add('bank') : null,
    own: add('own'),
    companies: add('companies'),
    livreurs: add('livreurs'),
    employees: add('employees'),
    outside: add('outside'),
    tickets: add('tickets'),
    byBoutique: rows,
  };
}
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

/** One livreur over the boutiques: the money they must hand over in each, and in all of them. */
interface LivreurAcross {
  key: string;
  name: string;
  phone: string | null;
  /** to hand over: what they collected minus their share */
  net: number;
  /** delivered parcels whose money is not handed over yet */
  notCashed: number;
  /** parcels on the road with them */
  inHand: number;
  /** their last handover, any boutique */
  last: string | null;
  boutiques: { id: number; name: string; livreurId: number; net: number; notCashed: number; inHand: number; last: string | null }[];
}

/**
 * Caisse › Vue d'ensemble over the boutiques: the money of each and the totals (caisseAcross), and each livreur once —
 * the same person in several boutiques (their e-mail, which stays here) with what they must hand over in each.
 */
async function caisseOverviewAcross(targets: Target[], base: unknown, run: Runner) {
  const done = await Promise.allSettled(
    targets.map(async (tg) => {
      const sc = await tg.ctx();
      const out = (await run(sc, 'caisse.overview', tg.input ?? base)) as any;
      const ids = ((out?.livreurs ?? []) as any[]).map((l) => l.id);
      const mails = ids.length ? await sc.db.query('SELECT id, lower(email) AS e FROM profiles WHERE id = ANY($1)', [ids]) : [];
      return { seller: tg.source, out, mail: new Map(mails.map((r: any) => [num(r.id), String(r.e ?? '')])) };
    }),
  );
  const parts = done.flatMap((d) => (d.status === 'fulfilled' ? [d.value] : []));
  if (!parts.length && done.length) throw (done[0] as PromiseRejectedResult).reason;
  const by = new Map<string, LivreurAcross>();
  for (const p of parts) {
    for (const l of (p.out?.livreurs ?? []) as any[]) {
      const k = p.mail.get(l.id) || `#${p.seller.id}:${l.id}`;
      const net = Number(l.net) || 0;
      const notCashed = Number(l.notCashed) || 0;
      const inHand = Number(l.inHand) || 0;
      const last = (l.last as string | null) ?? null;
      let x = by.get(k);
      if (!x) by.set(k, (x = { key: `l${by.size + 1}`, name: String(l.name ?? ''), phone: l.phone ?? null, net: 0, notCashed: 0, inHand: 0, last: null, boutiques: [] }));
      x.net += net;
      x.notCashed += notCashed;
      x.inHand += inHand;
      if (last && (!x.last || last > x.last)) x.last = last;
      if (!x.phone && l.phone) x.phone = l.phone;
      x.boutiques.push({ id: p.seller.id, name: p.seller.name, livreurId: num(l.id), net, notCashed, inHand, last });
    }
  }
  const livreurs = [...by.values()].filter((x) => x.net !== 0 || x.notCashed > 0 || x.inHand > 0 || x.boutiques.length > 1);
  livreurs.sort((a, b) => b.net - a.net || a.name.localeCompare(b.name));
  return { ...caisseAcross(parts.map((p) => ({ seller: p.seller, out: p.out }))), livreurs };
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
  if (name === 'caisse.overview' && targets.length) return caisseOverviewAcross(targets, base, run);
  const fan = BOUTIQUE_FANOUT[name];
  if (!fan) throw bad('Choisissez une boutique pour cette action');
  // the filters leave no boutique: this one's answer, empty
  if (!targets.length) return nothing(await run({ ...ctx, boutique: undefined }, name, base));
  return fanOut(name, fan, base, targets, run);
}

// ---------------------------------------------------------------- the team, boutique by boutique
const UserIn = z.record(z.string(), z.unknown());

export const boutiqueWorkProcs = {
  /**
   * Utilisateurs › new person, « Boutiques » ticked: the same account (name, e-mail, phone, roles, password) made in
   * these other boutiques of the person, each one checking its own rules (who may add people there, its seats).
   */
  'users.addToBoutiques': proc(null, z.object({ shops: z.array(z.number().int().positive()).min(1).max(50), user: UserIn }), async (ctx, i) => {
    const mine = await boutiqueWork(ctx);
    const { call } = await import('../index');
    const out: { id: number; name: string; ok: boolean; error?: string }[] = [];
    for (const id of [...new Set(i.shops)]) {
      const b = mine.find((x) => x.id === id);
      if (!b || b.id === ctx.shop?.id) continue;
      try {
        const c = await boutiqueCtx(ctx, b);
        const made = (await call('users.create', c, i.user)) as { id: number };
        // the person's Pilotix account (one password for all their boutiques)
        const s = ctx.t ? await loadShop(ctx.t, { id: b.id }) : null;
        if (ctx.t && s) await attachProfile(ctx.t, s.schema, made.id);
        out.push({ id: b.id, name: b.name, ok: true });
      } catch (e: any) {
        out.push({ id: b.id, name: b.name, ok: false, error: String(e?.message ?? e) });
      }
    }
    return out;
  }),

  /** Utilisateurs › « Boutiques »: for each person of this boutique, the person's boutiques where they also work. */
  'users.boutiques': proc(null, z.object({}), async (ctx) => {
    if (!ctx.session.isAdmin && !ctx.session.canManageUsers) return {} as Record<string, number[]>;
    const mine = await boutiqueWork(ctx);
    if (mine.length < 2) return {} as Record<string, number[]>;
    const where = new Map<string, number[]>();
    for (const b of mine) {
      const c = await boutiqueCtx(ctx, b).catch(() => null);
      if (!c) continue;
      for (const r of (await c.db.query('SELECT lower(email) AS e FROM profiles WHERE active')) as any[]) where.set(String(r.e), [...(where.get(String(r.e)) ?? []), b.id]);
    }
    const here = await ctx.db.query('SELECT id, lower(email) AS e FROM profiles');
    return Object.fromEntries(here.map((r: any) => [String(num(r.id)), where.get(String(r.e)) ?? []])) as Record<string, number[]>;
  }),
};
