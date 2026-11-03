// « Mes boutiques »: a seller's boutiques — each one's name, its link (the first part of its addresses:
// <site>/<link>/<page> for its landing pages, pilotix.online/<link>/… for the app) and its logo — and the boutique at
// the bottom of the menu, to go from one to another. A seller never adds another seller: one account, many boutiques
// (users.ts refuses the « Vendeur » role).
//
// Only the person who created a boutique (its owner) changes its name and its logo. Its link is chosen once, when the
// boutique is made, and never changes (nor in Landing pages › Réglages, nor in the control room). Links a boutique had
// before that rule still lead to it.
//
// On a server with one shop (and in the in-browser preview before the platform's tables exist) the only boutique is
// this shop: its name and logo are its settings, its link the landing pages' « Lien des pages ».
import type { Boutique } from '@pilotix/shared';
import { z } from 'zod';
import type { Db } from '../db';
import { num } from '../db';
import { accountByEmail } from '../platform/accounts';
import { loadShop, setShopStore, Shop } from '../platform/shops';
import type { Tenancy } from '../platform/tenancy';
import { bad, Ctx, forbidden, notFound, proc } from '../rpc';
import { getSetting, setSetting } from '../settings';
import { landingSettings, landingStore } from './landingquery';

/** A logo, as the app sends it: a small picture (the app makes it 256 × 256 at most), PNG, JPEG or WebP. */
export const LOGO_MAX = 160_000;
const LOGO_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

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
export async function ownBoutique(ctx: Ctx, id: number, notOwner = 'Seul le propriétaire de la boutique change son nom et son logo'): Promise<{ shop: Shop | null; db: Db }> {
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

/** A boutique's link is chosen once, when the boutique is made: it never changes. */
export const SLUG_LOCKED = 'Le lien d’une boutique ne change jamais : il est choisi une seule fois, à sa création';

const SaveIn = z.object({
  id: z.number().int().min(0),
  name: z.string().trim().min(2, 'Nom : au moins 2 lettres').max(80),
  /** its link, as it is (the link never changes: another one is refused) */
  slug: z.string().trim().toLowerCase().max(60).optional(),
  /** undefined: unchanged; null: no logo */
  logo: z.string().max(LOGO_MAX + 100).nullable().optional(),
});

export const boutiqueProcs = {
  /** The person's boutiques (the boutique at the bottom of the menu, « Mes boutiques »). */
  'boutiques.list': proc(null, z.object({}), (ctx) => myBoutiques(ctx)),

  /** Its owner changes a boutique's name and logo (the boutique open now, or another of theirs); its link never changes. */
  'boutiques.save': proc(null, SaveIn, async (ctx, i) => {
    const { shop, db } = await ownBoutique(ctx, i.id);
    const me = ctx.session.profile.id;
    const t = ctx.t;
    const slug = shop ? shop.slug : await landingStore(db);
    if (i.slug !== undefined && i.slug !== slug) throw bad(SLUG_LOCKED);
    if (i.logo !== undefined) await setShopLogo(db, i.logo, shop ? undefined : me);
    // its link stays where it is (written in its settings: a link made from the old name does not follow the new one)
    if (shop) await setShopStore(db, slug);
    else {
      const ls = await landingSettings(db);
      if (!String(ls.storeSlug ?? '').trim()) await setSetting(db, 'landing', { ...ls, storeSlug: slug }, me);
    }
    // the name: on the platform (the boutique lists) and in the boutique's settings (messages, labels, pages)
    const set = await getSetting(db, 'shop');
    if (set.name !== i.name) await setSetting(db, 'shop', { ...set, name: i.name }, shop ? undefined : me);
    if (shop && t && shop.name !== i.name) await t.platform.query('UPDATE platform.shops SET name = $2 WHERE id = $1', [shop.id, i.name]);
    ctx.server?.platformChanged?.();
    if (!shop || shop.id === ctx.shop?.id) ctx.emit({ type: 'settings' });
    return (await myBoutiques(ctx)).find((b) => b.id === (shop ? shop.id : (ctx.shop?.id ?? 0)))!;
  }),
};
