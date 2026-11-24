// The shop's website (Landing pages › Website): its home page made of blocks, edited on a phone in Pilotix (the
// « Phone first » editor) and shown at the root of the boutique's own domain once published. Two copies are kept: the
// one being edited (site.draft) and the one customers see (site.live), so a half-done change never reaches them.
// Each product card opens the product's own landing page: its order form, pixel and fake-order check stay as they are.
import {
  renderSite,
  renderTicket,
  SITE_CORNER_KEYS,
  SITE_DESIGNS,
  SITE_FONT_KEYS,
  SITE_LANGS,
  SITE_LIMITS,
  SITE_PALETTE_KEYS,
  SITE_TRUST_ICONS,
  siteFromDesign,
  SiteCorners,
  SiteDoc,
  SiteFont,
  SiteLang,
  SitePalette,
  SiteProduct,
  SiteView,
  whatsappNumber,
} from '@pilotix/shared';
import { z } from 'zod';
import { Db, num, numOrNull } from '../db';
import { bad, Ctx, notFound, proc } from '../rpc';
import { getSetting } from '../settings';
import { getRaw, setRaw } from './admin';
import { b64, followedRefs, landingIconUrl, productPhotoSets, readImgs, WHO } from './landing';
import { landingSettings } from './landingquery';
import { pageLinks } from './pagelinks';
import { rdvTicket, siteSessions } from './rdv';
import { modulesOf } from './shopmodules';

const DRAFT = 'site.draft';
const LIVE = 'site.live';
interface Stored {
  doc: SiteDoc;
  at: string;
  by?: number | null;
}

// ---------------------------------------------------------------- what a site may hold
const Lang = z.enum(SITE_LANGS);
const Text = (max: number) => z.object({ ar: z.string().max(max).optional(), fr: z.string().max(max).optional(), en: z.string().max(max).optional() }).strict();
const BlockId = z.string().regex(/^[a-z0-9]{1,12}$/);
const B = { id: BlockId, hidden: z.boolean().optional() };
const Block = z.discriminatedUnion('type', [
  z.object({ ...B, type: z.literal('header'), phone: z.boolean() }).strict(),
  z
    .object({
      ...B,
      type: z.literal('hero'),
      layout: z.enum(['side', 'center', 'plain']),
      title: Text(SITE_LIMITS.title),
      text: Text(SITE_LIMITS.text),
      button: Text(60),
      link: z.enum(['products', 'whatsapp', 'sessions']),
      productId: z.number().int().positive().nullable(),
    })
    .strict(),
  z.object({ ...B, type: z.literal('trust'), items: z.array(z.object({ icon: z.enum(SITE_TRUST_ICONS), text: Text(80) }).strict()).max(SITE_LIMITS.items) }).strict(),
  z.object({ ...B, type: z.literal('best'), title: Text(SITE_LIMITS.title), count: z.number().int().min(1).max(SITE_LIMITS.count), oldPrice: z.boolean(), button: Text(60) }).strict(),
  z.object({ ...B, type: z.literal('products'), title: Text(SITE_LIMITS.title), button: Text(60) }).strict(),
  z.object({ ...B, type: z.literal('sessions'), title: Text(SITE_LIMITS.title), text: Text(SITE_LIMITS.text), button: Text(60) }).strict(),
  z.object({ ...B, type: z.literal('why'), title: Text(SITE_LIMITS.title), points: z.array(Text(200)).max(SITE_LIMITS.items) }).strict(),
  z.object({ ...B, type: z.literal('faq'), title: Text(SITE_LIMITS.title), items: z.array(z.object({ q: Text(160), a: Text(SITE_LIMITS.text) }).strict()).max(SITE_LIMITS.items) }).strict(),
  z.object({ ...B, type: z.literal('whatsapp'), text: Text(80) }).strict(),
  z.object({ ...B, type: z.literal('footer'), text: Text(200) }).strict(),
]);
export const SiteDocInput = z
  .object({
    v: z.literal(1),
    design: z.string().max(40),
    theme: z
      .object({
        palette: z.enum(SITE_PALETTE_KEYS as [SitePalette, ...SitePalette[]]),
        font: z.enum(SITE_FONT_KEYS as [SiteFont, ...SiteFont[]]),
        corners: z.enum(SITE_CORNER_KEYS as [SiteCorners, ...SiteCorners[]]),
      })
      .strict(),
    langs: z.array(Lang).min(1).max(3),
    home: z.array(Block).max(SITE_LIMITS.blocks),
  })
  .strict()
  .refine((d) => new Set(d.langs).size === d.langs.length, { message: 'Une langue en double' })
  .refine((d) => new Set(d.home.map((b) => b.id)).size === d.home.length, { message: 'Deux blocs ont le même nom' });

// ---------------------------------------------------------------- what the page shows
/**
 * The products with a page online (one card each: the newest page of a product), newest first, with the page's first
 * photo: its address on the server (imgBase), or the picture itself for the editor's preview inside Pilotix.
 */
async function siteProducts(db: Db, imgBase: string | null): Promise<SiteProduct[]> {
  const rows = await db.query(
    `SELECT DISTINCT ON (l.product_id) l.id, l.slug, l.product_id, COALESCE(NULLIF(l.title, ''), p.name) AS title, COALESCE(l.price, p.price) AS price, l.old_price, l.images
       FROM landing_pages l JOIN products p ON p.id = l.product_id
      WHERE l.active AND p.active
      ORDER BY l.product_id, l.updated_at DESC`,
  );
  rows.sort((a: any, b: any) => num(b.id) - num(a.id));
  const list = rows.slice(0, 60);
  const sets = await productPhotoSets(db, list.map((r: any) => num(r.product_id)));
  const firsts = list.map((r: any) => followedRefs(readImgs(r.images), num(r.product_id), sets.get(num(r.product_id)), imgBase)[0]);
  const ids = firsts.filter((f): f is { id: number } => !!f && 'id' in f).map((f) => f.id);
  const pics = ids.length ? await db.query(`SELECT id, w720 IS NOT NULL AS has720, w320 IS NOT NULL AS has320${imgBase ? '' : ', t160'} FROM landing_images WHERE id = ANY($1)`, [ids]) : [];
  const P = new Map(pics.map((x: any) => [num(x.id), x]));
  return list.map((r: any, k: number) => {
    const f = firsts[k];
    let img: SiteProduct['img'] = null;
    if (f && 'url' in f) img = { src: f.url, ...(f.srcset ? { srcset: f.srcset } : {}) };
    else if (f && P.has(f.id)) {
      const x = P.get(f.id);
      if (imgBase) {
        const at = (w: number) => `${imgBase}${f.id}/${w}.webp`;
        img = { src: at(480), srcset: [...(x.has320 ? [`${at(320)} 320w`] : []), `${at(480)} 480w`, ...(x.has720 ? [`${at(720)} 720w`] : []), `${at(960)} 960w`].join(', ') };
      } else img = { src: b64(String(x.t160)) };
    }
    return { id: num(r.product_id), slug: String(r.slug), title: String(r.title), price: num(r.price), oldPrice: numOrNull(r.old_price), img };
  });
}

/** products by pieces delivered in the last 90 days, the most first */
async function bestSellers(db: Db, now: number): Promise<number[]> {
  const rows = await db.query(
    `SELECT i.product_id, sum(i.qty)::int AS n FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.follow_status = 'delivered' AND o.delivered_at >= $1 AND NOT i.is_upsell
      GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 24`,
    [new Date(now - 90 * 86_400_000)],
  );
  return rows.map((r: any) => num(r.product_id));
}

/** the shop as its site shows it: name, logo (its address on the server, or the picture itself), phone, WhatsApp */
async function siteShop(db: Db, imgBase: string | null): Promise<SiteView['shop']> {
  const shop = await getSetting(db, 'shop');
  const logo = await getSetting(db, 'logo');
  const wa = (await landingSettings(db)).whatsapp;
  const phone = String(shop.savPhone ?? '').trim();
  return {
    name: String(shop.name || 'Boutique'),
    logo: logo.url ? (imgBase ? ((await landingIconUrl(db, imgBase)) ?? null) : logo.url) : null,
    phone,
    whatsapp: whatsappNumber(String(wa?.number ?? '')) || whatsappNumber(phone),
  };
}

export async function siteView(ctx: Ctx, imgBase: string | null): Promise<Omit<SiteView, 'doc' | 'lang'>> {
  return {
    shop: await siteShop(ctx.db, imgBase),
    products: await siteProducts(ctx.db, imgBase),
    best: await bestSellers(ctx.db, ctx.now()),
    // a service's sessions (Rendez-vous, when the boutique turned it on)
    sessions: await siteSessions(ctx.db, ctx.now()),
    rdv: (await modulesOf(ctx.db)).rdv,
  };
}

const stored = (v: unknown): Stored | null => {
  const s = v as Stored | null;
  if (!s || typeof s !== 'object' || !s.doc) return null;
  const d = SiteDocInput.safeParse(s.doc);
  return d.success ? { ...s, doc: d.data as SiteDoc } : null;
};
const readDraft = async (db: Db) => stored(await getRaw<unknown>(db, DRAFT, null));
const readLive = async (db: Db) => stored(await getRaw<unknown>(db, LIVE, null));

export const siteProcs = {
  /** the site being edited, what customers see now, the designs to start from, and what the preview shows */
  'site.get': proc([...WHO], z.object({}), async (ctx) => {
    const draft = await readDraft(ctx.db);
    const live = await readLive(ctx.db);
    const l = await pageLinks(ctx);
    return {
      draft: draft?.doc ?? null,
      savedAt: draft?.at ?? null,
      live: live ? { at: live.at, same: !!draft && JSON.stringify(live.doc) === JSON.stringify(draft.doc) } : null,
      /** where the published site lives: the boutique's own domain once it is ready ('' / null: not yet) */
      url: l.ownPrefix || null,
      designs: SITE_DESIGNS.map((d) => ({ key: d.key, niche: d.niche, name: d.name, theme: d.theme })),
      view: await siteView(ctx, null),
    };
  }),

  /** a new site from a design (an existing one is replaced only when asked) */
  'site.start': proc(
    [...WHO],
    z.object({ design: z.string().max(40), langs: z.array(Lang).min(1).max(3), replace: z.boolean().default(false) }),
    async (ctx, i) => {
      if (!SITE_DESIGNS.some((d) => d.key === i.design)) throw notFound('Design introuvable');
      if (!i.replace && (await readDraft(ctx.db))) throw bad('Ce site existe déjà : choisissez « Changer de design » pour le remplacer');
      const doc = siteFromDesign(i.design, [...new Set(i.langs)] as SiteLang[]);
      const at = new Date(ctx.now()).toISOString();
      await setRaw(ctx.db, DRAFT, { doc, at, by: ctx.session.profile.id } satisfies Stored, ctx.session.profile.id);
      return { draft: doc, savedAt: at };
    },
  ),

  /** the editor's copy (saved as the shop types: customers see nothing until « Publier ») */
  'site.save': proc([...WHO], z.object({ doc: SiteDocInput }), async (ctx, i) => {
    const at = new Date(ctx.now()).toISOString();
    await setRaw(ctx.db, DRAFT, { doc: i.doc as SiteDoc, at, by: ctx.session.profile.id } satisfies Stored, ctx.session.profile.id);
    return { savedAt: at };
  }),

  /** the editor's copy becomes what customers see */
  'site.publish': proc([...WHO], z.object({}), async (ctx) => {
    const draft = await readDraft(ctx.db);
    if (!draft) throw bad('Choisissez d’abord un design');
    const at = new Date(ctx.now()).toISOString();
    await setRaw(ctx.db, LIVE, { doc: draft.doc, at, by: ctx.session.profile.id } satisfies Stored, ctx.session.profile.id);
    ctx.emit({ type: 'settings' });
    return { at, url: (await pageLinks(ctx)).ownPrefix || null };
  }),

  /** customers see the simple list of pages again (the editor's copy stays) */
  'site.unpublish': proc([...WHO], z.object({}), async (ctx) => {
    await ctx.db.query('DELETE FROM settings WHERE key = $1', [LIVE]);
    ctx.emit({ type: 'settings' });
    return { ok: true as const };
  }),

  /**
   * The published site for the server (the root of the boutique's own domain): null when nothing is published. `lang`:
   * the language asked for (?lang=…), else the site's main one; `langHref`: each language's address of this page.
   */
  'site.html': proc(
    [],
    z.object({
      imgBase: z.string().max(500),
      base: z.string().max(500),
      url: z.string().max(600).optional(),
      lang: z.string().max(5).optional(),
      langHref: z.record(z.string().max(600)).optional(),
      /** the Sessions block's form posts here (Rendez-vous); after a refused booking: why, and the session chosen */
      bookUrl: z.string().max(600).optional(),
      err: z.string().max(20).optional(),
      pick: z.number().int().optional(),
      /** a booking's ticket (/?billet=…) instead of the home */
      ticket: z.string().max(64).optional(),
    }),
    async (ctx, i) => {
      const live = await readLive(ctx.db);
      if (!live) return { html: null as string | null };
      const langs = live.doc.langs;
      const lang = (langs as string[]).includes(String(i.lang)) ? (i.lang as SiteLang) : langs[0];
      const v = await siteView(ctx, i.imgBase);
      const langHref = Object.fromEntries(Object.entries(i.langHref ?? {}).filter(([k]) => (langs as string[]).includes(k)));
      const r = { mode: 'live' as const, base: i.base, url: i.url, langHref, year: new Date(ctx.now()).getFullYear(), now: ctx.now() };
      if (i.ticket !== undefined) return { html: renderTicket({ doc: live.doc, lang, ...v }, await rdvTicket(ctx.db, i.ticket), r) as string | null };
      return {
        html: renderSite({ doc: live.doc, lang, ...v }, { ...r, ...(i.bookUrl ? { book: { action: i.bookUrl, err: i.err ?? null, pick: i.pick ?? null } } : {}) }) as string | null,
      };
    },
  ),
};
