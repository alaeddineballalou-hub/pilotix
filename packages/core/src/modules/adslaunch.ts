// Pilot Ads › Lancer une pub: what the launcher needs (the products with what a delivered order may cost, their sales
// pages, the shop's photos and videos, the Page, Instagram, the pixel, the forms, the wilayas that deliver well), the
// ad's words (Pilot AI, or ready sentences in the demo), the launches themselves (a draft, waiting for the owner's yes,
// live, failed) and what goes to Meta.
//
// A launch is sent to Meta all PAUSED (campaign, ad sets, créas, ads), then turned on in one go. A retry after a
// failure goes on where it stopped (the ids Meta gave are kept) and creates nothing twice. In the demo (no server)
// nothing leaves Pilotix: the launch gets made-up ids and appears in « Mes pubs » at once.
import { normalizePhone, WILAYAS } from '@pilotix/shared';
import { z } from 'zod';
import { Db, num, numOrNull } from '../db';
import { bad, Ctx, forbidden, notFound, proc, publicApi, withActionLock } from '../rpc';
import { getSetting } from '../settings';
import { getRaw, setRaw } from './admin';
import { addDays, fxTable, isOwner, moneyOf, ordersOf } from './ads';
import { audienceIds, pilotSettings, shopDailyUsd, wilayaRates, type AccountHealth } from './adsmgr';
import { B64, mediaOf, mediaView, PLAN_LIMITS, VIDEO_CHUNK, VIDEO_TYPES, type MediaRow } from './cmplan';
import { aiKeyed, dellalSettings, PILOT_CHEAP_MODEL, pilotOn, type AiResponse } from './dellal';
import { landingStore } from './landingquery';
import { fieldOf } from './leads';
import { budgetPacks, CHANNELS, GOAL_META, GOALS, launchProblems, limitOf, metaPlan, type Goal, type LaunchInput, type LaunchMedia } from './pilotads';
import { linkedPage } from './social';

const algDay = (ms: number) => new Date(ms + 3_600_000).toISOString().slice(0, 10);
const me = (ctx: Ctx) => ctx.session.profile.id || null;
const stamp = (ctx: Ctx) => new Date(ctx.now()).toISOString();
const extOf = (mime: string | null | undefined) => (mime === 'video/quicktime' ? 'mov' : 'mp4');
const randomKey = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
/** a marketer partner's person given some products only: those, else null (every product) */
const givenOf = (ctx: Ctx): Set<number> | null => (ctx.session.profile.agencyId && ctx.session.profile.agencyProducts ? new Set(ctx.session.profile.agencyProducts) : null);
const partner = (ctx: Ctx) => ctx.session.profile.agencyId !== null && ctx.session.profile.agencyId !== undefined;
const LAST_KEY = 'pilot_ads_last';
/** the demo's pages have no real address: one that looks like the shop's */
const DEMO_BASE = 'https://go.pilotix.app';

// ---------------------------------------------------------------- what an order may cost, per product
export interface ProductLimit {
  id: number;
  name: string;
  price: number;
  photo: string | null;
  /** the 90 last days: orders received, delivered, returned */
  received: number;
  delivered: number;
  returned: number;
  /** share of settled parcels that arrive (0–1) */
  share: number;
  /** what one delivered order leaves before ads (DA): the product's own numbers, or worked out from its price */
  perDelivered: number;
  estimated: boolean;
  limit: ReturnType<typeof limitOf>;
  packs: ReturnType<typeof budgetPacks>;
  landing: { id: number; slug: string; title: string; url: string; pixelId: string | null } | null;
}

/** The products the launcher offers, with what an order may cost each (one read of the orders for all of them). */
export async function productLimits(ctx: Ctx, onlyId?: number | null): Promise<ProductLimit[]> {
  const today = algDay(ctx.now());
  const rate = (await fxTable(ctx.db))(today.slice(0, 7));
  const given = givenOf(ctx);
  const rows = (await ctx.db.query(`SELECT id, name, price, cost, photo FROM products WHERE active AND NOT is_service AND archived_at IS NULL ORDER BY lower(name), id LIMIT 300`)).filter(
    (p: any) => (!given || given.has(num(p.id))) && (!onlyId || num(p.id) === onlyId),
  );
  if (!rows.length) return [];
  const orders = await ordersOf(ctx.db, rows.map((p: any) => num(p.id)), addDays(today, -89), today);
  const by = new Map<number, any[]>();
  for (const o of orders) by.set(num(o.product_id), [...(by.get(num(o.product_id)) ?? []), o]);
  // the shop's own averages, for a product with too few orders yet
  const avg = (
    await ctx.db.query(
      `SELECT avg(delivery_cost) FILTER (WHERE follow_status IN ('delivered','exchanged')) AS liv,
              count(*) FILTER (WHERE follow_status IN ('delivered','exchanged')) AS d, count(*) FILTER (WHERE follow_status IN ('returned','lost')) AS r
       FROM sales WHERE created_at >= $1`,
      [new Date(ctx.now() - 90 * 86_400_000).toISOString()],
    )
  )[0];
  const shopShare = num(avg?.d) + num(avg?.r) >= 20 ? num(avg.d) / (num(avg.d) + num(avg.r)) : 0.65;
  const plans = await getSetting(ctx.db, 'payPlans');
  const pages = await ctx.db.query(`SELECT id, slug, title, product_id, pixel_id FROM landing_pages WHERE active ORDER BY id DESC`).catch(() => []);
  const base = (ctx.server?.pagesUrl?.() || ctx.server?.publicUrl || (ctx.server ? '' : DEMO_BASE)).replace(/\/+$/, '');
  const store = await landingStore(ctx.db);
  const out: ProductLimit[] = [];
  for (const p of rows) {
    const id = num(p.id);
    const m = await moneyOf(ctx.db, by.get(id) ?? [], 0);
    const settled = m.d + m.r;
    const share = settled >= 10 ? m.d / settled : shopShare;
    const estimated = m.d < 5;
    const price = num(p.price);
    const agent = price >= plans.agent.threshold ? plans.agent.above : plans.agent.below;
    // no numbers yet: price − purchase − delivery − the agent, and the returns' cost carried by each delivered order
    const perDelivered = estimated ? price - num(p.cost) - num(avg?.liv ?? 600) - agent - ((1 - share) / Math.max(share, 0.2)) * 300 : m.avant / m.d;
    const limit = limitOf(perDelivered, rate);
    const lp = pages.find((x: any) => num(x.product_id) === id);
    out.push({
      id,
      name: String(p.name),
      price,
      photo: p.photo && String(p.photo).length < 200_000 ? String(p.photo) : null,
      received: m.n,
      delivered: m.d,
      returned: m.r,
      share: Math.round(share * 100) / 100,
      perDelivered: Math.round(perDelivered),
      estimated,
      limit,
      packs: budgetPacks(limit.targetUsd),
      landing: lp ? { id: num(lp.id), slug: String(lp.slug), title: String(lp.title ?? lp.slug), url: base ? `${base}/${store ? `${store}/` : ''}${lp.slug}` : '', pixelId: lp.pixel_id ? String(lp.pixel_id) : null } : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------- the launcher's choices
async function account(ctx: Ctx): Promise<{ id: string; currency: string; name: string; status: number | null } | null> {
  const meta = await getSetting(ctx.db, 'meta');
  const id = String(meta.adAccountId ?? '').replace(/^act_/, '');
  const known = await getRaw<AccountHealth[]>(ctx.db, 'pilot_ads_accounts', []);
  const h = known.find((a) => a.id === id);
  if (h) return { id, currency: h.currency, name: h.name, status: h.status };
  const cur = (await ctx.db.query(`SELECT currency, count(*) AS n FROM adsets WHERE currency IS NOT NULL GROUP BY currency ORDER BY n DESC LIMIT 1`))[0]?.currency;
  if (id) return { id, currency: String(cur ?? 'USD').toUpperCase(), name: '', status: null };
  // the demo: a dollar account
  return ctx.server ? null : { id: '120211887', currency: 'USD', name: 'Compte pub démo', status: 1 };
}

/** the shop's Facebook Page and Instagram (the demo: made-up ones) */
async function pageOf(ctx: Ctx) {
  return (await linkedPage(ctx.db)) ?? (ctx.server ? null : { pageId: '104500000000001', name: 'Bébé Confort DZ', igId: '178400000000001', igUsername: 'bebeconfort.dz', account: '' });
}
/** the shop's Meta pixels, the main one first */
async function pixelsOf(ctx: Ctx): Promise<{ id: string; name: string; main: boolean }[]> {
  const pixels = (await ctx.db.query(`SELECT pixel_id, name, is_default FROM tracking_pixels WHERE platform = 'meta' ORDER BY is_default DESC, id`).catch(() => [])).map((r: any) => ({ id: String(r.pixel_id), name: String(r.name ?? r.pixel_id), main: !!r.is_default }));
  const landing = await getSetting(ctx.db, 'landing');
  if (landing.pixelId && !pixels.some((x) => x.id === landing.pixelId)) pixels.unshift({ id: String(landing.pixelId), name: 'Pixel des pages', main: true });
  return pixels;
}

async function options(ctx: Ctx) {
  const today = algDay(ctx.now());
  const rate = (await fxTable(ctx.db))(today.slice(0, 7));
  const page = await pageOf(ctx);
  const pixels = await pixelsOf(ctx);
  const forms = (await ctx.db.query(`SELECT form_id, name, product_id, meta_status FROM lead_forms WHERE active ORDER BY id DESC LIMIT 50`).catch(() => [])).map((r: any) => ({ id: String(r.form_id), name: String(r.name), productId: numOrNull(r.product_id), status: String(r.meta_status) }));
  const posts = (await ctx.db.query(`SELECT fb_id, caption, published_at FROM cm_planned WHERE status = 'published' AND fb_id IS NOT NULL ORDER BY published_at DESC LIMIT 12`).catch(() => [])).map((r: any) => ({ id: String(r.fb_id), text: String(r.caption ?? '').slice(0, 120), at: r.published_at ? new Date(r.published_at).toISOString() : null }));
  const rates = await wilayaRates(ctx.db, ctx.now());
  const wilayas = WILAYAS.map((name, k) => {
    const r = rates.get(k + 1) ?? { settled: 0, delivered: 0 };
    const pct = r.settled ? Math.round((r.delivered / r.settled) * 100) : null;
    return { id: k + 1, name, settled: r.settled, delivered: r.delivered, rate: pct, weak: r.settled >= 10 && pct !== null && pct < 50 };
  });
  const aud = await audienceIds(ctx.db);
  const s = await pilotSettings(ctx.db);
  const last = await getRaw<{ privacyUrl?: string; phone?: string }>(ctx.db, LAST_KEY, {});
  const shop = await getSetting(ctx.db, 'shop');
  return {
    owner: isOwner(ctx),
    demo: !ctx.server,
    ai: !ctx.server ? !!ctx.dellalAi : await aiKeyed(ctx),
    rate,
    account: await account(ctx),
    page,
    pixels,
    forms,
    posts,
    wilayas,
    audiences: aud.list,
    guard: s.guard,
    goals: GOALS.map((g) => ({ goal: g, objective: GOAL_META[g].objective })),
    phone: last.phone ?? (normalizePhone(shop.savPhone ?? '') ? `+213${normalizePhone(shop.savPhone)!.slice(1)}` : ''),
    privacyUrl: last.privacyUrl ?? '',
    products: await productLimits(ctx),
  };
}

// ---------------------------------------------------------------- the ad's words
export type CopyLang = 'darija' | 'fr' | 'ar';
/** 12 900: a space that never breaks the number in two (the words wrap around it) */
const da = (n: number) => Math.round(n).toLocaleString('fr-FR').replace(/[\s\u202f\u00a0]/g, '\u00a0');
/** Ready sentences (the demo, or when the AI cannot answer): three angles, no promise Meta would refuse. */
export function demoCopy(lang: CopyLang, p: { name: string; price: number }, goal: Goal): { variants: { primary: string; headline: string }[]; welcome: { text: string; questions: string[] } } {
  const price = da(p.price);
  const ask =
    goal === 'messages' ? { darija: '💬 ابعثلنا ميساج و نجاوبوك دركا', fr: '💬 Écrivez-nous, on vous répond tout de suite', ar: '💬 راسلنا ونرد عليك فورا' }
    : goal === 'calls' ? { darija: '📞 عيطلنا و اطلب في دقيقة', fr: '📞 Appelez-nous et commandez en une minute', ar: '📞 اتصل بنا واطلب في دقيقة' }
    : goal === 'form' ? { darija: '📝 عمّر الفورمولار و نعيطولك نأكدو', fr: '📝 Remplissez le formulaire, on vous rappelle pour confirmer', ar: '📝 املأ الاستمارة ونتصل بك للتأكيد' }
    : { darija: '👇 اطلب دركا من الموقع', fr: '👇 Commandez maintenant sur le site', ar: '👇 اطلب الآن من الموقع' };
  const T = {
    darija: [
      { primary: `🔥 ${p.name} بـ ${price} دج برك!\n✅ الخلاص عند الاستلام\n🚚 التوصيل لكل الولايات\n${ask.darija}`, headline: `${p.name} · ${price} دج` },
      { primary: `تعبت و ما لقيتش الحل؟ ${p.name} هو اللي يريحك 👌\n✅ تشوف السلعة قبل ما تخلص\n🚚 توصيل للدار ولا للمكتب\n${ask.darija}`, headline: 'الخلاص عند الاستلام' },
      { primary: `${p.name} ✨\nالكمية محدودة، ما تفوتش الفرصة\n💵 ${price} دج و الخلاص كي توصلك\n${ask.darija}`, headline: `اطلب ${p.name}` },
    ],
    fr: [
      { primary: `🔥 ${p.name} à ${price} DA seulement\n✅ Paiement à la livraison\n🚚 Livraison dans toute l’Algérie\n${ask.fr}`, headline: `${p.name} · ${price} DA` },
      { primary: `Vous cherchez une solution simple ? ${p.name} 👌\n✅ Vous vérifiez avant de payer\n🚚 À domicile ou au bureau\n${ask.fr}`, headline: 'Paiement à la livraison' },
      { primary: `${p.name} ✨\nQuantité limitée\n💵 ${price} DA, payés à la réception\n${ask.fr}`, headline: `Commandez ${p.name}` },
    ],
    ar: [
      { primary: `🔥 ${p.name} بـ ${price} دج فقط\n✅ الدفع عند الاستلام\n🚚 التوصيل إلى كل الولايات\n${ask.ar}`, headline: `${p.name} · ${price} دج` },
      { primary: `تبحث عن حل بسيط؟ ${p.name} 👌\n✅ تتحقق من المنتج قبل الدفع\n🚚 إلى المنزل أو المكتب\n${ask.ar}`, headline: 'الدفع عند الاستلام' },
      { primary: `${p.name} ✨\nالكمية محدودة\n💵 ${price} دج تدفعها عند الاستلام\n${ask.ar}`, headline: `اطلب ${p.name}` },
    ],
  };
  const W = {
    darija: { text: `مرحبا بيك 👋 حاب تعرف على ${p.name}؟`, questions: ['شحال السعر؟', 'كيفاش نطلب؟', 'كاين التوصيل لولايتي؟'] },
    fr: { text: `Bonjour 👋 Vous voulez en savoir plus sur ${p.name} ?`, questions: ['Quel est le prix ?', 'Comment commander ?', 'Vous livrez dans ma wilaya ?'] },
    ar: { text: `مرحبا 👋 تريد معرفة المزيد عن ${p.name}؟`, questions: ['ما هو السعر؟', 'كيف أطلب؟', 'هل التوصيل متوفر في ولايتي؟'] },
  };
  return { variants: T[lang], welcome: W[lang] };
}

const COPY_SYSTEM = `Tu écris des publicités Facebook et Instagram pour une boutique algérienne qui vend en paiement à la livraison.
Règles :
- 3 versions différentes (prix et offre, problème puis solution, confiance : on vérifie avant de payer).
- Texte court : 2 à 5 lignes, des emojis sobres, le prix en dinars (DA ou دج), « paiement à la livraison », une action claire à la fin.
- Jamais de promesse que Meta refuse ou qui serait fausse : pas de « 100 % garanti », pas de résultat médical, pas d’avant/après, pas de faux avis, pas de fausse urgence chiffrée.
- Darija : la darija algérienne en lettres arabes, comme les vendeurs l’écrivent (pas l’arabe du Moyen-Orient).
- Le titre : 40 caractères au plus.
Réponds seulement avec ce JSON : {"variants":[{"primary":"…","headline":"…"},…],"welcome":{"text":"…","questions":["…","…","…"]}}`;

async function writeCopy(ctx: Ctx, i: { productId: number; goal: Goal; lang: CopyLang; idea: string }) {
  const p = (await ctx.db.query(`SELECT id, name, price FROM products WHERE id = $1`, [i.productId]))[0];
  if (!p) throw notFound('Produit introuvable');
  const given = givenOf(ctx);
  if (given && !given.has(num(p.id))) throw forbidden();
  const product = { name: String(p.name), price: num(p.price) };
  const ready = demoCopy(i.lang, product, i.goal);
  const inPage = !ctx.server?.dellal && ctx.dellalAi ? ctx.dellalAi : null;
  if (!inPage && !(await aiKeyed(ctx))) return { ...ready, by: 'ready' as const };
  try {
    const pilot = !inPage && (await pilotOn(ctx));
    const model = pilot ? PILOT_CHEAP_MODEL : (await dellalSettings(ctx.db)).model;
    const user = `Produit : ${product.name}\nPrix : ${product.price} DA\nObjectif de la pub : ${i.goal}\nLangue : ${i.lang === 'darija' ? 'darija algérienne (lettres arabes)' : i.lang === 'fr' ? 'français' : 'arabe simple'}${i.idea.trim() ? `\nIdée du vendeur : ${i.idea.trim().slice(0, 400)}` : ''}`;
    const req = { model, system: COPY_SYSTEM, messages: [{ role: 'user' as const, content: user }], tools: [], max_tokens: 900 };
    const res = (inPage ? await inPage({ ...req, runTool: async () => ({ error: 'Pas d’outil ici' }) }) : await ctx.server!.dellal!('complete', { ...req, feature: 'other', pilot }, ctx)) as AiResponse;
    const text = res.content.map((b: any) => (b.type === 'text' ? b.text : '')).join('');
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    const variants = (Array.isArray(json?.variants) ? json.variants : [])
      .map((v: any) => ({ primary: String(v?.primary ?? '').slice(0, 2000).trim(), headline: String(v?.headline ?? '').slice(0, 80).trim() }))
      .filter((v: any) => v.primary)
      .slice(0, 3);
    if (!variants.length) throw new Error('vide');
    const w = json?.welcome;
    const welcome = w?.text ? { text: String(w.text).slice(0, 300), questions: (Array.isArray(w.questions) ? w.questions : []).map((q: any) => String(q).slice(0, 80)).filter(Boolean).slice(0, 3) } : ready.welcome;
    return { variants, welcome, by: 'ai' as const };
  } catch {
    return { ...ready, by: 'ready' as const };
  }
}

// ---------------------------------------------------------------- the launch itself
export const LaunchSpec = z.object({
  goal: z.enum(GOALS),
  productId: z.number().int().positive().nullable(),
  name: z.string().trim().min(1).max(200),
  mediaIds: z.array(z.number().int().positive()).max(10).default([]),
  text: z.object({ primary: z.string().max(2000), headline: z.string().max(255) }),
  channels: z.array(z.enum(CHANNELS)).max(3).default(['messenger']),
  welcome: z.object({ text: z.string().max(300), questions: z.array(z.string().max(80)).max(3) }).nullable().default(null),
  phone: z.string().max(20).nullable().default(null),
  formId: z.string().regex(/^\d{5,25}$/).nullable().default(null),
  /** a new instant form, made on the Page at launch */
  newForm: z.object({ name: z.string().trim().min(1).max(100), commune: z.boolean(), variant: z.boolean(), privacyUrl: z.string().url().max(500), lang: z.enum(['fr', 'ar']) }).nullable().default(null),
  postId: z.string().regex(/^\d{5,25}(_\d{5,25})?$/).nullable().default(null),
  budgetUsd: z.number().min(1).max(10_000),
  budgetLevel: z.enum(['campaign', 'adset']).default('campaign'),
  split: z.enum(['one', 'perMedia']).default('one'),
  excludeWilayas: z.array(z.number().int().min(1).max(69)).max(69).default([]),
  ageMin: z.number().int().min(18).max(65).default(18),
  ageMax: z.number().int().min(18).max(65).default(65),
  genders: z.array(z.union([z.literal(1), z.literal(2)])).max(2).default([]),
  advantageAudience: z.boolean().default(true),
  useAudiences: z.boolean().default(true),
  bid: z.object({ strategy: z.enum(['LOWEST_COST_WITHOUT_CAP', 'COST_CAP', 'LOWEST_COST_WITH_BID_CAP']), usd: z.number().positive().max(10_000).nullable() }).nullable().default(null),
  start: z.string().datetime({ offset: true }).nullable().default(null),
  pixelId: z.string().regex(/^\d{6,25}$/).nullable().default(null),
});
export type LaunchSpec = z.infer<typeof LaunchSpec>;

type Status = 'draft' | 'waiting_yes' | 'launching' | 'live' | 'failed' | 'refused';
const view = (r: any) => ({
  id: num(r.id),
  mode: String(r.mode) as 'simple' | 'pro',
  goal: String(r.goal) as Goal,
  productId: numOrNull(r.product_id),
  productName: r.product_name ?? null,
  name: String(r.name),
  spec: r.spec as LaunchSpec,
  budgetUsd: Number(r.spec?.budgetUsd ?? 0),
  status: String(r.status) as Status,
  step: r.step ?? null,
  error: r.error ?? null,
  campaignId: r.campaign_id ?? null,
  adsetIds: (r.adset_ids ?? []).map(String),
  by: r.by_name ?? null,
  byUser: numOrNull(r.by_user),
  approvedBy: r.approved_name ?? null,
  createdAt: new Date(r.created_at).toISOString(),
  liveAt: r.live_at ? new Date(r.live_at).toISOString() : null,
});
async function launchRow(db: Db, id: number) {
  const r = (await db.query(`SELECT l.*, p.name AS product_name, u.name AS by_name, a.name AS approved_name FROM ad_launches l LEFT JOIN products p ON p.id = l.product_id LEFT JOIN profiles u ON u.id = l.by_user LEFT JOIN profiles a ON a.id = l.approved_by WHERE l.id = $1`, [id]))[0];
  if (!r) throw notFound('Lancement introuvable');
  return r;
}
/** a marketer sees his own launches (and the owner every one) */
function mayOpen(ctx: Ctx, r: any) {
  if (isOwner(ctx)) return;
  if (numOrNull(r.by_user) !== me(ctx)) throw forbidden();
}

/** Accents and words Meta adds (« Province ») away: « Béjaïa » and « Bejaia Province » are the same. */
const plain = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’]/g, '').replace(/\b(province|wilaya|of|de|d)\b/g, ' ').replace(/[^a-z]+/g, ' ').trim();
const ALIASES: Record<string, string[]> = { alger: ['algiers', 'alger'], tamanrasset: ['tamanrasset', 'tamanghasset'], bejaia: ['bejaia', 'bgayet'], msila: ['msila', 'm sila'], tipaza: ['tipaza', 'tipasa'] };
export function regionMatches(wilaya: string, metaName: string): boolean {
  const w = plain(wilaya).replace(/\s+/g, '');
  const m = plain(metaName).replace(/\s+/g, '');
  return (ALIASES[w] ?? [w]).some((a) => m.startsWith(a.replace(/\s+/g, '')));
}

/** The money a launch spends per day, in the ad account's own cents. */
function budgetCents(usd: number, currency: string, rate: number | null): number {
  if (currency.toUpperCase() === 'DZD') {
    if (!rate) throw bad('Ajoutez le taux du dollar de ce mois (Publicité) : le compte pub est en dinars.');
    return Math.round(usd * rate * 100);
  }
  return Math.round(usd * 100);
}

/** The launch as Meta will get it, checked: the problems first (nothing goes to Meta while one is left). */
async function inputOf(ctx: Ctx, r: any): Promise<{ input: LaunchInput; acct: { id: string; currency: string }; media: MediaRow[]; product: ProductLimit | null; excluded: number[] }> {
  const spec = LaunchSpec.parse(r.spec);
  const acct = await account(ctx);
  if (!acct) throw bad('Reliez le compte pub Meta de la boutique (Pilot AI › Comptes).');
  const page = await pageOf(ctx);
  const rate = (await fxTable(ctx.db))(algDay(ctx.now()).slice(0, 7));
  const product = spec.productId ? ((await productLimits(ctx, spec.productId))[0] ?? null) : null;
  if (spec.productId && !product) throw forbidden('Ce produit ne vous est pas confié.');
  const media = await mediaOf(ctx, spec.mediaIds);
  if (media.length !== spec.mediaIds.length) throw bad('Une photo ou une vidéo n’est plus dans la bibliothèque : choisissez-la à nouveau.');
  const lm: LaunchMedia[] = media.map((m, n) => ({ kind: m.kind, mediaId: m.id, url: m.kind === 'video' ? (videoAddress(ctx, m) ?? null) : null, name: `${m.kind === 'video' ? 'Vidéo' : 'Photo'} ${n + 1}` }));
  const pixelId = spec.pixelId ?? product?.landing?.pixelId ?? (await pixelsOf(ctx))[0]?.id ?? null;
  const phone = spec.phone ? (normalizePhone(spec.phone) ? `+213${normalizePhone(spec.phone)!.slice(1)}` : spec.phone) : null;
  const aud = spec.useAudiences ? await audienceIds(ctx.db) : { exclude: [], include: [] };
  const input: LaunchInput = {
    goal: spec.goal,
    name: spec.name,
    pageId: page?.pageId ?? '',
    instagramId: page?.igId ?? null,
    pixelId,
    link: product?.landing?.url || null,
    phone,
    formId: spec.formId,
    postId: spec.postId ? (spec.postId.includes('_') ? spec.postId : `${page?.pageId ?? ''}_${spec.postId}`) : null,
    channels: spec.channels,
    welcome: spec.welcome,
    text: spec.text,
    media: lm,
    budgetCents: budgetCents(spec.budgetUsd, acct.currency, rate),
    budgetLevel: spec.budgetLevel,
    split: spec.split,
    regions: [],
    ageMin: spec.ageMin,
    ageMax: spec.ageMax,
    genders: spec.genders,
    advantageAudience: spec.advantageAudience,
    excludeAudiences: aud.exclude,
    includeAudiences: aud.include,
    bid: spec.bid ? { strategy: spec.bid.strategy, amountCents: spec.bid.usd ? budgetCents(spec.bid.usd, acct.currency, rate) : null } : null,
    start: spec.start,
  };
  // a new form is made at launch: until then the plan has its place
  const problems = launchProblems(spec.goal === 'form' && spec.newForm && !spec.formId ? { ...input, formId: 'new' } : input);
  if (spec.goal === 'form' && !spec.formId && !spec.newForm) problems.push('Choisissez un formulaire, ou faites-en un nouveau.');
  if (problems.length) throw bad(problems.join(' · '));
  return { input, acct, media, product, excluded: spec.excludeWilayas };
}

/** a video in the library: the public address Meta downloads it from (the server only) */
function videoAddress(ctx: Ctx, m: MediaRow): string | null {
  const api = ctx.server ? publicApi(ctx) : '';
  if (!m.ready) return null;
  return api ? `${api}/lp/vid/${m.id}/${m.key}.${extOf(m.mime)}` : `demo://video/${m.id}`;
}

/** Meta's region keys of the wilayas left out (the new wilayas, which Meta does not split yet, are skipped). */
async function regionKeys(ctx: Ctx, ids: number[]): Promise<{ keys: string[]; skipped: number[] }> {
  const keys: string[] = [];
  const skipped: number[] = [];
  for (const id of ids) {
    const name = WILAYAS[id - 1];
    if (!name || id > 48) {
      skipped.push(id);
      continue;
    }
    if (!ctx.server) {
      keys.push(`DZ-${String(id).padStart(2, '0')}`);
      continue;
    }
    const r = (await ctx.server.meta('geo', { q: plain(name) || name }, ctx)) as { regions: { key: string; name: string }[] };
    const hit = r.regions.find((x) => regionMatches(name, x.name));
    if (hit) keys.push(hit.key);
    else skipped.push(id);
  }
  return { keys, skipped };
}

/** the demo's ids, Meta-like (17 digits) */
const fakeId = (ctx: Ctx, n: number) => `2385${String(Math.floor(ctx.now() % 1e10)).padStart(10, '0')}${String(n).padStart(3, '0')}`;

/**
 * « Lancer »: the owner's limits first (a marketer's launch may wait for the owner), then Meta: everything PAUSED, then
 * on. Pilotix then knows the new campaign, its ad sets and ads at once (« Mes pubs », the buttons, Pilote auto).
 */
async function go(ctx: Ctx, id: number, approved = false) {
  return withActionLock(ctx.db, `launch:${id}`, me(ctx), 'Ce lancement est déjà en cours.', async () => {
    const r = await launchRow(ctx.db, id);
    mayOpen(ctx, r);
    if (r.status === 'live') return view(r);
    if (r.status === 'waiting_yes' && !approved) throw bad('Ce lancement attend le oui du propriétaire.');
    if (r.status === 'refused') throw bad('Le propriétaire a refusé ce lancement : faites-en un autre.');
    const s = await pilotSettings(ctx.db);
    if (s.guard.stopped) throw bad('Tout est arrêté par le propriétaire : rien ne démarre avant « Tout relancer ».');
    const { input, acct, media, product, excluded } = await inputOf(ctx, r);
    const rate = (await fxTable(ctx.db))(algDay(ctx.now()).slice(0, 7));
    const usd = Number(r.spec.budgetUsd);
    // the shop's spend per day with this one: above the owner's limit, a marketer cannot; the owner is told
    const runningUsd = await shopDailyUsd(ctx.db, rate);
    const owner = isOwner(ctx) || approved;
    if (s.guard.maxDailyUsd !== null && runningUsd + usd > s.guard.maxDailyUsd && !owner)
      throw bad(`La boutique dépenserait ${Math.round(runningUsd + usd)} $ par jour : la limite du propriétaire est ${s.guard.maxDailyUsd} $.`);
    if (!owner && (s.guard.launchYes || (s.guard.yesAboveUsd !== null && usd > s.guard.yesAboveUsd))) {
      await ctx.db.query(`UPDATE ad_launches SET status = 'waiting_yes', error = NULL, updated_at = now() WHERE id = $1`, [id]);
      return view(await launchRow(ctx.db, id));
    }
    await ctx.db.query(`UPDATE ad_launches SET status = 'launching', error = NULL, updated_at = now() WHERE id = $1`, [id]);
    const done: Record<string, string> = { ...(r.meta_ids ?? {}) };
    try {
      const spec = LaunchSpec.parse(r.spec);
      // the wilayas left out: Meta's own keys
      if (excluded.length) input.excludeRegions = (await regionKeys(ctx, excluded)).keys;
      // a new instant form: made on the Page now, and known by Formulaires (its leads become orders)
      if (input.goal === 'form' && !input.formId && spec.newForm) {
        if (!done.form) {
          const questions = [
            { type: 'FULL_NAME', key: 'full_name' },
            { type: 'PHONE', key: 'phone_number' },
            { type: 'CUSTOM', key: 'wilaya', label: spec.newForm.lang === 'ar' ? 'الولاية' : 'Wilaya' },
            ...(spec.newForm.commune ? [{ type: 'CUSTOM', key: 'commune', label: spec.newForm.lang === 'ar' ? 'البلدية' : 'Commune' }] : []),
            ...(spec.newForm.variant ? [{ type: 'CUSTOM', key: 'variante', label: spec.newForm.lang === 'ar' ? 'اللون أو المقاس' : 'Couleur ou taille' }] : []),
          ];
          const body = {
            name: spec.newForm.name,
            locale: spec.newForm.lang === 'ar' ? 'ar_AR' : 'fr_FR',
            questions,
            privacy_policy: { url: spec.newForm.privacyUrl, link_text: spec.newForm.lang === 'ar' ? 'سياسة الخصوصية' : 'Politique de confidentialité' },
            follow_up_action_url: input.link || `https://www.facebook.com/${input.pageId}`,
          };
          done.form = ctx.server ? String(((await ctx.server.meta('leadform', { pageId: input.pageId, body }, ctx)) as { id: string }).id) : fakeId(ctx, 90);
          await ctx.db.query(
            `INSERT INTO lead_forms (form_id, page_id, name, questions, mapping, product_id, mode) VALUES ($1,$2,$3,$4,$5,$6,'order') ON CONFLICT (form_id) DO NOTHING`,
            [
              done.form,
              input.pageId,
              spec.newForm.name,
              JSON.stringify(questions.map((q) => ({ key: q.key, label: q.label ?? q.type, type: q.type }))),
              JSON.stringify(Object.fromEntries(questions.map((q) => [q.key, fieldOf({ key: q.key, label: q.label, type: q.type })]))),
              spec.productId,
            ],
          );
          await ctx.db.query(`UPDATE ad_launches SET meta_ids = $2, updated_at = now() WHERE id = $1`, [id, JSON.stringify(done)]);
        }
        input.formId = done.form;
      }
      const plan = metaPlan(input);
      let ids: Record<string, string>;
      if (ctx.server) {
        const res = (await ctx.server.meta('launch', { plan, accountId: acct.id, done }, ctx)) as { ids: Record<string, string>; error: string | null; step: string };
        ids = res.ids;
        await ctx.db.query(`UPDATE ad_launches SET meta_ids = $2, step = $3, updated_at = now() WHERE id = $1`, [id, JSON.stringify(res.ids), res.step]);
        if (res.error) throw bad(res.error);
      } else {
        // the demo: made-up ids, nothing leaves Pilotix
        ids = { ...done, campaign: done.campaign ?? fakeId(ctx, 0) };
        plan.adsets.forEach((a, n) => (ids[`adset:${a.key}`] ??= fakeId(ctx, 10 + n)));
        plan.ads.forEach((a, n) => (ids[`ad:${a.key}`] ??= fakeId(ctx, 40 + n)));
      }
      const adsetIds = plan.adsets.map((a) => ids[`adset:${a.key}`]);
      const adIds = plan.ads.map((a) => ids[`ad:${a.key}`]);
      if (ctx.server) await ctx.server.meta('activate', { ids: [ids.campaign, ...adsetIds, ...adIds] }, ctx);
      // Pilotix knows them now (the next sync completes them): « Mes pubs », the buttons, Pilote auto
      const marketer = isOwner(ctx) ? (r.by_user !== null && !(await ownsShop(ctx.db, num(r.by_user))) ? num(r.by_user) : null) : me(ctx);
      await ctx.db.tx(async (tx) => {
        await tx.query(
          `INSERT INTO ad_campaigns (id, account_id, name, objective, status, daily_budget_cents, bid_strategy, launch_id, changed_at, updated_at) VALUES ($1,$2,$3,$4,'ACTIVE',$5,$6,$7,now(),now())
           ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE', launch_id = EXCLUDED.launch_id, updated_at = now()`,
          [ids.campaign, acct.id, input.name, GOAL_META[input.goal].objective, input.budgetLevel === 'campaign' ? input.budgetCents : null, input.bid?.strategy ?? 'LOWEST_COST_WITHOUT_CAP', id],
        );
        for (const [n, a] of plan.adsets.entries())
          await tx.query(
            `INSERT INTO adsets (id, name, campaign, campaign_id, account_id, daily_budget_cents, goal, product_ids, marketer_id, status, currency, launch_id, changed_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ACTIVE',$10,$11,now(),now()) ON CONFLICT (id) DO UPDATE SET goal = EXCLUDED.goal, launch_id = EXCLUDED.launch_id, product_ids = EXCLUDED.product_ids, status = 'ACTIVE', updated_at = now()`,
            [adsetIds[n], String(a.body.name), input.name, ids.campaign, acct.id, input.budgetLevel === 'adset' ? input.budgetCents : null, input.goal, product ? [product.id] : [], marketer, acct.currency, id],
          );
        for (const [n, a] of plan.ads.entries())
          await tx.query(`INSERT INTO ads (id, adset_id, name, status, is_video, updated_at) VALUES ($1,$2,$3,'ACTIVE',$4,now()) ON CONFLICT (id) DO NOTHING`, [
            adIds[n],
            ids[`adset:${a.adset}`],
            String(a.body.name),
            media[n]?.kind === 'video',
          ]);
        if (media.length) await tx.query(`UPDATE cm_media SET for_ads = true WHERE id = ANY($1)`, [media.map((m) => m.id)]);
        await tx.query(
          `UPDATE ad_launches SET status = 'live', step = 'done', campaign_id = $2, adset_ids = $3, ad_ids = $4, meta_ids = $5, approved_by = COALESCE(approved_by, $6), live_at = now(), updated_at = now() WHERE id = $1`,
          [id, ids.campaign, adsetIds, adIds, JSON.stringify(ids), approved ? me(ctx) : null],
        );
        await tx.query(
          `INSERT INTO ad_actions (level, object_id, object_name, op, before, after, source, status, why, by_user, approved_by, done_at) VALUES ('campaign',$1,$2,'launch',NULL,$3,'launch','done',$4,$5,$6,now())`,
          [ids.campaign, input.name, JSON.stringify({ status: 'ACTIVE', budgetUsd: usd, goal: input.goal }), GOAL_META[input.goal].objective, numOrNull(r.by_user), approved ? me(ctx) : null],
        );
      });
      if (input.phone) await setRaw(ctx.db, LAST_KEY, { ...(await getRaw(ctx.db, LAST_KEY, {})), phone: input.phone });
      if (spec.newForm) await setRaw(ctx.db, LAST_KEY, { ...(await getRaw(ctx.db, LAST_KEY, {})), privacyUrl: spec.newForm.privacyUrl });
      return view(await launchRow(ctx.db, id));
    } catch (e: any) {
      await ctx.db.query(`UPDATE ad_launches SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [id, String(e?.message ?? e).slice(0, 500)]);
      throw e;
    }
  });
}
/** is this person the shop's owner or an admin (their launches are the shop's, not a marketer's) */
async function ownsShop(db: Db, id: number): Promise<boolean> {
  const r = (await db.query(`SELECT roles FROM profiles WHERE id = $1`, [id]))[0];
  const roles: string[] = Array.isArray(r?.roles) ? r.roles : String(r?.roles ?? '').replace(/[{}]/g, '').split(',');
  return roles.includes('vendeur') || roles.includes('admin');
}

async function saveLaunch(ctx: Ctx, i: { id?: number | null; clientId?: string | null; mode: 'simple' | 'pro'; spec: LaunchSpec }) {
  const given = givenOf(ctx);
  if (i.spec.productId && given && !given.has(i.spec.productId)) throw forbidden('Ce produit ne vous est pas confié.');
  if (i.spec.mediaIds.length) {
    const found = await ctx.db.query(`SELECT id, created_by FROM cm_media WHERE id = ANY($1)`, [i.spec.mediaIds]);
    if (found.length !== new Set(i.spec.mediaIds).size) throw bad('Une photo ou une vidéo est introuvable.');
    // a marketer partner's person uses the photos and videos they sent themselves
    if (partner(ctx) && found.some((m: any) => numOrNull(m.created_by) !== me(ctx))) throw forbidden('Choisissez vos propres photos et vidéos.');
  }
  const usdCents = Math.round(i.spec.budgetUsd * 100);
  if (i.id) {
    const r = await launchRow(ctx.db, i.id);
    mayOpen(ctx, r);
    if (!['draft', 'failed', 'refused'].includes(r.status)) throw bad('Ce lancement est déjà parti : il ne change plus.');
    await ctx.db.query(`UPDATE ad_launches SET mode = $2, goal = $3, product_id = $4, name = $5, spec = $6, budget_cents = $7, status = 'draft', error = NULL, updated_at = now() WHERE id = $1`, [
      i.id,
      i.mode,
      i.spec.goal,
      i.spec.productId,
      i.spec.name,
      JSON.stringify(i.spec),
      usdCents,
    ]);
    return view(await launchRow(ctx.db, i.id));
  }
  if (i.clientId) {
    const seen = (await ctx.db.query(`SELECT id FROM ad_launches WHERE client_id = $1`, [i.clientId]))[0];
    if (seen) return view(await launchRow(ctx.db, num(seen.id)));
  }
  const row = (
    await ctx.db.query(`INSERT INTO ad_launches (client_id, mode, goal, product_id, name, spec, budget_cents, by_user) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [
      i.clientId ?? null,
      i.mode,
      i.spec.goal,
      i.spec.productId,
      i.spec.name,
      JSON.stringify(i.spec),
      usdCents,
      me(ctx),
    ])
  )[0];
  return view(await launchRow(ctx.db, num(row.id)));
}

// ---------------------------------------------------------------- the library (photos and videos for the ads)
async function library(ctx: Ctx) {
  const mine = partner(ctx);
  const rows = await ctx.db.query(
    // on the server a photo goes to Meta as its bytes (jpeg); the demo's pictures are drawings (src), shown as they are
    `SELECT id FROM cm_media WHERE ready AND (jpeg IS NOT NULL OR kind = 'video'${ctx.server ? '' : ' OR src IS NOT NULL'}) AND ($1::bigint IS NULL OR created_by = $1) ORDER BY for_ads DESC, id DESC LIMIT 60`,
    [mine ? me(ctx) : null],
  );
  const media = await mediaOf(ctx, rows.map((r: any) => num(r.id)));
  return media.map((m) => mediaView(ctx, m));
}

const Id = z.number().int().positive();
const Lang = z.enum(['darija', 'fr', 'ar']);

export const adsLaunchProcs = {
  'ads.launch.options': proc(['marketer'], z.object({}), (ctx) => options(ctx)),
  /** the ad's words: three versions and the welcome message (Pilot AI, or ready sentences) */
  'ads.launch.copy': proc(['marketer'], z.object({ productId: Id, goal: z.enum(GOALS), lang: Lang, idea: z.string().max(400).default('') }), (ctx, i) => writeCopy(ctx, i)),
  'ads.launch.save': proc(['marketer'], z.object({ id: Id.nullable().optional(), clientId: z.string().max(64).nullable().optional(), mode: z.enum(['simple', 'pro']), spec: LaunchSpec }), (ctx, i) => saveLaunch(ctx, i)),
  'ads.launch.list': proc(['marketer'], z.object({}), async (ctx) => {
    const rows = await ctx.db.query(
      `SELECT l.*, p.name AS product_name, u.name AS by_name, a.name AS approved_name FROM ad_launches l LEFT JOIN products p ON p.id = l.product_id LEFT JOIN profiles u ON u.id = l.by_user LEFT JOIN profiles a ON a.id = l.approved_by
       WHERE ($1::bigint IS NULL OR l.by_user = $1) ORDER BY l.id DESC LIMIT 60`,
      [isOwner(ctx) ? null : me(ctx)],
    );
    return { owner: isOwner(ctx), launches: rows.map(view) };
  }),
  'ads.launch.get': proc(['marketer'], z.object({ id: Id }), async (ctx, i) => {
    const r = await launchRow(ctx.db, i.id);
    mayOpen(ctx, r);
    return view(r);
  }),
  /** what Meta will get (the problems, the budget in the account's money), without sending anything */
  'ads.launch.check': proc(['marketer'], z.object({ id: Id }), async (ctx, i) => {
    const r = await launchRow(ctx.db, i.id);
    mayOpen(ctx, r);
    try {
      const { input, acct } = await inputOf(ctx, r);
      return { ok: true as const, problems: [] as string[], currency: acct.currency, budgetCents: input.budgetCents, exclude: input.excludeAudiences.length };
    } catch (e: any) {
      return { ok: false as const, problems: String(e?.message ?? e).split(' · '), currency: null, budgetCents: null, exclude: 0 };
    }
  }),
  'ads.launch.go': proc(['marketer'], z.object({ id: Id }), (ctx, i) => go(ctx, i.id)),
  /** the owner says yes (it goes to Meta now) or no to a marketer's launch */
  'ads.launch.approve': proc(['vendeur'], z.object({ id: Id, yes: z.boolean() }), async (ctx, i) => {
    const r = await launchRow(ctx.db, i.id);
    if (r.status !== 'waiting_yes') throw bad('Ce lancement n’attend plus de réponse.');
    if (!i.yes) {
      await ctx.db.query(`UPDATE ad_launches SET status = 'refused', approved_by = $2, updated_at = now() WHERE id = $1`, [i.id, me(ctx)]);
      return view(await launchRow(ctx.db, i.id));
    }
    await ctx.db.query(`UPDATE ad_launches SET approved_by = $2 WHERE id = $1`, [i.id, me(ctx)]);
    return go(ctx, i.id, true);
  }),
  'ads.launch.remove': proc(['marketer'], z.object({ id: Id }), async (ctx, i) => {
    const r = await launchRow(ctx.db, i.id);
    mayOpen(ctx, r);
    if (r.status === 'live' || r.status === 'launching') throw bad('Une pub lancée ne s’efface pas : mettez-la en pause.');
    await ctx.db.query(`DELETE FROM ad_launches WHERE id = $1`, [i.id]);
    return { ok: true };
  }),

  // the photos and videos of the ads (the shop's library, shared with the Planner; kept while the ads use them)
  'ads.media.list': proc(['marketer'], z.object({}), (ctx) => library(ctx)),
  'ads.media.photo': proc(
    ['marketer'],
    z.object({ jpeg: B64(4_850_000), thumb: B64(200_000), w: z.number().int().min(320).max(1440), h: z.number().int().min(160).max(2560) }),
    async (ctx, i) => {
      if (!i.jpeg.startsWith('/9j/') || !i.thumb.startsWith('/9j/')) throw bad('Envoyez une photo JPEG.');
      const ratio = i.w / i.h;
      // Meta's feeds take 4:5 (tall) to 1.91:1 (wide); stories and reels 9:16
      if (ratio < 0.5 || ratio > 1.915) throw bad('Une photo de pub va de 9:16 (en hauteur) à 1,91:1 (en largeur).');
      const key = randomKey();
      const r = (
        await ctx.db.query(`INSERT INTO cm_media (key, w, h, jpeg, thumb, bytes, for_ads, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8) RETURNING id`, [
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
      return mediaView(ctx, { id: num(r.id), key, kind: 'photo', mime: null, duration: null, ready: true, w: i.w, h: i.h, hasJpeg: true, hasThumb: true, thumb: i.thumb, src: null });
    },
  ),
  /** a video starts (sent in pieces to PUT /api/cm/video/<id>/<key>, as the Planner's), then ads.media.videoDone */
  'ads.media.videoStart': proc(
    ['marketer'],
    z.object({ mime: z.enum(VIDEO_TYPES), size: z.number().int().min(1).max(PLAN_LIMITS.videoBytes), w: z.number().int().min(16).max(8192), h: z.number().int().min(16).max(8192), duration: z.number().min(1).max(241 * 60), thumb: B64(200_000) }),
    async (ctx, i) => {
      if (!i.thumb.startsWith('/9j/')) throw bad('Image de la vidéo illisible.');
      const key = randomKey();
      const upload = !!ctx.server?.media;
      const r = (
        await ctx.db.query(`INSERT INTO cm_media (key, kind, mime, duration, ready, w, h, thumb, bytes, for_ads, created_by, created_at) VALUES ($1,'video',$2,$3,$4,$5,$6,$7,$8,true,$9,$10) RETURNING id`, [
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
  'ads.media.videoDone': proc(['marketer'], z.object({ id: Id }), async (ctx, i) => {
    const r = (await ctx.db.query(`SELECT key, kind, mime, bytes, ready FROM cm_media WHERE id = $1`, [i.id]))[0];
    if (!r || r.kind !== 'video') throw notFound('Vidéo introuvable');
    if (!r.ready) {
      if (!ctx.server?.media) throw bad('Pas de stockage de vidéos sur ce serveur.');
      await ctx.server.media('finish', { id: i.id, key: String(r.key), ext: extOf(r.mime), size: num(r.bytes) });
      await ctx.db.query(`UPDATE cm_media SET ready = true WHERE id = $1`, [i.id]);
    }
    return mediaView(ctx, (await mediaOf(ctx, [i.id]))[0]);
  }),
  /** for the server's public addresses when the plan has Publicité but not the Planner (same answers as cm.plan.*) */
  'ads.media.videoFile': proc([], z.object({ id: Id, key: z.string().regex(/^[a-f0-9]{24}$/) }), async (ctx, i) => {
    const r = (await ctx.db.query(`SELECT key, mime, bytes, ready FROM cm_media WHERE id = $1 AND kind = 'video' AND for_ads`, [i.id]))[0];
    if (!r || r.key !== i.key) throw notFound('Vidéo introuvable');
    return { ext: extOf(r.mime), mime: String(r.mime ?? 'video/mp4'), size: num(r.bytes), ready: !!r.ready, chunk: VIDEO_CHUNK };
  }),
  'ads.media.image': proc([], z.object({ id: Id, key: z.string().regex(/^[a-f0-9]{24}$/), small: z.boolean().default(false) }), async (ctx, i) => {
    const r = (await ctx.db.query(`SELECT key, ${i.small ? 'thumb' : 'jpeg'} AS b FROM cm_media WHERE id = $1 AND for_ads`, [i.id]))[0];
    if (!r || r.key !== i.key || !r.b) throw notFound('Photo introuvable');
    return { base64: String(r.b) };
  }),
};

