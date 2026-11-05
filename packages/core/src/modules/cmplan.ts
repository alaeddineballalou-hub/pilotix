// AI social media manager › Calendar: posts planned on a calendar. A person picks the photos or the video (always at the highest
// quality: the photos as big as Instagram keeps them, the video's original file), the networks (the shop's Facebook Page,
// its Instagram account), the product the post sells and the time; the AI writes the caption (Darija, French or Arabic)
// from the product and an idea; Pilotix posts it at that time (the 'cm-plan' job calls cm.plan.run every minute) or at
// once. A post that went out can be deleted on both networks, and its Facebook text changed (Instagram lets no app change
// a posted caption). Each post that goes out is added to cm_posts with its product, so CM AI answers its comments about
// the right product.
// On the server the networks are reached through ctx.server.dellal ('planPublish', 'planDelete', 'planEdit'); in the
// preview (no server) going out is only recorded, so the whole flow can be tried there.
// A post is a feed post (photos, a carousel, a video) or a story (one photo or one video, 24 hours, no caption); a feed
// post may get its first comment right after it goes out. When the shop asks for it (Réglages), a marketer's post waits
// for the administrator's yes ('review') before it is planned. The rest of the manager (results, « Fill my week »,
// « Post again », moving a post, the settings) is in ./cmsocial.ts.
import { SCORE_KEYS, ScoreKey, Slot } from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, isoOrNull, num, numOrNull } from '../db';
import { bad, Ctx, notFound, proc, publicApi } from '../rpc';
import { getRaw } from './admin';
import { cmSettings } from './cm';
import { AiResponse, aiKeyed, Complete, dellalSettings, PILOT_CHEAP_MODEL, pilotOn } from './dellal';
import { guideText, readGuide } from './guide';
import { linkedPage } from './social';

export const PLAN_CHANNELS = ['facebook', 'instagram'] as const;
export type PlanChannel = (typeof PLAN_CHANNELS)[number];
export const PLAN_STATUSES = ['draft', 'review', 'scheduled', 'publishing', 'published', 'failed'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export const PLAN_LANGS = ['darija', 'fr', 'ar'] as const;
export type PlanLang = (typeof PLAN_LANGS)[number];
export const PLAN_KINDS = ['post', 'story'] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];
/** Meta's limits (Instagram's are the smaller ones), the photos of one post, a video (an Instagram Reel's) */
export const PLAN_LIMITS = { photos: 10, igCaption: 2200, fbCaption: 5000, hashtags: 30, mentions: 20, videoBytes: 300 * 1024 * 1024, videoMin: 3, videoMax: 15 * 60, storyVideoMax: 60, firstComment: 500 } as const;
/** a video is sent in pieces of this size (under Cloudflare's 100 MB per request, quick to send again on a weak line) */
export const VIDEO_CHUNK = 8 * 1024 * 1024;
export const VIDEO_TYPES = ['video/mp4', 'video/quicktime'] as const;
const extOf = (mime: string | null | undefined) => (mime === 'video/quicktime' ? 'mov' : 'mp4');

/** who plans posts (an admin always can) */
export const PLAN_ROLES = ['marketer'] as const;
const id = z.number().int().positive();
export const B64 = (max: number) => z.string().max(max).regex(/^[A-Za-z0-9+/=]+$/, 'Photo invalide');
export const me = (ctx: Ctx) => ctx.session.profile.id;
export const stamp = (ctx: Ctx) => new Date(ctx.now()).toISOString();
/** the demo's Page and Instagram account (the same ids as the demo comments, seeds/cm.ts) */
const DEMO = { page: '1029384756', ig: '17841400000000001' };

// ---------------------------------------------------------------- rules
export const hashtagCount = (s: string) => (s.match(/(^|[^\p{L}\p{N}_&])#[\p{L}\p{N}_]+/gu) ?? []).length;
export const mentionCount = (s: string) => (s.match(/(^|[^\p{L}\p{N}_])@[\p{L}\p{N}_.]+/gu) ?? []).length;

/** What stops a post from going out (empty: it can go), in the words the person reads. */
export function planProblems(p: { caption: string; photos: number; videos?: number; videoReady?: boolean; channels: readonly string[]; kind?: PlanKind; duration?: number | null; tall?: number }): string[] {
  const out: string[] = [];
  const videos = p.videos ?? 0;
  if (!p.channels.length) out.push('Choisissez Facebook, Instagram ou les deux.');
  if (p.kind === 'story') {
    // a story is its picture: one photo or one video, no caption
    if (p.photos + videos !== 1) out.push('Une story a une seule photo ou une seule vidéo.');
    if (videos && p.videoReady === false) out.push('La vidéo n’est pas encore arrivée entière : attendez la fin de l’envoi.');
    if (videos && (p.duration ?? 0) > PLAN_LIMITS.storyVideoMax) out.push(`Story : ${PLAN_LIMITS.storyVideoMax} secondes de vidéo au plus.`);
    return out;
  }
  if (!p.caption.trim() && !p.photos && !videos) out.push('Ajoutez une photo, une vidéo ou un texte.');
  if (videos && p.photos) out.push('Un post a des photos ou une vidéo, pas les deux.');
  if (videos > 1) out.push('Une seule vidéo par post.');
  if (videos && p.videoReady === false) out.push('La vidéo n’est pas encore arrivée entière : attendez la fin de l’envoi.');
  if (p.photos > PLAN_LIMITS.photos) out.push(`${PLAN_LIMITS.photos} photos au plus.`);
  if (p.caption.length > PLAN_LIMITS.fbCaption) out.push(`Texte trop long : ${PLAN_LIMITS.fbCaption} caractères au plus.`);
  if (p.channels.includes('instagram')) {
    if (!p.photos && !videos) out.push('Instagram : ajoutez une photo ou une vidéo.');
    if (p.tall) out.push('Instagram : une photo est trop haute pour un post (4:5 au plus). Faites-en une story, ou changez la photo.');
    if (p.caption.length > PLAN_LIMITS.igCaption) out.push(`Instagram : ${PLAN_LIMITS.igCaption} caractères au plus (le texte en a ${p.caption.length}).`);
    const tags = hashtagCount(p.caption);
    if (tags > PLAN_LIMITS.hashtags) out.push(`Instagram : ${PLAN_LIMITS.hashtags} hashtags au plus (le texte en a ${tags}).`);
    if (mentionCount(p.caption) > PLAN_LIMITS.mentions) out.push(`Instagram : ${PLAN_LIMITS.mentions} mentions @ au plus.`);
  }
  return out;
}

// ---------------------------------------------------------------- the manager's settings (Réglages, key 'social')
export interface SocialSettings {
  /** the fixed posting times (« every day at 20:00 »): « Fill my week » and « Next free time » use them */
  slots: Slot[];
  /** a marketer's post waits for the administrator's yes before it is planned */
  approval: boolean;
  /** the first comment a feed post gets right after it goes out (the editor starts with it) */
  firstComment: { on: boolean; text: string };
}
export const DEFAULT_SOCIAL: SocialSettings = { slots: [{ days: [0, 1, 2, 3, 4, 5, 6], time: '20:00' }], approval: false, firstComment: { on: true, text: '📩 Écrivez « prix » en commentaire, on vous répond en message 👇' } };

export async function socialSettings(db: Db): Promise<SocialSettings> {
  const raw = await getRaw<Partial<SocialSettings>>(db, 'social', {});
  return { ...DEFAULT_SOCIAL, ...raw, firstComment: { ...DEFAULT_SOCIAL.firstComment, ...(raw.firstComment ?? {}) }, slots: Array.isArray(raw.slots) ? raw.slots : DEFAULT_SOCIAL.slots };
}

/** A marketer's post needs the administrator's yes (the shop asked for it). */
export const needsYes = async (ctx: Ctx) => !ctx.session.isAdmin && (await socialSettings(ctx.db)).approval;

// ---------------------------------------------------------------- the shop's accounts
export interface PlanAccounts {
  facebook: { id: string; name: string } | null;
  instagram: { id: string; username: string } | null;
  /** the preview without a linked Page: the demo's names */
  demo: boolean;
}

/** The Page and the Instagram account the shop posts on (Pilot AI › Comptes writes them where Dellal reads them). */
export async function planAccounts(ctx: Ctx): Promise<PlanAccounts> {
  const lp = await linkedPage(ctx.db);
  const ds = await dellalSettings(ctx.db);
  const pageId = ds.messengerPageId || lp?.pageId || '';
  const igId = ds.instagramId || lp?.igId || '';
  if (!pageId && !igId && !ctx.server?.dellal) return { facebook: { id: DEMO.page, name: 'Bébé Confort DZ' }, instagram: { id: DEMO.ig, username: 'bebeconfort.dz' }, demo: true };
  return { facebook: pageId ? { id: pageId, name: lp?.name || '' } : null, instagram: igId ? { id: igId, username: lp?.igUsername || '' } : null, demo: false };
}

// ---------------------------------------------------------------- photos
export interface MediaRow {
  id: number;
  key: string;
  kind: 'photo' | 'video';
  mime: string | null;
  duration: number | null;
  /** a video sent whole (a photo always is) */
  ready: boolean;
  w: number;
  h: number;
  hasJpeg: boolean;
  hasThumb: boolean;
  /** the small copy itself, read only in the preview (on the server the browser loads it from its address) */
  thumb: string | null;
  src: string | null;
}

export async function mediaOf(ctx: Ctx, ids: number[]): Promise<MediaRow[]> {
  if (!ids.length) return [];
  const inline = !ctx.server;
  const rows = await ctx.db.query(
    `SELECT id, key, kind, mime, duration, ready, w, h, jpeg IS NOT NULL AS has_jpeg, thumb IS NOT NULL AS has_thumb, ${inline ? 'thumb' : 'NULL::text AS thumb'}, src FROM cm_media WHERE id = ANY($1)`,
    [ids],
  );
  const by = new Map(rows.map((r: any) => [num(r.id), r]));
  return ids.flatMap((x) => {
    const r: any = by.get(x);
    return r
      ? [
          {
            id: num(r.id),
            key: String(r.key),
            kind: r.kind === 'video' ? ('video' as const) : ('photo' as const),
            mime: (r.mime as string | null) ?? null,
            duration: r.duration === null || r.duration === undefined ? null : Number(r.duration),
            ready: r.ready !== false,
            w: num(r.w),
            h: num(r.h),
            hasJpeg: !!r.has_jpeg,
            hasThumb: !!r.has_thumb,
            thumb: (r.thumb as string | null) ?? null,
            src: (r.src as string | null) ?? null,
          },
        ]
      : [];
  });
}

/** Where a photo is: Pilotix's public address on the server (Meta downloads it from there), the photo itself in the preview. */
export function photoUrl(ctx: Ctx, m: MediaRow, small: boolean): string | null {
  const api = ctx.server ? publicApi(ctx) : '';
  if (small) {
    if (m.hasThumb && api) return `${api}/lp/pic/${m.id}/${m.key}-s.jpg`;
    if (m.thumb) return `data:image/jpeg;base64,${m.thumb}`;
    return m.src;
  }
  if (m.kind === 'video') return m.ready && api ? `${api}/lp/vid/${m.id}/${m.key}.${extOf(m.mime)}` : null;
  if (m.hasJpeg && api) return `${api}/lp/pic/${m.id}/${m.key}.jpg`;
  return m.src;
}

/** A photo or video as the editor shows it. */
export const mediaView = (ctx: Ctx, m: MediaRow) => ({ id: m.id, kind: m.kind, w: m.w, h: m.h, url: photoUrl(ctx, m, true), video: m.kind === 'video' ? photoUrl(ctx, m, false) : null, duration: m.duration, ready: m.ready });

const randomKey = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------- reading
export async function getRow(db: Db, pid: number): Promise<any> {
  const r = (await db.query(`SELECT p.*, pr.name AS product_name FROM cm_planned p LEFT JOIN products pr ON pr.id = p.product_id WHERE p.id = $1`, [pid]))[0];
  if (!r) throw notFound('Post introuvable');
  return r;
}

export function toPlanned(ctx: Ctx, r: any, media: MediaRow[]) {
  const chans = PLAN_CHANNELS.filter((c) => ((r.channels ?? []) as string[]).includes(c));
  const net = (on: boolean, ext: unknown, url: unknown, error: unknown) => (on ? { done: !!ext, url: (url as string | null) ?? null, error: (error as string | null) ?? null } : null);
  return {
    id: num(r.id),
    caption: String(r.caption ?? ''),
    channels: chans as PlanChannel[],
    status: r.status as PlanStatus,
    publishAt: isoOrNull(r.publish_at),
    publishedAt: isoOrNull(r.published_at),
    productId: numOrNull(r.product_id),
    productName: (r.product_name as string | null) ?? null,
    /** its photos, or its one video */
    photos: media.map((m) => mediaView(ctx, m)),
    facebook: net(chans.includes('facebook'), r.fb_id, r.fb_url, r.fb_error),
    instagram: net(chans.includes('instagram'), r.ig_id, r.ig_url, r.ig_error),
    aiLang: (r.ai_lang as PlanLang | null) ?? null,
    kind: (r.kind === 'story' ? 'story' : 'post') as PlanKind,
    /** the first comment, and where it went out */
    firstComment: (r.first_comment as string | null) ?? null,
    comment: r.first_comment ? { facebook: !!r.fb_comment_id, instagram: !!r.ig_comment_id, error: (r.comment_error as string | null) ?? null } : null,
    /** the administrator's word when the post came back to its writer */
    reviewNote: (r.review_note as string | null) ?? null,
    approvedAt: isoOrNull(r.approved_at),
    againOf: numOrNull(r.again_of),
    eventKey: (r.event_key as string | null) ?? null,
    createdBy: numOrNull(r.created_by),
    updatedAt: iso(r.updated_at),
  };
}
export type Planned = ReturnType<typeof toPlanned>;

/** One post as the editor shows it, with what it did when it went out. */
export async function planned(ctx: Ctx, pid: number): Promise<Planned & { results: PostResult | null }> {
  const r = await getRow(ctx.db, pid);
  const results = r.fb_id || r.ig_id ? ((await postResults(ctx.db, [pid])).get(pid) ?? null) : null;
  return { ...toPlanned(ctx, r, await mediaOf(ctx, ((r.media ?? []) as unknown[]).map(num))), results };
}

// ---------------------------------------------------------------- what a post did
export interface PostResult {
  views: number;
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  /** Meta gave its numbers for it (else likes and comments only, or nothing yet) */
  insights: boolean;
  /** its comments in CM AI agent, the conversations they opened in Message AI agent, the orders those brought */
  cmComments: number;
  messages: number;
  orders: number;
  revenue: number;
  delivered: number;
}

/** Each post's numbers: Meta's (both networks added up) and Pilotix's own (its comments → messages → orders). */
export async function postResults(db: Db, ids: number[]): Promise<Map<number, PostResult>> {
  const out = new Map<number, PostResult>();
  if (!ids.length) return out;
  const meta = await db.query(
    `SELECT p.id, coalesce(sum(s.views), 0)::int AS views, coalesce(sum(s.reach), 0)::int AS reach, coalesce(sum(s.likes), 0)::int AS likes, coalesce(sum(s.comments), 0)::int AS comments,
            coalesce(sum(s.shares), 0)::int AS shares, coalesce(sum(s.saves), 0)::int AS saves, coalesce(bool_or(s.insights), false) AS insights
     FROM cm_planned p LEFT JOIN cm_post_stats s ON (s.channel = 'facebook' AND s.external_id = p.fb_id) OR (s.channel = 'instagram' AND s.external_id = p.ig_id)
     WHERE p.id = ANY($1) GROUP BY p.id`,
    [ids],
  );
  const cm = await db.query(
    `SELECT p.id, count(c.id)::int AS comments, count(DISTINCT c.conversation_id)::int AS messages
     FROM cm_planned p JOIN cm_posts cp ON (cp.channel = 'facebook' AND cp.external_id = p.fb_id) OR (cp.channel = 'instagram' AND cp.external_id = p.ig_id)
     JOIN cm_comments c ON c.post_id = cp.id WHERE p.id = ANY($1) GROUP BY p.id`,
    [ids],
  );
  const orders = await db.query(
    `SELECT pid, count(*)::int AS n, coalesce(sum(total), 0)::bigint AS amount, count(*) FILTER (WHERE follow_status = 'delivered')::int AS delivered FROM (
       SELECT DISTINCT p.id AS pid, o.id, o.total, o.follow_status
       FROM cm_planned p JOIN cm_posts cp ON (cp.channel = 'facebook' AND cp.external_id = p.fb_id) OR (cp.channel = 'instagram' AND cp.external_id = p.ig_id)
       JOIN cm_comments c ON c.post_id = cp.id AND c.conversation_id IS NOT NULL JOIN orders o ON o.conversation_id = c.conversation_id
       WHERE p.id = ANY($1)) x GROUP BY pid`,
    [ids],
  );
  const cmBy = new Map(cm.map((r: any) => [num(r.id), r]));
  const oBy = new Map(orders.map((r: any) => [num(r.pid), r]));
  for (const r of meta) {
    const c: any = cmBy.get(num(r.id));
    const o: any = oBy.get(num(r.id));
    out.set(num(r.id), {
      views: num(r.views),
      reach: num(r.reach),
      likes: num(r.likes),
      comments: num(r.comments),
      shares: num(r.shares),
      saves: num(r.saves),
      insights: !!r.insights,
      cmComments: num(c?.comments),
      messages: num(c?.messages),
      orders: num(o?.n),
      revenue: num(o?.amount),
      delivered: num(o?.delivered),
    });
  }
  return out;
}

/** The hours (Algeria) when the shop's customers ordered most in the last 60 days: good hours to post. */
export async function bestHours(db: Db, now: number): Promise<{ hour: number; orders: number }[]> {
  const rows = await db.query(
    `SELECT ((extract(hour FROM created_at AT TIME ZONE 'UTC'))::int + 1) % 24 AS h, count(*)::int AS n
     FROM orders WHERE created_at >= $1 GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 3`,
    [new Date(now - 60 * 86_400_000).toISOString()],
  );
  return rows.map((r: any) => ({ hour: num(r.h), orders: num(r.n) })).filter((x) => x.orders > 0);
}

// ---------------------------------------------------------------- the caption
const LANG_RULE: Record<PlanLang, string> = {
  darija: 'en darija algérienne écrite en lettres arabes, comme les Algériens l’écrivent sur Facebook (pas de français, pas d’arabe littéraire)',
  fr: 'en français simple et chaleureux',
  ar: 'en arabe standard simple',
};

/** Claude's instructions for one caption. */
export function captionSystem(o: { lang: PlanLang; channels: readonly string[]; tone: string; notes: string }): string {
  const where = o.channels.includes('instagram') ? (o.channels.includes('facebook') ? 'Facebook et Instagram' : 'Instagram') : 'Facebook';
  return [
    `Tu écris la légende d’une publication ${where} pour une boutique en ligne en Algérie : livraison dans les 58 wilayas, paiement à la livraison.`,
    `Écris ${LANG_RULE[o.lang]}.`,
    'Forme : une première ligne qui accroche (un emoji au plus), puis 2 à 4 lignes courtes qui disent ce que le client y gagne (une coche ✅ ou un emoji au début de chaque ligne), le prix s’il est donné, la livraison et le paiement à la livraison, puis une ligne qui invite à commenter ou à écrire en message pour commander. Termine par 3 à 6 hashtags utiles.',
    '600 caractères au plus.',
    'N’invente rien : pas de prix, de promotion, de cadeau, de délai ni de garantie qui ne sont pas donnés. Pas de numéro de téléphone, pas de lien.',
    o.tone ? `Ton : ${o.tone}` : '',
    o.notes.trim() ? `À respecter (consignes de la boutique) :\n${o.notes.trim()}` : '',
    'Réponds par la légende seule, sans guillemets ni explication.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The AI's text, cleaned: no code fence, no quotes around it, Instagram's length at most. */
export function cleanCaption(t: string): string {
  let s = t.replace(/^```[a-z]*\s*|```\s*$/g, '').trim();
  s = s.replace(/^(?:légende|caption)\s*:\s*/i, '').trim();
  if (/^["«“]/.test(s) && /["»”]$/.test(s)) s = s.slice(1, -1).trim();
  return s.slice(0, PLAN_LIMITS.igCaption);
}

const money = (n: number) => n.toLocaleString('fr-FR').replace(/[  ]/g, ' ');

/** Without AI (the preview, or no key): a caption from the product's name and price, in the chosen language. */
export function demoCaption(lang: PlanLang, p: { name: string; price: number } | null, idea = ''): string {
  const name = p?.name?.trim() ?? '';
  const tag = name ? `#${name.split(/\s+/)[0].replace(/[^\p{L}\p{N}]/gu, '')}` : '';
  const extra = idea.trim() ? `✨ ${idea.trim()}` : '';
  const price = p?.price ? money(p.price) : '';
  const lines =
    lang === 'fr'
      ? [`🔥 ${name || 'Nouveau chez nous'}${price ? ` à ${price} DA` : ''}`, extra, '🚚 Livraison dans les 58 wilayas', '💵 Paiement à la livraison', '📩 Commentez « prix » ou écrivez-nous en message pour commander', `#Algérie #dz ${tag}`]
      : lang === 'ar'
        ? [`🔥 ${name || 'جديد لدينا'}${price ? ` بسعر ${price} د.ج` : ''}`, extra, '🚚 التوصيل إلى 58 ولاية', '💵 الدفع عند الاستلام', '📩 علّق «السعر» أو راسلنا للطلب', `#الجزائر #dz ${tag}`]
        : [`🔥 ${name || 'جديد عندنا'}${price ? ` بـ ${price} دج` : ''}`, extra, '🚚 التوصيل لـ 58 ولاية', '💵 الخلاص عند الاستلام', '📩 علّق «السعر» ولا ابعثلنا ميساج باش تطلب', `#الجزائر #dz ${tag}`];
  return lines
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

const CaptionInput = z.object({
  productId: id.nullable().default(null),
  idea: z.string().max(500).default(''),
  lang: z.enum(PLAN_LANGS).default('darija'),
  channels: z.array(z.enum(PLAN_CHANNELS)).max(2).default(['facebook', 'instagram']),
  /** the text already there: the AI makes it better instead of starting again */
  current: z.string().max(PLAN_LIMITS.fbCaption).default(''),
  /** « Fix it » (Post score): what the caption must get (the price, delivery to 58 wilayas…), keeping the rest */
  fix: z.array(z.enum(SCORE_KEYS)).max(SCORE_KEYS.length).default([]),
});

/** What each missing check asks the AI (and the lines added without AI). */
const FIX_RULE: Partial<Record<ScoreKey, string>> = {
  hook: 'une première ligne courte qui accroche (8 à 90 caractères)',
  price: 'le prix en DA',
  delivery: 'la livraison dans les 58 wilayas',
  cod: 'le paiement à la livraison',
  cta: 'une invitation claire à commander (commenter « prix » ou écrire en message)',
  hashtags: '3 à 6 hashtags utiles à la fin',
};
const FIX_LINE: Record<PlanLang, Partial<Record<ScoreKey, string>>> = {
  fr: { delivery: '🚚 Livraison dans les 58 wilayas', cod: '💵 Paiement à la livraison', cta: '📩 Commentez « prix » ou écrivez-nous en message pour commander', hashtags: '#Algérie #dz' },
  ar: { delivery: '🚚 التوصيل إلى 58 ولاية', cod: '💵 الدفع عند الاستلام', cta: '📩 علّق «السعر» أو راسلنا للطلب', hashtags: '#الجزائر #dz' },
  darija: { delivery: '🚚 التوصيل لـ 58 ولاية', cod: '💵 الخلاص عند الاستلام', cta: '📩 علّق «السعر» ولا ابعثلنا ميساج باش تطلب', hashtags: '#الجزائر #dz' },
};

/** Without AI: the caption with what it misses added (a first line, the price, delivery, payment on delivery…). */
export function fixCaption(current: string, fix: readonly ScoreKey[], lang: PlanLang, p: { name: string; price: number } | null): string {
  const cur = current.trim();
  if (!cur) return demoCaption(lang, p);
  let lines = cur.split('\n');
  const tags = lines.filter((l) => /^\s*#/.test(l));
  let body = lines.filter((l) => !/^\s*#/.test(l));
  const price = p?.price ? money(p.price) : '';
  if (fix.includes('hook')) {
    const head = p?.name ? `🔥 ${p.name}${price ? (lang === 'fr' ? ` à ${price} DA` : lang === 'ar' ? ` بسعر ${price} د.ج` : ` بـ ${price} دج`) : ''}` : lang === 'fr' ? '🔥 Nouveau chez nous' : '🔥 جديد عندنا';
    body = [head, ...body];
  } else if (fix.includes('price') && price) body = [...body, lang === 'fr' ? `💰 ${price} DA` : lang === 'ar' ? `💰 ${price} د.ج` : `💰 ${price} دج`];
  for (const k of ['delivery', 'cod', 'cta'] as const) if (fix.includes(k) && FIX_LINE[lang][k]) body.push(FIX_LINE[lang][k]!);
  if (fix.includes('hashtags')) tags.push(`${FIX_LINE[lang].hashtags}${p?.name ? ` #${p.name.split(/\s+/)[0].replace(/[^\p{L}\p{N}]/gu, '')}` : ''}`);
  lines = [...body, ...tags];
  return lines.join('\n').slice(0, PLAN_LIMITS.igCaption);
}

async function writeCaption(ctx: Ctx, i: z.infer<typeof CaptionInput>): Promise<{ caption: string; by: 'ai' | 'demo' }> {
  const pr = i.productId ? (await ctx.db.query(`SELECT id, name, price, description FROM products WHERE id = $1`, [i.productId]))[0] : null;
  if (i.productId && !pr) throw notFound('Produit introuvable');
  const p = pr ? { id: num(pr.id), name: String(pr.name), price: num(pr.price), description: pr.description ? String(pr.description) : '' } : null;
  const inPage = !ctx.server?.dellal && ctx.dellalAi ? ctx.dellalAi : null;
  const fixing = i.fix.filter((k) => FIX_RULE[k]);
  if (!inPage && !(await aiKeyed(ctx))) return { caption: fixing.length && i.current.trim() ? fixCaption(i.current, fixing, i.lang, p) : demoCaption(i.lang, p, i.idea), by: 'demo' };
  const ds = await dellalSettings(ctx.db);
  // Pilotix's key pays: Haiku, whatever the shop chose (as for CM AI's answers)
  const pilot = !inPage && (await pilotOn(ctx));
  const model = pilot ? PILOT_CHEAP_MODEL : ds.model;
  const complete: Complete = (req) =>
    inPage ? (inPage({ ...req, runTool: async () => ({ error: 'Pas d’outil ici' }) }) as Promise<AiResponse>) : (ctx.server!.dellal!('complete', { ...req, feature: 'cm', pilot }, ctx) as Promise<AiResponse>);
  const s = await cmSettings(ctx.db);
  const guide = p ? await readGuide(ctx.db, p.id).then((g) => (g ? guideText(g.guide, g.upsell) : '')).catch(() => '') : '';
  const user = [
    p ? `Produit : ${p.name} — ${money(p.price)} DA` : 'Pas de produit précis : une publication pour la boutique.',
    p?.description ? `Description : ${p.description.slice(0, 600)}` : '',
    guide ? `Ce que le vendeur sait du produit :\n${guide.slice(0, 1500)}` : '',
    i.idea.trim() ? `Idée de la publication : ${i.idea.trim()}` : '',
    i.current.trim() ? `Légende déjà écrite (garde l’idée, rends-la meilleure) :\n${i.current.trim().slice(0, 2200)}` : '',
    fixing.length ? `Garde tout ce qui est juste et ajoute ce qui manque : ${fixing.map((k) => FIX_RULE[k]).join(' ; ')}.` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const res = await complete({ model, system: captionSystem({ lang: i.lang, channels: i.channels, tone: s.tone, notes: s.notes }), messages: [{ role: 'user', content: user }], tools: [], max_tokens: 700 });
  const text = cleanCaption(res.content.map((b) => (b.type === 'text' ? b.text : '')).join(''));
  return text ? { caption: text, by: 'ai' } : { caption: demoCaption(i.lang, p, i.idea), by: 'demo' };
}
export { writeCaption, CaptionInput };

// ---------------------------------------------------------------- going out
const INTERRUPTED = 'Coupé pendant l’envoi (le serveur a redémarré). Regardez la Page avant de réessayer : le post est peut-être déjà sorti.';
export const NO_PAGE = 'Facebook : aucune Page liée à cette boutique (Pilot AI › Comptes).';
export const NO_IG = 'Instagram : aucun compte Instagram lié à la Page (Pilot AI › Comptes).';

/** Meta's refusal, with what to do about it. */
export function planError(e: any, ch: PlanChannel, what: 'post' | 'delete' = 'post', video = false): string {
  const m = String(e?.message ?? e ?? 'Erreur').slice(0, 300);
  const code = typeof e?.metaCode === 'number' ? e.metaCode : null;
  const net = ch === 'facebook' ? 'Facebook' : 'Instagram';
  const perm = ch === 'facebook' ? (video && what === 'post' ? 'publish_video' : 'pages_manage_posts') : what === 'delete' ? 'instagram_manage_contents' : 'instagram_content_publish';
  if (code === 10 || code === 200 || code === 3 || /\(#(10|200|3)\)|permission|not authori[sz]ed/i.test(m))
    return `${net} : Meta ne permet pas encore à Pilotix de ${what === 'delete' ? 'supprimer' : 'publier'}. Ajoutez « ${perm} » dans l’app Meta, puis appuyez sur « Continuer avec Facebook » dans Pilot AI › Comptes. (${m})`;
  if (code === 9 || code === 4 || code === 32 || code === 613 || /limits? (has been )?reached|too many|rate limit/i.test(m)) return `${net} : la limite de Meta est atteinte (Instagram : 100 posts par jour). Réessayez plus tard. (${m})`;
  if (code === 36003 || /aspect ratio/i.test(m)) return 'Instagram : la photo doit être entre 4:5 (en hauteur) et 1,91:1 (en largeur).';
  if (/2207026|2207004|unsupported|codec|format/i.test(m) && video) return `${net} : ce format de vidéo n’est pas pris (MP4 ou MOV, image H.264 ou HEVC, son AAC). (${m})`;
  if (/fetch|download|2207052|2207003/i.test(m)) return `${net} n’a pas pu télécharger ${video ? 'la vidéo' : 'la photo'} depuis Pilotix. Réessayez dans une minute. (${m})`;
  return m;
}

/** The first comment under a post that just went out (feed posts): its failure never stops the post. */
async function firstComment(ctx: Ctx, r: any, ch: PlanChannel, postId: string) {
  const col = ch === 'facebook' ? 'fb' : 'ig';
  const text = String(r.first_comment ?? '').trim();
  if (!text || r.kind === 'story' || r[`${col}_comment_id`]) return;
  try {
    const out = ctx.server?.dellal ? ((await ctx.server.dellal('planComment', { channel: ch, postId, text }, ctx)) as { id?: string }) : { id: `c${postId}` };
    const cid = String(out?.id || 'ok');
    await ctx.db.query(`UPDATE cm_planned SET ${col}_comment_id = $2 WHERE id = $1`, [num(r.id), cid]);
    r[`${col}_comment_id`] = cid;
  } catch (e: any) {
    const m = String(e?.message ?? e ?? 'Erreur').slice(0, 300);
    const net = ch === 'facebook' ? 'Facebook' : 'Instagram';
    const perm = ch === 'facebook' ? 'pages_manage_engagement' : 'instagram_manage_comments';
    const msg = /\(#(10|200|3)\)|permission|not authori[sz]ed/i.test(m) || [10, 200, 3].includes(e?.metaCode) ? `${net} : le premier commentaire n’est pas parti (ajoutez « ${perm} » dans l’app Meta). (${m})` : `${net} : le premier commentaire n’est pas parti. (${m})`;
    await ctx.db.query(`UPDATE cm_planned SET comment_error = $2 WHERE id = $1`, [num(r.id), msg]);
  }
}

/** A network's post that went out: written down, and added to the posts CM AI knows (it answers their comments). */
async function wentOut(ctx: Ctx, r: any, ch: PlanChannel, accountId: string, out: { id: string; url: string | null }) {
  const col = ch === 'facebook' ? 'fb' : 'ig';
  await ctx.db.query(`UPDATE cm_planned SET ${col}_id = $2, ${col}_url = $3, ${col}_error = NULL, ${ch === 'instagram' ? 'ig_container = NULL, ig_wait_at = NULL, ' : ''}updated_at = $4 WHERE id = $1`, [
    num(r.id),
    String(out.id),
    out.url ?? null,
    stamp(ctx),
  ]);
  r[`${col}_id`] = out.id;
  // a story gets no comments (its answers come as messages): it is not one of CM AI's posts
  if (r.kind === 'story') return;
  await ctx.db.query(
    `INSERT INTO cm_posts (channel, external_id, account_id, caption, permalink, product_id) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (channel, external_id) DO UPDATE SET caption = coalesce(EXCLUDED.caption, cm_posts.caption), permalink = coalesce(EXCLUDED.permalink, cm_posts.permalink), product_id = coalesce(EXCLUDED.product_id, cm_posts.product_id)`,
    [ch, String(out.id), accountId, String(r.caption ?? '') || null, out.url ?? null, r.product_id ?? null],
  );
  await firstComment(ctx, r, ch, String(out.id));
}

/** The post's state once its networks answered: out everywhere, still being prepared by Instagram (a video), or not out. */
async function settle(ctx: Ctx, r: any): Promise<PlanStatus> {
  const chans = PLAN_CHANNELS.filter((c) => ((r.channels ?? []) as string[]).includes(c));
  const done = chans.every((c) => !!r[`${c === 'facebook' ? 'fb' : 'ig'}_id`]);
  const waiting = !done && !!r.ig_container && !r.ig_error;
  const status: PlanStatus = done ? 'published' : waiting ? 'publishing' : 'failed';
  await ctx.db.query(
    `UPDATE cm_planned SET status = $2, tries = tries + CASE WHEN $2 = 'publishing' THEN 0 ELSE 1 END,
       published_at = CASE WHEN $2 = 'published' THEN coalesce(published_at, $3::timestamptz) ELSE published_at END, updated_at = $3 WHERE id = $1`,
    [num(r.id), status, stamp(ctx)],
  );
  ctx.emit({ type: 'chat', data: { plan: num(r.id) } });
  return status;
}

/** Sends one post to its networks (only those it has not reached yet) and writes down what each one answered. */
async function publishOne(ctx: Ctx, pid: number): Promise<PlanStatus> {
  const r = (await ctx.db.query(`SELECT * FROM cm_planned WHERE id = $1`, [pid]))[0];
  if (!r) return 'failed';
  const chans = PLAN_CHANNELS.filter((c) => ((r.channels ?? []) as string[]).includes(c));
  const media = await mediaOf(ctx, ((r.media ?? []) as unknown[]).map(num));
  const clip = media.find((m) => m.kind === 'video');
  // its photos for Meta, or its video (the original file, as it was sent)
  const images = clip ? [] : media.map((m) => photoUrl(ctx, m, false)).filter((x): x is string => !!x);
  const video = clip ? { url: photoUrl(ctx, clip, false) ?? '', mime: clip.mime ?? 'video/mp4', duration: clip.duration } : undefined;
  const story = r.kind === 'story';
  const acc = await planAccounts(ctx);
  // Facebook first: its post is the quickest
  for (const ch of chans) {
    const col = ch === 'facebook' ? 'fb' : 'ig';
    if (r[`${col}_id`]) continue;
    try {
      const acct = ch === 'facebook' ? acc.facebook : acc.instagram;
      if (!acct) throw bad(ch === 'facebook' ? NO_PAGE : NO_IG);
      if (clip && !clip.ready) throw bad('La vidéo n’est pas arrivée entière sur Pilotix : ajoutez-la encore.');
      if (!ctx.server?.dellal) {
        // the preview: going out is only written down
        await wentOut(ctx, r, ch, acct.id, { id: ch === 'facebook' ? `${acct.id}_${90_000 + pid}` : String(17_890_000_000_000 + pid), url: null });
        continue;
      }
      const out = (await ctx.server.dellal('planPublish', { channel: ch, pageId: acc.facebook?.id ?? '', igId: acc.instagram?.id ?? '', caption: story ? '' : String(r.caption ?? ''), images, video, story }, ctx)) as {
        id?: string;
        url?: string | null;
        pending?: boolean;
        container?: string;
      };
      if (out.pending && out.container) {
        // Instagram prepares the video: the job looks again every minute (cm.plan.run)
        await ctx.db.query(`UPDATE cm_planned SET ig_container = $2, ig_wait_at = $3, ig_error = NULL, updated_at = $3 WHERE id = $1`, [pid, out.container, stamp(ctx)]);
        r.ig_container = out.container;
        r.ig_error = null;
        continue;
      }
      if (!out.id) throw bad(`${ch === 'facebook' ? 'Facebook' : 'Instagram'} n’a pas donné le numéro du post.`);
      await wentOut(ctx, r, ch, acct.id, { id: String(out.id), url: out.url ?? null });
    } catch (e) {
      const msg = planError(e, ch, 'post', !!clip);
      await ctx.db.query(`UPDATE cm_planned SET ${col}_error = $2, updated_at = $3 WHERE id = $1`, [pid, msg, stamp(ctx)]);
      r[`${col}_error`] = msg;
    }
  }
  return settle(ctx, r);
}

/** A video Instagram was preparing: posted once it is ready (30 minutes at most). */
async function checkPrepared(ctx: Ctx, r: any): Promise<PlanStatus> {
  const acc = await planAccounts(ctx);
  try {
    if (!ctx.server?.dellal || !acc.instagram) throw bad(NO_IG);
    const out = (await ctx.server.dellal('planCheck', { channel: 'instagram', igId: acc.instagram.id, container: String(r.ig_container) }, ctx)) as { done: boolean; id?: string; url?: string | null };
    if (out.done && out.id) await wentOut(ctx, r, 'instagram', acc.instagram.id, { id: String(out.id), url: out.url ?? null });
    else if (Date.parse(iso(r.ig_wait_at ?? r.updated_at)) < ctx.now() - 30 * 60_000) throw bad('Instagram n’a pas fini de préparer la vidéo en 30 minutes. Réessayez plus tard.');
    else return 'publishing';
  } catch (e) {
    const msg = planError(e, 'instagram', 'post', true);
    await ctx.db.query(`UPDATE cm_planned SET ig_error = $2, ig_container = NULL, ig_wait_at = NULL, updated_at = $3 WHERE id = $1`, [num(r.id), msg, stamp(ctx)]);
    r.ig_error = msg;
    r.ig_container = null;
  }
  return settle(ctx, r);
}

/** Removes photos and videos (their rows, and the videos' files on the server). */
async function dropMedia(ctx: Ctx, where: string, params: unknown[]): Promise<void> {
  const rows = await ctx.db.query(`SELECT id, key, kind, mime FROM cm_media m WHERE ${where}`, params);
  for (const m of rows) if (m.kind === 'video') await ctx.server?.media?.('remove', { id: num(m.id), key: String(m.key), ext: extOf(m.mime) }).catch(() => null);
  if (rows.length) await ctx.db.query(`DELETE FROM cm_media WHERE id = ANY($1)`, [rows.map((m: any) => num(m.id))]);
}

/** The 'cm-plan' job: the posts whose time has come go out; Instagram's prepared videos too; old leftovers are cleaned. */
export async function runPlanned(ctx: Ctx): Promise<{ published: number; failed: number }> {
  const now = stamp(ctx);
  // a post left « publishing » for 10 minutes: the server stopped while it was going out (a video Instagram prepares waits)
  await ctx.db.query(
    `UPDATE cm_planned SET status = 'failed', updated_at = $1,
       fb_error = CASE WHEN 'facebook' = ANY(channels) AND fb_id IS NULL THEN coalesce(fb_error, $2) ELSE fb_error END,
       ig_error = CASE WHEN 'instagram' = ANY(channels) AND ig_id IS NULL THEN coalesce(ig_error, $2) ELSE ig_error END
     WHERE status = 'publishing' AND ig_container IS NULL AND updated_at < $1::timestamptz - interval '10 minutes'`,
    [now, INTERRUPTED],
  );
  let published = 0;
  let failed = 0;
  const count = (s: PlanStatus) => {
    if (s === 'published') published++;
    else if (s === 'failed') failed++;
  };
  for (const r of await ctx.db.query(`SELECT * FROM cm_planned WHERE status = 'publishing' AND ig_container IS NOT NULL ORDER BY ig_wait_at, id LIMIT 20`)) count(await checkPrepared(ctx, r));
  const due = await ctx.db.query(
    `UPDATE cm_planned SET status = 'publishing', updated_at = $1
     WHERE id IN (SELECT id FROM cm_planned WHERE status = 'scheduled' AND publish_at <= $1::timestamptz ORDER BY publish_at, id LIMIT 10) RETURNING id`,
    [now],
  );
  for (const d of due) count(await publishOne(ctx, num(d.id)));
  // photos and videos nobody kept (an editor closed without saving) after 2 days
  await dropMedia(ctx, `m.created_at < $1::timestamptz - interval '2 days' AND NOT EXISTS (SELECT 1 FROM cm_planned p WHERE m.id = ANY(p.media))`, [now]);
  // a week after a post went out: the big copies (Meta has its own); the small one stays for the calendar
  // (a post still to go out may use the same photos: « Post again », « Fill my week »)
  const old = `m.id IN (SELECT unnest(media) FROM cm_planned WHERE status = 'published' AND published_at < $1::timestamptz - interval '7 days') AND NOT EXISTS (SELECT 1 FROM cm_planned q WHERE m.id = ANY(q.media) AND q.status <> 'published')`;
  await ctx.db.query(`UPDATE cm_media m SET jpeg = NULL WHERE jpeg IS NOT NULL AND ${old}`, [now]);
  for (const m of await ctx.db.query(`SELECT id, key, mime FROM cm_media m WHERE kind = 'video' AND ready AND ${old}`, [now])) {
    await ctx.server?.media?.('remove', { id: num(m.id), key: String(m.key), ext: extOf(m.mime) }).catch(() => null);
    await ctx.db.query(`UPDATE cm_media SET ready = false WHERE id = $1`, [num(m.id)]);
  }
  return { published, failed };
}

/** Meta answered that the post is not there any more: deleted already (by hand on the Page). */
const gone = (e: any) => /does not exist|cannot be loaded|n'existe pas|introuvable/i.test(String(e?.message ?? ''));

// ---------------------------------------------------------------- procedures
const PlanInput = z.object({
  id: id.optional(),
  caption: z.string().max(PLAN_LIMITS.fbCaption).default(''),
  photos: z.array(id).max(PLAN_LIMITS.photos).default([]),
  channels: z.array(z.enum(PLAN_CHANNELS)).max(2).default([]),
  productId: id.nullable().default(null),
  publishAt: z.string().datetime({ offset: true }).nullable().default(null),
  /** true: it goes out at publishAt; false: kept as a draft */
  schedule: z.boolean().default(false),
  /** the language the AI wrote it in (kept for the next « Write with AI ») */
  lang: z.enum(PLAN_LANGS).nullable().default(null),
  kind: z.enum(PLAN_KINDS).default('post'),
  /** posted under the post right after it goes out (feed posts only) */
  firstComment: z.string().trim().max(PLAN_LIMITS.firstComment).nullable().default(null),
  /** the Algerian calendar's day it was made for */
  eventKey: z.string().max(40).nullable().default(null),
});

export const cmPlanProcs = {
  /** The posts of a period of the calendar, the drafts without a day, and what the editor needs. */
  'cm.plan.list': proc([...PLAN_ROLES], z.object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) }), async (ctx, i) => {
    const sel = `SELECT p.*, pr.name AS product_name FROM cm_planned p LEFT JOIN products pr ON pr.id = p.product_id`;
    const rows = await ctx.db.query(`${sel} WHERE p.publish_at >= $1 AND p.publish_at < $2 ORDER BY p.publish_at, p.id LIMIT 500`, [i.from, i.to]);
    const drafts = await ctx.db.query(`${sel} WHERE p.publish_at IS NULL ORDER BY p.updated_at DESC LIMIT 50`);
    // whatever month is shown: the next posts, and the ones that did not go out (to fix)
    const next = await ctx.db.query(`${sel} WHERE p.status IN ('scheduled', 'publishing') AND p.publish_at >= $1 ORDER BY p.publish_at, p.id LIMIT 6`, [stamp(ctx)]);
    const failed = await ctx.db.query(`${sel} WHERE p.status = 'failed' ORDER BY p.publish_at DESC NULLS LAST, p.id DESC LIMIT 20`);
    // the posts waiting for the administrator's yes (when the shop asks for it)
    const review = await ctx.db.query(`${sel} WHERE p.status = 'review' ORDER BY p.publish_at NULLS LAST, p.id LIMIT 30`);
    const media = await mediaOf(ctx, [...new Set([...rows, ...drafts, ...next, ...failed, ...review].flatMap((r: any) => ((r.media ?? []) as unknown[]).map(num)))]);
    const by = new Map(media.map((m) => [m.id, m]));
    // what each post that went out did (Meta's numbers, and the orders from its comments' messages)
    const outIds = rows.filter((r: any) => r.fb_id || r.ig_id).map((r: any) => num(r.id));
    const res = outIds.length ? await postResults(ctx.db, outIds) : new Map<number, PostResult>();
    const view = (r: any) => ({ ...toPlanned(ctx, r, ((r.media ?? []) as unknown[]).map(num).flatMap((x) => (by.has(x) ? [by.get(x)!] : []))), results: res.get(num(r.id)) ?? null });
    const products = await ctx.db.query(`SELECT id, name, price FROM products WHERE active AND archived_at IS NULL ORDER BY name LIMIT 300`);
    return {
      rows: rows.map(view),
      drafts: drafts.map(view),
      next: next.map(view),
      failed: failed.map(view),
      review: review.map(view),
      settings: await socialSettings(ctx.db),
      isAdmin: ctx.session.isAdmin,
      accounts: await planAccounts(ctx),
      bestHours: await bestHours(ctx.db, ctx.now()),
      products: products.map((p: any) => ({ id: num(p.id), name: String(p.name), price: num(p.price) })),
      /** a real AI writes the caption (else an example built from the product) */
      ai: !!ctx.dellalAi || (await aiKeyed(ctx)),
      limits: PLAN_LIMITS,
    };
  }),

  'cm.plan.get': proc([...PLAN_ROLES], z.object({ id }), (ctx, i) => planned(ctx, i.id)),

  /**
   * One photo, already JPEG and cropped by the browser at the highest quality that fits in one upload (pages/cm/jpeg.ts):
   * kept exactly as it is until its post goes out (then that very file goes to Meta).
   */
  'cm.plan.photo': proc(
    [...PLAN_ROLES],
    z.object({ jpeg: B64(4_850_000), thumb: B64(200_000), w: z.number().int().min(320).max(1440), h: z.number().int().min(160).max(2560), story: z.boolean().default(false) }),
    async (ctx, i) => {
      if (!i.jpeg.startsWith('/9j/') || !i.thumb.startsWith('/9j/')) throw bad('Envoyez une photo JPEG.');
      const ratio = i.w / i.h;
      // a story is tall (9:16); a feed post between 4:5 and 1.91:1
      if (ratio < (i.story ? 0.5 : 0.795) || ratio > 1.915) throw bad(i.story ? 'Une story prend une photo entre 9:16 (en hauteur) et 1,91:1 (en largeur).' : 'Instagram prend des photos entre 4:5 (en hauteur) et 1,91:1 (en largeur).');
      const key = randomKey();
      const r = (
        await ctx.db.query(`INSERT INTO cm_media (key, w, h, jpeg, thumb, bytes, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [
          key,
          i.w,
          i.h,
          i.jpeg,
          i.thumb,
          Math.floor((i.jpeg.length * 3) / 4),
          me(ctx),
          stamp(ctx),
        ])
      )[0];
      const m: MediaRow = { id: num(r.id), key, kind: 'photo', mime: null, duration: null, ready: true, w: i.w, h: i.h, hasJpeg: true, hasThumb: true, thumb: i.thumb, src: null };
      return mediaView(ctx, m);
    },
  ),

  /**
   * A video starts: its row (and the still for the calendar, made in the browser). On the server the file then comes
   * in pieces of VIDEO_CHUNK (PUT /api/cm/video/<id>/<key>?part=N, the original file untouched, its index first), then
   * cm.plan.videoDone; in the preview nothing is sent (the browser keeps the video for the editor).
   */
  'cm.plan.videoStart': proc(
    [...PLAN_ROLES],
    z.object({
      mime: z.enum(VIDEO_TYPES),
      size: z.number().int().min(1).max(PLAN_LIMITS.videoBytes),
      w: z.number().int().min(16).max(8192),
      h: z.number().int().min(16).max(8192),
      duration: z.number().min(0).max(4 * 3600),
      thumb: B64(200_000),
    }),
    async (ctx, i) => {
      if (!i.thumb.startsWith('/9j/')) throw bad('Image de la vidéo illisible.');
      if (i.duration < PLAN_LIMITS.videoMin) throw bad(`Vidéo trop courte : Instagram demande ${PLAN_LIMITS.videoMin} secondes au moins.`);
      if (i.duration > PLAN_LIMITS.videoMax) throw bad('Vidéo trop longue : Instagram prend 15 minutes au plus.');
      const key = randomKey();
      const upload = !!ctx.server?.media;
      const r = (
        await ctx.db.query(`INSERT INTO cm_media (key, kind, mime, duration, ready, w, h, thumb, bytes, created_by, created_at) VALUES ($1,'video',$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [
          key,
          i.mime,
          i.duration,
          !upload,
          i.w,
          i.h,
          i.thumb,
          i.size,
          me(ctx),
          stamp(ctx),
        ])
      )[0];
      const m: MediaRow = { id: num(r.id), key, kind: 'video', mime: i.mime, duration: i.duration, ready: !upload, w: i.w, h: i.h, hasJpeg: false, hasThumb: true, thumb: i.thumb, src: null };
      return { ...mediaView(ctx, m), key, upload, chunk: VIDEO_CHUNK };
    },
  ),

  /** The video's last piece arrived: the server checks it is whole, and it is ready to go out. */
  'cm.plan.videoDone': proc([...PLAN_ROLES], z.object({ id }), async (ctx, i) => {
    const r = (await ctx.db.query(`SELECT key, kind, mime, bytes, ready FROM cm_media WHERE id = $1`, [i.id]))[0];
    if (!r || r.kind !== 'video') throw notFound('Vidéo introuvable');
    if (!r.ready) {
      if (!ctx.server?.media) throw bad('Pas de stockage de vidéos sur ce serveur.');
      await ctx.server.media('finish', { id: i.id, key: String(r.key), ext: extOf(r.mime), size: num(r.bytes) });
      await ctx.db.query(`UPDATE cm_media SET ready = true WHERE id = $1`, [i.id]);
    }
    return mediaView(ctx, (await mediaOf(ctx, [i.id]))[0]);
  }),

  /** What the server needs to receive a video's pieces, and to give the file to Meta (the key must match). */
  'cm.plan.videoFile': proc([], z.object({ id, key: z.string().regex(/^[a-f0-9]{24}$/) }), async (ctx, i) => {
    const r = (await ctx.db.query(`SELECT key, mime, bytes, ready FROM cm_media WHERE id = $1 AND kind = 'video'`, [i.id]))[0];
    if (!r || r.key !== i.key) throw notFound('Vidéo introuvable');
    return { ext: extOf(r.mime), mime: String(r.mime ?? 'video/mp4'), size: num(r.bytes), ready: !!r.ready, chunk: VIDEO_CHUNK };
  }),

  /** A photo for Meta (and the small copy for the calendar), read by the public address /lp/pic/<id>/<key>.jpg. */
  'cm.plan.image': proc([], z.object({ id, key: z.string().regex(/^[a-f0-9]{24}$/), small: z.boolean().default(false) }), async (ctx, i) => {
    const r = (await ctx.db.query(`SELECT key, ${i.small ? 'thumb' : 'jpeg'} AS b FROM cm_media WHERE id = $1`, [i.id]))[0];
    if (!r || r.key !== i.key || !r.b) throw notFound('Photo introuvable');
    return { base64: String(r.b) };
  }),

  /** Saves a post: a draft, or planned for its day and hour (checked as Meta will check it). */
  'cm.plan.save': proc([...PLAN_ROLES], PlanInput, async (ctx, i) => {
    const channels = PLAN_CHANNELS.filter((c) => i.channels.includes(c));
    const photos = [...new Set(i.photos)];
    const kinds = photos.length ? await ctx.db.query(`SELECT kind, ready, w, h, duration FROM cm_media WHERE id = ANY($1)`, [photos]) : [];
    if (kinds.length !== photos.length) throw bad('Une photo ou la vidéo a disparu : ajoutez-la encore.');
    const videos = kinds.filter((k: any) => k.kind === 'video');
    if (videos.length && (videos.length > 1 || videos.length < kinds.length)) throw bad('Un post a des photos ou une vidéo, pas les deux.');
    const counts = {
      photos: kinds.length - videos.length,
      videos: videos.length,
      videoReady: videos.every((v: any) => v.ready !== false),
      kind: i.kind,
      duration: videos[0]?.duration == null ? null : Number(videos[0].duration),
      tall: kinds.filter((k: any) => k.kind !== 'video' && num(k.w) / Math.max(1, num(k.h)) < 0.795).length,
    };
    if (i.productId && !(await ctx.db.query(`SELECT 1 FROM products WHERE id = $1`, [i.productId])).length) throw notFound('Produit introuvable');
    const old = i.id ? await getRow(ctx.db, i.id) : null;
    if (old?.status === 'publishing') throw bad('Il part en ce moment : attendez une minute.');
    if (old?.status === 'published') throw bad('Ce post est déjà sorti : changez son texte avec « Modifier sur Facebook ».');
    const story = i.kind === 'story';
    const comment = story ? null : i.firstComment || null;
    if (i.schedule) {
      const probs = planProblems({ caption: i.caption, ...counts, channels });
      if (probs.length) throw bad(probs[0]);
      if (!i.publishAt) throw bad('Choisissez le jour et l’heure.');
      const at = Date.parse(i.publishAt);
      if (at < ctx.now() + 60_000) throw bad('Choisissez une heure à venir, ou « Publier maintenant ».');
      if (at > ctx.now() + 366 * 86_400_000) throw bad('Un an à l’avance au plus.');
      const acc = await planAccounts(ctx);
      if (channels.includes('facebook') && !acc.facebook) throw bad(NO_PAGE);
      if (channels.includes('instagram') && !acc.instagram) throw bad(NO_IG);
    }
    // a marketer's planned post waits for the administrator's yes when the shop asks for it
    const yes = i.schedule && !(await needsYes(ctx));
    const status: PlanStatus = i.schedule ? (yes ? 'scheduled' : 'review') : 'draft';
    const approved = yes && ctx.session.isAdmin && old?.status === 'review';
    if (old) {
      // partly out before (one network done): that network keeps its post, the other one is tried again at the new time
      await ctx.db.query(
        `UPDATE cm_planned SET caption = $2, media = $3, channels = $4, product_id = $5, publish_at = $6, status = $7, ai_lang = $8, fb_error = NULL, ig_error = NULL, updated_by = $9, updated_at = $10,
           kind = $11, first_comment = $12, event_key = coalesce($13, event_key),
           review_note = CASE WHEN $7 = 'scheduled' THEN NULL ELSE review_note END,
           approved_by = CASE WHEN $14 THEN $9 ELSE approved_by END, approved_at = CASE WHEN $14 THEN $10::timestamptz ELSE approved_at END WHERE id = $1`,
        [old.id, i.caption, photos, channels, i.productId, i.publishAt, status, i.lang, me(ctx), stamp(ctx), i.kind, comment, i.eventKey, approved],
      );
      ctx.emit({ type: 'chat', data: { plan: num(old.id) } });
      return { id: num(old.id), status };
    }
    const r = await ctx.db.query(
      `INSERT INTO cm_planned (caption, media, channels, product_id, publish_at, status, ai_lang, created_by, updated_by, created_at, updated_at, kind, first_comment, event_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$9,$10,$11,$12) RETURNING id`,
      [i.caption, photos, channels, i.productId, i.publishAt, status, i.lang, me(ctx), stamp(ctx), i.kind, comment, i.eventKey],
    );
    ctx.emit({ type: 'chat', data: { plan: num(r[0].id) } });
    return { id: num(r[0].id), status };
  }),

  /** « Publier maintenant » (also « Réessayer » after a failure): it goes out at once, on the networks it has not reached. */
  'cm.plan.publishNow': proc([...PLAN_ROLES], z.object({ id }), async (ctx, i) => {
    const r = await getRow(ctx.db, i.id);
    if (r.status === 'published') throw bad('Ce post est déjà sorti.');
    if (r.status === 'publishing') throw bad('Il part déjà : attendez une minute.');
    // (a post the administrator already said yes to may be tried again)
    if ((await needsYes(ctx)) && !(r.approved_at && ['scheduled', 'failed'].includes(r.status))) throw bad('Ce post attend le oui de l’administrateur : demandez-lui de le valider.');
    const ids = ((r.media ?? []) as unknown[]).map(num);
    const kinds = ids.length ? await ctx.db.query(`SELECT kind, ready, w, h, duration FROM cm_media WHERE id = ANY($1)`, [ids]) : [];
    const videos = kinds.filter((k: any) => k.kind === 'video');
    const probs = planProblems({
      caption: String(r.caption ?? ''),
      photos: kinds.length - videos.length,
      videos: videos.length,
      videoReady: videos.every((v: any) => v.ready !== false),
      channels: (r.channels ?? []) as string[],
      kind: r.kind === 'story' ? 'story' : 'post',
      duration: videos[0]?.duration == null ? null : Number(videos[0].duration),
      tall: kinds.filter((k: any) => k.kind !== 'video' && num(k.w) / Math.max(1, num(k.h)) < 0.795).length,
    });
    if (probs.length) throw bad(probs[0]);
    const now = stamp(ctx);
    const claimed = await ctx.db.query(
      `UPDATE cm_planned SET status = 'publishing', publish_at = CASE WHEN status = 'failed' AND publish_at IS NOT NULL AND publish_at <= $2::timestamptz THEN publish_at ELSE $2::timestamptz END, updated_by = $3, updated_at = $2
       WHERE id = $1 AND status IN ('draft', 'review', 'scheduled', 'failed') RETURNING id`,
      [i.id, now, me(ctx)],
    );
    if (!claimed.length) throw bad('Il part déjà : attendez une minute.');
    const status = await publishOne(ctx, i.id);
    return { status, post: await planned(ctx, i.id) };
  }),

  /** The text of a post already out on Facebook (Instagram lets no app change a posted caption). */
  'cm.plan.editPosted': proc([...PLAN_ROLES], z.object({ id, caption: z.string().trim().min(1).max(PLAN_LIMITS.fbCaption) }), async (ctx, i) => {
    const r = await getRow(ctx.db, i.id);
    if (!r.fb_id) throw bad('Seul le texte d’un post sorti sur Facebook peut changer : Instagram ne le permet à aucune application.');
    if (ctx.server?.dellal) {
      try {
        await ctx.server.dellal('planEdit', { channel: 'facebook', postId: String(r.fb_id), caption: i.caption }, ctx);
      } catch (e) {
        throw bad(planError(e, 'facebook'));
      }
    }
    await ctx.db.query(`UPDATE cm_planned SET caption = $2, updated_by = $3, updated_at = $4 WHERE id = $1`, [i.id, i.caption, me(ctx), stamp(ctx)]);
    await ctx.db.query(`UPDATE cm_posts SET caption = $2 WHERE channel = 'facebook' AND external_id = $1`, [String(r.fb_id), i.caption]);
    ctx.emit({ type: 'chat', data: { plan: i.id } });
    return { ok: true };
  }),

  /** Deletes a post: from Pilotix, and from Facebook and Instagram when it went out there. */
  'cm.plan.delete': proc([...PLAN_ROLES], z.object({ id }), async (ctx, i) => {
    const r = await getRow(ctx.db, i.id);
    if (r.status === 'publishing') throw bad('Il part en ce moment : attendez une minute, puis supprimez-le.');
    const fails: string[] = [];
    // a story leaves by itself after 24 hours: only Pilotix forgets it
    for (const ch of r.kind === 'story' ? [] : PLAN_CHANNELS) {
      const col = ch === 'facebook' ? 'fb' : 'ig';
      const ext = r[`${col}_id`];
      if (!ext) continue;
      try {
        if (ctx.server?.dellal) await ctx.server.dellal('planDelete', { channel: ch, postId: String(ext) }, ctx).catch((e) => (gone(e) ? null : Promise.reject(e)));
        await ctx.db.query(`UPDATE cm_planned SET ${col}_id = NULL, ${col}_url = NULL WHERE id = $1`, [i.id]);
      } catch (e) {
        fails.push(planError(e, ch, 'delete'));
      }
    }
    if (fails.length) throw bad(fails.join(' '));
    await ctx.db.query(`DELETE FROM cm_planned WHERE id = $1`, [i.id]);
    const media = ((r.media ?? []) as unknown[]).map(num);
    if (media.length) await dropMedia(ctx, `m.id = ANY($1) AND NOT EXISTS (SELECT 1 FROM cm_planned p WHERE m.id = ANY(p.media))`, [media]);
    ctx.emit({ type: 'chat', data: { plan: i.id } });
    return { ok: true };
  }),

  /** « Écrire avec l’IA »: a caption from the product, the idea and the shop's CM settings (its tone, what never to say). */
  'cm.plan.caption': proc([...PLAN_ROLES], CaptionInput, (ctx, i) => writeCaption(ctx, i)),
};
