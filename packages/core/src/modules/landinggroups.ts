// Landing pages › Groupes: one page with several products. The customer picks one; it opens that product's own landing
// page (its address with ?g=<group>), which shows « رجوع إلى كل المنتجات » at the top, back to the group. Five looks
// (GROUP_THEMES); in « best » the shop picks the product shown big at the top. The group's address is the same kind as
// a landing page's (site/<store>/<slug>, the shop's own domain, /lp/<slug>): landingPage() falls back to the group.
import { GROUP_THEMES, GroupItem, GroupTheme, isHexColor, LANDING_DEFAULT_COLOR, renderGroup } from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, num, numOrNull } from '../db';
import { bad, Ctx, notFound, proc } from '../rpc';
import { getSetting } from '../settings';
// (landing.ts imports this file too: only functions from it here, used once both are loaded)
import { b64, HtmlOpts, imageRows, ImgRef, productContext, readImgs, viewImages } from './landing';

const WHO = ['marketer'] as const;
import { landingSettings, landingStore } from './landingquery';

const id = z.number().int().positive();
const SLUG = z.string().trim().min(2).max(60).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Adresse : lettres minuscules, chiffres et tirets');

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
    .array(z.object({ pageId: id, tab: z.string().trim().max(40).default(''), note: z.string().trim().max(120).default('') }))
    .max(60, '60 produits au maximum')
    .default([]),
  pixelId: z.string().trim().max(30).regex(/^\d*$/, 'Pixel : chiffres seulement').default(''),
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
}

const readItems = (v: unknown): { pageId: number; tab: string; note: string }[] => {
  const a = typeof v === 'string' ? JSON.parse(v) : v;
  return Array.isArray(a) ? a.filter((x) => x && x.pageId).map((x) => ({ pageId: num(x.pageId), tab: String(x.tab ?? ''), note: String(x.note ?? '') })) : [];
};

/** The group page's HTML (a group saved at this address; none: « page introuvable »). */
export async function groupHtml(ctx: Ctx, slug: string, o: HtmlOpts): Promise<string> {
  const g = (await ctx.db.query('SELECT * FROM landing_groups WHERE slug = $1', [slug]))[0];
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
  for (const it of list) {
    const l = P.get(it.pageId);
    if (!l || (o.mode === 'live' && !l.active)) continue;
    const pc = await productContext(ctx.db, num(l.product_id)).catch(() => null);
    if (!pc || (o.mode === 'live' && !pc.active)) continue;
    shopName = pc.shopName;
    const refs: ImgRef[] = readImgs(l.images).slice(0, 1);
    const image = viewImages(refs, await imageRows(ctx.db, refs, !o.imgBase), o.imgBase)[0] ?? null;
    items.push({
      pageId: it.pageId,
      slug: String(l.slug),
      title: String(l.title || pc.name),
      price: numOrNull(l.price) ?? pc.price,
      oldPrice: numOrNull(l.old_price),
      image,
      soldOut: l.stock_mode === 'hide' && pc.soldOut,
      tab: it.tab,
      note: it.note,
    });
  }
  const s = await landingSettings(ctx.db);
  if (!shopName) shopName = (await getSetting(ctx.db, 'shop')).name;
  const best = items.find((x) => x.pageId === g.best_page_id);
  const url = o.url ?? (o.site ? `${o.site}/${await landingStore(ctx.db, s)}/${g.slug}` : '');
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
      pixelId: o.mode === 'live' ? String(g.pixel_id || s.pixelId || '').trim() : '',
    },
    { mode: o.mode, url: url || undefined },
  );
}

/**
 * A product page opened from a group (?g=<slug>): the group's « back » bar, when that group is online and has this
 * product. On the real page the visit is counted as a click of the group on this product.
 */
export async function groupOf(db: Db, slug: string, pageId: number, live: boolean): Promise<{ slug: string; title: string } | null> {
  if (!/^[a-z0-9-]{2,60}$/.test(slug)) return null;
  const g = (await db.query('SELECT id, slug, title, active, items FROM landing_groups WHERE slug = $1', [slug]))[0];
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
  const orders = await db.query(
    `SELECT utm->>'g' AS g, landing_id, count(*)::int AS n FROM orders WHERE utm ? 'g' AND utm->>'g' = ANY($1) GROUP BY 1, 2`,
    [rows.map((r: any) => r.slug)],
  );
  const allIds = [...new Set(rows.flatMap((r: any) => readItems(r.items).map((x) => x.pageId)))];
  const pages = allIds.length ? await db.query('SELECT id, slug, title, active, images, product_id, (SELECT name FROM products p WHERE p.id = l.product_id) AS pname FROM landing_pages l WHERE id = ANY($1)', [allIds]) : [];
  const firsts = pages.map((p: any) => readImgs(p.images)[0]).filter((x: ImgRef | undefined): x is { id: number } => !!x && 'id' in x);
  const thumbs = firsts.length ? await db.query('SELECT id, t160 FROM landing_images WHERE id = ANY($1)', [firsts.map((x) => x.id)]) : [];
  const T = new Map(thumbs.map((t: any) => [num(t.id), b64(t.t160)]));
  const P = new Map(
    pages.map((p: any) => {
      const f = readImgs(p.images)[0];
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
        orders: num(orders.find((o: any) => o.g === r.slug && num(o.landing_id) === x.pageId)?.n),
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
      views: num(r.views),
      clicks: items.reduce((n, x) => n + x.clicks, 0),
      orders: orders.filter((o: any) => o.g === r.slug).reduce((n: number, o: any) => n + num(o.n), 0),
      items,
      updatedAt: iso(r.updated_at),
    };
  });
}
export type LandingGroupRow = Awaited<ReturnType<typeof listGroups>>[number];

async function checkInput(db: Db, i: GroupIn) {
  if ((await db.query('SELECT 1 FROM landing_pages WHERE slug = $1', [i.slug])).length) throw bad(`L’adresse « ${i.slug} » est déjà prise par une landing page`);
  const dup = (await db.query('SELECT id FROM landing_groups WHERE slug = $1', [i.slug]))[0];
  if (dup && num(dup.id) !== i.id) throw bad(`L’adresse « ${i.slug} » est déjà prise`);
  const ids = i.items.map((x) => x.pageId);
  if (new Set(ids).size !== ids.length) throw bad('Un produit est deux fois dans le groupe');
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
});

export const landingGroupProcs = {
  'landing.groups': proc([...WHO], z.object({}), (ctx) => listGroups(ctx.db)),

  'landing.groupSave': proc([...WHO], GroupInput, async (ctx, i) => {
    await checkInput(ctx.db, i);
    const r = rowOf(i);
    const vals = [r.slug, r.active, r.title, r.subtitle, r.color, r.theme, r.best_page_id, JSON.stringify(r.items), r.pixel_id || null];
    let gid: number;
    if (i.id) {
      const u = await ctx.db.query(
        `UPDATE landing_groups SET slug=$2, active=$3, title=$4, subtitle=$5, color=$6, theme=$7, best_page_id=$8, items=$9, pixel_id=$10, updated_at=now() WHERE id=$1 RETURNING id`,
        [i.id, ...vals],
      );
      if (!u.length) throw notFound('Groupe introuvable');
      gid = i.id;
    } else {
      gid = num(
        (
          await ctx.db.query(
            `INSERT INTO landing_groups (slug, active, title, subtitle, color, theme, best_page_id, items, pixel_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [...vals, ctx.session.profile.id],
          )
        )[0].id,
      );
    }
    return (await listGroups(ctx.db, [gid]))[0];
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
  'landing.groupSlug': proc([...WHO], z.object({ title: z.string().max(200), id: id.optional() }), async (ctx, i) => {
    const base =
      i.title
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'collection';
    for (let n = 1; n < 200; n++) {
      const s = n === 1 ? base : `${base}-${n}`;
      if (s.length < 2) continue;
      const taken =
        (await ctx.db.query('SELECT 1 FROM landing_pages WHERE slug = $1', [s])).length ||
        (await ctx.db.query('SELECT 1 FROM landing_groups WHERE slug = $1 AND id IS DISTINCT FROM $2', [s, i.id ?? null])).length;
      if (!taken) return { slug: s };
    }
    return { slug: `${base}-${Date.now().toString(36)}` };
  }),
};
