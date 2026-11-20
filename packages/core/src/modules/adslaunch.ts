// Pilot Ads › Lancer une pub: what the launcher needs (the products with what a delivered order may cost, their sales
// pages, the shop's photos and videos, the Page, Instagram, the pixel, the forms, the wilayas that deliver well), the
// ad's words (Pilot AI, or ready sentences in the demo), the launches themselves (a draft, waiting for the owner's yes,
// live, failed) and what goes to Meta.
//
// A launch is sent to Meta all PAUSED (campaign, ad sets, créas, ads), then turned on in one go. A retry after a
// failure goes on where it stopped (the ids Meta gave are kept) and creates nothing twice. In the demo (no server)
// nothing leaves Pilotix: the launch gets made-up ids and appears in « Mes pubs » at once.
import { featureOn, normalizePhone, WILAYAS } from '@pilotix/shared';
import { z } from 'zod';
import { Db, num, numOrNull } from '../db';
import { bad, Ctx, forbidden, notFound, proc, publicApi, withActionLock } from '../rpc';
import { getSetting } from '../settings';
import { getRaw, setRaw } from './admin';
import { addDays, fxTable, isOwner, moneyOf, ordersOf, visibleAdsets } from './ads';
import { audienceIds, ensureEventAudiences, pilotSettings, wilayaRates, type AccountHealth } from './adsmgr';
import { B64, mediaOf, mediaView, PLAN_LIMITS, VIDEO_CHUNK, VIDEO_TYPES, type MediaRow } from './cmplan';
import { aiKeyed, dellalSettings, PILOT_CHEAP_MODEL, pilotOn, type AiResponse } from './dellal';
import { fieldOf } from './leads';
import { pageLinks } from './pagelinks';
import { budgetPacks, CHANNELS, GOAL_META, GOALS, isGone, isOn, launchProblems, limitOf, metaPlan, type Goal, type LaunchInput, type LaunchMedia } from './pilotads';
import { contentFor, partnerChoices, partnerFor, USABLE } from './partners';
import { launchAccounts, linkedPage } from './social';

const algDay = (ms: number) => new Date(ms + 3_600_000).toISOString().slice(0, 10);
/**
 * Meta's refusal of a new ad set, with the way out when it is about one of the shop's lists (Audiences): the launch
 * can go again without that list (what Meta already made is kept, nothing is made twice).
 */
export function audienceRefusal(error: string, input: Pick<LaunchInput, 'excludeAudiences' | 'includeAudiences'>): string {
  if (!input.excludeAudiences.length && !input.includeAudiences.length) return error;
  if (!/custom[ _]?audience|audiences? personnalisée|publics? personnalisé/i.test(error)) return error;
  return `${error} · Meta refuse une de vos audiences : éteignez-la dans Publicité › Audiences (ou décochez « Utiliser mes audiences »), puis relancez.`;
}
/**
 * Partenaires › Influenceurs is open in this shop (its plan has it, and Pilotix has not put it « Bientôt »). Closed: no
 * creator to pick, and a launch saved with one before goes out in the Page's name alone.
 */
const influencersOn = (ctx: Ctx) => featureOn(ctx.shop?.features, 'marketing/influenceurs');
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
  /** its page; `own`: at the shop's own domain (Landing pages › Réglages), so the ad shows that name, not the platform's */
  landing: { id: number; slug: string; title: string; url: string; own: boolean; pixelId: string | null } | null;
}

/**
 * The public address of a landing page or a group (theirs are the same kind: site/<store>/<slug>): at the shop's own
 * domain by default once it is ready, so the ads show the shop's name and not PILOTIX.ONLINE (seen on a real ad,
 * 17 Nov 2026), unless the shop chose the platform's address (Réglages › « Liens des pages »: modules/pagelinks.ts).
 * '' when there is no platform address (the browser preview has DEMO_BASE).
 */
async function pageAddress(ctx: Ctx): Promise<{ url: (slug: string) => string; own: boolean }> {
  const l = await pageLinks(ctx, ctx.server ? '' : DEMO_BASE);
  return { own: l.usesOwn, url: (slug) => (l.prefix ? `${l.prefix}${slug}` : '') };
}

/** The products the launcher offers, with what an order may cost each (one read of the orders for all of them). */
export async function productLimits(ctx: Ctx, only?: number | number[] | null): Promise<ProductLimit[]> {
  const today = algDay(ctx.now());
  const rate = (await fxTable(ctx.db))(today.slice(0, 7));
  const given = givenOf(ctx);
  const want = only === null || only === undefined ? null : new Set(Array.isArray(only) ? only : [only]);
  const rows = (await ctx.db.query(`SELECT id, name, price, cost, photo FROM products WHERE active AND NOT is_service AND archived_at IS NULL ORDER BY lower(name), id LIMIT 300`)).filter(
    (p: any) => (!given || given.has(num(p.id))) && (!want || want.has(num(p.id))),
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
  const address = await pageAddress(ctx);
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
      landing: lp
        ? {
            id: num(lp.id),
            slug: String(lp.slug),
            title: String(lp.title ?? lp.slug),
            url: address.url(String(lp.slug)),
            own: address.own,
            pixelId: lp.pixel_id ? String(lp.pixel_id) : null,
          }
        : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------- a group of products (Landing pages › Groupes)
/** Above this many products, a group's ad shows too many choices: the launcher says so (the owner's choice, 20 Nov 2026). */
export const GROUP_MANY = 5;
/** What a group's ad may be for: the ad opens the group's page (no messages, calls or form: they sell one product). */
export const GROUP_GOALS: Goal[] = ['sales', 'traffic', 'awareness'];

/**
 * A group the launcher offers: the ad opens the group's page and the customer picks the product there. Its numbers are
 * those of its product with the LOWEST limit (the safe one: an order of any of its products stays under it); `landing`
 * is the group's own page (null while it is offline), `price` its cheapest product's.
 */
export interface GroupLimit extends ProductLimit {
  group: { count: number; productIds: number[]; names: string[]; lowest: string; maxPrice: number };
}

/** A group's products, from its items (the landing pages it shows, in their order; a page deleted since has left it). */
const groupPageIds = (items: unknown): number[] => {
  const list = typeof items === 'string' ? (() => { try { return JSON.parse(items); } catch { return []; } })() : items;
  return (Array.isArray(list) ? list : []).map((x: any) => Number(x?.pageId)).filter((n) => Number.isSafeInteger(n) && n > 0);
};

/**
 * The groups of Landing pages › Groupes with at least one product on sale. A marketer partner's person: only the groups
 * whose products the store all gave them. `products`: the products' numbers already read (the launcher's list).
 */
export async function groupLimits(ctx: Ctx, opts: { only?: number | null; products?: ProductLimit[] } = {}): Promise<GroupLimit[]> {
  const rows = await ctx.db
    .query(`SELECT id, slug, title, active, items, pixel_id FROM landing_groups ${opts.only ? 'WHERE id = $1' : ''} ORDER BY updated_at DESC, id DESC LIMIT 100`, opts.only ? [opts.only] : [])
    .catch(() => []);
  if (!rows.length) return [];
  const pageIds = [...new Set(rows.flatMap((r: any) => groupPageIds(r.items)))];
  const pages = pageIds.length ? await ctx.db.query(`SELECT id, product_id FROM landing_pages WHERE id = ANY($1) AND active`, [pageIds]) : [];
  const productOf = new Map<number, number>(pages.filter((p: any) => p.product_id !== null).map((p: any) => [num(p.id), num(p.product_id)]));
  const wanted = [...new Set([...productOf.values()])];
  const products = opts.products ?? (wanted.length ? await productLimits(ctx, wanted) : []);
  const P = new Map(products.map((p) => [p.id, p]));
  const given = givenOf(ctx);
  const address = await pageAddress(ctx);
  const out: GroupLimit[] = [];
  for (const r of rows) {
    const pids = [...new Set(groupPageIds(r.items).map((id) => productOf.get(id)).filter((p): p is number => p !== undefined))];
    if (given && pids.some((p) => !given.has(p))) continue;
    const ps = pids.map((p) => P.get(p)).filter((p): p is ProductLimit => !!p);
    if (!ps.length) continue;
    const lowest = ps.reduce((a, b) => (b.limit.maxDzd < a.limit.maxDzd ? b : a));
    const slug = String(r.slug);
    out.push({
      ...lowest,
      id: num(r.id),
      name: String(r.title || slug),
      price: Math.min(...ps.map((p) => p.price)),
      photo: ps.find((p) => p.photo)?.photo ?? null,
      landing: r.active ? { id: num(r.id), slug, title: String(r.title || slug), url: address.url(slug), own: address.own, pixelId: r.pixel_id ? String(r.pixel_id) : null } : null,
      group: { count: ps.length, productIds: ps.map((p) => p.id), names: ps.map((p) => p.name), lowest: lowest.name, maxPrice: Math.max(...ps.map((p) => p.price)) },
    });
  }
  return out;
}

// ---------------------------------------------------------------- the launcher's choices
/** the ad account new ads start from (Pilot AI › Comptes), with its money; the demo's: a dollar account */
export async function account(ctx: Ctx): Promise<{ id: string; currency: string; name: string; status: number | null } | null> {
  const meta = await getSetting(ctx.db, 'meta');
  const id = String(meta.adAccountId ?? '').replace(/^act_/, '');
  const known = await getRaw<AccountHealth[]>(ctx.db, 'pilot_ads_accounts', []);
  const h = known.find((a) => a.id === id);
  if (h) return { id, currency: h.currency, name: h.name, status: h.status };
  // not read from Meta yet (just chosen in Comptes): its money is the one its linked account gave, never a guess
  const linked = (await launchAccounts(ctx.db))?.accounts.find((a) => a.id === id);
  if (linked?.currency) return { id, currency: linked.currency.toUpperCase(), name: linked.name, status: null };
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

async function options(ctx: Ctx, contentId: string | null = null) {
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
  const products = await productLimits(ctx);
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
    products,
    /** Landing pages › Groupes: the ad opens the group's page, the customer picks the product there */
    groups: await groupLimits(ctx, { products }),
    groupGoals: GROUP_GOALS,
    groupMany: GROUP_MANY,
    /** Marketing › Influenceurs: the creators an ad in two names may use, and the creator's post to boost when one is chosen
     *  (none while Influenceurs is off: out of the plan, or « Bientôt ») */
    partners: influencersOn(ctx) ? await partnerChoices(ctx.db) : [],
    boost: contentId && influencersOn(ctx) ? await contentFor(ctx.db, contentId).then((c) => (c ? { ...c, adCode: undefined, hasCode: !!c.adCode } : null)) : null,
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

/**
 * Ready sentences for a group's ad (the customer picks on the group's page): the choice, the prices from the cheapest
 * to the dearest, paid on delivery. Never one product's name or price alone: the ad sells the choice.
 */
export function groupCopy(lang: CopyLang, g: { name: string; count: number; price: number; maxPrice: number }): { variants: { primary: string; headline: string }[]; welcome: { text: string; questions: string[] } } {
  const from = da(g.price);
  const to = da(g.maxPrice);
  const one = g.price === g.maxPrice;
  const T = {
    darija: [
      { primary: `👶 ${g.name}\nعندنا ${g.count} موديلات، اختار اللي يعجبك\n💵 من ${from} دج\n✅ الخلاص عند الاستلام\n🚚 التوصيل لكل الولايات\n👇 شوف الموديلات و اطلب من الموقع`, headline: `${g.count} موديلات · من ${from} دج` },
      { primary: `حاب تشري و ما عرفتش واش تختار؟ 🤔\n${g.count} موديلات في «${g.name}»، كل واحد بسومتو\n✅ تشوف السلعة قبل ما تخلص\n🚚 توصيل للدار ولا للمكتب\n👇 شوف الموديلات و اطلب من الموقع`, headline: 'الخلاص عند الاستلام' },
      { primary: `${g.name} ✨\n${one ? `${from} دج` : `من ${from} حتى ${to} دج`}، كاين لكل ميزانية\n💵 الخلاص كي توصلك\n👇 شوف الموديلات و اطلب من الموقع`, headline: 'اختار الموديل تاعك' },
    ],
    fr: [
      { primary: `👶 ${g.name}\n${g.count} modèles au choix\n💵 À partir de ${from} DA\n✅ Paiement à la livraison\n🚚 Livraison dans toute l’Algérie\n👇 Voyez les modèles et commandez sur le site`, headline: `${g.count} modèles · dès ${from} DA` },
      { primary: `Vous hésitez ? 🤔\n${g.count} modèles dans « ${g.name} », un prix pour chacun\n✅ Vous vérifiez avant de payer\n🚚 À domicile ou au bureau\n👇 Voyez les modèles et commandez sur le site`, headline: 'Paiement à la livraison' },
      { primary: `${g.name} ✨\n${one ? `${from} DA` : `De ${from} à ${to} DA`} : un modèle pour chaque budget\n💵 Payé à la réception\n👇 Voyez les modèles et commandez sur le site`, headline: 'Choisissez votre modèle' },
    ],
    ar: [
      { primary: `👶 ${g.name}\n${g.count} موديلات للاختيار\n💵 ابتداءً من ${from} دج\n✅ الدفع عند الاستلام\n🚚 التوصيل إلى كل الولايات\n👇 شاهد الموديلات واطلب من الموقع`, headline: `${g.count} موديلات · من ${from} دج` },
      { primary: `محتار؟ 🤔\n${g.count} موديلات في «${g.name}»، لكل واحد سعره\n✅ تتحقق من المنتج قبل الدفع\n🚚 إلى المنزل أو المكتب\n👇 شاهد الموديلات واطلب من الموقع`, headline: 'الدفع عند الاستلام' },
      { primary: `${g.name} ✨\n${one ? `${from} دج` : `من ${from} إلى ${to} دج`}: موديل لكل ميزانية\n💵 تدفع عند الاستلام\n👇 شاهد الموديلات واطلب من الموقع`, headline: 'اختر الموديل المناسب لك' },
    ],
  };
  const W = {
    darija: { text: `مرحبا بيك 👋 حاب تعرف على ${g.name}؟`, questions: ['شحال السعر؟', 'كيفاش نطلب؟', 'كاين التوصيل لولايتي؟'] },
    fr: { text: `Bonjour 👋 Vous voulez en savoir plus sur ${g.name} ?`, questions: ['Quels sont les prix ?', 'Comment commander ?', 'Vous livrez dans ma wilaya ?'] },
    ar: { text: `مرحبا 👋 تريد معرفة المزيد عن ${g.name}؟`, questions: ['ما هي الأسعار؟', 'كيف أطلب؟', 'هل التوصيل متوفر في ولايتي؟'] },
  };
  return { variants: T[lang], welcome: W[lang] };
}

async function writeCopy(ctx: Ctx, i: { productId?: number | null; groupId?: number | null; goal: Goal; lang: CopyLang; idea: string }) {
  const language = i.lang === 'darija' ? 'darija algérienne (lettres arabes)' : i.lang === 'fr' ? 'français' : 'arabe simple';
  const idea = i.idea.trim() ? `\nIdée du vendeur : ${i.idea.trim().slice(0, 400)}` : '';
  let ready: ReturnType<typeof demoCopy>;
  let user: string;
  if (i.groupId) {
    // a group: its page shows several products and the customer picks one (its products all given to this person)
    const g = (await groupLimits(ctx, { only: i.groupId }))[0];
    if (!g) throw notFound('Groupe introuvable');
    ready = groupCopy(i.lang, { name: g.name, count: g.group.count, price: g.price, maxPrice: g.group.maxPrice });
    user = `Groupe de produits : ${g.name} (une page avec ${g.group.count} produits : le client choisit le sien sur la page ; la pub vend ce choix, pas un seul produit)\nProduits : ${g.group.names.join(', ')}\nPrix : ${g.price === g.group.maxPrice ? `${g.price} DA` : `de ${g.price} à ${g.group.maxPrice} DA`}\nObjectif de la pub : ${i.goal}\nLangue : ${language}${idea}`;
  } else {
    if (!i.productId) throw bad('Choisissez un produit ou un groupe.');
    const p = (await ctx.db.query(`SELECT id, name, price FROM products WHERE id = $1`, [i.productId]))[0];
    if (!p) throw notFound('Produit introuvable');
    const given = givenOf(ctx);
    if (given && !given.has(num(p.id))) throw forbidden();
    const product = { name: String(p.name), price: num(p.price) };
    ready = demoCopy(i.lang, product, i.goal);
    user = `Produit : ${product.name}\nPrix : ${product.price} DA\nObjectif de la pub : ${i.goal}\nLangue : ${language}${idea}`;
  }
  const inPage = !ctx.server?.dellal && ctx.dellalAi ? ctx.dellalAi : null;
  if (!inPage && !(await aiKeyed(ctx))) return { ...ready, by: 'ready' as const };
  try {
    const pilot = !inPage && (await pilotOn(ctx));
    const model = pilot ? PILOT_CHEAP_MODEL : (await dellalSettings(ctx.db)).model;
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
  /** …or a group of Landing pages › Groupes (never both): the ad opens the group's page */
  groupId: z.number().int().positive().nullable().default(null),
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
  /** Marketing › Influenceurs: the ad in the shop's name and this creator's */
  partnerId: z.number().int().positive().nullable().default(null),
  /** …or this post of the creator, boosted (Instagram media id, or a Facebook post's id) */
  partnerContentId: z.string().regex(/^[\w.:-]{3,80}$/).nullable().default(null),
  /**
   * « Où va la pub ? »: a campaign already made (a new ad set in it), or one of its ad sets (only the ads go in);
   * null: a new campaign, as before
   */
  into: z.object({ campaignId: z.string().regex(/^\d{6,25}$/), adsetId: z.string().regex(/^\d{6,25}$/).nullable() }).nullable().default(null),
  /** the product's bid limit (DA), typed for a new ad set in TEST or SCALE: kept for this product, next time */
  bidLimitDzd: z.number().int().positive().max(1_000_000).nullable().default(null),
});
export type LaunchSpec = z.infer<typeof LaunchSpec>;
/** the bid limit typed for each product (« Où va la pub ? » in TEST or SCALE), in DA: { [product id]: DA } */
export const BID_LIMITS_KEY = 'pilot_ads_bid_limits';

/**
 * Where a launch goes when it is not a new campaign: a campaign of the shop (a new ad set in it), or one of that
 * campaign's ad sets (only the ads). Its goal must be the campaign's objective (a « Ventes » campaign takes sales ads).
 * A campaign with its own budget (Advantage+) keeps it: the new ad set has none. New ads leave from the shop's ad
 * account (Comptes › « Compte pour lancer »): a campaign of another ad account cannot take them.
 */
export async function placeOf(ctx: Ctx, into: NonNullable<LaunchSpec['into']>, goal: Goal) {
  const c = (await ctx.db.query(`SELECT id, name, objective, status, daily_budget_cents, account_id FROM ad_campaigns WHERE id = $1`, [into.campaignId]))[0];
  if (!c || isGone(c.status)) throw bad('Cette campagne n’est plus chez Meta : choisissez-en une autre.');
  const acct = await account(ctx);
  if (acct && String(c.account_id ?? '').replace(/^act_/, '') !== acct.id)
    throw bad(`La campagne « ${c.name} » est dans un autre compte pub : choisissez une campagne de « ${acct.name || acct.id} », le compte de vos pubs.`);
  if (c.objective && c.objective !== GOAL_META[goal].objective) throw bad(`La campagne « ${c.name} » est faite pour un autre but : choisissez son but, ou une autre campagne.`);
  let adset: { id: string; name: string; productIds: number[]; on: boolean } | null = null;
  if (into.adsetId) {
    const s = (await ctx.db.query(`SELECT id, name, status, campaign_id, product_ids FROM adsets WHERE id = $1`, [into.adsetId]))[0];
    if (!s || isGone(s.status)) throw bad('Cet ensemble de pubs n’est plus chez Meta : choisissez-en un autre.');
    if (String(s.campaign_id ?? '') !== String(c.id)) throw bad('Cet ensemble de pubs n’est pas dans cette campagne.');
    if (!isOwner(ctx) && !(await visibleAdsets(ctx)).some((v) => v.id === String(s.id))) throw forbidden('Cet ensemble de pubs ne vous est pas confié.');
    adset = { id: String(s.id), name: String(s.name), productIds: (s.product_ids ?? []).map(num), on: isOn(s.status) };
  }
  return { campaign: { id: String(c.id), name: String(c.name), cbo: c.daily_budget_cents !== null, on: isOn(c.status) }, adset };
}

type Status = 'draft' | 'waiting_yes' | 'launching' | 'live' | 'failed' | 'refused';

/** A live launch as Meta has it now: running, paused, deleted, or with a problem at Meta. */
export type LaunchNow = 'live' | 'paused' | 'stopped' | 'issue';
const GONE = ['DELETED', 'ARCHIVED'];
const HELD = ['PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED'];
/**
 * « En ligne » is only what the launch did; what runs now is its campaign and ad sets as Meta has them (read at each
 * sync, and at once when Pilotix pauses or starts one). Nothing known yet: still « En ligne ».
 */
export function launchNow(campaign: string | null, adsets: (string | null)[]): LaunchNow {
  const c = String(campaign ?? '').toUpperCase();
  const sets = adsets.filter((s): s is string => !!s).map((s) => s.toUpperCase());
  if (GONE.includes(c) || (sets.length > 0 && sets.every((s) => GONE.includes(s)))) return 'stopped';
  if (c === 'PAUSED') return 'paused';
  if (c === 'WITH_ISSUES') return 'issue';
  if (sets.some((s) => s === 'ACTIVE' || s === 'IN_PROCESS')) return 'live';
  if (sets.includes('WITH_ISSUES')) return 'issue';
  if (sets.length > 0 && sets.every((s) => HELD.includes(s) || GONE.includes(s))) return 'paused';
  return 'live';
}

const view = (r: any) => ({
  id: num(r.id),
  mode: String(r.mode) as 'simple' | 'pro',
  goal: String(r.goal) as Goal,
  productId: numOrNull(r.product_id),
  productName: r.product_name ?? null,
  /** a group of Landing pages › Groupes (its ad opens the group's page) */
  groupId: numOrNull(r.spec?.groupId ?? null),
  groupName: r.group_title ?? null,
  name: String(r.name),
  spec: r.spec as LaunchSpec,
  budgetUsd: Number(r.spec?.budgetUsd ?? 0),
  status: String(r.status) as Status,
  /** a live launch: what Meta does with it now (the badge); null when it is not live */
  now: r.status === 'live' ? launchNow(r.campaign_status ?? null, r.adset_statuses ?? []) : null,
  step: r.step ?? null,
  error: r.error ?? null,
  campaignId: r.campaign_id ?? null,
  adsetIds: (r.adset_ids ?? []).map(String),
  by: r.by_name ?? null,
  byUser: numOrNull(r.by_user),
  approvedBy: r.approved_name ?? null,
  createdAt: new Date(r.created_at).toISOString(),
  liveAt: r.live_at ? new Date(r.live_at).toISOString() : null,
  partnerId: numOrNull(r.partner_id),
  partnerName: r.partner_name ?? null,
});
/** a launch with its names, and its campaign and ad sets as Meta has them now */
const LAUNCH_SQL = `SELECT l.*, p.name AS product_name, u.name AS by_name, a.name AS approved_name, pt.name AS partner_name,
    (SELECT g.title FROM landing_groups g WHERE g.id::text = l.spec->>'groupId') AS group_title,
    c.status AS campaign_status, (SELECT array_agg(s.status) FROM adsets s WHERE s.id = ANY(l.adset_ids)) AS adset_statuses
  FROM ad_launches l LEFT JOIN products p ON p.id = l.product_id LEFT JOIN profiles u ON u.id = l.by_user
  LEFT JOIN profiles a ON a.id = l.approved_by LEFT JOIN ad_partners pt ON pt.id = l.partner_id LEFT JOIN ad_campaigns c ON c.id = l.campaign_id`;
async function launchRow(db: Db, id: number) {
  const r = (await db.query(`${LAUNCH_SQL} WHERE l.id = $1`, [id]))[0];
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
async function inputOf(
  ctx: Ctx,
  r: any,
): Promise<{ input: LaunchInput; acct: { id: string; currency: string }; media: MediaRow[]; product: ProductLimit | null; group: GroupLimit | null; excluded: number[]; boostVideo: boolean }> {
  const spec = LaunchSpec.parse(r.spec);
  const acct = await account(ctx);
  if (!acct) throw bad('Reliez le compte pub Meta de la boutique (Pilot AI › Comptes).');
  const page = await pageOf(ctx);
  const rate = (await fxTable(ctx.db))(algDay(ctx.now()).slice(0, 7));
  if (spec.productId && spec.groupId) throw bad('Choisissez un produit ou un groupe, pas les deux.');
  const product = spec.productId ? ((await productLimits(ctx, spec.productId))[0] ?? null) : null;
  if (spec.productId && !product) throw forbidden('Ce produit ne vous est pas confié.');
  const group = spec.groupId ? ((await groupLimits(ctx, { only: spec.groupId }))[0] ?? null) : null;
  if (spec.groupId && !group) throw bad('Ce groupe n’existe plus, n’a plus de produit en vente, ou a un produit qui ne vous est pas confié.');
  // what the ad opens: the product's page, or the group's
  const target = product ?? group;
  const media = await mediaOf(ctx, spec.mediaIds);
  if (media.length !== spec.mediaIds.length) throw bad('Une photo ou une vidéo n’est plus dans la bibliothèque : choisissez-la à nouveau.');
  const lm: LaunchMedia[] = media.map((m, n) => ({ kind: m.kind, mediaId: m.id, url: m.kind === 'video' ? (videoAddress(ctx, m) ?? null) : null, name: `${m.kind === 'video' ? 'Vidéo' : 'Photo'} ${n + 1}` }));
  const pixelId = spec.pixelId ?? target?.landing?.pixelId ?? (await pixelsOf(ctx))[0]?.id ?? null;
  const phone = spec.phone ? (normalizePhone(spec.phone) ? `+213${normalizePhone(spec.phone)!.slice(1)}` : spec.phone) : null;
  const aud = spec.useAudiences ? await audienceIds(ctx.db) : { exclude: [], include: [] };
  const input: LaunchInput = {
    goal: spec.goal,
    name: spec.name,
    pageId: page?.pageId ?? '',
    instagramId: page?.igId ?? null,
    pixelId,
    link: target?.landing?.url || null,
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
  // Marketing › Influenceurs: an ad in two names, or a creator's post boosted
  const extra: string[] = [];
  const partner = spec.partnerId && influencersOn(ctx) ? await partnerFor(ctx.db, spec.partnerId) : null;
  if (spec.partnerId && influencersOn(ctx) && !partner) extra.push('Cet influenceur n’est plus dans la liste : choisissez-en un autre.');
  if (partner && !USABLE.includes(partner.status)) extra.push(`${partner.name} a retiré son accord (ou l’a refusé) : demandez-le à nouveau dans Influenceurs.`);
  const post = spec.partnerContentId && influencersOn(ctx) ? await contentFor(ctx.db, spec.partnerContentId) : null;
  if (spec.partnerContentId && influencersOn(ctx) && !post) extra.push('Cette publication n’est plus dans la liste : actualisez la page Influenceurs.');
  if (post && !post.boostable) extra.push(`Meta ne permet pas de booster cette publication${post.errors[0]?.message ? ` : ${post.errors[0].message}` : '.'}`);
  if (post) input.boost = { platform: post.platform, contentId: post.id, adCode: post.adCode };
  else if (partner && USABLE.includes(partner.status)) input.partner = { igId: partner.igId, pageId: partner.pageId };
  // a group: its page sells the products (messages, calls and forms sell one product)
  if (group && !GROUP_GOALS.includes(spec.goal)) extra.push('Un groupe se lance pour vendre sur la page, pour des visites ou pour être vu : choisissez un de ces objectifs.');
  // a new form is made at launch: until then the plan has its place
  const problems = [...extra, ...launchProblems(spec.goal === 'form' && spec.newForm && !spec.formId ? { ...input, formId: 'new' } : input)].map((p) =>
    // a group without its page: it is offline (Landing pages › Groupes), not a product without a page
    group && /^Ce produit n’a pas de page de vente/.test(p) ? 'Ce groupe est hors ligne : mettez-le en ligne (Landing pages › Groupes).' : p,
  );
  if (spec.goal === 'form' && !spec.formId && !spec.newForm) problems.push('Choisissez un formulaire, ou faites-en un nouveau.');
  if (problems.length) throw bad(problems.join(' · '));
  return { input, acct, media, product, group, excluded: spec.excludeWilayas, boostVideo: post?.mediaType === 'VIDEO' };
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
    const { input, acct, media, product, group, excluded, boostVideo } = await inputOf(ctx, r);
    // « Où va la pub ? »: a campaign already made (its ad sets keep their own money), or a new one as before
    const into = LaunchSpec.parse(r.spec).into;
    const place = into ? await placeOf(ctx, into, input.goal) : null;
    if (place) {
      input.budgetLevel = place.campaign.cbo ? 'campaign' : 'adset';
      if (place.campaign.cbo) input.bid = null;
      if (place.adset) input.split = 'one';
    }
    // the money this launch adds per day: none when its ads go in an ad set, or a campaign, that has its own budget
    const usd = place && (place.adset || place.campaign.cbo) ? 0 : Number(r.spec.budgetUsd);
    const owner = isOwner(ctx) || approved;
    if (!owner && (s.guard.launchYes || (s.guard.yesAboveUsd !== null && usd > s.guard.yesAboveUsd))) {
      await ctx.db.query(`UPDATE ad_launches SET status = 'waiting_yes', error = NULL, updated_at = now() WHERE id = $1`, [id]);
      return view(await launchRow(ctx.db, id));
    }
    await ctx.db.query(`UPDATE ad_launches SET status = 'launching', error = NULL, updated_at = now() WHERE id = $1`, [id]);
    const done: Record<string, string> = { ...(r.meta_ids ?? {}) };
    // what is already at Meta is not made again: the campaign chosen, and its ad set when the ads go in one
    if (place) {
      done.campaign = place.campaign.id;
      if (place.adset) done['adset:a0'] = place.adset.id;
    }
    try {
      const spec = LaunchSpec.parse(r.spec);
      // the two lists Meta fills from the pages' events (fake orders, competitors): made now if they are not yet, so
      // this launch already leaves them out. Only here: the check above (« ads.launch.check ») sends nothing to Meta.
      if (spec.useAudiences && ctx.server) {
        await ensureEventAudiences(ctx);
        const aud = await audienceIds(ctx.db);
        input.excludeAudiences = aud.exclude;
        input.includeAudiences = aud.include;
      }
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
        if (res.error) throw bad(res.step === 'adsets' ? audienceRefusal(res.error, input) : res.error);
      } else {
        // the demo: made-up ids, nothing leaves Pilotix
        ids = { ...done, campaign: done.campaign ?? fakeId(ctx, 0) };
        plan.adsets.forEach((a, n) => (ids[`adset:${a.key}`] ??= fakeId(ctx, 10 + n)));
        plan.ads.forEach((a, n) => (ids[`ad:${a.key}`] ??= fakeId(ctx, 40 + n)));
      }
      const adsetIds = plan.adsets.map((a) => ids[`adset:${a.key}`]);
      const adIds = plan.ads.map((a) => ids[`ad:${a.key}`]);
      // on: what this launch made, never the campaign or ad set it went into (they stay as their owner left them)
      if (ctx.server) await ctx.server.meta('activate', { ids: [...(place ? [] : [ids.campaign]), ...(place?.adset ? [] : adsetIds), ...adIds] }, ctx);
      // Pilotix knows them now (the next sync completes them): « Mes pubs », the buttons, Pilote auto
      const marketer = isOwner(ctx) ? (r.by_user !== null && !(await ownsShop(ctx.db, num(r.by_user))) ? num(r.by_user) : null) : me(ctx);
      await ctx.db.tx(async (tx) => {
        if (!place)
          await tx.query(
            `INSERT INTO ad_campaigns (id, account_id, name, objective, status, daily_budget_cents, bid_strategy, launch_id, changed_at, updated_at) VALUES ($1,$2,$3,$4,'ACTIVE',$5,$6,$7,now(),now())
             ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE', launch_id = EXCLUDED.launch_id, updated_at = now()`,
            [ids.campaign, acct.id, input.name, GOAL_META[input.goal].objective, input.budgetLevel === 'campaign' ? input.budgetCents : null, input.bid?.strategy ?? 'LOWEST_COST_WITHOUT_CAP', id],
          );
        // a group's ad sets sell all its products (« Plus de stock » waits until none is left), and « Mes pubs » shows
        // them as the group's one card. An ad set already made (« Où va la pub ? ») keeps its own.
        if (!place?.adset)
          for (const [n, a] of plan.adsets.entries())
            await tx.query(
              `INSERT INTO adsets (id, name, campaign, campaign_id, account_id, daily_budget_cents, goal, product_ids, group_id, marketer_id, status, currency, launch_id, changed_at, updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ACTIVE',$11,$12,now(),now())
               ON CONFLICT (id) DO UPDATE SET goal = EXCLUDED.goal, launch_id = EXCLUDED.launch_id, product_ids = EXCLUDED.product_ids, group_id = EXCLUDED.group_id, status = 'ACTIVE', updated_at = now()`,
              [
                adsetIds[n],
                String(a.body.name),
                place ? place.campaign.name : input.name,
                ids.campaign,
                acct.id,
                input.budgetLevel === 'adset' ? input.budgetCents : null,
                input.goal,
                product ? [product.id] : group ? group.group.productIds : [],
                group ? group.id : null,
                marketer,
                acct.currency,
                id,
              ],
            );
        for (const [n, a] of plan.ads.entries())
          await tx.query(`INSERT INTO ads (id, adset_id, name, status, is_video, updated_at) VALUES ($1,$2,$3,'ACTIVE',$4,now()) ON CONFLICT (id) DO NOTHING`, [
            adIds[n],
            ids[`adset:${a.adset}`],
            String(a.body.name),
            input.boost ? boostVideo : media[n]?.kind === 'video',
          ]);
        if (media.length) await tx.query(`UPDATE cm_media SET for_ads = true WHERE id = ANY($1)`, [media.map((m) => m.id)]);
        await tx.query(
          `UPDATE ad_launches SET status = 'live', step = 'done', campaign_id = $2, adset_ids = $3, ad_ids = $4, meta_ids = $5, approved_by = COALESCE(approved_by, $6), live_at = now(), updated_at = now() WHERE id = $1`,
          [id, ids.campaign, adsetIds, adIds, JSON.stringify(ids), approved ? me(ctx) : null],
        );
        // the log: a new campaign, or what came into one already made (« TEST › Poussette »)
        const where = place ? (place.adset ? { level: 'adset', id: place.adset.id, name: `${place.campaign.name} › ${place.adset.name}` } : { level: 'adset', id: adsetIds[0], name: `${place.campaign.name} › ${input.name}` }) : { level: 'campaign', id: ids.campaign, name: input.name };
        await tx.query(
          `INSERT INTO ad_actions (level, object_id, object_name, op, before, after, source, status, why, by_user, approved_by, done_at) VALUES ($1,$2,$3,'launch',NULL,$4,'launch','done',$5,$6,$7,now())`,
          [where.level, where.id, where.name, JSON.stringify({ status: 'ACTIVE', budgetUsd: usd, goal: input.goal, ...(place ? { campaignId: place.campaign.id, ads: adIds.length } : {}) }), GOAL_META[input.goal].objective, numOrNull(r.by_user), approved ? me(ctx) : null],
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
  if ((i.spec.partnerId || i.spec.partnerContentId) && !influencersOn(ctx)) i = { ...i, spec: { ...i.spec, partnerId: null, partnerContentId: null } };
  // a creator's post: its creator is the launch's creator (their numbers count its orders)
  if (i.spec.partnerContentId) {
    const post = await contentFor(ctx.db, i.spec.partnerContentId);
    if (!post) throw bad('Cette publication n’est plus dans la liste : actualisez la page Influenceurs.');
    i = { ...i, spec: { ...i.spec, partnerId: i.spec.partnerId ?? post.partnerId, mediaIds: [] } };
  }
  if (i.spec.partnerId && !(await partnerFor(ctx.db, i.spec.partnerId))) throw bad('Cet influenceur n’est plus dans la liste.');
  const given = givenOf(ctx);
  if (i.spec.productId && given && !given.has(i.spec.productId)) throw forbidden('Ce produit ne vous est pas confié.');
  if (i.spec.productId && i.spec.groupId) throw bad('Choisissez un produit ou un groupe, pas les deux.');
  // a group: there, with its products all given to this person
  if (i.spec.groupId && !(await groupLimits(ctx, { only: i.spec.groupId })).length) throw forbidden('Ce groupe n’existe plus, ou un de ses produits ne vous est pas confié.');
  if (i.spec.mediaIds.length) {
    const found = await ctx.db.query(`SELECT id, created_by FROM cm_media WHERE id = ANY($1)`, [i.spec.mediaIds]);
    if (found.length !== new Set(i.spec.mediaIds).size) throw bad('Une photo ou une vidéo est introuvable.');
    // a marketer partner's person uses the photos and videos they sent themselves
    if (partner(ctx) && found.some((m: any) => numOrNull(m.created_by) !== me(ctx))) throw forbidden('Choisissez vos propres photos et vidéos.');
  }
  const usdCents = Math.round(i.spec.budgetUsd * 100);
  // the bid limit typed for this product comes back next time (TEST and SCALE start from it)
  if (i.spec.bidLimitDzd && i.spec.productId) {
    const limits = await getRaw<Record<string, number>>(ctx.db, BID_LIMITS_KEY, {});
    if (limits[String(i.spec.productId)] !== i.spec.bidLimitDzd) await setRaw(ctx.db, BID_LIMITS_KEY, { ...limits, [String(i.spec.productId)]: i.spec.bidLimitDzd }, me(ctx) || undefined);
  }
  if (i.id) {
    const r = await launchRow(ctx.db, i.id);
    mayOpen(ctx, r);
    if (!['draft', 'failed', 'refused'].includes(r.status)) throw bad('Ce lancement est déjà parti : il ne change plus.');
    await ctx.db.query(
      `UPDATE ad_launches SET mode = $2, goal = $3, product_id = $4, name = $5, spec = $6, budget_cents = $7, partner_id = $8, partner_content_id = $9, status = 'draft', error = NULL, updated_at = now() WHERE id = $1`,
      [i.id, i.mode, i.spec.goal, i.spec.productId, i.spec.name, JSON.stringify(i.spec), usdCents, i.spec.partnerId, i.spec.partnerContentId],
    );
    return view(await launchRow(ctx.db, i.id));
  }
  if (i.clientId) {
    const seen = (await ctx.db.query(`SELECT id FROM ad_launches WHERE client_id = $1`, [i.clientId]))[0];
    if (seen) return view(await launchRow(ctx.db, num(seen.id)));
  }
  const row = (
    await ctx.db.query(`INSERT INTO ad_launches (client_id, mode, goal, product_id, name, spec, budget_cents, by_user, partner_id, partner_content_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [
      i.clientId ?? null,
      i.mode,
      i.spec.goal,
      i.spec.productId,
      i.spec.name,
      JSON.stringify(i.spec),
      usdCents,
      me(ctx),
      i.spec.partnerId,
      i.spec.partnerContentId,
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

/**
 * « Photo du produit » (Lancer une pub): the product's main photo as bytes, for the page to make an ad photo of
 * (social/jpeg.ts › toPlanPhoto) — its HD photo (Produits › Photos) in its 960 px copy (the one its pages use), else its
 * small picture. Bytes, never an address: the site's security refuses a fetch of a data: address (17 Nov 2026), and the
 * bucket's are on another site. null: the product has no photo.
 */
async function productAdPhoto(ctx: Ctx, productId: number): Promise<{ type: string; base64: string } | null> {
  const given = givenOf(ctx);
  if (given && !given.has(productId)) throw forbidden('Ce produit ne vous est pas confié.');
  const p = (await ctx.db.query('SELECT photo FROM products WHERE id = $1', [productId]))[0];
  if (!p) throw notFound('Produit introuvable');
  const hd = (
    await ctx.db
      .query(`SELECT id, store, key, data FROM product_photos WHERE product_id = $1 AND kind = 'photo' ORDER BY (variant_id IS NOT NULL), position, id LIMIT 1`, [productId])
      .catch(() => [])
  )[0];
  if (hd) {
    // the browser preview (and the demo shop) keep the photo itself: a JPEG of 2048 px at most
    if (hd.store === 'local' && hd.data) return { type: 'image/jpeg', base64: String(hd.data) };
    const have = (await ctx.db.query('SELECT webp FROM landing_hd WHERE photo_id = $1 AND width = 960', [hd.id]).catch(() => []))[0];
    if (have) return { type: 'image/webp', base64: String(have.webp) };
    const made: any = ctx.server?.dellal && hd.store === 'r2' ? await ctx.server.dellal('landingHd', { key: hd.key, data: null, width: 960 }, ctx).catch(() => null) : null;
    if (made?.base64) {
      await ctx.db.query('INSERT INTO landing_hd (photo_id, width, webp) VALUES ($1, 960, $2) ON CONFLICT (photo_id, width) DO NOTHING', [hd.id, made.base64]).catch(() => undefined);
      return { type: 'image/webp', base64: String(made.base64) };
    }
  }
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(p.photo ?? ''));
  return m ? { type: m[1], base64: m[2] } : null;
}

const Id = z.number().int().positive();
const Lang = z.enum(['darija', 'fr', 'ar']);

export const adsLaunchProcs = {
  'ads.launch.options': proc(['marketer'], z.object({ contentId: z.string().max(80).nullable().default(null) }), (ctx, i) => options(ctx, i.contentId)),
  /** the ad's words: three versions and the welcome message (Pilot AI, or ready sentences) */
  'ads.launch.copy': proc(['marketer'], z.object({ productId: Id.nullable().default(null), groupId: Id.nullable().default(null), goal: z.enum(GOALS), lang: Lang, idea: z.string().max(400).default('') }), (ctx, i) => writeCopy(ctx, i)),
  'ads.launch.save': proc(['marketer'], z.object({ id: Id.nullable().optional(), clientId: z.string().max(64).nullable().optional(), mode: z.enum(['simple', 'pro']), spec: LaunchSpec }), (ctx, i) => saveLaunch(ctx, i)),
  'ads.launch.list': proc(['marketer'], z.object({}), async (ctx) => {
    const rows = await ctx.db.query(`${LAUNCH_SQL} WHERE ($1::bigint IS NULL OR l.by_user = $1) ORDER BY l.id DESC LIMIT 60`, [isOwner(ctx) ? null : me(ctx)]);
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
      const into = LaunchSpec.parse(r.spec).into;
      if (into) await placeOf(ctx, into, input.goal);
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
  'ads.media.productPhoto': proc(['marketer'], z.object({ productId: Id }), (ctx, i) => productAdPhoto(ctx, i.productId)),
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

