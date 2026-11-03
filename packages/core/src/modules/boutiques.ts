// « Mes boutiques »: a seller's boutiques — each one's name, its link (the first part of its pages' address:
// <site>/<link>/<page>) and its logo — and the boutique at the bottom of the menu, to go from one to another. A seller
// never adds another seller: one account, many boutiques (users.ts refuses the « Vendeur » role).
//
// Only the person who created a boutique (its owner) changes it. Its link can change: the old one keeps leading to it
// (its pages send people to the new address, its webhooks answer as before) and no other boutique can take it; five
// former links at most, so nobody keeps names they do not use.
//
// On a server with one shop (and in the in-browser preview before the platform's tables exist) the only boutique is
// this shop: its name and logo are its settings, its link the landing pages' « Lien des pages ».
import type { Boutique } from '@pilotix/shared';
import { z } from 'zod';
import type { Db } from '../db';
import { num } from '../db';
import { accountByEmail } from '../platform/accounts';
import { keepOldSlug, loadShop, NAME_RESERVED, setShopStore, Shop, slugOk, slugTakenByOther } from '../platform/shops';
import type { Tenancy } from '../platform/tenancy';
import { bad, Ctx, forbidden, notFound, proc } from '../rpc';
import { getSetting, setSetting } from '../settings';
import { landingSettings, landingStore } from './landingquery';

/** A logo, as the app sends it: a small picture (the app makes it 256 × 256 at most), PNG, JPEG or WebP. */
export const LOGO_MAX = 160_000;
const LOGO_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
/** Former links a boutique keeps at most. */
export const OLD_SLUGS_MAX = 5;

/** The boutique's logo (its settings). */
export async function shopLogo(db: Db): Promise<string | null> {
  return (await getSetting(db, 'logo')).url ?? null;
}

/** Saves a logo (null: none). A seed may give an SVG drawing (`svg`); what people send is checked. */
export async function setShopLogo(db: Db, url: string | null, userId?: number, opts: { svg?: boolean } = {}) {
  if (url !== null && !(opts.svg && /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2}$/.test(url))) {
    if (url.length > LOGO_MAX) throw bad('Logo trop lourd : choisissez une image plus petite');
    if (!LOGO_RE.test(url)) throw bad('Logo : une image PNG, JPEG ou WebP');
  }
  await setSetting(db, 'logo', { url, updatedAt: url ? new Date().toISOString() : null }, userId);
}

async function oldSlugsOf(t: Tenancy, ids: number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  if (!ids.length) return out;
  const rows = await t.platform.query('SELECT slug, shop_id FROM platform.shop_old_slugs WHERE shop_id = ANY($1) ORDER BY created_at DESC, slug', [ids]);
  for (const r of rows as any[]) out.set(num(r.shop_id), [...(out.get(num(r.shop_id)) ?? []), String(r.slug)]);
  return out;
}

/** What is wrong with this link for that shop (null: it is free). */
async function slugProblem(ctx: Ctx, slug: string, shopId: number | null): Promise<string | null> {
  if (NAME_RESERVED.includes(slug)) return 'Ce nom est réservé par Pilotix, choisissez-en un autre';
  if (!slugOk(slug)) return 'Lien : 2 à 40 lettres minuscules (sans accents), chiffres et tirets, ex. ma-boutique';
  if (ctx.t && (await slugTakenByOther(ctx.t, slug, shopId))) return 'Ce lien est déjà pris par une autre boutique';
  if (!ctx.t && ctx.server?.storeTaken && (await ctx.server.storeTaken(slug))) return 'Ce lien est déjà pris par une autre boutique';
  return null;
}

// ---------------------------------------------------------------- the person's boutiques
/** This shop alone (a server with one shop, the preview before the platform exists). */
async function thisShopOnly(ctx: Ctx): Promise<Boutique[]> {
  return [
    {
      id: ctx.shop?.id ?? 0,
      name: String((await getSetting(ctx.db, 'shop')).name ?? '').trim() || 'Ma boutique',
      slug: await landingStore(ctx.db),
      logo: await shopLogo(ctx.db),
      kind: ctx.shop?.kind ?? 'store',
      // on a platform a shop is changed by its owner only (and this person's shops were not found): not here
      owner: !ctx.t && ctx.session.isAdmin,
      current: true,
      locked: !!ctx.shop?.locked,
      oldSlugs: [],
    },
  ];
}

/** Every boutique the person can open (their own first), with its logo and its former links; the one open now. */
export async function myBoutiques(ctx: Ctx): Promise<Boutique[]> {
  const t = ctx.t;
  if (!t || !ctx.shop) return thisShopOnly(ctx);
  const { storeChoices } = await import('../platform/signup');
  const list = await storeChoices(t, ctx.session.profile.email, ctx.now());
  if (!list.some((s) => s.id === ctx.shop!.id)) return thisShopOnly(ctx);
  const ids = list.map((s) => s.id);
  const schemas = new Map<number, string>((await t.platform.query('SELECT id, schema_name FROM platform.shops WHERE id = ANY($1)', [ids])).map((r: any) => [num(r.id), String(r.schema_name)]));
  const olds = await oldSlugsOf(t, ids);
  const out: Boutique[] = [];
  for (const s of list) {
    const schema = schemas.get(s.id);
    out.push({
      id: s.id,
      name: s.name,
      slug: s.slug,
      logo: schema ? await shopLogo(t.shop(schema)).catch(() => null) : null,
      kind: s.kind ?? 'store',
      owner: s.owner,
      current: s.id === ctx.shop.id,
      locked: s.locked,
      oldSlugs: s.owner ? (olds.get(s.id) ?? []) : [],
    });
  }
  return out;
}

/** A boutique the person owns (on a platform: the account that created it), ready to change. */
export async function ownBoutique(ctx: Ctx, id: number, notOwner = 'Seul le propriétaire de la boutique change son nom, son lien et son logo'): Promise<{ shop: Shop | null; db: Db }> {
  const t = ctx.t;
  if (!t || !ctx.shop) {
    if (id !== (ctx.shop?.id ?? 0)) throw notFound('Boutique introuvable');
    if (!ctx.session.isAdmin) throw forbidden('Seul l’administrateur de la boutique la modifie');
    return { shop: null, db: ctx.db };
  }
  const s = await loadShop(t, { id });
  if (!s || s.status === 'deleted' || s.status === 'archived') throw notFound('Boutique introuvable');
  if (s.kind !== 'store') throw bad('Seules les boutiques se changent ici');
  const acc = await accountByEmail(t, ctx.session.profile.email);
  if (!acc || s.ownerAccountId !== acc.id) throw forbidden(notOwner);
  return { shop: s, db: s.id === ctx.shop.id ? ctx.db : t.shop(s.schema) };
}

const Slug = z.string().trim().toLowerCase().max(60);
const SaveIn = z.object({
  id: z.number().int().min(0),
  name: z.string().trim().min(2, 'Nom : au moins 2 lettres').max(80),
  slug: Slug,
  /** undefined: unchanged; null: no logo */
  logo: z.string().max(LOGO_MAX + 100).nullable().optional(),
});

export const boutiqueProcs = {
  /** The person's boutiques (the boutique at the bottom of the menu, « Mes boutiques »). */
  'boutiques.list': proc(null, z.object({}), (ctx) => myBoutiques(ctx)),

  /** « Ce lien est-il libre ? » while the link is typed. */
  'boutiques.slugCheck': proc(null, z.object({ id: z.number().int().min(0), slug: Slug }), async (ctx, i) => {
    await ownBoutique(ctx, i.id);
    const reason = await slugProblem(ctx, i.slug, ctx.t ? i.id : null);
    return { slug: i.slug, free: !reason, reason };
  }),

  /** Its owner changes a boutique's name, link and logo (the boutique open now, or another of theirs). */
  'boutiques.save': proc(null, SaveIn, async (ctx, i) => {
    const { shop, db } = await ownBoutique(ctx, i.id);
    const me = ctx.session.profile.id;
    const t = ctx.t;
    const oldSlug = shop ? shop.slug : await landingStore(db);
    if (i.slug !== oldSlug) {
      const why = await slugProblem(ctx, i.slug, shop ? shop.id : null);
      if (why) throw bad(why);
      if (shop && t) {
        const olds = (await oldSlugsOf(t, [shop.id])).get(shop.id) ?? [];
        if (!olds.includes(i.slug) && olds.length >= OLD_SLUGS_MAX)
          throw bad(`Le lien de cette boutique a déjà changé ${OLD_SLUGS_MAX} fois : écrivez à Pilotix pour le changer encore`);
      }
    }
    if (i.logo !== undefined) await setShopLogo(db, i.logo, shop ? undefined : me);
    // the name: on the platform (the boutique lists) and in the boutique's settings (messages, labels, pages)
    const set = await getSetting(db, 'shop');
    if (set.name !== i.name) await setSetting(db, 'shop', { ...set, name: i.name }, shop ? undefined : me);
    if (shop && t) {
      if (shop.name !== i.name) await t.platform.query('UPDATE platform.shops SET name = $2 WHERE id = $1', [shop.id, i.name]);
      if (i.slug !== shop.slug) {
        await keepOldSlug(t, shop.id, shop.slug, i.slug);
        await t.platform.query('UPDATE platform.shops SET slug = $2 WHERE id = $1', [shop.id, i.slug]);
        // the boutique's own settings follow (its links in Pilotix; shop #1's name on the platform comes from them)
        await setShopStore(db, i.slug);
      }
    } else if (i.slug !== oldSlug) {
      const s = await landingSettings(db);
      await setSetting(db, 'landing', { ...s, storeSlug: i.slug }, me);
    }
    ctx.server?.platformChanged?.();
    if (!shop || shop.id === ctx.shop?.id) ctx.emit({ type: 'settings' });
    return (await myBoutiques(ctx)).find((b) => b.id === (shop ? shop.id : (ctx.shop?.id ?? 0)))!;
  }),
};
