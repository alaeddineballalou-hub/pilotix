// AI social media manager: everything around the calendar (./cmplan.ts holds the posts and how they go out).
//  - Results (cm.plan.stats): what each post did. Meta's numbers (cm_post_stats, fetched by the job) and Pilotix's own
//    (its comments in CM AI agent → the conversations they opened in Message AI agent → the orders); the best posts,
//    hours, days and kinds (photo, carousel, video, story); the followers of each day; this week against the one before,
//    with what to do next
//  - « Fill my week » (cm.plan.fillWeek): the AI prepares drafts on the shop's fixed times from its products (best
//    sellers, new ones, ones not posted lately) and the Algerian calendar's days coming; the person checks and plans them
//  - « Post again » (cm.plan.again), moving a post on the calendar (cm.plan.move), the administrator's yes
//    (cm.plan.review), planning several drafts at once (cm.plan.planMany), the settings (cm.plan.settings)
//  - the job (cm.plan.run, every minute): the posts whose time has come go out; the numbers come again (a new post every
//    hour, older ones less often, a story only in its 24 hours) and the followers once a day
import { DzEventKey, dzEvents, nextSlot } from '@pilotix/shared';
import { z } from 'zod';
import { iso, num, numOrNull } from '../db';
import { bad, Ctx, proc } from '../rpc';
import { setRaw } from './admin';
import {
  bestHours,
  getRow,
  me,
  mediaOf,
  needsYes,
  NO_IG,
  NO_PAGE,
  PLAN_CHANNELS,
  PLAN_LANGS,
  PLAN_LIMITS,
  PLAN_ROLES,
  PlanLang,
  planAccounts,
  planned,
  planProblems,
  postResults,
  PostResult,
  runPlanned,
  socialSettings,
  stamp,
  toPlanned,
  writeCaption,
} from './cmplan';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const OFF = HOUR;
const id = z.number().int().positive();
const ymd = (t: number) => new Date(t + OFF).toISOString().slice(0, 10);
/** the hour (0-23) and the weekday (0 = Sunday) of a moment in Algeria */
const algHour = (t: number) => new Date(t + OFF).getUTCHours();
const algDay = (t: number) => new Date(t + OFF).getUTCDay();

/** What the AI is told for a day of the Algerian calendar (it never invents a discount or a price). */
export const EVENT_IDEA: Record<DzEventKey, string> = {
  newyear: 'Le Nouvel An approche : présenter le produit comme une belle idée pour bien commencer l’année',
  yennayer: 'Yennayer (Nouvel An amazigh) approche : souhaiter « Assegas Amegas » et présenter le produit',
  valentine: 'La Saint-Valentin approche : une idée de cadeau, à commander maintenant pour la recevoir avant le 14 février',
  women: 'Le 8 mars approche : une idée de cadeau pour les femmes de la famille',
  ramadan: 'Ramadan arrive : préparez le mois, commandez avant, livraison partout',
  fitr: 'L’Aïd el-Fitr approche : commandez maintenant pour être livré avant l’Aïd',
  adha: 'L’Aïd el-Adha approche : commandez maintenant pour être livré avant l’Aïd',
  hijri: 'Le Nouvel An de l’Hégire : souhaiter une bonne année à la famille',
  achoura: 'Achoura approche : une publication chaleureuse pour la famille',
  mawlid: 'Le Mawlid approche : une publication chaleureuse, une idée de cadeau pour les enfants',
  independence: 'Le 5 juillet, fête de l’Indépendance : une publication fière de l’Algérie',
  school: 'La rentrée scolaire approche : préparez-la sans stress, commandez maintenant',
  revolution: 'Le 1er novembre, fête de la Révolution : une publication fière de l’Algérie',
  blackfriday: 'Black Friday : le bon moment pour commander ce produit (sans inventer de remise)',
};
/** what the AI is told for each kind of product « Fill my week » picks */
const WHY_IDEA = {
  best: 'Notre produit le plus commandé en ce moment : dites pourquoi les clients l’adorent',
  new: 'Nouveau chez nous : présentez-le pour la première fois',
  quiet: 'Rappelez ce produit à ceux qui ne l’ont pas encore vu',
} as const;

// ---------------------------------------------------------------- what stops a post from being planned
async function firstProblem(ctx: Ctx, r: any): Promise<string | null> {
  const ids = ((r.media ?? []) as unknown[]).map(num);
  const kinds = ids.length ? await ctx.db.query(`SELECT kind, ready, w, h, duration FROM cm_media WHERE id = ANY($1)`, [ids]) : [];
  if (kinds.length !== ids.length) return 'Une photo ou la vidéo a disparu : ajoutez-la encore.';
  const videos = kinds.filter((k: any) => k.kind === 'video');
  const channels = PLAN_CHANNELS.filter((c) => ((r.channels ?? []) as string[]).includes(c));
  const probs = planProblems({
    caption: String(r.caption ?? ''),
    photos: kinds.length - videos.length,
    videos: videos.length,
    videoReady: videos.every((v: any) => v.ready !== false),
    channels,
    kind: r.kind === 'story' ? 'story' : 'post',
    duration: videos[0]?.duration == null ? null : Number(videos[0].duration),
    tall: kinds.filter((k: any) => k.kind !== 'video' && num(k.w) / Math.max(1, num(k.h)) < 0.795).length,
  });
  if (probs.length) return probs[0];
  if (!r.publish_at) return 'Choisissez le jour et l’heure.';
  if (Date.parse(iso(r.publish_at)) < ctx.now() + 60_000) return 'Son heure est passée : choisissez une heure à venir.';
  const acc = await planAccounts(ctx);
  if (channels.includes('facebook') && !acc.facebook) return NO_PAGE;
  if (channels.includes('instagram') && !acc.instagram) return NO_IG;
  return null;
}

/** The planned times already taken between two moments (a post within 30 minutes of a time takes it). */
async function takenTimes(ctx: Ctx, from: number, to: number): Promise<number[]> {
  const rows = await ctx.db.query(`SELECT publish_at FROM cm_planned WHERE publish_at >= $1 AND publish_at < $2 AND status <> 'failed'`, [new Date(from).toISOString(), new Date(to).toISOString()]);
  return rows.map((r: any) => Date.parse(iso(r.publish_at)));
}

/** The photos or video of a product's last post that Pilotix still has (a week after a post went out the big copies go). */
async function productMedia(ctx: Ctx, productId: number): Promise<number[]> {
  const rows = await ctx.db.query(`SELECT media FROM cm_planned WHERE product_id = $1 AND kind = 'post' AND cardinality(media) > 0 ORDER BY coalesce(published_at, updated_at) DESC LIMIT 6`, [productId]);
  for (const r of rows) {
    const ids = ((r.media ?? []) as unknown[]).map(num);
    const media = await mediaOf(ctx, ids);
    if (media.length === ids.length && media.every((m) => (m.kind === 'video' ? m.ready : m.hasJpeg || !!m.src))) return ids;
  }
  return [];
}

// ---------------------------------------------------------------- Meta's numbers (the job)
/**
 * Asks Meta again for the numbers of the posts that went out in the last 60 days (a post of the last 2 days every hour,
 * of the last week every 6 hours, older ones once a day; a story only in its 24 hours), 15 at a time, and the followers
 * once a day. Nothing in the preview (its numbers are the demo's).
 */
export async function refreshStats(ctx: Ctx): Promise<number> {
  if (!ctx.server?.dellal) return 0;
  const now = ctx.now();
  const rows = await ctx.db.query(
    `SELECT p.id, p.kind, p.fb_id, p.ig_id, coalesce(p.published_at, p.publish_at) AS at,
       (SELECT fetched_at FROM cm_post_stats s WHERE s.channel = 'facebook' AND s.external_id = p.fb_id) AS fb_at,
       (SELECT fetched_at FROM cm_post_stats s WHERE s.channel = 'instagram' AND s.external_id = p.ig_id) AS ig_at
     FROM cm_planned p WHERE (p.fb_id IS NOT NULL OR p.ig_id IS NOT NULL) AND coalesce(p.published_at, p.publish_at) > $1
     ORDER BY coalesce(p.published_at, p.publish_at) DESC LIMIT 300`,
    [new Date(now - 60 * DAY).toISOString()],
  );
  const due = (at: unknown, fetched: unknown, story: boolean) => {
    const age = now - Date.parse(iso(at));
    if (story && age > DAY) return false;
    const every = age < 2 * DAY ? HOUR : age < 7 * DAY ? 6 * HOUR : DAY;
    return !fetched || now - Date.parse(iso(fetched)) >= every;
  };
  const items: { channel: 'facebook' | 'instagram'; id: string; kind: 'post' | 'story'; planned: number }[] = [];
  for (const r of rows) {
    const story = r.kind === 'story';
    // Facebook gives no numbers for a Page's story
    if (r.fb_id && !story && due(r.at, r.fb_at, story)) items.push({ channel: 'facebook', id: String(r.fb_id), kind: 'post', planned: num(r.id) });
    if (r.ig_id && due(r.at, r.ig_at, story)) items.push({ channel: 'instagram', id: String(r.ig_id), kind: story ? 'story' : 'post', planned: num(r.id) });
  }
  const batch = items.slice(0, 15);
  const acc = await planAccounts(ctx);
  const today = ymd(now);
  const have = (await ctx.db.query(`SELECT channel FROM cm_follow_days WHERE day = $1`, [today])).map((r: any) => String(r.channel));
  const needFollowers = (!!acc.facebook && !have.includes('facebook')) || (!!acc.instagram && !have.includes('instagram'));
  if (!batch.length && !needFollowers) return 0;
  const out = (await ctx.server.dellal('planStats', { pageId: acc.facebook?.id, igId: acc.instagram?.id, items: batch.map(({ channel, id: ext, kind }) => ({ channel, id: ext, kind })), followers: needFollowers }, ctx)) as {
    items?: { channel: string; id: string; views: number | null; reach: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null; insights: boolean; error: string | null }[];
    followers?: { facebook?: number | null; instagram?: number | null };
  };
  const at = new Date(now).toISOString();
  for (const s of out?.items ?? []) {
    const it = batch.find((b) => b.channel === s.channel && b.id === String(s.id));
    if (!it) continue;
    // a passing error keeps the numbers already there
    await ctx.db.query(
      `INSERT INTO cm_post_stats (channel, external_id, planned_id, views, reach, likes, comments, shares, saves, insights, error, fetched_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (channel, external_id) DO UPDATE SET planned_id = EXCLUDED.planned_id, views = coalesce(EXCLUDED.views, cm_post_stats.views), reach = coalesce(EXCLUDED.reach, cm_post_stats.reach),
         likes = coalesce(EXCLUDED.likes, cm_post_stats.likes), comments = coalesce(EXCLUDED.comments, cm_post_stats.comments), shares = coalesce(EXCLUDED.shares, cm_post_stats.shares),
         saves = coalesce(EXCLUDED.saves, cm_post_stats.saves), insights = EXCLUDED.insights OR cm_post_stats.insights, error = EXCLUDED.error, fetched_at = EXCLUDED.fetched_at`,
      [it.channel, it.id, it.planned, s.views, s.reach, s.likes, s.comments, s.shares, s.saves, !!s.insights, s.error ? String(s.error).slice(0, 300) : null, at],
    );
  }
  for (const ch of PLAN_CHANNELS) {
    const n = out?.followers?.[ch];
    if (typeof n === 'number' && n >= 0) await ctx.db.query(`INSERT INTO cm_follow_days (day, channel, followers) VALUES ($1,$2,$3) ON CONFLICT (day, channel) DO UPDATE SET followers = EXCLUDED.followers`, [today, ch, n]);
  }
  return batch.length;
}

// ---------------------------------------------------------------- the results page
type PostType = 'photo' | 'carousel' | 'video' | 'story' | 'text';
const typeOf = (p: { kind: string; photos: { kind: string }[] }): PostType =>
  p.kind === 'story' ? 'story' : p.photos.some((m) => m.kind === 'video') ? 'video' : p.photos.length > 1 ? 'carousel' : p.photos.length ? 'photo' : 'text';
const EMPTY: PostResult = { views: 0, reach: 0, likes: 0, comments: 0, shares: 0, saves: 0, insights: false, cmComments: 0, messages: 0, orders: 0, revenue: 0, delivered: 0 };
const interactions = (r: PostResult) => r.likes + r.comments + r.shares + r.saves;
/** one number to compare posts: an order weighs most, then the interactions, then the views */
const worth = (r: PostResult) => r.orders * 100 + interactions(r) + r.views / 100;

async function outPosts(ctx: Ctx, from: number, to: number) {
  const rows = await ctx.db.query(
    `SELECT p.*, pr.name AS product_name FROM cm_planned p LEFT JOIN products pr ON pr.id = p.product_id
     WHERE (p.fb_id IS NOT NULL OR p.ig_id IS NOT NULL) AND coalesce(p.published_at, p.publish_at) >= $1 AND coalesce(p.published_at, p.publish_at) < $2
     ORDER BY coalesce(p.published_at, p.publish_at) DESC LIMIT 400`,
    [new Date(from).toISOString(), new Date(to).toISOString()],
  );
  const media = await mediaOf(ctx, [...new Set(rows.flatMap((r: any) => ((r.media ?? []) as unknown[]).map(num)))]);
  const by = new Map(media.map((m) => [m.id, m]));
  const res = await postResults(
    ctx.db,
    rows.map((r: any) => num(r.id)),
  );
  return rows.map((r: any) => {
    const p = toPlanned(
      ctx,
      r,
      ((r.media ?? []) as unknown[]).map(num).flatMap((x) => (by.has(x) ? [by.get(x)!] : [])),
    );
    const at = Date.parse(p.publishedAt ?? p.publishAt ?? iso(r.updated_at));
    return { ...p, type: typeOf(p), at, results: res.get(p.id) ?? EMPTY };
  });
}

function totalsOf(posts: { results: PostResult }[]) {
  const sum = (k: keyof PostResult) => posts.reduce((a, p) => a + Number(p.results[k] ?? 0), 0);
  const t = { posts: posts.length, views: sum('views'), reach: sum('reach'), likes: sum('likes'), comments: sum('comments'), shares: sum('shares'), saves: sum('saves'), cmComments: sum('cmComments'), messages: sum('messages'), orders: sum('orders'), revenue: sum('revenue'), delivered: sum('delivered') };
  return { ...t, interactions: t.likes + t.comments + t.shares + t.saves };
}

/** Posts grouped (by hour, by day, by kind): how many, and how much each one did on average. */
function groupBy<K extends string | number>(posts: { results: PostResult }[], key: (p: any) => K) {
  const m = new Map<K, { key: K; posts: number; views: number; interactions: number; orders: number; worth: number }>();
  for (const p of posts) {
    const k = key(p);
    const g = m.get(k) ?? { key: k, posts: 0, views: 0, interactions: 0, orders: 0, worth: 0 };
    g.posts++;
    g.views += p.results.views;
    g.interactions += interactions(p.results);
    g.orders += p.results.orders;
    g.worth += worth(p.results);
    m.set(k, g);
  }
  return [...m.values()].map((g) => ({ key: g.key, posts: g.posts, views: Math.round(g.views / g.posts), interactions: Math.round(g.interactions / g.posts), orders: g.orders, worth: g.worth / g.posts }));
}
const bestOf = <T extends { worth: number; posts: number }>(groups: T[]) => [...groups].sort((a, b) => b.worth - a.worth || b.posts - a.posts)[0] ?? null;

// ---------------------------------------------------------------- procedures
const SlotInput = z.object({ days: z.array(z.number().int().min(0).max(6)).min(1).max(7), time: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'Heure HH:MM') });
const SettingsInput = z.object({
  slots: z.array(SlotInput).max(21),
  approval: z.boolean(),
  firstComment: z.object({ on: z.boolean(), text: z.string().trim().max(PLAN_LIMITS.firstComment) }),
});

export const cmSocialProcs = {
  'cm.plan.settings': proc([...PLAN_ROLES], z.object({}), (ctx) => socialSettings(ctx.db)),

  /** Réglages (administrator): the fixed times, the yes before a marketer's post goes out, the first comment. */
  'cm.plan.saveSettings': proc([], SettingsInput, async (ctx, i) => {
    const slots = i.slots.map((s) => ({ days: [...new Set(s.days)].sort(), time: s.time.padStart(5, '0') }));
    const value = { slots, approval: i.approval, firstComment: { on: i.firstComment.on, text: i.firstComment.text } };
    await setRaw(ctx.db, 'social', value, me(ctx));
    return socialSettings(ctx.db);
  }),

  /** A post dragged to another day on the calendar (its hour stays): a post that did not go out is planned again. */
  'cm.plan.move': proc([...PLAN_ROLES], z.object({ id, publishAt: z.string().datetime({ offset: true }) }), async (ctx, i) => {
    const r = await getRow(ctx.db, i.id);
    if (!['draft', 'review', 'scheduled', 'failed'].includes(r.status)) throw bad('Ce post est déjà sorti, ou il part en ce moment.');
    const at = Date.parse(i.publishAt);
    if (at < ctx.now() + 60_000) throw bad('Choisissez un jour et une heure à venir.');
    if (at > ctx.now() + 366 * DAY) throw bad('Un an à l’avance au plus.');
    const status = r.status === 'failed' ? ((await needsYes(ctx)) && !r.approved_at ? 'review' : 'scheduled') : r.status;
    await ctx.db.query(
      `UPDATE cm_planned SET publish_at = $2, status = $3, fb_error = CASE WHEN status = 'failed' THEN NULL ELSE fb_error END, ig_error = CASE WHEN status = 'failed' THEN NULL ELSE ig_error END, updated_by = $4, updated_at = $5 WHERE id = $1`,
      [i.id, i.publishAt, status, me(ctx), stamp(ctx)],
    );
    ctx.emit({ type: 'chat', data: { plan: i.id } });
    return planned(ctx, i.id);
  }),

  /** The administrator's answer to a post waiting for a yes: planned, or back to its writer with a word. */
  'cm.plan.review': proc([], z.object({ id, approve: z.boolean(), note: z.string().trim().max(300).default('') }), async (ctx, i) => {
    const r = await getRow(ctx.db, i.id);
    if (r.status !== 'review') throw bad('Ce post n’attend plus de validation.');
    if (i.approve) {
      const pb = await firstProblem(ctx, r);
      if (pb) throw bad(pb);
      await ctx.db.query(`UPDATE cm_planned SET status = 'scheduled', approved_by = $2, approved_at = $3, review_note = NULL, updated_at = $3 WHERE id = $1`, [i.id, me(ctx), stamp(ctx)]);
    } else {
      await ctx.db.query(`UPDATE cm_planned SET status = 'draft', review_note = $2, updated_by = $3, updated_at = $4 WHERE id = $1`, [i.id, i.note || 'À revoir', me(ctx), stamp(ctx)]);
    }
    ctx.emit({ type: 'chat', data: { plan: i.id } });
    return planned(ctx, i.id);
  }),

  /** Plans several drafts at once (« Fill my week »): each one checked as when it is planned alone. */
  'cm.plan.planMany': proc([...PLAN_ROLES], z.object({ ids: z.array(id).min(1).max(30) }), async (ctx, i) => {
    const yes = !(await needsYes(ctx));
    let done = 0;
    const skipped: { id: number; problem: string }[] = [];
    for (const pid of [...new Set(i.ids)]) {
      const r = (await ctx.db.query(`SELECT * FROM cm_planned WHERE id = $1`, [pid]))[0];
      if (!r || r.status !== 'draft') {
        skipped.push({ id: pid, problem: 'Déjà planifié ou sorti.' });
        continue;
      }
      const pb = await firstProblem(ctx, r);
      if (pb) {
        skipped.push({ id: pid, problem: pb });
        continue;
      }
      await ctx.db.query(`UPDATE cm_planned SET status = $2, updated_by = $3, updated_at = $4 WHERE id = $1 AND status = 'draft'`, [pid, yes ? 'scheduled' : 'review', me(ctx), stamp(ctx)]);
      done++;
    }
    ctx.emit({ type: 'chat', data: { plan: 0 } });
    return { planned: yes ? done : 0, review: yes ? 0 : done, skipped };
  }),

  /** « Post again »: a post that sold comes back as a draft, with the same photos (while Pilotix has them) and new words. */
  'cm.plan.again': proc([...PLAN_ROLES], z.object({ id, lang: z.enum(PLAN_LANGS).optional() }), async (ctx, i) => {
    const r = await getRow(ctx.db, i.id);
    if (!r.fb_id && !r.ig_id) throw bad('Seul un post sorti peut repartir.');
    const ids = ((r.media ?? []) as unknown[]).map(num);
    const media = await mediaOf(ctx, ids);
    const keep = media.length === ids.length && media.every((m) => (m.kind === 'video' ? m.ready : m.hasJpeg || !!m.src)) ? ids : [];
    const lang = (i.lang ?? r.ai_lang ?? 'darija') as PlanLang;
    const channels = PLAN_CHANNELS.filter((c) => ((r.channels ?? []) as string[]).includes(c));
    const story = r.kind === 'story';
    const caption = story
      ? ''
      : (await writeCaption(ctx, { productId: numOrNull(r.product_id), idea: 'Le même post, dit autrement : une nouvelle première ligne, les mêmes informations', lang, channels, current: String(r.caption ?? ''), fix: [] })).caption;
    const s = await socialSettings(ctx.db);
    const after = ctx.now() + 2 * HOUR;
    const slot = nextSlot(s.slots, after, await takenTimes(ctx, after, after + 32 * DAY));
    const created = await ctx.db.query(
      `INSERT INTO cm_planned (caption, media, channels, product_id, publish_at, status, ai_lang, created_by, updated_by, created_at, updated_at, kind, first_comment, again_of)
       VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$7,$8,$8,$9,$10,$11) RETURNING id`,
      [caption, keep, channels, r.product_id ?? null, slot ? new Date(slot).toISOString() : null, lang, me(ctx), stamp(ctx), story ? 'story' : 'post', story ? null : r.first_comment ?? null, num(r.id)],
    );
    ctx.emit({ type: 'chat', data: { plan: num(created[0].id) } });
    return { post: await planned(ctx, num(created[0].id)), mediaKept: keep.length > 0 };
  }),

  /**
   * « Fill my week »: drafts for the next 7 days on the shop's fixed times (else its best hours, else 20:00), each for a
   * product (a best seller of the last 30 days, a new one, one not posted for 3 weeks, in turn) or for a day of the
   * Algerian calendar coming; the AI writes each caption, the photos of the product's last post come along when Pilotix
   * still has them. The person checks them, then plans them (cm.plan.planMany).
   */
  'cm.plan.fillWeek': proc([...PLAN_ROLES], z.object({ count: z.number().int().min(1).max(7).default(5), lang: z.enum(PLAN_LANGS).default('darija') }), async (ctx, i) => {
    const acc = await planAccounts(ctx);
    const channels = PLAN_CHANNELS.filter((c) => (c === 'facebook' ? acc.facebook : acc.instagram));
    if (!channels.length) throw bad('Liez d’abord une Page Facebook ou un compte Instagram (Pilot AI › Comptes).');
    const s = await socialSettings(ctx.db);
    const now = ctx.now();
    const end = now + 7 * DAY;
    const taken = await takenTimes(ctx, now, end + DAY);
    const times: number[] = [];
    for (let after = now + 30 * 60_000; times.length < i.count; ) {
      const t = nextSlot(s.slots, after, [...taken, ...times], 8);
      if (t === null || t > end) break;
      times.push(t);
      after = t;
    }
    // no fixed time left: the best hour of each day from tomorrow
    const hour = (await bestHours(ctx.db, now))[0]?.hour ?? 20;
    for (let d = 1; times.length < i.count && d <= 7; d++) {
      const day = Math.floor((now + OFF) / DAY) + d;
      const t = day * DAY - OFF + hour * HOUR;
      if (![...taken, ...times].some((x) => Math.abs(x - t) < 30 * 60_000)) times.push(t);
    }
    times.sort((a, b) => a - b);
    const prods = await ctx.db.query(
      `SELECT p.id, p.name, p.price, p.created_at,
         (SELECT count(*) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.product_id = p.id AND o.created_at > $1)::int AS sold,
         (SELECT max(coalesce(c.publish_at, c.created_at)) FROM cm_planned c WHERE c.product_id = p.id) AS last_plan,
         EXISTS (SELECT 1 FROM cm_planned c WHERE c.product_id = p.id AND c.publish_at >= $2 AND c.publish_at < $3 AND c.status <> 'failed') AS this_week
       FROM products p WHERE p.active AND p.archived_at IS NULL AND NOT p.is_service ORDER BY p.id LIMIT 500`,
      [new Date(now - 30 * DAY).toISOString(), new Date(now).toISOString(), new Date(end).toISOString()],
    );
    const free = prods.filter((p: any) => !p.this_week);
    const lists = {
      best: [...free].filter((p: any) => num(p.sold) > 0).sort((a: any, b: any) => num(b.sold) - num(a.sold)),
      new: free.filter((p: any) => Date.parse(iso(p.created_at)) > now - 21 * DAY).sort((a: any, b: any) => Date.parse(iso(b.created_at)) - Date.parse(iso(a.created_at))),
      quiet: free.filter((p: any) => !p.last_plan || Date.parse(iso(p.last_plan)) < now - 21 * DAY),
    };
    const used = new Set<number>();
    const picks: { product: any | null; why: keyof typeof WHY_IDEA | 'event'; event?: DzEventKey; at: number }[] = [];
    // a day of the Algerian calendar whose time to post falls this week takes the first time in its window
    for (const e of dzEvents(ymd(now), ymd(end + 30 * DAY))) {
      const day = Date.parse(e.date) - OFF;
      const slot = times.find((t) => t >= day - e.lead * DAY && t < day + DAY && !picks.some((p) => p.at === t));
      if (slot !== undefined && picks.filter((p) => p.why === 'event').length < 2) picks.push({ product: lists.best[0] ?? null, why: 'event', event: e.key, at: slot });
    }
    const order: (keyof typeof WHY_IDEA)[] = ['best', 'new', 'quiet'];
    for (const t of times) {
      if (picks.some((p) => p.at === t)) continue;
      let pick: { product: any; why: keyof typeof WHY_IDEA } | null = null;
      for (let k = 0; k < order.length && !pick; k++) {
        const why = order[(picks.length + k) % order.length];
        const p = lists[why].find((x: any) => !used.has(num(x.id)));
        if (p) pick = { product: p, why };
      }
      if (!pick) break;
      used.add(num(pick.product.id));
      picks.push({ ...pick, at: t });
    }
    if (!picks.length) throw bad('Aucun produit actif à présenter : ajoutez un produit dans Produits & stock.');
    picks.sort((a, b) => a.at - b.at);
    const out: number[] = [];
    let ai = false;
    for (const p of picks) {
      const productId = p.product ? num(p.product.id) : null;
      const idea = p.why === 'event' ? EVENT_IDEA[p.event!] : WHY_IDEA[p.why];
      const cap = await writeCaption(ctx, { productId, idea, lang: i.lang, channels, current: '', fix: [] });
      ai ||= cap.by === 'ai';
      const media = productId ? await productMedia(ctx, productId) : [];
      const r = await ctx.db.query(
        `INSERT INTO cm_planned (caption, media, channels, product_id, publish_at, status, ai_lang, created_by, updated_by, created_at, updated_at, kind, first_comment, event_key)
         VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$7,$8,$8,'post',$9,$10) RETURNING id`,
        [cap.caption, media, channels, productId, new Date(p.at).toISOString(), i.lang, me(ctx), stamp(ctx), s.firstComment.on && s.firstComment.text.trim() ? s.firstComment.text.trim() : null, p.event ?? null],
      );
      out.push(num(r[0].id));
    }
    ctx.emit({ type: 'chat', data: { plan: 0 } });
    return { posts: await Promise.all(out.map((x) => planned(ctx, x))), ai, why: picks.map((p) => (p.why === 'event' ? `event:${p.event}` : p.why)) };
  }),

  /**
   * Results: the posts that went out in the period with what each one did, the totals, the followers, the best posts,
   * the best hours, days and kinds, and this week against the one before with what to do next.
   */
  'cm.plan.stats': proc([...PLAN_ROLES], z.object({ days: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]).default(30) }), async (ctx, i) => {
    const now = ctx.now();
    const from = now - i.days * DAY;
    const posts = await outPosts(ctx, from, now + DAY);
    const totals = totalsOf(posts);
    // the followers of each day (one number a day and a network, the job writes it)
    const fd = await ctx.db.query(`SELECT day, channel, followers FROM cm_follow_days WHERE day >= $1::date ORDER BY day`, [ymd(from - DAY)]);
    const followers = Object.fromEntries(
      PLAN_CHANNELS.map((ch) => {
        const series = fd.filter((r: any) => r.channel === ch).map((r: any) => ({ day: String(iso(r.day)).slice(0, 10), n: num(r.followers) }));
        return [ch, series.length ? { now: series[series.length - 1].n, change: series[series.length - 1].n - series[0].n, series } : null];
      }),
    ) as Record<'facebook' | 'instagram', { now: number; change: number; series: { day: string; n: number }[] } | null>;
    const byHour = groupBy(posts, (p) => algHour(p.at)).sort((a, b) => a.key - b.key);
    const byDay = groupBy(posts, (p) => algDay(p.at)).sort((a, b) => a.key - b.key);
    const byType = groupBy(posts, (p) => p.type as PostType).sort((a, b) => b.worth - a.worth);
    const best = [...posts].sort((a, b) => worth(b.results) - worth(a.results)).slice(0, 3);
    // this week against the one before
    const two = await outPosts(ctx, now - 14 * DAY, now + DAY);
    const week = two.filter((p) => p.at >= now - 7 * DAY);
    const prev = two.filter((p) => p.at < now - 7 * DAY);
    const tips: { key: 'hour' | 'type' | 'again' | 'quiet' | 'event' | 'more' | 'insights'; hour?: number; type?: string; id?: number; caption?: string; n?: number; event?: string; date?: string; inDays?: number }[] = [];
    const insights = posts.some((p) => p.results.insights);
    if (posts.length && !insights) tips.push({ key: 'insights' });
    const bh = bestOf(byHour);
    if (bh && posts.length >= 3) tips.push({ key: 'hour', hour: bh.key });
    const bt = bestOf(byType);
    if (bt && byType.length > 1) tips.push({ key: 'type', type: bt.key });
    const win = [...posts].filter((p) => p.at < now - 7 * DAY && p.results.orders > 0).sort((a, b) => worth(b.results) - worth(a.results))[0];
    if (win) tips.push({ key: 'again', id: win.id, caption: win.caption.split('\n')[0].slice(0, 80), n: win.results.orders });
    if (week.length < 3) tips.push({ key: 'more', n: week.length });
    const quiet = num(
      (
        await ctx.db.query(
          `SELECT count(*)::int AS n FROM products p WHERE p.active AND p.archived_at IS NULL AND NOT p.is_service
           AND NOT EXISTS (SELECT 1 FROM cm_planned c WHERE c.product_id = p.id AND coalesce(c.publish_at, c.created_at) > $1)`,
          [new Date(now - 21 * DAY).toISOString()],
        )
      )[0]?.n,
    );
    if (quiet) tips.push({ key: 'quiet', n: quiet });
    const ev = dzEvents(ymd(now), ymd(now + 30 * DAY))[0];
    if (ev) tips.push({ key: 'event', event: ev.key, date: ev.date, inDays: Math.max(0, Math.round((Date.parse(ev.date) - (now + OFF - ((now + OFF) % DAY))) / DAY)) });
    const updated = (await ctx.db.query(`SELECT max(fetched_at) AS at FROM cm_post_stats`))[0]?.at;
    return {
      days: i.days,
      posts: posts.map(({ at: _at, ...p }) => p),
      totals,
      followers,
      best: best.map(({ at: _at, ...p }) => p),
      byHour: byHour.map(({ worth: _w, ...g }) => g),
      byDay: byDay.map(({ worth: _w, ...g }) => g),
      byType: byType.map(({ worth: _w, ...g }) => g),
      bestHour: bh?.key ?? null,
      bestDay: bestOf(byDay)?.key ?? null,
      bestType: bt?.key ?? null,
      week: { now: totalsOf(week), prev: totalsOf(prev), best: week.length ? (({ at: _at, ...p }) => p)([...week].sort((a, b) => worth(b.results) - worth(a.results))[0]) : null, tips },
      insights,
      updatedAt: updated ? iso(updated) : null,
    };
  }),

  /** The job (every minute): the posts whose time has come go out, then Meta's numbers come again when they are due. */
  'cm.plan.run': proc([], z.object({}), async (ctx) => {
    const r = await runPlanned(ctx);
    const stats = await refreshStats(ctx).catch(() => 0);
    return { ...r, stats };
  }),
};
