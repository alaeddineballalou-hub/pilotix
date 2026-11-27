// Ad sets › Produit, by itself (the owner, 27 Nov 2026: « can the product be linked automatically using the
// destination to landing page to the product so I do not need to do it manually »).
//
// Every Pilote auto run (15 min, ./adsmgr.ts › tagRun) reads the shop's ads with where each one sends people
// (./meta.ts › tagAds). A link to one of the boutique's landing pages gives the ad that page's product (a group page:
// its group). An ad made from an existing post shows no link on its créa (Meta keeps it on the post): it takes the page
// its orders came through. An ad whose link goes elsewhere (Messenger, WhatsApp, another site) is left to a person.
// Then each ad set whose ads' pages are known follows them, whatever was chosen by hand (the owner's choice, 27 Nov
// 2026: « the link wins »): its products are its ads' products, or its group when all of them send to one group page.
// Publicité counts each ad's spend for its own product (./ads.ts › overview, productShares).
//
// Imports only ./pagelinks (and through it ./landingquery): no import cycle with ./ads or ./adsmgr.
import { Db, num } from '../db';
import { Ctx } from '../rpc';
import { pageLinks } from './pagelinks';

/** Where the boutique's pages live: its own domain (https://<domain>/<page>) and the platform's (https://<host>/<store>/<page>). */
export interface ShopAddress {
  /** its own domain, without « www. » (null: none) */
  own: string | null;
  /** the platform's hosts that serve its pages (go.<domain>, <domain>) */
  hosts: string[];
  /** the store's part of the platform's addresses */
  store: string;
}

const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, '');
const hostOf = (u: string | null | undefined): string | null => {
  try {
    return u ? bareHost(new URL(u).hostname) : null;
  } catch {
    return null;
  }
};

export async function shopAddress(ctx: Ctx): Promise<ShopAddress> {
  const l = await pageLinks(ctx);
  const hosts = new Set<string>();
  for (const u of [l.base, ctx.server?.publicUrl, ctx.server?.pagesUrl?.()]) {
    const h = hostOf(u);
    if (!h) continue;
    hosts.add(h);
    // the pages' own door (go.<domain>) and the site itself serve the same pages
    hosts.add(h.startsWith('go.') ? h.slice(3) : `go.${h}`);
  }
  return { own: l.own?.domain ? bareHost(l.own.domain) : null, hosts: [...hosts], store: l.store.toLowerCase() };
}

/** The page's address part (its slug) a link sends people to, when it is one of the boutique's pages; else null. */
export function slugOfLink(link: string | null | undefined, a: ShopAddress): string | null {
  let u: URL;
  try {
    u = new URL(String(link ?? '').trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = bareHost(u.hostname);
  const segs = u.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s).toLowerCase();
      } catch {
        return s.toLowerCase();
      }
    });
  const page = (k: number) => (segs[k] && /^[a-z0-9-]+$/.test(segs[k]) ? segs[k] : null);
  // its own domain: https://<domain>/<page> (the platform's form there too: https://<domain>/<store>/<page>)
  if (a.own && host === a.own) return a.store && segs[0] === a.store && segs.length > 1 ? page(1) : page(0);
  if (a.store && a.hosts.includes(host) && segs[0] === a.store) return page(1);
  return null;
}

/** What one ad sends people to: a product's page or a group's page. */
export interface AdTarget {
  slug: string;
  productId: number | null;
  groupId: number | null;
}

/** The boutique's pages and groups by their address (their former addresses too, still leading to them). */
async function targetsBySlug(db: Db): Promise<Map<string, AdTarget>> {
  const out = new Map<string, AdTarget>();
  const pages = await db.query('SELECT id, slug, product_id FROM landing_pages');
  const pageProduct = new Map<number, number | null>(pages.map((p: any) => [num(p.id), p.product_id === null ? null : num(p.product_id)]));
  for (const p of pages) out.set(String(p.slug).toLowerCase(), { slug: String(p.slug), productId: pageProduct.get(num(p.id)) ?? null, groupId: null });
  for (const g of await db.query('SELECT id, slug FROM landing_groups').catch(() => [] as any[])) out.set(String(g.slug).toLowerCase(), { slug: String(g.slug), productId: null, groupId: num(g.id) });
  for (const f of await db.query('SELECT slug, page_id, group_id FROM landing_old_slugs').catch(() => [] as any[])) {
    const k = String(f.slug).toLowerCase();
    if (out.has(k)) continue;
    if (f.page_id !== null && f.page_id !== undefined) out.set(k, { slug: String(f.slug), productId: pageProduct.get(num(f.page_id)) ?? null, groupId: null });
    else if (f.group_id !== null && f.group_id !== undefined) out.set(k, { slug: String(f.slug), productId: null, groupId: num(f.group_id) });
  }
  return out;
}

/** A group's products: those of the pages it shows (in their order; a page deleted since has left it). */
async function groupProducts(db: Db, groupIds: number[]): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  if (!groupIds.length) return out;
  const rows = await db.query('SELECT id, items FROM landing_groups WHERE id = ANY($1)', [groupIds]);
  const pageIdsOf = (items: unknown): number[] => {
    const list = typeof items === 'string' ? (() => { try { return JSON.parse(items); } catch { return []; } })() : items;
    return (Array.isArray(list) ? list : []).map((x: any) => Number(x?.pageId)).filter((n) => Number.isSafeInteger(n) && n > 0);
  };
  const pageIds = [...new Set(rows.flatMap((r: any) => pageIdsOf(r.items)))];
  const pages = pageIds.length ? await db.query('SELECT id, product_id FROM landing_pages WHERE id = ANY($1)', [pageIds]) : [];
  const productOf = new Map<number, number>(pages.filter((p: any) => p.product_id !== null).map((p: any) => [num(p.id), num(p.product_id)]));
  for (const r of rows) out.set(num(r.id), [...new Set(pageIdsOf(r.items).map((id) => productOf.get(id)).filter((p): p is number => p !== undefined))]);
  return out;
}

/** An ad as Meta gave it: its id, its ad set, and where it sends people (null: an existing post, a message ad…). */
export interface ReadAd {
  id: string;
  adsetId: string;
  name?: string;
  link?: string | null;
}

export interface LinkRun {
  /** ads whose page is known now */
  known: number;
  /** ad sets whose products (or group) changed */
  changed: number;
}

const sameList = (a: number[], b: number[]) => a.length === b.length && a.every((x, k) => x === b[k]);

/**
 * Gives each ad read its page's product (or group), and each of their ad sets its ads' products. `a`: the boutique's
 * addresses (shopAddress; the demo passes its own). The ads Meta no longer gives (deleted, archived) keep what they had.
 */
export async function linkAdsets(db: Db, ads: ReadAd[], a: ShopAddress): Promise<LinkRun> {
  if (!ads.length) return { known: 0, changed: 0 };
  const bySlug = await targetsBySlug(db);
  const fromLink = new Map<string, AdTarget | null>();
  for (const ad of ads) {
    const slug = slugOfLink(ad.link, a);
    fromLink.set(ad.id, slug ? bySlug.get(slug) ?? null : null);
  }
  // an ad with no link on its créa (made from an existing post: Meta keeps the link on the post): the page its orders
  // came through, the one most of them came through (a group's page: its address in utm « g »). An ad whose link goes
  // elsewhere (Messenger, WhatsApp, another site) is not guessed: a person chooses its product.
  const ask = ads.filter((ad) => !String(ad.link ?? '').trim()).map((ad) => ad.id);
  const fromOrders = new Map<string, AdTarget>();
  if (ask.length) {
    const rows = await db.query(
      `SELECT o.utm->>'ad_id' AS ad, l.slug, o.utm->>'g' AS g, count(*)::int AS n
         FROM orders o LEFT JOIN landing_pages l ON l.id = o.landing_id
        WHERE o.utm->>'ad_id' = ANY($1) AND (o.landing_id IS NOT NULL OR o.utm->>'g' IS NOT NULL)
        GROUP BY 1, 2, 3 ORDER BY 4 DESC`,
      [ask],
    );
    for (const r of rows) {
      const ad = String(r.ad);
      if (fromOrders.has(ad)) continue;
      const t = (r.g ? bySlug.get(String(r.g).toLowerCase()) : null) ?? (r.slug ? bySlug.get(String(r.slug).toLowerCase()) : null);
      if (t && (t.productId !== null || t.groupId !== null)) fromOrders.set(ad, t);
    }
  }
  let known = 0;
  // what each ad has now: only the ads whose page changed are written (an ad Pilotix does not know yet is added)
  const before = new Map<string, any>((await db.query('SELECT id, link, link_slug, link_product_id, link_group_id, link_from FROM ads WHERE id = ANY($1)', [ads.map((ad) => ad.id)])).map((r: any) => [String(r.id), r]));
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
  await db.tx(async (tx) => {
    for (const ad of ads) {
      const own = fromLink.get(ad.id) ?? null;
      const t = own ?? fromOrders.get(ad.id) ?? null;
      if (t && (t.productId !== null || t.groupId !== null)) known++;
      const v = [ad.link ? String(ad.link).slice(0, 2000) : null, t?.slug ?? null, t?.productId ?? null, t?.groupId ?? null, t ? (own ? 'ad' : 'orders') : null] as const;
      const b = before.get(ad.id);
      if (b && str(b.link) === v[0] && str(b.link_slug) === v[1] && str(b.link_product_id) === str(v[2]) && str(b.link_group_id) === str(v[3]) && str(b.link_from) === v[4]) continue;
      await tx.query(
        `INSERT INTO ads (id, adset_id, name, link, link_slug, link_product_id, link_group_id, link_from, link_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
         ON CONFLICT (id) DO UPDATE SET link = EXCLUDED.link, link_slug = EXCLUDED.link_slug, link_product_id = EXCLUDED.link_product_id,
           link_group_id = EXCLUDED.link_group_id, link_from = EXCLUDED.link_from, link_at = now()`,
        [ad.id, ad.adsetId, ad.name ?? ad.id, ...v],
      );
    }
  });

  // the ad sets of these ads follow their ads' pages (the ads Meta did not give this time count with what they had)
  const setIds = [...new Set(ads.map((ad) => ad.adsetId).filter(Boolean))];
  if (!setIds.length) return { known, changed: 0 };
  const sets = await db.query('SELECT id, product_ids, group_id, link_auto FROM adsets WHERE id = ANY($1)', [setIds]);
  const kids = await db.query('SELECT adset_id, link_product_id, link_group_id FROM ads WHERE adset_id = ANY($1)', [setIds]);
  const groups = await groupProducts(db, [...new Set(kids.map((k: any) => k.link_group_id).filter((g: unknown) => g !== null && g !== undefined).map(num))]);
  let changed = 0;
  for (const s of sets) {
    const mine = kids.filter((k: any) => String(k.adset_id) === String(s.id));
    const products = [...new Set(mine.map((k: any) => k.link_product_id).filter((p: unknown) => p !== null && p !== undefined).map(num))].sort((x, y) => x - y);
    const groupIds = [...new Set(mine.map((k: any) => k.link_group_id).filter((g: unknown) => g !== null && g !== undefined).map(num))];
    const had = ((s.product_ids ?? []) as unknown[]).map(num).sort((x, y) => x - y);
    const hadGroup = s.group_id === null || s.group_id === undefined ? null : num(s.group_id);
    let next: { productIds: number[]; groupId: number | null } | null = null;
    // only product pages: its products are theirs; only one group's page: that group (and its products)
    if (products.length && !groupIds.length) next = { productIds: products, groupId: null };
    else if (!products.length && groupIds.length === 1) next = { productIds: (groups.get(groupIds[0]) ?? []).slice().sort((x, y) => x - y), groupId: groupIds[0] };
    if (!next) {
      // nothing known (or product and group pages mixed in one ad set): a person chooses, as before
      if (s.link_auto) await db.query('UPDATE adsets SET link_auto = false, updated_at = now() WHERE id = $1', [s.id]);
      continue;
    }
    if (sameList(had, next.productIds) && hadGroup === next.groupId && s.link_auto) continue;
    await db.query('UPDATE adsets SET product_ids = $2, group_id = $3, link_auto = true, updated_at = now() WHERE id = $1', [s.id, next.productIds, next.groupId]);
    if (!sameList(had, next.productIds) || hadGroup !== next.groupId) changed++;
  }
  return { known, changed };
}

/**
 * How one ad set's spend goes to its products: by its ads' spend, each ad to the product of its page (the owner's choice,
 * 27 Nov 2026: « by each ad »). The spend of its ads with no known page (or a page of a product the ad set does not
 * sell) is shared equally between its products, as before; no ad spend known at all: equal parts. The shares add up to 1.
 */
export function productShares(productIds: number[], ads: { productId: number | null; cents: number }[]): Map<number, number> {
  const out = new Map<number, number>();
  if (!productIds.length) return out;
  const total = ads.reduce((s, x) => s + Math.max(0, x.cents), 0);
  if (!total) {
    for (const p of productIds) out.set(p, 1 / productIds.length);
    return out;
  }
  let loose = 0;
  for (const x of ads) {
    const c = Math.max(0, x.cents);
    if (x.productId !== null && productIds.includes(x.productId)) out.set(x.productId, (out.get(x.productId) ?? 0) + c / total);
    else loose += c / total;
  }
  for (const p of productIds) out.set(p, (out.get(p) ?? 0) + loose / productIds.length);
  return out;
}

/** Each ad set's days of ad spend, ad by ad, with the product of each ad's page: `${adsetId}|${day}` → its ads. */
export async function adDaySpend(db: Db, adsetIds: string[], from: string, to: string): Promise<Map<string, { productId: number | null; cents: number }[]>> {
  const out = new Map<string, { productId: number | null; cents: number }[]>();
  if (!adsetIds.length) return out;
  const rows = await db.query(
    `SELECT d.day::text AS dtext, d.adset_id, d.spend_cents, a.link_product_id
       FROM ad_daily d LEFT JOIN ads a ON a.id = d.ad_id
      WHERE d.adset_id = ANY($1) AND d.day BETWEEN $2 AND $3`,
    [adsetIds, from, to],
  );
  for (const r of rows) {
    const k = `${String(r.adset_id)}|${String(r.dtext).slice(0, 10)}`;
    (out.get(k) ?? out.set(k, []).get(k)!).push({ productId: r.link_product_id === null || r.link_product_id === undefined ? null : num(r.link_product_id), cents: num(r.spend_cents) });
  }
  return out;
}
