// Marketing › Influenceurs: ads in two names, the shop's and a creator's (Meta's partnership ads).
//
// The shop adds a creator by their Instagram account: Pilotix asks Meta for the right to run ads in both names
// (instagram_branded_content_ads_brand); the creator says yes in the Instagram app, and the request turns « accepté » at
// the next refresh. A creator's Facebook Page can be added too (its number): Meta asks the creator at the first ad
// (facebook_branded_content_ads_brand). A creator may also give a « code pub » for one post.
//
// Pilotix then shows, for each creator: where the request is, their posts that tag the shop (Meta's Advertisable
// Content API: Instagram and Facebook in one list, ready for an ad or not, with how they did on their own), and what
// their ads brought: the money spent, the orders and the delivered orders — counted with the ads' own ids, which the
// landing pages keep on each order (utm). « Lancer une pub avec lui » opens Publicité › Lancer with the creator as the
// second name (a new ad of the shop: its photo, its words, its sales page), or with one of the creator's posts boosted.
//
// In the demo (no server) nothing leaves Pilotix: the seeded creators, posts and launches show the page.
import { z } from 'zod';
import { Db, isoOrNull, num, numOrNull } from '../db';
import { bad, Ctx, forbidden, notFound, proc } from '../rpc';
import { daySpend, fxTable, isOwner } from './ads';
import { linkedPage } from './social';

const ROLES = ['marketer'] as const;
const me = (ctx: Ctx) => ctx.session.profile.id || null;
/** a marketer partner's person (an agency's): the shop's creators are the shop's business, not theirs */
const agency = (ctx: Ctx) => ctx.session.profile.agencyId !== null && ctx.session.profile.agencyId !== undefined;

export const STATUSES = ['pending', 'approved', 'refused', 'revoked', 'page', 'code'] as const;
export type PartnerStatus = (typeof STATUSES)[number];
/** the creators an ad in both names may use (a refused or removed one may not) */
export const USABLE: readonly PartnerStatus[] = ['approved', 'pending', 'page', 'code'];

// ---------------------------------------------------------------- what the person types
/** « @Amina.Style », « instagram.com/amina.style/ » → « amina.style »; anything else → null. */
export function igUsername(raw: string | null | undefined): string | null {
  let s = String(raw ?? '').trim();
  const m = s.match(/instagram\.com\/([^/?#\s]+)/i);
  if (m) s = m[1];
  s = s.replace(/^@+/, '').replace(/\/+$/, '').toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(s) && !/^\.|\.$|\.\./.test(s) ? s : null;
}
/** A Facebook Page's number: « 1234567890 », « facebook.com/profile.php?id=1234567890 », « …/pages/Nom/1234567890 ». */
export function pageNumber(raw: string | null | undefined): string | null {
  const s = String(raw ?? '').trim();
  const m = s.match(/[?&]id=(\d{5,25})/) ?? s.match(/\/(\d{5,25})\/?(?:[?#].*)?$/) ?? s.match(/^(\d{5,25})$/);
  return m ? m[1] : null;
}
/** A partnership ad code as creators copy it (letters, digits, - and _). */
export const adCodeOk = (s: string) => /^[A-Za-z0-9_-]{6,200}$/.test(s);

// ---------------------------------------------------------------- Meta's answers, made plain
/** Meta's word for an Instagram request → Pilotix's. */
export function statusOf(meta: string | null | undefined): PartnerStatus {
  const s = String(meta ?? '').toUpperCase();
  if (s === 'APPROVED' || s === 'ACCEPTED' || s === 'ACTIVE') return 'approved';
  if (s === 'DECLINED' || s === 'REJECTED' || s === 'DENIED') return 'refused';
  if (s === 'REVOKED' || s === 'EXPIRED' || s === 'REMOVED' || s === 'CANCELED' || s === 'CANCELLED') return 'revoked';
  return 'pending';
}
export interface PermissionRow {
  id: string | null;
  username: string | null;
  igId: string | null;
  pageId: string | null;
  status: PartnerStatus;
}
/** One line of GET /{brand-ig}/branded_content_ad_permissions. */
export function permissionOf(r: any): PermissionRow {
  return {
    id: r?.id ? String(r.id) : null,
    username: igUsername(r?.creator_username),
    igId: r?.creator_id ? String(r.creator_id) : null,
    pageId: r?.creator_fb_page ? String(typeof r.creator_fb_page === 'object' ? (r.creator_fb_page.id ?? '') : r.creator_fb_page) || null : null,
    status: statusOf(r?.permission_status),
  };
}

export interface ContentRow {
  contentId: string;
  platform: 'INSTAGRAM' | 'FACEBOOK';
  mediaType: string | null;
  postType: string | null;
  caption: string;
  permalink: string | null;
  postedOn: string | null;
  author: { name: string; igId: string | null; pageId: string | null; picture: string | null };
  /** AD_READY, NEEDS_ATTENTION, INELIGIBLE, EXCLUDED */
  eligibility: string | null;
  permission: string | null;
  adCode: string | null;
  errors: { code: string; message: string; severity: string }[];
  usage: string | null;
  insights: { likes: number | null; comments: number | null; views: number | null; reach: number | null; shares: number | null; saves: number | null };
}
const ELIGIBILITY_RANK: Record<string, number> = { AD_READY: 0, NEEDS_ATTENTION: 1, INELIGIBLE: 2, EXCLUDED: 3 };
const intOrNull = (v: unknown) => (v === undefined || v === null || v === '' || !isFinite(Number(v)) ? null : Math.round(Number(v)));
/** One item of GET /{business}/partnership-ads-advertisable-content (the best of its partnership lines kept). */
export function contentOf(r: any): ContentRow | null {
  const id = String(r?.content_id ?? r?.id ?? '');
  if (!/^[\w.:-]{3,80}$/.test(id)) return null;
  const infos: any[] = Array.isArray(r?.partnership_info) ? r.partnership_info : r?.partnership_info ? [r.partnership_info] : [];
  const best = [...infos].sort((a, b) => (ELIGIBILITY_RANK[String(a?.ad_eligibility)] ?? 9) - (ELIGIBILITY_RANK[String(b?.ad_eligibility)] ?? 9))[0] ?? {};
  const a = r?.author ?? {};
  const ins = r?.organic_insights ?? {};
  const platform = String(r?.platform ?? '').toUpperCase() === 'FACEBOOK' ? 'FACEBOOK' : 'INSTAGRAM';
  const day = String(r?.creation_time ?? '').slice(0, 10);
  return {
    contentId: id,
    platform,
    mediaType: r?.media_type ? String(r.media_type).toUpperCase() : null,
    postType: r?.post_type ? String(r.post_type).toUpperCase() : null,
    caption: String(r?.caption ?? '').slice(0, 2000),
    permalink: /^https:\/\//.test(String(r?.permalink ?? '')) ? String(r.permalink) : null,
    postedOn: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null,
    author: {
      name: String(a.display_name ?? '').slice(0, 120),
      igId: a.ig_user_id ? String(a.ig_user_id) : null,
      pageId: a.fb_page_id ? String(a.fb_page_id) : null,
      picture: /^https:\/\//.test(String(a.profile_picture_url ?? '')) ? String(a.profile_picture_url) : null,
    },
    eligibility: best.ad_eligibility ? String(best.ad_eligibility).toUpperCase() : null,
    permission: best.permission_status ? String(best.permission_status).toUpperCase() : null,
    adCode: best.ad_code && adCodeOk(String(best.ad_code)) ? String(best.ad_code) : null,
    errors: (Array.isArray(best.eligibility_errors) ? best.eligibility_errors : [])
      .map((e: any) => ({ code: String(e?.code ?? ''), message: String(e?.message ?? '').slice(0, 300), severity: String(e?.severity ?? 'error').toLowerCase() }))
      .slice(0, 5),
    usage: r?.ad_usage ? String(r.ad_usage).toUpperCase() : null,
    insights: { likes: intOrNull(ins.likes), comments: intOrNull(ins.comments), views: intOrNull(ins.views), reach: intOrNull(ins.reach), shares: intOrNull(ins.shares), saves: intOrNull(ins.saves) },
  };
}

// ---------------------------------------------------------------- the shop's Page and Instagram
/** The shop's Facebook Page and Instagram account (the demo: made-up ones, the same as Lancer une pub's). */
export async function brandOf(ctx: Ctx) {
  return (await linkedPage(ctx.db)) ?? (ctx.server ? null : { pageId: '104500000000001', name: 'Bébé Confort DZ', igId: '178400000000001', igUsername: 'bebeconfort.dz', account: '' });
}

// ---------------------------------------------------------------- one creator, as the page shows them
export interface PartnerStats {
  launches: number;
  live: number;
  spendUsd: number;
  orders: number;
  delivered: number;
  /** what the delivered orders were worth (DA) */
  cash: number;
  lastAt: string | null;
}
const zero = (): PartnerStats => ({ launches: 0, live: 0, spendUsd: 0, orders: 0, delivered: 0, cash: 0, lastAt: null });

const partnerView = (r: any, s: PartnerStats, posts: number) => ({
  id: num(r.id),
  igUsername: r.ig_username ? String(r.ig_username) : null,
  igId: r.ig_id ? String(r.ig_id) : null,
  pageId: r.fb_page_id ? String(r.fb_page_id) : null,
  name: String(r.name || (r.ig_username ? `@${r.ig_username}` : (r.fb_page_id ?? ''))),
  picture: r.picture ? String(r.picture) : null,
  status: String(r.status) as PartnerStatus,
  note: String(r.note ?? ''),
  error: r.error ? String(r.error) : null,
  requestedAt: isoOrNull(r.requested_at),
  checkedAt: isoOrNull(r.checked_at),
  usable: (USABLE as readonly string[]).includes(String(r.status)),
  posts,
  ...s,
  spendUsd: Math.round(s.spendUsd * 100) / 100,
  /** what one delivered order cost in ads ($) */
  perDeliveredUsd: s.delivered ? Math.round((s.spendUsd / s.delivered) * 100) / 100 : null,
});
export type PartnerView = ReturnType<typeof partnerView>;

const contentView = (r: any) => ({
  id: String(r.content_id),
  partnerId: numOrNull(r.partner_id),
  platform: String(r.platform) as 'INSTAGRAM' | 'FACEBOOK',
  mediaType: r.media_type ? String(r.media_type) : null,
  postType: r.post_type ? String(r.post_type) : null,
  caption: String(r.caption ?? ''),
  permalink: r.permalink ? String(r.permalink) : null,
  postedOn: r.posted_on ? (r.posted_on instanceof Date ? r.posted_on.toISOString().slice(0, 10) : String(r.posted_on).slice(0, 10)) : null,
  author: { name: String(r.author?.name ?? ''), igId: r.author?.igId ?? null, pageId: r.author?.pageId ?? null, picture: r.author?.picture ?? null },
  eligibility: r.eligibility ? String(r.eligibility) : null,
  permission: r.permission ? String(r.permission) : null,
  hasCode: !!r.ad_code,
  errors: (Array.isArray(r.errors) ? r.errors : []) as { code: string; message: string; severity: string }[],
  usage: r.ad_usage ? String(r.ad_usage) : null,
  insights: (r.insights ?? {}) as ContentRow['insights'],
  thumb: r.thumb ? String(r.thumb) : null,
  /** Meta lets this post become an ad now (an ineligible or excluded one cannot) */
  boostable: r.eligibility !== 'INELIGIBLE' && r.eligibility !== 'EXCLUDED',
});
export type ContentView = ReturnType<typeof contentView>;

/**
 * What each creator's ads brought: the launches made with them (a new ad in both names, or one of their posts boosted),
 * the money those ads spent (dollars: a dinar ad account is counted with its month's rate), and the orders that came
 * from those ads (their ad's or ad set's id on the order), delivered or not. `days`: 0 = since the start.
 */
export async function partnerStats(db: Db, now: number, days: number): Promise<Map<number, PartnerStats>> {
  const out = new Map<number, PartnerStats>();
  const launches = await db.query(`SELECT id, partner_id, status, ad_ids, adset_ids, live_at, created_at FROM ad_launches WHERE partner_id IS NOT NULL`);
  if (!launches.length) return out;
  const since = days ? new Date(now - days * 86_400_000) : null;
  const sinceDay = since ? new Date(since.getTime() + 3_600_000).toISOString().slice(0, 10) : null;
  const adOwner = new Map<string, number>();
  const setOwner = new Map<string, number>();
  for (const l of launches) {
    const p = num(l.partner_id);
    const s = out.get(p) ?? zero();
    s.launches++;
    if (l.status === 'live') s.live++;
    const at = l.live_at ?? l.created_at;
    if (at && (!s.lastAt || new Date(at).toISOString() > s.lastAt)) s.lastAt = new Date(at).toISOString();
    out.set(p, s);
    for (const a of l.ad_ids ?? []) adOwner.set(String(a), p);
    for (const a of l.adset_ids ?? []) setOwner.set(String(a), p);
  }
  const ads = [...adOwner.keys()];
  const sets = [...setOwner.keys()];
  if (ads.length) {
    const fx = await fxTable(db);
    const spend = await db.query(
      `SELECT to_char(d.day, 'YYYY-MM-DD') AS day, d.ad_id, d.spend_cents, s.currency FROM ad_daily d LEFT JOIN adsets s ON s.id = d.adset_id WHERE d.ad_id = ANY($1) AND ($2::date IS NULL OR d.day >= $2)`,
      [ads, sinceDay],
    );
    for (const r of spend) {
      const p = adOwner.get(String(r.ad_id));
      if (p === undefined) continue;
      out.get(p)!.spendUsd += daySpend(fx, String(r.day), num(r.spend_cents), r.currency).spendCents / 100;
    }
  }
  if (ads.length || sets.length) {
    const orders = await db.query(
      `SELECT o.utm->>'ad_id' AS ad, o.utm->>'adset_id' AS adset, count(*)::int AS n,
              count(*) FILTER (WHERE o.follow_status IN ('delivered', 'exchanged'))::int AS d,
              COALESCE(sum(o.total) FILTER (WHERE o.follow_status IN ('delivered', 'exchanged')), 0)::bigint AS cash
       FROM sales o
       WHERE (o.utm->>'ad_id' = ANY($1) OR o.utm->>'adset_id' = ANY($2)) AND o.conf_status <> 'duplicate' AND ($3::timestamptz IS NULL OR o.created_at >= $3)
       GROUP BY 1, 2`,
      [ads, sets, since ? since.toISOString() : null],
    );
    for (const r of orders) {
      const p = adOwner.get(String(r.ad ?? '')) ?? setOwner.get(String(r.adset ?? ''));
      if (p === undefined) continue;
      const s = out.get(p)!;
      s.orders += num(r.n);
      s.delivered += num(r.d);
      s.cash += num(r.cash);
    }
  }
  return out;
}

async function partnerRow(db: Db, id: number) {
  const r = (await db.query(`SELECT * FROM ad_partners WHERE id = $1`, [id]))[0];
  if (!r) throw notFound('Influenceur introuvable');
  return r;
}
/** a creator for a launch (Lancer une pub), or null */
export async function partnerFor(db: Db, id: number): Promise<{ id: number; igId: string | null; pageId: string | null; status: PartnerStatus; name: string } | null> {
  const r = (await db.query(`SELECT * FROM ad_partners WHERE id = $1`, [id]))[0];
  return r ? { id: num(r.id), igId: r.ig_id ? String(r.ig_id) : null, pageId: r.fb_page_id ? String(r.fb_page_id) : null, status: String(r.status) as PartnerStatus, name: partnerView(r, zero(), 0).name } : null;
}
/** a creator's post for a launch (to boost it), or null */
export async function contentFor(db: Db, id: string): Promise<(ContentView & { adCode: string | null }) | null> {
  const r = (await db.query(`SELECT * FROM ad_partner_content WHERE content_id = $1`, [id]))[0];
  return r ? { ...contentView(r), adCode: r.ad_code ? String(r.ad_code) : null } : null;
}
/** the creators Lancer une pub offers (the usable ones first) */
export async function partnerChoices(db: Db) {
  const rows = await db.query(`SELECT * FROM ad_partners WHERE status = ANY($1) ORDER BY (status = 'approved') DESC, lower(name), id`, [USABLE as unknown as string[]]);
  return rows.map((r: any) => {
    const v = partnerView(r, zero(), 0);
    return { id: v.id, name: v.name, igUsername: v.igUsername, pageId: v.pageId, picture: v.picture, status: v.status };
  });
}

async function board(ctx: Ctx, days: number) {
  const brand = await brandOf(ctx);
  const stats = await partnerStats(ctx.db, ctx.now(), days);
  const rows = await ctx.db.query(`SELECT * FROM ad_partners ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'code' THEN 1 WHEN 'page' THEN 2 WHEN 'pending' THEN 3 ELSE 4 END, lower(name), id`);
  const posts = new Map<number, number>(
    (await ctx.db.query(`SELECT partner_id, count(*)::int AS n FROM ad_partner_content WHERE partner_id IS NOT NULL GROUP BY partner_id`)).map((r: any) => [num(r.partner_id), num(r.n)]),
  );
  const partners = rows.map((r: any) => partnerView(r, stats.get(num(r.id)) ?? zero(), posts.get(num(r.id)) ?? 0));
  const content = (await ctx.db.query(`SELECT * FROM ad_partner_content ORDER BY posted_on DESC NULLS LAST, seen_at DESC, content_id LIMIT 120`)).map(contentView);
  const totals = partners.reduce((t, p) => ({ spendUsd: t.spendUsd + p.spendUsd, orders: t.orders + p.orders, delivered: t.delivered + p.delivered, cash: t.cash + p.cash, launches: t.launches + p.launches }), {
    spendUsd: 0,
    orders: 0,
    delivered: 0,
    cash: 0,
    launches: 0,
  });
  const checked = (await ctx.db.query(`SELECT max(checked_at) AS at FROM ad_partners`))[0]?.at;
  const s = await settingsOf(ctx.db);
  return {
    demo: !ctx.server,
    owner: isOwner(ctx),
    /** an agency's person sees the creators and launches with them, but does not add or remove one */
    manage: !agency(ctx),
    days,
    brand: brand ? { pageId: brand.pageId, name: brand.name, igId: brand.igId, igUsername: brand.igUsername } : null,
    checkedAt: isoOrNull(checked) ?? s.at,
    syncError: s.error,
    partners,
    totals: {
      ...totals,
      spendUsd: Math.round(totals.spendUsd * 100) / 100,
      perDeliveredUsd: totals.delivered ? Math.round((totals.spendUsd / totals.delivered) * 100) / 100 : null,
      approved: partners.filter((p) => p.status === 'approved').length,
      waiting: partners.filter((p) => p.status === 'pending').length,
    },
    content,
  };
}

// ---------------------------------------------------------------- the last refresh (when, Meta's error)
const SETTINGS_KEY = 'partners';
async function settingsOf(db: Db): Promise<{ at: string | null; error: string | null }> {
  const v = (await db.query(`SELECT value FROM settings WHERE key = $1`, [SETTINGS_KEY]))[0]?.value;
  return { at: v?.at ?? null, error: v?.error ?? null };
}
async function saveSettings(db: Db, v: { at: string | null; error: string | null }) {
  await db.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [SETTINGS_KEY, JSON.stringify(v)]);
}

/** Keeps a creator's post (Meta's answer), tied to the creator it belongs to when the shop knows them. */
async function keepContent(db: Db, c: ContentRow, thumb: string | null = null): Promise<number | null> {
  const owner = (
    await db.query(`SELECT id FROM ad_partners WHERE ($1::text IS NOT NULL AND ig_id = $1) OR ($2::text IS NOT NULL AND fb_page_id = $2) OR ($3::text <> '' AND lower(ig_username) = lower($3)) ORDER BY id LIMIT 1`, [
      c.author.igId,
      c.author.pageId,
      c.platform === 'INSTAGRAM' ? c.author.name.replace(/^@/, '') : '',
    ])
  )[0];
  const partnerId = owner ? num(owner.id) : null;
  await db.query(
    `INSERT INTO ad_partner_content (content_id, partner_id, platform, media_type, post_type, caption, permalink, author, posted_on, eligibility, permission, ad_code, errors, ad_usage, insights, thumb, seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
     ON CONFLICT (content_id) DO UPDATE SET partner_id = COALESCE(EXCLUDED.partner_id, ad_partner_content.partner_id), media_type = EXCLUDED.media_type, post_type = EXCLUDED.post_type,
       caption = EXCLUDED.caption, permalink = EXCLUDED.permalink, author = EXCLUDED.author, posted_on = EXCLUDED.posted_on, eligibility = EXCLUDED.eligibility, permission = EXCLUDED.permission,
       ad_code = COALESCE(EXCLUDED.ad_code, ad_partner_content.ad_code), errors = EXCLUDED.errors, ad_usage = EXCLUDED.ad_usage, insights = EXCLUDED.insights,
       thumb = COALESCE(EXCLUDED.thumb, ad_partner_content.thumb), seen_at = now()`,
    [
      c.contentId,
      partnerId,
      c.platform,
      c.mediaType,
      c.postType,
      c.caption,
      c.permalink,
      JSON.stringify(c.author),
      c.postedOn,
      c.eligibility,
      c.permission,
      c.adCode,
      JSON.stringify(c.errors),
      c.usage,
      JSON.stringify(c.insights),
      thumb,
    ],
  );
  // what Meta knows of the creator fills what the shop typed (their Instagram number, their Page, their picture)
  if (partnerId)
    await db
      .query(
        `UPDATE ad_partners SET ig_id = COALESCE(ig_id, $2), fb_page_id = COALESCE(fb_page_id, $3), picture = COALESCE($4, picture), name = CASE WHEN name = '' THEN $5 ELSE name END, updated_at = now() WHERE id = $1`,
        [partnerId, c.author.igId, c.platform === 'FACEBOOK' ? c.author.pageId : null, c.author.picture, c.author.name],
      )
      .catch(() => null);
  return partnerId;
}

/**
 * « Actualiser »: where each Instagram request is (Meta's list for the shop's account), and the creators' posts that
 * tag the shop (Instagram and Facebook together). A Meta error is kept and shown; it never erases what Pilotix knew.
 */
async function refresh(ctx: Ctx) {
  if (!ctx.server) {
    await ctx.db.query(`UPDATE ad_partners SET checked_at = now() WHERE status <> 'revoked'`);
    await saveSettings(ctx.db, { at: new Date(ctx.now()).toISOString(), error: null });
    return { ok: true, permissions: 0, posts: 0, error: null as string | null };
  }
  const brand = await brandOf(ctx);
  if (!brand) throw bad('Reliez la Page Facebook de la boutique (Pilot AI › Comptes).');
  const r = (await ctx.server.meta('partnerSync', { igId: brand.igId, pageId: brand.pageId }, ctx)) as { permissions: any[]; content: any[]; errors: string[] };
  const perms = (r.permissions ?? []).map(permissionOf);
  for (const p of perms) {
    const row = (await ctx.db.query(`SELECT id, status FROM ad_partners WHERE ($1::text IS NOT NULL AND ig_id = $1) OR ($2::text IS NOT NULL AND lower(ig_username) = $2) ORDER BY id LIMIT 1`, [p.igId, p.username]))[0];
    if (row)
      await ctx.db.query(
        `UPDATE ad_partners SET status = CASE WHEN status = 'revoked' AND $2 <> 'approved' THEN status ELSE $2 END, ig_id = COALESCE($3, ig_id), ig_username = COALESCE(ig_username, $4), fb_page_id = COALESCE(fb_page_id, $5),
           permission_id = COALESCE($6, permission_id), error = NULL, checked_at = now(), updated_at = now() WHERE id = $1`,
        [row.id, p.status, p.igId, p.username, p.pageId, p.id],
      );
    // a request the shop made elsewhere (Meta Business Suite) joins the list
    else if (p.username && p.status !== 'revoked')
      await ctx.db.query(`INSERT INTO ad_partners (ig_username, ig_id, fb_page_id, name, status, permission_id, requested_at, checked_at) VALUES ($1,$2,$3,$4,$5,$6,now(),now()) ON CONFLICT DO NOTHING`, [
        p.username,
        p.igId,
        p.pageId,
        `@${p.username}`,
        p.status,
        p.id,
      ]);
  }
  let posts = 0;
  for (const raw of r.content ?? []) {
    const c = contentOf(raw);
    if (!c) continue;
    await keepContent(ctx.db, c);
    posts++;
  }
  await ctx.db.query(`UPDATE ad_partners SET checked_at = now() WHERE status <> 'revoked'`);
  const error = (r.errors ?? []).filter(Boolean).join(' · ').slice(0, 500) || null;
  await saveSettings(ctx.db, { at: new Date(ctx.now()).toISOString(), error });
  return { ok: true, permissions: perms.length, posts, error };
}

const AddIn = z.object({
  ig: z.string().trim().max(120).nullable().default(null),
  page: z.string().trim().max(300).nullable().default(null),
  name: z.string().trim().max(120).default(''),
  note: z.string().trim().max(300).default(''),
});
/**
 * « Ajouter un influenceur »: by their Instagram (Pilotix asks Meta at once; the creator says yes in the Instagram app)
 * and / or their Facebook Page's number (Meta asks the creator at the first ad).
 */
async function add(ctx: Ctx, i: z.infer<typeof AddIn>, again = false) {
  if (agency(ctx)) throw forbidden('Seule la boutique ajoute ses influenceurs.');
  const ig = i.ig ? igUsername(i.ig) : null;
  const page = i.page ? pageNumber(i.page) : null;
  if (i.ig && !ig) throw bad('Ce nom Instagram n’est pas valable : écrivez-le comme dans Instagram (lettres, chiffres, points, _).');
  if (i.page && !page) throw bad('Collez le numéro de la Page Facebook (des chiffres), ou son lien « profile.php?id=… ».');
  if (!ig && !page) throw bad('Donnez son Instagram ou le numéro de sa Page Facebook.');
  const brand = await brandOf(ctx);
  if (ig && !brand?.igId) throw bad('Reliez d’abord le compte Instagram de la boutique (Pilot AI › Comptes) : la demande part de lui.');
  if (ig && brand?.igUsername && ig === brand.igUsername.toLowerCase()) throw bad('C’est le compte Instagram de la boutique.');
  if (page && page === brand?.pageId) throw bad('C’est la Page de la boutique.');
  const seen = (await ctx.db.query(`SELECT * FROM ad_partners WHERE ($1::text IS NOT NULL AND lower(ig_username) = $1) OR ($2::text IS NOT NULL AND fb_page_id = $2) ORDER BY id LIMIT 1`, [ig, page]))[0];
  if (seen && !again && seen.status !== 'revoked' && seen.status !== 'refused' && !(ig && !seen.ig_username) && !(page && !seen.fb_page_id)) throw bad('Cet influenceur est déjà dans la liste.');
  // Instagram: the request goes now (a request already there is kept by Meta)
  let permissionId: string | null = null;
  if (ig && ctx.server) permissionId = String(((await ctx.server.meta('partnerRequest', { igId: brand!.igId, username: ig }, ctx)) as { id?: string })?.id ?? '') || null;
  const status: PartnerStatus = ig ? 'pending' : 'page';
  const name = i.name || (ig ? `@${ig}` : '');
  if (seen) {
    await ctx.db.query(
      `UPDATE ad_partners SET ig_username = COALESCE($2, ig_username), fb_page_id = COALESCE($3, fb_page_id), name = CASE WHEN $4 <> '' THEN $4 ELSE name END, note = CASE WHEN $5 <> '' THEN $5 ELSE note END,
         status = CASE WHEN $2::text IS NOT NULL OR status IN ('revoked', 'refused') THEN $6 ELSE status END, permission_id = COALESCE($7, permission_id), error = NULL,
         requested_by = $8, requested_at = CASE WHEN $2::text IS NOT NULL THEN now() ELSE requested_at END, updated_at = now() WHERE id = $1`,
      [seen.id, ig, page, i.name, i.note, status, permissionId, me(ctx)],
    );
    return { id: num(seen.id), status };
  }
  const r = (
    await ctx.db.query(
      `INSERT INTO ad_partners (ig_username, fb_page_id, name, note, status, permission_id, requested_by, requested_at) VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $1::text IS NOT NULL THEN now() END) RETURNING id`,
      [ig, page, name, i.note, status, permissionId, me(ctx)],
    )
  )[0];
  return { id: num(r.id), status };
}

/**
 * « Code pub » or a post's link: Meta's answer for that one post (direct lookup) is kept; its creator joins the list
 * (a code carries the creator's yes for that post).
 */
async function lookup(ctx: Ctx, i: { code: string | null; link: string | null }) {
  if (agency(ctx)) throw forbidden('Seule la boutique ajoute ses influenceurs.');
  const code = i.code?.trim() || null;
  const link = i.link?.trim() || null;
  if (code && !adCodeOk(code)) throw bad('Ce code pub n’est pas valable : copiez-le tel que l’influenceur l’a donné.');
  if (link && !/^https:\/\/(www\.)?(instagram\.com|facebook\.com|fb\.watch)\//i.test(link)) throw bad('Collez le lien Instagram ou Facebook de la publication.');
  if (!code && !link) throw bad('Collez un code pub ou le lien d’une publication.');
  let rows: ContentRow[];
  if (ctx.server) {
    const brand = await brandOf(ctx);
    if (!brand) throw bad('Reliez la Page Facebook de la boutique (Pilot AI › Comptes).');
    const r = (await ctx.server.meta('partnerLookup', { igId: brand.igId, pageId: brand.pageId, adCode: code, permalink: link }, ctx)) as { content: any[] };
    rows = (r.content ?? []).map(contentOf).filter((x): x is ContentRow => !!x);
  } else rows = [demoLookup(ctx, code, link)];
  if (!rows.length) throw bad('Meta ne trouve pas cette publication pour votre boutique : vérifiez le code ou le lien.');
  const out: string[] = [];
  for (const c of rows) {
    if (code && !c.adCode) c.adCode = code;
    let partnerId = await keepContent(ctx.db, c, ctx.server ? null : demoThumb(c.contentId));
    if (!partnerId) {
      const ig = c.platform === 'INSTAGRAM' ? igUsername(c.author.name) : null;
      const made = (
        await ctx.db.query(`INSERT INTO ad_partners (ig_username, ig_id, fb_page_id, name, picture, status, requested_by, checked_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT DO NOTHING RETURNING id`, [
          ig,
          c.author.igId,
          c.platform === 'FACEBOOK' ? c.author.pageId : null,
          c.author.name || (ig ? `@${ig}` : 'Créateur'),
          c.author.picture,
          code ? 'code' : c.platform === 'FACEBOOK' ? 'page' : 'pending',
          me(ctx),
        ])
      )[0];
      partnerId = made ? num(made.id) : null;
      if (partnerId) await ctx.db.query(`UPDATE ad_partner_content SET partner_id = $2 WHERE content_id = $1`, [c.contentId, partnerId]);
    }
    out.push(c.contentId);
  }
  return { ids: out };
}

/** « Retirer »: the right to run ads in their name ends (Meta is told for Instagram); kept in the list while ads used it. */
async function revoke(ctx: Ctx, id: number, drop: boolean) {
  if (agency(ctx)) throw forbidden('Seule la boutique retire ses influenceurs.');
  const r = await partnerRow(ctx.db, id);
  const brand = await brandOf(ctx);
  if (ctx.server && (r.ig_id || r.ig_username) && ['approved', 'pending'].includes(String(r.status)) && brand?.igId)
    await ctx.server.meta('partnerRevoke', { igId: brand.igId, creatorId: r.ig_id ? String(r.ig_id) : null, username: r.ig_username ? String(r.ig_username) : null }, ctx);
  const used = num((await ctx.db.query(`SELECT count(*)::int AS n FROM ad_launches WHERE partner_id = $1`, [id]))[0]?.n);
  if (drop && !used) {
    await ctx.db.query(`DELETE FROM ad_partners WHERE id = $1`, [id]);
    return { removed: true };
  }
  await ctx.db.query(`UPDATE ad_partners SET status = 'revoked', updated_at = now() WHERE id = $1`, [id]);
  return { removed: false };
}

// ---------------------------------------------------------------- the demo (no Meta)
/** a post found by its code in the demo: a reel of a creator the shop does not know yet */
function demoLookup(ctx: Ctx, code: string | null, link: string | null): ContentRow {
  const key = (code ?? link ?? 'x').replace(/[^A-Za-z0-9]/g, '').slice(-8) || 'demo';
  const day = new Date(ctx.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  return {
    contentId: `1790000${String(Math.abs([...key].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7)) % 1e9).padStart(9, '0')}`,
    platform: 'INSTAGRAM',
    mediaType: 'VIDEO',
    postType: 'REEL',
    caption: 'جربت الطقم تاع @bebeconfort.dz و عجبني بزاف 😍 القماش رطب و التوصيل كان سريع',
    permalink: link && /instagram\.com/.test(link) ? link : null,
    postedOn: day,
    author: { name: 'lina.maman.dz', igId: '178419900000077', pageId: null, picture: null },
    eligibility: 'AD_READY',
    permission: code ? 'APPROVED' : 'PENDING',
    adCode: code,
    errors: [],
    usage: 'NEVER_USED',
    insights: { likes: 1840, comments: 96, views: 41200, reach: 30500, shares: 57, saves: 210 },
  };
}
/** the demo's posts are drawings (the server shows the creator's picture and the post's link) */
export function demoThumb(seed: string): string {
  const hues = [18, 32, 345, 200, 160, 280];
  const h = hues[[...seed].reduce((a, c) => a + c.charCodeAt(0), 0) % hues.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 150"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},70%,86%)"/><stop offset="1" stop-color="hsl(${(h + 30) % 360},65%,72%)"/></linearGradient></defs><rect width="120" height="150" fill="url(#g)"/><circle cx="60" cy="58" r="22" fill="hsl(${h},45%,96%)" opacity=".9"/><rect x="34" y="86" width="52" height="40" rx="12" fill="hsl(${h},45%,96%)" opacity=".85"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// ---------------------------------------------------------------- the actions
const Id = z.number().int().positive();
export const partnersProcs = {
  /** the creators, what their ads brought (`days`: 0 = since the start), their posts that tag the shop */
  'partners.board': proc([...ROLES], z.object({ days: z.union([z.literal(0), z.literal(7), z.literal(30), z.literal(90)]).default(30) }), (ctx, i) => board(ctx, i.days)),
  'partners.refresh': proc([...ROLES], z.object({}), (ctx) => refresh(ctx)),
  'partners.add': proc([...ROLES], AddIn, (ctx, i) => add(ctx, i)),
  'partners.lookup': proc([...ROLES], z.object({ code: z.string().max(200).nullable().default(null), link: z.string().max(500).nullable().default(null) }), (ctx, i) => lookup(ctx, i)),
  'partners.note': proc([...ROLES], z.object({ id: Id, note: z.string().trim().max(300) }), async (ctx, i) => {
    await partnerRow(ctx.db, i.id);
    await ctx.db.query(`UPDATE ad_partners SET note = $2, updated_at = now() WHERE id = $1`, [i.id, i.note]);
    return { ok: true };
  }),
  /** asks again (a request refused, removed, or that the creator did not see) */
  'partners.ask': proc([...ROLES], z.object({ id: Id }), async (ctx, i) => {
    const r = await partnerRow(ctx.db, i.id);
    if (!r.ig_username) throw bad('Cet influenceur n’a pas de compte Instagram dans la liste.');
    return add(ctx, { ig: String(r.ig_username), page: null, name: '', note: '' }, true);
  }),
  'partners.revoke': proc([...ROLES], z.object({ id: Id, remove: z.boolean().default(false) }), (ctx, i) => revoke(ctx, i.id, i.remove)),
};
