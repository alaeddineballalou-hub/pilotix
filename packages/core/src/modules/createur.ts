// Espace créateur (AI Pilot › Pilot Content): the shop's side of the AI credits and of the AI tools that use them. The
// videos never come here: they are cut, mixed and drawn in the browser, on the user's computer (apps/web › createur).
// Only what an AI tool needs leaves it: the sound of a piece for its subtitles (sent to Google, not kept), and the words
// of the hooks for the post texts. Each tool takes its credits first, and gives them back when the AI fails.
//
// The control room sets the tools, the strategies, the packs and the plans' credits (platform/credits.ts). A pack is
// bought with « J'ai payé » (the receipt's photo), checked by Pilotix's team like a subscription payment.
import { z } from 'zod';
import { num } from '../db';
import { bad, Ctx, proc } from '../rpc';
import { CLAIM_METHODS, CLAIM_PHOTO_MAX, CLAIM_PHOTO_RE } from '../platform/claims';
import {
  CreditsConfig,
  creditsConfig,
  CreditTool,
  DEFAULT_CREDITS,
  refundCredits,
  Spent,
  spendCredits,
  TOOL_HOOKS,
  TOOL_TEXT,
  TOOL_WORDS,
  toolCost,
  usedToday,
  wallet,
  Wallet,
} from '../platform/credits';
import { alertTeam, payingShop } from './billing';
import { AiResponse, aiKeyed, PILOT_CHEAP_MODEL, pilotOn } from './dellal';
import { getSetting } from '../settings';

const NOT_ENOUGH = 'Pas assez de crédits : achetez un pack pour continuer.';
const WAITING = 'Un achat de crédits attend déjà la vérification de Pilotix';
const money = (n: number) => n.toLocaleString('fr-FR').replace(/[  ]/g, ' ');

/** The shop's own view of the settings: only what is on (never the AI's instructions). */
function shopView(c: CreditsConfig) {
  return {
    tools: c.tools.filter((x) => x.on).map((x) => ({ key: x.key, name: x.name, desc: x.desc, credits: c.on ? x.credits : 0, unit: x.unit })),
    strategies: c.strategies.filter((x) => x.on).map((x) => ({ key: x.key, name: x.name, kind: x.kind, style: x.style, desc: x.desc, credits: c.on ? x.credits : 0, trend: x.trend, types: x.types })),
    packs: c.on ? c.packs.filter((x) => x.on).map((x) => ({ key: x.key, name: x.name, credits: x.credits, price: x.price, best: x.best })) : [],
  };
}

/** The paying shop on the server; null in the preview (no platform: the tools are free there, with example answers). */
async function payer(ctx: Ctx) {
  if (!ctx.t || !ctx.shop) return null;
  return payingShop(ctx);
}

/** Takes the credits of `units` of a tool (null in the preview: nothing counted). */
async function take(ctx: Ctx, cfg: CreditsConfig, key: string, units: number, extra = 0): Promise<{ tool: CreditTool; spent: Spent | null; shopId: number | null }> {
  const tool = cfg.tools.find((x) => x.key === key);
  if (!tool || !tool.on) throw bad('Cet outil IA est arrêté pour le moment.');
  const s = await payer(ctx);
  if (!s) return { tool, spent: null, shopId: null };
  if (tool.dayLimit > 0 && (await usedToday(ctx.t!, s.id, key)) + units > tool.dayLimit) throw bad(`Limite du jour atteinte pour « ${tool.name} » : réessayez demain.`);
  const cost = toolCost(tool, units) + extra;
  const spent = await spendCredits(ctx.t!, { id: s.id, planId: s.planId }, cost, { tool: key, units: Math.ceil(units), now: ctx.now() });
  if (!spent) throw bad(NOT_ENOUGH);
  return { tool, spent, shopId: s.id };
}

const giveBack = (ctx: Ctx, t: { spent: Spent | null; shopId: number | null; tool: CreditTool }) =>
  t.spent && t.shopId ? refundCredits(ctx.t!, t.shopId, t.spent, t.tool.key, ctx.now()).catch(() => undefined) : Promise.resolve();

/** Claude, as Pilot Comments asks it (Pilotix's key on the server; in the page: the preview's AI). */
async function ask(ctx: Ctx, system: string, user: string, max: number, model: string): Promise<string | null> {
  const inPage = !ctx.server?.dellal && ctx.dellalAi ? ctx.dellalAi : null;
  if (!inPage && !(await aiKeyed(ctx))) return null;
  const pilot = !inPage && (await pilotOn(ctx));
  const req = {
    model: pilot ? (/^claude-[a-z0-9-]+$/.test(model) ? model : PILOT_CHEAP_MODEL) : model || PILOT_CHEAP_MODEL,
    system,
    messages: [{ role: 'user' as const, content: user }],
    tools: [],
    max_tokens: max,
  };
  const res = (
    inPage ? await inPage({ ...req, runTool: async () => ({ error: 'Pas d’outil ici' }) } as any) : await ctx.server!.dellal!('complete', { ...req, feature: 'cm', pilot }, ctx)
  ) as AiResponse;
  if (res.demo) return null;
  return res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

/** A JSON list of strings in the AI's answer (« {"lines": [...]} » or a bare list). */
export function readLines(raw: string | null, n: number): string[] | null {
  if (!raw) return null;
  const m = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const list = Array.isArray(j) ? j : Array.isArray(j?.lines) ? j.lines : null;
    if (!list) return null;
    const out = list
      .map((x: unknown) =>
        String(x ?? '')
          .replace(/\s+\n/g, '\n')
          .trim()
          .slice(0, 600),
      )
      .filter(Boolean);
    return out.length >= Math.min(n, 1) ? out.slice(0, n) : null;
  } catch {
    return null;
  }
}

const LANG_RULE = {
  darija: 'en darija algérienne, en lettres arabes (comme les Algériens l’écrivent sur Facebook), quelques mots français permis',
  fr: 'en français simple',
  ar: 'en arabe simple',
} as const;

/** Example lines (the preview, or no AI on this server): from the hooks' own words. */
export function demoLines(items: { hook: string }[], product: string, lang: keyof typeof LANG_RULE): string[] {
  const open =
    lang === 'fr'
      ? ['Vous cherchez la solution ?', 'Regardez ça 👀', 'Le plus demandé ce mois-ci 🔥', 'Enfin disponible !']
      : ['راك تقلب على الحل؟', 'شوف هذا 👀', 'الأكثر طلبا هذا الشهر 🔥', 'أخيرا متوفر!'];
  return items.map((x, k) => {
    const h = x.hook.trim();
    const first = h ? (h.length > 80 ? `${h.slice(0, 77)}…` : h) : open[k % open.length];
    return product ? `${first}\n${lang === 'fr' ? `✨ ${product}` : `✨ ${product}`}` : first;
  });
}

const Strat = z.string().trim().max(40).optional();

export const createurProcs = {
  /** The page: the credits left, the tools and strategies that are on, the packs, and the last pack bought. */
  'createur.state': proc(['marketer'], z.object({}), async (ctx) => {
    const preview = !ctx.t || !ctx.shop;
    const cfg = preview ? DEFAULT_CREDITS : await creditsConfig(ctx.t!);
    let w: Wallet | null = null;
    let claim: { id: number; credits: number; amount: number; status: string; reason: string | null; createdAt: string } | null = null;
    let canBuy = false;
    if (!preview) {
      const s = await payingShop(ctx).catch(() => null);
      if (s) {
        w = await wallet(ctx.t!, { id: s.id, planId: s.planId }, ctx.now(), cfg);
        canBuy = cfg.on;
        const r = (
          await ctx.t!.platform.query(`SELECT id, credits, amount, status, reason, created_at FROM platform.payment_claims WHERE shop_id = $1 AND credits IS NOT NULL ORDER BY id DESC LIMIT 1`, [s.id])
        )[0];
        if (r)
          claim = {
            id: num(r.id),
            credits: num(r.credits),
            amount: num(r.amount),
            status: String(r.status),
            reason: (r.reason as string | null) ?? null,
            createdAt: new Date(r.created_at).toISOString(),
          };
      }
    }
    const shop = await getSetting(ctx.db, 'shop').catch(() => null);
    const logo = await getSetting(ctx.db, 'logo').catch(() => null);
    return { preview, wallet: w, canBuy, claim, ...shopView(cfg), shop: { name: shop?.name ?? '', phone: shop?.savPhone ?? '', logo: logo?.url ?? null } };
  }),

  /** « J'ai payé » for a pack: the way, a reference and the receipt's photo. The price is the pack's (never the screen's). */
  'createur.buy': proc(
    [],
    z.object({
      pack: z.string().trim().min(1).max(40),
      method: z.enum(CLAIM_METHODS),
      reference: z.string().trim().max(120).optional(),
      photo: z.string().max(CLAIM_PHOTO_MAX, 'Photo trop lourde : prenez-la plus petite').regex(CLAIM_PHOTO_RE, 'Ajoutez la photo du reçu (une image)'),
    }),
    async (ctx, i) => {
      const s = await payer(ctx);
      if (!s) throw bad('L’achat de crédits fonctionne sur le serveur Pilotix (pas dans cet aperçu)');
      const cfg = await creditsConfig(ctx.t!);
      const pack = cfg.on ? cfg.packs.find((p) => p.key === i.pack && p.on) : null;
      if (!pack) throw bad('Ce pack n’est plus en vente');
      const t = ctx.t!;
      if ((await t.platform.query(`SELECT 1 FROM platform.payment_claims WHERE shop_id = $1 AND status = 'pending' AND credits IS NOT NULL`, [s.id])).length) throw bad(WAITING);
      const p = ctx.session.profile;
      let id: number;
      try {
        const r = await t.platform.query(
          `INSERT INTO platform.payment_claims (shop_id, plan_id, months, amount, method, reference, photo, sent_by, credits, pack_key) VALUES ($1, NULL, 0, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [s.id, pack.price, i.method, i.reference || null, i.photo, `${p.name} (${p.email})`.slice(0, 200), pack.credits, pack.key],
        );
        id = num(r[0].id);
      } catch (e) {
        if (/payment_claims_one_pending|duplicate key|unique/i.test(String((e as Error)?.message))) throw bad(WAITING);
        throw e;
      }
      void alertTeam(ctx, id);
      return { id, credits: pack.credits, amount: pack.price, status: 'pending' as const };
    },
  ),

  /**
   * « Sous-titres IA »: the sound of one piece (OGG Opus or WAV, made in the browser) → its lines with their seconds.
   * It costs the tool's credits per started minute.
   */
  'createur.words': proc(
    ['marketer'],
    z.object({
      audio: z
        .string()
        .max(4_000_000, 'Morceau trop long pour les sous-titres (2 minutes au plus)')
        .regex(/^[A-Za-z0-9+/]+=*$/),
      mime: z.enum(['audio/ogg', 'audio/wav']),
      seconds: z.number().min(0.2).max(180),
      script: z.enum(['arabic', 'latin', 'fr']).default('arabic'),
    }),
    async (ctx, i) => {
      const cfg = ctx.t && ctx.shop ? await creditsConfig(ctx.t) : DEFAULT_CREDITS;
      const minutes = Math.max(1, Math.ceil(i.seconds / 60));
      const got = await take(ctx, cfg, TOOL_WORDS, minutes);
      if (!ctx.server?.dellal) {
        // the preview: no AI listens here
        return { segments: [] as { start: number; end: number; text: string }[], demo: true, credits: 0 };
      }
      try {
        const r = (await ctx.server.dellal('clipWords', { data: i.audio, mime: i.mime, script: i.script, model: got.tool.model, prompt: got.tool.prompt, seconds: i.seconds }, ctx)) as any;
        if (!r?.ok) {
          await giveBack(ctx, got);
          throw bad(r?.error === 'off' ? 'Les sous-titres IA ne sont pas encore branchés sur ce serveur (Pilot AI › Voix).' : 'L’IA n’a pas pu écouter ce morceau : réessayez.');
        }
        return { segments: r.segments as { start: number; end: number; text: string }[], demo: false, credits: (got.spent?.month ?? 0) + (got.spent?.bonus ?? 0) };
      } catch (e) {
        if ((e as any)?.code !== 'bad_request') await giveBack(ctx, got);
        throw e;
      }
    },
  ),

  /**
   * « Texte du post IA »: the changing part of each post (one per ad, from its hook's words), the fixed part stays the
   * shop's. It costs the tool's credits per post.
   */
  'createur.texts': proc(
    ['marketer'],
    z.object({
      productId: z.number().int().positive().nullable(),
      strategy: Strat,
      lang: z.enum(['darija', 'fr', 'ar']).default('darija'),
      items: z
        .array(z.object({ hook: z.string().trim().max(400), body: z.string().trim().max(600).default('') }))
        .min(1)
        .max(60),
    }),
    async (ctx, i) => {
      const cfg = ctx.t && ctx.shop ? await creditsConfig(ctx.t) : DEFAULT_CREDITS;
      const pr = i.productId ? (await ctx.db.query(`SELECT name, price, description FROM products WHERE id = $1`, [i.productId]))[0] : null;
      const product = pr ? String(pr.name) : '';
      const got = await take(ctx, cfg, TOOL_TEXT, i.items.length);
      const st = cfg.strategies.find((x) => x.key === i.strategy);
      const system = [
        'Tu écris pour une boutique en ligne algérienne (paiement à la livraison) la PARTIE QUI CHANGE du texte de chaque post Facebook / Instagram qui accompagne une vidéo pub.',
        `Écris ${LANG_RULE[i.lang]}.`,
        'Pour chaque vidéo : 1 à 2 lignes courtes qui reprennent l’idée de son hook (le début de la vidéo), qui donnent envie et parlent au client. 1 ou 2 émojis au plus.',
        'N’écris JAMAIS le prix, la livraison, le paiement, le lien ni le numéro : la boutique les ajoute elle-même en dessous (la partie fixe).',
        'Pas de mensonge, pas de promesse médicale, pas de faux avis. Chaque texte différent des autres.',
        st?.idea ? `Stratégie de la pub : ${st.name} — ${st.idea}` : '',
        got.tool.prompt ? `Consignes de la boutique Pilotix : ${got.tool.prompt}` : '',
        `Réponds seulement en JSON : {"lines": ["texte 1", "texte 2", …]} avec exactement ${i.items.length} textes, dans l’ordre.`,
      ]
        .filter(Boolean)
        .join('\n');
      const user = [
        product ? `Produit : ${product}${pr?.price ? ` (${money(num(pr.price))} DA)` : ''}` : 'Pas de produit précis.',
        pr?.description ? `Description : ${String(pr.description).slice(0, 500)}` : '',
        ...i.items.map((x, k) => `Vidéo ${k + 1} — hook : ${x.hook || '(pas de texte)'}${x.body ? ` — ce que dit le corps : ${x.body.slice(0, 300)}` : ''}`),
      ]
        .filter(Boolean)
        .join('\n');
      let raw: string | null = null;
      try {
        raw = await ask(ctx, system, user, Math.min(4000, 150 + i.items.length * 120), got.tool.model);
      } catch (e) {
        await giveBack(ctx, got);
        throw bad(`L’IA n’a pas pu écrire les textes : ${(e as Error)?.message ?? 'réessayez'}`);
      }
      const lines = readLines(raw, i.items.length);
      if (!lines || lines.length < i.items.length) {
        // no AI here (or a broken answer): the credits come back, the example texts stay editable
        await giveBack(ctx, got);
        return { lines: demoLines(i.items, product, i.lang), demo: true };
      }
      return { lines, demo: false };
    },
  ),

  /**
   * An ad was made on the computer with a strategy that costs credits (a free one costs nothing): its credits are taken
   * once the video is there (a video that failed costs nothing).
   */
  'createur.made': proc(['marketer'], z.object({ strategy: z.string().trim().min(1).max(40), count: z.number().int().min(1).max(60).default(1) }), async (ctx, i) => {
    const cfg = ctx.t && ctx.shop ? await creditsConfig(ctx.t) : DEFAULT_CREDITS;
    const st = cfg.strategies.find((x) => x.key === i.strategy && x.on);
    if (!st) throw bad('Cette stratégie est arrêtée pour le moment.');
    const s = await payer(ctx);
    if (!s || !cfg.on || st.credits <= 0) return { credits: 0 };
    const spent = await spendCredits(ctx.t!, { id: s.id, planId: s.planId }, st.credits * i.count, { tool: `strategy:${st.key}`, units: i.count, now: ctx.now() });
    if (!spent) throw bad(NOT_ENOUGH);
    return { credits: st.credits * i.count };
  }),

  /** « Idées de hooks IA »: 10 short first sentences for the product's videos. */
  'createur.hooks': proc(['marketer'], z.object({ productId: z.number().int().positive(), lang: z.enum(['darija', 'fr', 'ar']).default('darija'), strategy: Strat }), async (ctx, i) => {
    const cfg = ctx.t && ctx.shop ? await creditsConfig(ctx.t) : DEFAULT_CREDITS;
    const pr = (await ctx.db.query(`SELECT name, description FROM products WHERE id = $1`, [i.productId]))[0];
    if (!pr) throw bad('Produit introuvable');
    const got = await take(ctx, cfg, TOOL_HOOKS, 1);
    const st = cfg.strategies.find((x) => x.key === i.strategy);
    const system = [
      'Tu es un créateur de pubs vidéo pour des boutiques en ligne algériennes. Donne 10 HOOKS : la première phrase dite ou écrite dans les 3 premières secondes d’une vidéo, qui arrête le pouce.',
      `Écris ${LANG_RULE[i.lang]}. 4 à 10 mots chacun. Variés : une question, un problème, une surprise, un défi, une réaction.`,
      'Pas de mensonge, pas de promesse médicale.',
      st?.idea ? `Stratégie : ${st.name} — ${st.idea}` : '',
      got.tool.prompt ? `Consignes : ${got.tool.prompt}` : '',
      'Réponds seulement en JSON : {"lines": ["…", …]} (10 textes).',
    ]
      .filter(Boolean)
      .join('\n');
    let raw: string | null = null;
    try {
      raw = await ask(ctx, system, `Produit : ${pr.name}${pr.description ? `\nDescription : ${String(pr.description).slice(0, 500)}` : ''}`, 900, got.tool.model);
    } catch (e) {
      await giveBack(ctx, got);
      throw bad(`L’IA n’a pas pu écrire les idées : ${(e as Error)?.message ?? 'réessayez'}`);
    }
    const lines = readLines(raw, 10);
    if (!lines) {
      await giveBack(ctx, got);
      return {
        lines: demoLines(
          Array.from({ length: 4 }, () => ({ hook: '' })),
          '',
          i.lang,
        ),
        demo: true,
      };
    }
    return { lines, demo: false };
  }),
};
