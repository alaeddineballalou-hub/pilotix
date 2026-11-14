// Landing pages › Groupes: one page with several products. The customer picks one; it opens that product's own landing
// page (its address with ?g=<group>), which shows « رجوع إلى كل المنتجات » at the top, back to the group. Five looks
// (GROUP_THEMES); in « best » the shop picks the product shown big at the top. The group's address is the same kind as
// a landing page's (site/<store>/<slug>, the shop's own domain, /lp/<slug>): landingPage() falls back to the group.
import { GROUP_THEMES, GroupBadge, GroupItem, GroupTheme, isAppPage, isHexColor, LANDING_DEFAULT_COLOR, renderGroup } from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, num, numOrNull } from '../db';
import { bad, Ctx, notFound, proc } from '../rpc';
import { autoSettings, getSetting } from '../settings';
// (landing.ts imports this file too: only functions from it here, used once both are loaded)
import { b64, followedRefs, HtmlOpts, imageRows, ImgRef, landingIconUrl, productContext, productPhotoSets, readImgs, viewImages } from './landing';

const WHO = ['marketer'] as const;
import { addressOwner, addressTaken, APP_WORD, groupRowAt, keepFormerAddress, landingSettings, landingStore } from './landingquery';
import { checkPixels, PixelList, pixelsJson, pixelsOf, readPixels } from './pixels';

const id = z.number().int().positive();
const SLUG = z
  .string()
  .trim()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Adresse : lettres minuscules, chiffres et tirets')
  // site/<boutique>/<group>: a word of the app's own pages opens the app, not the group
  .refine((v) => !isAppPage(v), APP_WORD);

export const GroupInput = z.object({
  id: id.optional(),
  slug: SLUG,
  active: z.boolean().default(true),
  title: z.string().trim().min(1, 'Donnez un titre au groupe').max(160),
  subtitle: z.string().trim().max(300).default(''),
  color: z.string().refine(isHexColor, 'Couleur invalide').default(LANDING_DEFAULT_COLOR),
  theme: z.enum(GROUP_THEMES).default('grid'),
  /** design « best »: the product shown big at the top */
  bestPageId: id.nullable().default(null),
  items: z
    .array(
      z.object({
        pageId: id,
        tab: z.string().trim().max(40).default(''),
        note: z.string().trim().max(120).default(''),
        /** the band above the product's photo (« أفضل سعر »…); empty text: none */
        badge: z
          .object({ text: z.string().trim().max(30, 'Badge : 30 caractères au maximum'), color: z.string().refine(isHexColor, 'Couleur du badge invalide') })
          .nullable()
          .default(null)
          .transform((b) => (b && b.text ? { text: b.text, color: b.color.toLowerCase() } : null)),
      }),
    )
    .max(60, '60 produits au maximum')
    .default([]),
  pixelId: z.string().trim().max(30).regex(/^\d*$/, 'Pixel : chiffres seulement').default(''),
  /** Réglages › Pixels: null = the default one, 0 = none */
  metaPixels: PixelList,
  tiktokPixels: PixelList,
});
type GroupIn = z.infer<typeof GroupInput>;

interface GroupRowIn {
  slug: string;
  active: boolean;
  title: string;
  subtitle: string;
  color: string;
  theme: string;
  best_page_id: number | null;
  items: unknown;
  pixel_id: string | null;
  meta_pixels: unknown;
  tiktok_pixels: unknown;
}

const readBadge = (b: any): GroupBadge | null => (b && typeof b.text === 'string' && b.text.trim() && typeof b.color === 'string' && isHexColor(b.color) ? { text: b.text.trim(), color: b.color } : null);

const readItems = (v: unknown): { pageId: number; tab: string; note: string; badge: GroupBadge | null }[] => {
  const a = typeof v === 'string' ? JSON.parse(v) : v;
  return Array.isArray(a) ? a.filter((x) => x && x.pageId).map((x) => ({ pageId: num(x.pageId), tab: String(x.tab ?? ''), note: String(x.note ?? ''), badge: readBadge(x.badge) })) : [];
};

/** The group page's HTML (a group saved at this address; none: « page introuvable »). */
export async function groupHtml(ctx: Ctx, slug: string, o: HtmlOpts): Promise<string> {
  // the group that has this address, or had it before (its old links keep working)
  const g = await groupRowAt(ctx.db, slug);
  if (!g || (!g.active && o.mode === 'live')) throw notFound('Page introuvable');
  if (o.mode === 'live') await ctx.db.query('UPDATE landing_groups SET views = views + 1 WHERE id = $1', [g.id]);
  return renderRow(ctx, g, o);
}

async function renderRow(ctx: Ctx, g: GroupRowIn, o: Pick<HtmlOpts, 'mode' | 'imgBase' | 'site' | 'url'>): Promise<string> {
  const list = readItems(g.items);
  const pages = list.length ? await ctx.db.query('SELECT * FROM landing_pages WHERE id = ANY($1)', [list.map((x) => x.pageId)]) : [];
  const P = new Map(pages.map((p: any) => [num(p.id), p]));
  const items: (GroupItem & { pageId: number })[] = [];
  let shopName = '';
  const stopOut = (await autoSettings(ctx.db)).noStock.on;
  const sets = await productPhotoSets(ctx.db, pages.map((p: any) => num(p.product_id)));
  for (const it of list) {
    const l = P.get(it.pageId);
    if (!l || (o.mode === 'live' && !l.active)) continue;
    const pc = await productContext(ctx.db, num(l.product_id)).catch(() => null);
    if (!pc || (o.mode === 'live' && !pc.active)) continue;
    shopName = pc.shopName;
    // the first photo its page shows (its own, else its product's live one)
    const refs: ImgRef[] = followedRefs(readImgs(l.images), num(l.product_id), sets.get(num(l.product_id)), o.imgBase).slice(0, 1);
    const image = viewImages(refs, await imageRows(ctx.db, refs, !o.imgBase), o.imgBase)[0] ?? null;
    items.push({
      pageId: it.pageId,
      slug: String(l.slug),
      title: String(l.title || pc.name),
      price: numOrNull(l.price) ?? pc.price,
      oldPrice: numOrNull(l.old_price),
      image,
      soldOut: (l.stock_mode === 'hide' || stopOut) && pc.soldOut,
      tab: it.tab,
      note: it.note,
      badge: it.badge,
    });
  }
  const s = await landingSettings(ctx.db);
  if (!shopName) shopName = (await getSetting(ctx.db, 'shop')).name;
  const logo = (await getSetting(ctx.db, 'logo')).url ?? null;
  const best = items.find((x) => x.pageId === g.best_page_id);
  const url = o.url ?? (o.site ? `${o.site}/${await landingStore(ctx.db, s)}/${g.slug}` : '');
  const px = await pixelsOf(ctx.db, g, s.pixelId);
  return renderGroup(
    {
      slug: g.slug,
      title: g.title,
      subtitle: g.subtitle,
      color: g.color,
      theme: ((GROUP_THEMES as readonly string[]).includes(g.theme) ? g.theme : 'grid') as GroupTheme,
      items,
      bestSlug: best?.slug ?? null,
      shopName,
      shopLogo: (() => {
        const u = logo;
        return u && u.length <= 60_000 ? u : null;
      })(),
      pixelId: o.mode === 'live' ? px.meta.join(',') : '',
      tiktokId: o.mode === 'live' ? px.tiktok.join(',') : '',
    },
    { mode: o.mode, url: url || undefined, icon: await landingIconUrl(ctx.db, o.imgBase) },
  );
}

/**
 * A product page opened from a group (?g=<slug>): the group's « back » bar, when that group is online and has this
 * product. On the real page the visit is counted as a click of the group on this product.
 */
export async function groupOf(db: Db, slug: string, pageId: number, live: boolean): Promise<{ slug: string; title: string } | null> {
  if (!/^[a-z0-9-]{2,60}$/.test(slug)) return null;
  const g = await groupRowAt(db, slug);
  if (!g || (live && !g.active) || !readItems(g.items).some((x) => x.pageId === pageId)) return null;
  if (live)
    await db.query(
      `INSERT INTO landing_group_clicks (group_id, page_id, clicks) VALUES ($1,$2,1) ON CONFLICT (group_id, page_id) DO UPDATE SET clicks = landing_group_clicks.clicks + 1`,
      [g.id, pageId],
    );
  return { slug: String(g.slug), title: String(g.title) };
}

async function listGroups(db: Db, ids?: number[]) {
  const rows = await db.query(`SELECT * FROM landing_groups ${ids ? 'WHERE id = ANY($1)' : ''} ORDER BY updated_at DESC`, ids ? [ids] : []);
  if (!rows.length) return [];
  const clicks = await db.query('SELECT group_id, page_id, clicks FROM landing_group_clicks WHERE group_id = ANY($1)', [rows.map((r: any) => r.id)]);
  // a group's orders came through its address of the time (utm.g): its address now and its former ones
  const former = await db.query('SELECT slug, group_id FROM landing_old_slugs WHERE group_id = ANY($1)', [rows.map((r: any) => r.id)]);
  const slugsOf = new Map<number, Set<string>>(
    rows.map((r: any) => [num(r.id), new Set([String(r.slug), ...former.filter((f: any) => num(f.group_id) === num(r.id)).map((f: any) => String(f.slug))])]),
  );
  const orders = await db.query(
    `SELECT utm->>'g' AS g, landing_id, count(*)::int AS n FROM orders WHERE utm ? 'g' AND utm->>'g' = ANY($1) GROUP BY 1, 2`,
    [[...slugsOf.values()].flatMap((x) => [...x])],
  );
  const allIds = [...new Set(rows.flatMap((r: any) => readItems(r.items).map((x) => x.pageId)))];
  const pages = allIds.length ? await db.query('SELECT id, slug, title, active, images, product_id, (SELECT name FROM products p WHERE p.id = l.product_id) AS pname FROM landing_pages l WHERE id = ANY($1)', [allIds]) : [];
  const sets = await productPhotoSets(db, pages.map((p: any) => num(p.product_id)));
  const first = new Map<number, ImgRef | undefined>(pages.map((p: any) => [num(p.id), followedRefs(readImgs(p.images), num(p.product_id), sets.get(num(p.product_id)), null)[0]]));
  const firsts = [...first.values()].filter((x): x is { id: number } => !!x && 'id' in x);
  const thumbs = firsts.length ? await db.query('SELECT id, t160 FROM landing_images WHERE id = ANY($1)', [firsts.map((x) => x.id)]) : [];
  const T = new Map(thumbs.map((t: any) => [num(t.id), b64(t.t160)]));
  const P = new Map(
    pages.map((p: any) => {
      const f = first.get(num(p.id));
      return [num(p.id), { slug: String(p.slug), title: String(p.title || p.pname), active: !!p.active, thumb: !f ? null : 'url' in f ? f.url : T.get(f.id) ?? null }];
    }),
  );
  return rows.map((r: any) => {
    const gid = num(r.id);
    const items = readItems(r.items).map((x) => {
      const p = P.get(x.pageId);
      return {
        ...x,
        slug: p?.slug ?? '',
        title: p?.title ?? '',
        active: p?.active ?? false,
        thumb: p?.thumb ?? null,
        clicks: num(clicks.find((c: any) => num(c.group_id) === gid && num(c.page_id) === x.pageId)?.clicks),
        orders: orders.filter((o: any) => slugsOf.get(gid)!.has(String(o.g)) && num(o.landing_id) === x.pageId).reduce((n: number, o: any) => n + num(o.n), 0),
      };
    });
    return {
      id: gid,
      slug: String(r.slug),
      active: !!r.active,
      title: String(r.title),
      subtitle: String(r.subtitle),
      color: String(r.color),
      theme: ((GROUP_THEMES as readonly string[]).includes(r.theme) ? r.theme : 'grid') as GroupTheme,
      bestPageId: numOrNull(r.best_page_id),
      pixelId: String(r.pixel_id ?? ''),
      metaPixels: readPixels(r.meta_pixels),
      tiktokPixels: readPixels(r.tiktok_pixels),
      views: num(r.views),
      clicks: items.reduce((n, x) => n + x.clicks, 0),
      orders: orders.filter((o: any) => slugsOf.get(gid)!.has(String(o.g))).reduce((n: number, o: any) => n + num(o.n), 0),
      items,
      updatedAt: iso(r.updated_at),
    };
  });
}
export type LandingGroupRow = Awaited<ReturnType<typeof listGroups>>[number];

async function checkInput(db: Db, i: GroupIn) {
  // a page's or another group's address, now or before (its old links lead there): not this one's
  const taken = await addressTaken(db, i.slug, { group: i.id });
  if (taken) throw bad(taken);
  const ids = i.items.map((x) => x.pageId);
  if (new Set(ids).size !== ids.length) throw bad('Un produit est deux fois dans le groupe');
  // one product per badge: two « أفضل سعر » in one group would mislead the customer
  const seen = new Set<string>();
  for (const x of i.items) {
    if (!x.badge) continue;
    const k = x.badge.text.replace(/\s+/g, ' ').trim().toLowerCase();
    if (seen.has(k)) throw bad(`Le badge « ${x.badge.text} » est sur deux produits : un badge ne va que sur un seul produit du groupe`);
    seen.add(k);
  }
  if (ids.length && num((await db.query('SELECT count(*)::int AS n FROM landing_pages WHERE id = ANY($1)', [ids]))[0].n) !== ids.length) throw notFound('Landing page introuvable');
  if (i.theme === 'best' && i.bestPageId && !ids.includes(i.bestPageId)) throw bad('Le best-seller doit être un produit du groupe');
}

const rowOf = (i: GroupIn): GroupRowIn => ({
  slug: i.slug,
  active: i.active,
  title: i.title,
  subtitle: i.subtitle,
  color: i.color.toLowerCase(),
  theme: i.theme,
  best_page_id: i.bestPageId,
  items: i.items,
  pixel_id: i.pixelId,
  meta_pixels: i.metaPixels,
  tiktok_pixels: i.tiktokPixels,
});

/** a free address for a group, from its title: free, or this group's own (now or before); never a page's or another group's, even a former one */
async function freeGroupSlug(db: Db, title: string, selfId?: number): Promise<string> {
  const base =
    title
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'collection';
  for (let n = 1; n < 200; n++) {
    const s = n === 1 ? base : `${base}-${n}`;
    if (s.length < 2) continue;
    const o = await addressOwner(db, s);
    if (!o || (selfId !== undefined && o.group === selfId)) return s;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export const landingGroupProcs = {
  'landing.groups': proc([...WHO], z.object({}), (ctx) => listGroups(ctx.db)),

  'landing.groupSave': proc([...WHO], GroupInput, async (ctx, i) => {
    await checkInput(ctx.db, i);
    await checkPixels(ctx.db, 'meta', i.metaPixels);
    await checkPixels(ctx.db, 'tiktok', i.tiktokPixels);
    const r = rowOf(i);
    const vals = [r.slug, r.active, r.title, r.subtitle, r.color, r.theme, r.best_page_id, JSON.stringify(r.items), r.pixel_id || null, pixelsJson(i.metaPixels), pixelsJson(i.tiktokPixels)];
    let gid: number;
    if (i.id) {
      const before = (await ctx.db.query('SELECT slug FROM landing_groups WHERE id = $1', [i.id]))[0]?.slug as string | undefined;
      const u = await ctx.db.query(
        `UPDATE landing_groups SET slug=$2, active=$3, title=$4, subtitle=$5, color=$6, theme=$7, best_page_id=$8, items=$9, pixel_id=$10, meta_pixels=$11, tiktok_pixels=$12, updated_at=now() WHERE id=$1 RETURNING id`,
        [i.id, ...vals],
      );
      if (!u.length) throw notFound('Groupe introuvable');
      gid = i.id;
      // a new address: the old one keeps opening this group
      if (before) await keepFormerAddress(ctx.db, { group: gid }, before, i.slug);
    } else {
      gid = num(
        (
          await ctx.db.query(
            `INSERT INTO landing_groups (slug, active, title, subtitle, color, theme, best_page_id, items, pixel_id, meta_pixels, tiktok_pixels, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
            [...vals, ctx.session.profile.id],
          )
        )[0].id,
      );
    }
    return (await listGroups(ctx.db, [gid]))[0];
  }),

  /** A copy of a group (same products, design, colour, pixels), « (copie) » in its name, a new free address, offline. */
  'landing.groupDuplicate': proc([...WHO], z.object({ id }), async (ctx, { id: gid }) => {
    const src = (await ctx.db.query('SELECT slug, title FROM landing_groups WHERE id = $1', [gid]))[0];
    if (!src) throw notFound('Groupe introuvable');
    const slug = await freeGroupSlug(ctx.db, String(src.slug));
    const title = `${String(src.title ?? '').slice(0, 180)} (copie)`.trim();
    const r = await ctx.db.query(
      `INSERT INTO landing_groups (slug, active, title, subtitle, color, theme, best_page_id, items, pixel_id, meta_pixels, tiktok_pixels, meta_pixel_ref, tiktok_pixel_ref, created_by)
       SELECT $2, false, $3, subtitle, color, theme, best_page_id, items, pixel_id, meta_pixels, tiktok_pixels, meta_pixel_ref, tiktok_pixel_ref, $4 FROM landing_groups WHERE id = $1 RETURNING id`,
      [gid, slug, title, ctx.session.profile.id],
    );
    return (await listGroups(ctx.db, [num(r[0].id)]))[0];
  }),

  'landing.groupRemove': proc([...WHO], z.object({ id }), async (ctx, { id: gid }) => {
    await ctx.db.query('DELETE FROM landing_groups WHERE id = $1', [gid]);
    return { ok: true };
  }),

  /** the group as the customer will see it, from what the editor holds (not saved yet) */
  'landing.groupDraft': proc([...WHO], GroupInput.extend({ slug: z.string().max(60).default('groupe') }), async (ctx, i) => ({
    html: await renderRow(ctx, rowOf({ ...i, slug: /^[a-z0-9-]{2,60}$/.test(i.slug) ? i.slug : 'groupe' }), { mode: 'preview', imgBase: null }),
  })),

  /** a free address for a new group, from its title */
  'landing.groupSlug': proc([...WHO], z.object({ title: z.string().max(200), id: id.optional() }), async (ctx, i) => ({ slug: await freeGroupSlug(ctx.db, i.title, i.id) })),
};
