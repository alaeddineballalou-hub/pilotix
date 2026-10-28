// Pro marketers (see @pilotix/shared pro.ts). A marketer's space asks to be Pro (« Passer Pro »), pays Pilotix outside
// the app, and Pilotix's staff turn it on for some months (control room › Marketers). While Pro, verified and not
// suspended, it shows on Pilotix's list of marketers: every store's « Trouver un marketer Pro » (Marketers page, with
// « Inviter dans mon équipe »: the usual request, partners.request) and the public page (#/pro, no login).
//
// Its numbers are counted in every store its people made ad sets for: the stores it works or worked for (as a
// partner), and the stores where one of its people has an account of their own (their work before the space). Each
// store's ad sets are judged as on its Marketing › Marketer page (mkCompute). Counting opens every one of those
// stores, so the result is kept (pro_stats) and counted again when older than STATS_HOURS.
import { hasPrice, cleanProProfile, cleanProStats, monthsBetween, NO_PRO_STATS, PRO_NICHES, PRO_PLATFORMS, ProCard, ProStats, proRate } from '@pilotix/shared';
import { z } from 'zod';
import { iso, isoOrNull, num } from '../db';
import { bad, Ctx, forbidden, proc } from '../rpc';
import { cleanPrices, platformSettings } from '../platform/shops';
import type { Tenancy } from '../platform/tenancy';
import { agencyPeople } from './agencies';
import { mkCompute } from './marketers';

export const STATS_HOURS = 6;
const HOUR = 3_600_000;
const NO_SERVER = 'Les marketers Pro fonctionnent sur le serveur Pilotix (pas dans cet aperçu)';

/** Shown on the list: a marketer, active, verified by Pilotix, paid until later than now, not hidden by itself. */
const LISTED = `s.kind = 'marketer' AND s.status = 'active' AND s.agency_verified_at IS NOT NULL AND s.pro_until > now() AND COALESCE((s.pro_profile->>'visible')::boolean, true)`;

/** Counts a marketer's ad sets in every store its people worked for (see the top of this file). */
export async function computeProStats(t: Tenancy, partnerId: number, now: number): Promise<ProStats> {
  const sh = (await t.platform.query('SELECT schema_name FROM platform.shops WHERE id = $1', [partnerId]))[0];
  if (!sh) return { ...NO_PRO_STATS };
  const emails = (await agencyPeople(t.shop(sh.schema_name))).map((p) => p.email);
  const stores = await t.platform.query(
    `SELECT s.id, s.schema_name FROM platform.shops s
      WHERE s.kind = 'store' AND NOT s.is_demo AND s.status NOT IN ('archived', 'deleted')
        AND (s.id IN (SELECT store_id FROM platform.agency_links WHERE agency_id = $1 AND started_at IS NOT NULL)
             OR s.id IN (SELECT shop_id FROM platform.logins WHERE email = ANY($2::text[])))
      ORDER BY s.id`,
    [partnerId, emails],
  );
  const out: ProStats = { ...NO_PRO_STATS };
  const products = new Set<string>();
  for (const st of stores as any[]) {
    try {
      const db = t.shop(st.schema_name);
      const ids = new Set((await db.query('SELECT id FROM profiles WHERE agency_id = $1 OR lower(email) = ANY($2::text[])', [partnerId, emails])).map((r: any) => num(r.id)));
      if (!ids.size) continue;
      const r = await mkCompute(db, now, (s) => s.marketerId !== null && ids.has(s.marketerId));
      // launched: it spent at least once (an ad set copied from Meta that never ran is not counted)
      const rows = r.rows.filter((row) => row.sp > 0 || row.months.length > 0);
      if (!rows.length) continue;
      out.stores++;
      for (const row of rows) {
        out.adsets++;
        if (!row.final) out.run++;
        else if (row.ok) out.ok++;
        else out.ko++;
        for (const p of row.productIds) products.add(`${st.id}:${p}`);
      }
    } catch {
      // a store that cannot be read now (moved, being restored): its ad sets wait for the next count
    }
  }
  out.products = products.size;
  return out;
}

/** The numbers kept for this marketer, counted again when older than STATS_HOURS (or when `fresh`). */
async function statsOf(t: Tenancy, r: any, now: number, fresh = false): Promise<ProStats> {
  const at = r.pro_stats_at ? new Date(r.pro_stats_at).getTime() : 0;
  if (!fresh && r.pro_stats && now - at < STATS_HOURS * HOUR) return cleanProStats(typeof r.pro_stats === 'string' ? JSON.parse(r.pro_stats) : r.pro_stats);
  const s = await computeProStats(t, num(r.id), now);
  await t.platform.query('UPDATE platform.shops SET pro_stats = $2, pro_stats_at = $3 WHERE id = $1', [r.id, JSON.stringify(s), new Date(now).toISOString()]);
  return s;
}

const profileOf = (r: any) => cleanProProfile(typeof r.pro_profile === 'string' ? JSON.parse(r.pro_profile) : r.pro_profile);

async function toCard(t: Tenancy, r: any, now: number, fresh = false): Promise<ProCard> {
  const stats = await statsOf(t, r, now, fresh);
  return { id: num(r.id), code: (r.public_code as string | null) ?? '', name: r.name as string, profile: profileOf(r), stats, rate: proRate(stats), months: monthsBetween(r.created_at, now) };
}

const SELECT = 'SELECT s.id, s.name, s.public_code, s.created_at, s.agency_prices, s.pro_profile, s.pro_stats, s.pro_stats_at, s.pro_until, s.pro_asked_at, s.agency_verified_at, s.status FROM platform.shops s';

export interface ProFilter {
  q?: string;
  niche?: string;
  platform?: string;
}

/**
 * The Pro marketers shown on the list, the best rate first (those not judged yet after), filtered by a word (name,
 * code, city, bio), a niche and an ad platform.
 */
export async function listPros(t: Tenancy, now: number, f: ProFilter = {}): Promise<ProCard[]> {
  if (!(await platformSettings(t)).pro.on) return [];
  const rows = await t.platform.query(`${SELECT} WHERE ${LISTED} ORDER BY s.id`);
  const cards: ProCard[] = [];
  for (const r of rows) cards.push(await toCard(t, r, now));
  const q = (f.q ?? '').trim().toLowerCase();
  return cards
    .filter((c) => !q || [c.name, c.code, c.profile.city, c.profile.bio].some((v) => v.toLowerCase().includes(q)))
    .filter((c) => !f.niche || c.profile.niches.includes(f.niche as never))
    .filter((c) => !f.platform || c.profile.platforms.includes(f.platform as never))
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.stats.ok - a.stats.ok || a.name.localeCompare(b.name));
}

/** One Pro marketer of the list by its code (null: no such code, or not on the list now). */
export async function proByCode(t: Tenancy, code: string, now: number): Promise<ProCard | null> {
  if (!(await platformSettings(t)).pro.on) return null;
  const c = String(code).trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  const r = (await t.platform.query(`${SELECT} WHERE ${LISTED} AND s.public_code = $1`, [c]))[0];
  return r ? toCard(t, r, now) : null;
}

// ---------------------------------------------------------------- who calls
function tOf(ctx: Ctx): Tenancy {
  if (!ctx.t || !ctx.shop) throw bad(NO_SERVER);
  return ctx.t;
}
/** The marketer's own space (its chief: the procs are admin only). */
function asMarketer(ctx: Ctx) {
  const t = tOf(ctx);
  if (ctx.shop!.kind !== 'marketer') throw forbidden('Réservé aux espaces marketer');
  return { t, id: ctx.shop!.id };
}

const ProfileIn = z.object({
  niches: z.array(z.enum(PRO_NICHES)).max(4, 'Choisissez 4 niches au plus'),
  platforms: z.array(z.enum(PRO_PLATFORMS)).min(1, 'Choisissez au moins une plateforme').max(5),
  city: z.string().trim().max(60),
  bio: z.string().trim().max(300),
  visible: z.boolean(),
});

/** Where the marketer's Pro stands. */
function stateOf(r: any, now: number) {
  const until = isoOrNull(r.pro_until);
  const active = !!until && Date.parse(until) > now;
  return { active, until, askedAt: isoOrNull(r.pro_asked_at), verified: !!r.agency_verified_at };
}

export const proProcs = {
  /**
   * The marketer's « Profil Pro »: its state (Pro until, asked, verified), its words, its card as stores see it (its
   * numbers counted now), the price by the month and how to pay Pilotix.
   */
  'agency.pro.me': proc([], z.object({}), async (ctx) => {
    const { t, id } = asMarketer(ctx);
    const r = (await t.platform.query(`${SELECT} WHERE s.id = $1`, [id]))[0];
    const set = await platformSettings(t);
    // its own page counts its numbers now (and keeps them for the list)
    const card = await toCard(t, r, ctx.now(), true);
    return { ...stateOf(r, ctx.now()), on: set.pro.on, price: set.pro.price, payment: set.payment, card, listed: stateOf(r, ctx.now()).active && card.profile.visible && !!r.agency_verified_at };
  }),

  /** Saves the marketer's words (niches, platforms, city, a few lines, shown or hidden). */
  'agency.pro.save': proc([], ProfileIn, async (ctx, i) => {
    const { t, id } = asMarketer(ctx);
    await t.platform.query('UPDATE platform.shops SET pro_profile = $2 WHERE id = $1', [id, JSON.stringify(cleanProProfile(i))]);
    return { ok: true };
  }),

  /** « Passer Pro » / « Prolonger »: tells Pilotix (control room › Marketers), who turns it on once paid. */
  'agency.pro.ask': proc([], z.object({ cancel: z.boolean().default(false) }), async (ctx, i) => {
    const { t, id } = asMarketer(ctx);
    if (!(await platformSettings(t)).pro.on) throw bad('Le compte Pro n’est pas proposé pour le moment');
    if (i.cancel) {
      await t.platform.query('UPDATE platform.shops SET pro_asked_at = NULL WHERE id = $1', [id]);
      return { askedAt: null };
    }
    const r = (await t.platform.query('SELECT pro_profile, agency_prices FROM platform.shops WHERE id = $1', [id]))[0];
    if (!profileOf(r).platforms.length) throw bad('Remplissez d’abord votre profil Pro (au moins une plateforme)');
    if (!r.agency_prices || !hasPrice(cleanPrices(typeof r.agency_prices === 'string' ? JSON.parse(r.agency_prices) : r.agency_prices, 'marketer')))
      throw bad('Écrivez d’abord vos prix (Réglages) : les boutiques les voient avant de vous inviter');
    const u = (await t.platform.query('UPDATE platform.shops SET pro_asked_at = COALESCE(pro_asked_at, now()) WHERE id = $1 RETURNING pro_asked_at', [id]))[0];
    return { askedAt: iso(u.pro_asked_at) };
  }),

  /**
   * « Trouver un marketer Pro » (a store's administrator): the list, and for each one the request or contract this
   * store already has with it.
   */
  'partners.pro.search': proc(
    [],
    z.object({ q: z.string().max(100).optional(), niche: z.enum(PRO_NICHES).optional(), platform: z.enum(PRO_PLATFORMS).optional() }),
    async (ctx, i) => {
      const t = tOf(ctx);
      if (ctx.shop!.kind !== 'store') throw forbidden('Réservé aux boutiques');
      const cards = await listPros(t, ctx.now(), i);
      const links = cards.length
        ? await t.platform.query(`SELECT agency_id, id, status FROM platform.agency_links WHERE store_id = $1 AND agency_id = ANY($2::int[]) AND status IN ('pending', 'active')`, [ctx.shop!.id, cards.map((c) => c.id)])
        : [];
      const by = new Map(links.map((l: any) => [num(l.agency_id), { id: num(l.id), status: l.status as 'pending' | 'active' }]));
      const prices = new Map<number, ReturnType<typeof cleanPrices>>();
      if (cards.length)
        for (const r of await t.platform.query('SELECT id, agency_prices FROM platform.shops WHERE id = ANY($1::int[])', [cards.map((c) => c.id)]))
          prices.set(num(r.id), cleanPrices(typeof r.agency_prices === 'string' ? JSON.parse(r.agency_prices) : r.agency_prices ?? {}, 'marketer'));
      return { on: (await platformSettings(t)).pro.on, pros: cards.map((c) => ({ ...c, prices: prices.get(c.id)!, link: by.get(c.id) ?? null })) };
    },
  ),
};
