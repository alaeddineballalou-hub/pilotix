// Studio photo (Espace créateur › Studio photo): the AI poses a product on the shop's own background (its showroom),
// like a real photo, for each colour / size (variant) from 2 to 5 photos of it alone. Three versions each; Gemini then
// looks at each one (the same product? standing on the table with its shadow? the shop's logo free?) and a version that
// fails is made once more. The one the shop picks goes to that variant's photos (first: Dellal sends it), and its small
// copy becomes the variant's picture; the poster (made in the page, its texts and prices written by Pilotix, never by
// the AI) becomes the product's main photo.
//
// Who pays: Pilotix's Google key and the shop's AI credits (the control room's « Studio photo IA » tool, per image), or
// the shop's own key (Gemini or OpenAI, saved by an administrator): then it pays them itself and no credits are taken.
// The backgrounds are blurred by the page (once, so every photo on one matches) and kept in the shop's database.
import { z } from 'zod';
import { num } from '../db';
import { bad, Ctx, notFound, proc } from '../rpc';
import { creditsConfig, DEFAULT_CREDITS, TOOL_PHOTO, TOOL_TEXT } from '../platform/credits';
import { getRaw, setRaw } from './admin';
import { ask, giveBack, take } from './createur';
import { AddInput, addHdPhoto } from './hdphotos';
import { mimeOf } from './dellalphotos';

const M = ['marketer'] as const;
const Id = z.number().int().positive();
const KEY_ROW = 'secret_studio_key';
export const STUDIO = { backgrounds: 8, photos: 5, bgMax: 1_800_000, photoMax: 700_000, thumbMax: 120_000, smallMax: 60_000 } as const;
const MODES = ['credits', 'gemini', 'openai'] as const;
type Mode = (typeof MODES)[number];
/** the model that looks at the photos (a Gemini that reads images; cheap) */
export const STUDIO_CHECK_MODEL = 'gemini-flash-latest';
const MODEL_RE = /^[a-z0-9][a-z0-9.\-]{2,59}$/i;

type Logo = { x: number; y: number; w: number; h: number };
const LogoIn = z
  .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.01).max(1), h: z.number().min(0.01).max(1) })
  .nullable()
  .optional();
const Img = z.object({ mime: z.enum(['image/jpeg', 'image/png', 'image/webp']), data: z.string().min(100).max(Math.ceil((STUDIO.photoMax * 4) / 3) + 4) });
const b64Bytes = (b64: string) => Math.floor((b64.length * 3) / 4);

async function ownKey(ctx: Ctx): Promise<{ mode: Mode; key: string; model: string }> {
  const v = await getRaw<any>(ctx.db, KEY_ROW, null);
  const mode: Mode = (MODES as readonly string[]).includes(v?.mode) ? v.mode : 'credits';
  return { mode, key: typeof v?.key === 'string' ? v.key : '', model: typeof v?.model === 'string' && MODEL_RE.test(v.model) ? v.model : '' };
}

const pct = (n: number) => Math.round(n * 100);

/** What the image AI is told (the shop's « website-image » rules, made short and exact). */
export function studioPrompt(a: { product: string; variant: string | null; surface: 'table' | 'floor'; logo: Logo | null; photos: number; note?: string; extra?: string; again?: string[] }): string {
  const where = a.surface === 'floor' ? 'on the floor of the room' : 'on the wooden table / display surface in the front of the picture';
  return [
    'You are a professional commercial product photographer and compositing expert.',
    `IMAGE 1 is the BACKGROUND: the shop's real showroom. IMAGES 2 to ${a.photos + 1} are the SAME real product from different angles: « ${a.product}${a.variant ? ` — ${a.variant}` : ''} ».`,
    'Put this exact product into the background so the result looks like ONE real photograph taken in the shop. This is compositing, NOT a redesign.',
    '',
    'PRODUCT (most important):',
    '- Keep the exact same product: shape, proportions, colors, fabric, materials, logos, printed text, every part. Do not add, remove, merge or duplicate parts. Do not invent text or logos.',
    '- Remove price stickers and barcode labels if any. Use the angle from the product photos that fits the room best (a 3/4 view when possible).',
    '',
    'BACKGROUND:',
    '- Keep the background exactly as it is (it is already blurred and final): no new blur, no relight, no color change, no crop, nothing moved, added or removed.',
    a.logo
      ? `- The shop's sign / logo is inside the box from ${pct(a.logo.x)}% to ${pct(a.logo.x + a.logo.w)}% of the width and from ${pct(a.logo.y)}% to ${pct(a.logo.y + a.logo.h)}% of the height (from the top left). The product must NEVER cover, cross or touch that box: leave the logo fully visible, with a clear gap.`
      : '- If the background shows a sign or a logo, the product must never cover or cross it.',
    '',
    'SIZE AND PLACE:',
    `- Real-life size compared to the room and the furniture: not miniature, not oversized. The product stands ${where}, centered left-right, fully inside the picture with space around it.`,
    '',
    'LIGHT:',
    '- Same light as the room: same direction, same warmth, same camera height and angle. A real soft contact shadow under every point that touches the surface.',
    '- The product is sharp and detailed. No floating, no hard cut-out edges, no halo, no glow, no fake shine.',
    '',
    'OUTPUT: one photorealistic image, 4:5 portrait, no text, no watermark, no added graphics.',
    a.note ? `The shop adds: ${a.note}` : '',
    a.extra ? `Pilotix adds: ${a.extra}` : '',
    a.again?.length ? `A first try had these problems, avoid them: ${a.again.join(' ; ')}` : '',
  ]
    .filter((x) => x !== '')
    .join('\n');
}

/** What the checking AI is told: it answers in JSON. */
export function checkPrompt(a: { product: string; logo: Logo | null; photos: number }): string {
  return [
    `IMAGE 1 is a product photo made by an AI for an online shop. IMAGES 2 to ${a.photos + 1} are the real product « ${a.product} ».`,
    'Check IMAGE 1 strictly and answer in JSON only: {"ok": true or false, "problems": ["...", ...]} (problems in simple French, short, at most 4).',
    'ok is false if ANY of these fails:',
    '1. The product is the same as the real one (shape, colors, parts, logos, printed text not changed or invented).',
    '2. It stands on a surface with a real contact shadow (not floating, not pasted).',
    '3. Its size looks real for the room (not tiny, not huge) and it is fully in the picture.',
    a.logo
      ? `4. The shop's logo (box from ${pct(a.logo.x)}% to ${pct(a.logo.x + a.logo.w)}% of the width, ${pct(a.logo.y)}% to ${pct(a.logo.y + a.logo.h)}% of the height) is fully visible, not covered.`
      : '4. A sign or logo in the room is not covered by the product.',
    '5. No text, watermark or strange artefact was added.',
  ].join('\n');
}

/** The checking AI's answer: ok and the problems (a broken answer: not checked). */
export function readCheck(raw: string | null): { ok: boolean; problems: string[] } | null {
  if (!raw) return null;
  const m = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (typeof j?.ok !== 'boolean') return null;
    const problems = (Array.isArray(j.problems) ? j.problems : []).map((x: unknown) => String(x ?? '').trim().slice(0, 200)).filter(Boolean).slice(0, 4);
    return { ok: j.ok && !problems.length ? true : j.ok, problems };
  } catch {
    return null;
  }
}

/** The poster's words the AI suggests (all editable in the page): a title, a line under it, 4 short benefits. */
export function readPosterTexts(raw: string | null): { title: string; subtitle: string; features: string[] } | null {
  if (!raw) return null;
  const m = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const s = (x: unknown, n: number) => String(x ?? '').trim().slice(0, n);
    const features = (Array.isArray(j?.features) ? j.features : []).map((x: unknown) => s(x, 40)).filter(Boolean).slice(0, 4);
    if (!s(j?.title, 80) || features.length < 2) return null;
    return { title: s(j.title, 80), subtitle: s(j?.subtitle, 60), features };
  } catch {
    return null;
  }
}

const bgView = (r: any) => ({
  id: num(r.id),
  name: String(r.name),
  thumb: String(r.thumb),
  w: num(r.w),
  h: num(r.h),
  logo: (r.logo ?? null) as Logo | null,
  surface: r.surface === 'floor' ? ('floor' as const) : ('table' as const),
});

async function backgrounds(ctx: Ctx) {
  return (await ctx.db.query(`SELECT id, name, thumb, w, h, logo, surface FROM studio_backgrounds ORDER BY position, id`)).map(bgView);
}

export const studioProcs = {
  /** The page: the backgrounds, how the AI is paid, the tool's price, and the products with their colours / sizes. */
  'createur.studio': proc([...M], z.object({}), async (ctx) => {
    const cfg = ctx.t && ctx.shop ? await creditsConfig(ctx.t) : DEFAULT_CREDITS;
    const tool = cfg.tools.find((x) => x.key === TOOL_PHOTO);
    const k = await ownKey(ctx);
    const prods = await ctx.db.query(`SELECT id, name, price, photo FROM products WHERE active ORDER BY name LIMIT 500`);
    const vars = prods.length
      ? await ctx.db.query(`SELECT id, product_id, title, price, photo FROM product_variants WHERE active AND title <> '' AND product_id = ANY($1) ORDER BY id`, [prods.map((p: any) => p.id)])
      : [];
    return {
      backgrounds: await backgrounds(ctx),
      key: { mode: k.mode, has: !!k.key, model: k.model },
      tool: { on: !!tool?.on, credits: cfg.on ? (tool?.credits ?? 0) : 0, model: tool?.model ?? '' },
      server: !!ctx.server?.dellal,
      limits: STUDIO,
      products: prods.map((p: any) => ({
        id: num(p.id),
        name: String(p.name),
        price: p.price == null ? null : num(p.price),
        photo: p.photo ? String(p.photo) : null,
        variants: vars.filter((v: any) => num(v.product_id) === num(p.id)).map((v: any) => ({ id: num(v.id), title: String(v.title), price: v.price == null ? null : num(v.price), photo: v.photo ? String(v.photo) : null })),
      })),
    };
  }),

  /** A background's full picture (the page draws on it: the example photo of the preview). */
  'createur.studioBg': proc([...M], z.object({ id: Id }), async (ctx, i) => {
    const r = (await ctx.db.query(`SELECT data FROM studio_backgrounds WHERE id = $1`, [i.id]))[0];
    if (!r) throw notFound('Fond introuvable');
    return { data: String(r.data) };
  }),

  'createur.studioAddBg': proc(
    [...M],
    z.object({
      name: z.string().trim().min(1).max(60),
      /** JPEG, base64 (no data: prefix), already blurred by the page */
      data: z.string().min(100).max(Math.ceil((STUDIO.bgMax * 4) / 3) + 4),
      thumb: z.string().min(40).max(STUDIO.thumbMax),
      w: z.number().int().min(200).max(4096),
      h: z.number().int().min(200).max(4096),
      logo: LogoIn,
      surface: z.enum(['table', 'floor']).default('table'),
    }),
    async (ctx, i) => {
      const data = i.data.replace(/\s+/g, '');
      if (mimeOf(data) !== 'image/jpeg') throw bad('Le fond doit être un JPEG (la page le prépare elle-même : réessayez).');
      if (b64Bytes(data) > STUDIO.bgMax) throw bad('Fond trop lourd.');
      if (!/^data:image\/(jpeg|webp);base64,/.test(i.thumb)) throw bad('Petite copie invalide.');
      const n = num((await ctx.db.query(`SELECT count(*)::int AS n FROM studio_backgrounds`))[0]?.n);
      if (n >= STUDIO.backgrounds) throw bad(`${STUDIO.backgrounds} fonds au plus : supprimez-en un d’abord.`);
      await ctx.db.query(`INSERT INTO studio_backgrounds (name, data, thumb, w, h, logo, surface, position) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
        i.name,
        data,
        i.thumb,
        i.w,
        i.h,
        i.logo ? JSON.stringify(i.logo) : null,
        i.surface,
        n,
      ]);
      return { backgrounds: await backgrounds(ctx) };
    },
  ),

  'createur.studioEditBg': proc([...M], z.object({ id: Id, name: z.string().trim().min(1).max(60).optional(), logo: LogoIn, surface: z.enum(['table', 'floor']).optional() }), async (ctx, i) => {
    const r = (await ctx.db.query(`SELECT id FROM studio_backgrounds WHERE id = $1`, [i.id]))[0];
    if (!r) throw notFound('Fond introuvable');
    await ctx.db.query(
      `UPDATE studio_backgrounds SET name = coalesce($2, name), logo = CASE WHEN $3::boolean THEN $4::jsonb ELSE logo END, surface = coalesce($5, surface) WHERE id = $1`,
      [i.id, i.name ?? null, i.logo !== undefined, i.logo ? JSON.stringify(i.logo) : null, i.surface ?? null],
    );
    return { backgrounds: await backgrounds(ctx) };
  }),

  'createur.studioRemoveBg': proc([...M], z.object({ id: Id }), async (ctx, i) => {
    await ctx.db.query(`DELETE FROM studio_backgrounds WHERE id = $1`, [i.id]);
    return { backgrounds: await backgrounds(ctx) };
  }),

  /** How the AI is paid: Pilotix's credits, or the shop's own key (Gemini or OpenAI). Never sent back to the page. */
  'createur.studioKey': proc(
    ['admin'],
    z.object({ mode: z.enum(MODES), key: z.string().trim().max(300).optional(), model: z.string().trim().max(60).optional() }),
    async (ctx, i) => {
      const before = await ownKey(ctx);
      const key = i.mode === 'credits' ? '' : i.key || (before.mode === i.mode ? before.key : '');
      if (i.mode !== 'credits' && key.length < 20) throw bad('Collez la clé API (elle commence par « AIza » chez Google, par « sk- » chez OpenAI).');
      if (i.model && !MODEL_RE.test(i.model)) throw bad('Nom de modèle invalide.');
      await setRaw(ctx.db, KEY_ROW, { mode: i.mode, key, model: i.model || '' }, ctx.session.profile.id || undefined);
      return { mode: i.mode, has: !!key, model: i.model || '' };
    },
  ),

  /**
   * One version of a product's photo on a background (the page asks for 3 at once). Credits are taken per image (none
   * with the shop's own key) and given back when the AI fails. The check may make it once more (that image counts too).
   * In the browser preview (no server): { demo: true }, the page draws an example itself.
   */
  'createur.studioMake': proc(
    [...M],
    z.object({
      productId: Id,
      variantId: Id.nullable().optional(),
      backgroundId: Id,
      photos: z.array(Img).min(1).max(STUDIO.photos),
      note: z.string().trim().max(300).optional(),
      check: z.boolean().default(true),
    }),
    async (ctx, i) => {
      const pr = (await ctx.db.query(`SELECT name FROM products WHERE id = $1`, [i.productId]))[0];
      if (!pr) throw notFound('Produit introuvable');
      const va = i.variantId ? (await ctx.db.query(`SELECT title FROM product_variants WHERE id = $1 AND product_id = $2`, [i.variantId, i.productId]))[0] : null;
      if (i.variantId && !va) throw bad('Cette variante n’est pas celle de ce produit.');
      const bg = (await ctx.db.query(`SELECT data, logo, surface FROM studio_backgrounds WHERE id = $1`, [i.backgroundId]))[0];
      if (!bg) throw notFound('Fond introuvable');
      if (!ctx.server?.dellal) return { demo: true as const };

      const cfg = ctx.t && ctx.shop ? await creditsConfig(ctx.t) : DEFAULT_CREDITS;
      const tool = cfg.tools.find((x) => x.key === TOOL_PHOTO);
      if (!tool || !tool.on) throw bad('Le Studio photo IA est arrêté pour le moment.');
      const own = await ownKey(ctx);
      const useOwn = own.mode !== 'credits' && !!own.key;
      const provider = own.mode === 'openai' && useOwn ? ('openai' as const) : ('gemini' as const);
      const model = (useOwn && own.model) || (provider === 'openai' ? 'gpt-image-1' : tool.model || 'gemini-3.1-flash-image-preview');
      const product = String(pr.name);
      const logo = (bg.logo ?? null) as Logo | null;
      const surface = bg.surface === 'floor' ? ('floor' as const) : ('table' as const);
      const images = [{ mime: 'image/jpeg', data: String(bg.data) }, ...i.photos];
      // the check reads with Gemini: Pilotix's key, or the shop's own Gemini key (an OpenAI key cannot check here)
      const checkKey = useOwn && provider === 'gemini' ? own.key : null;
      const canCheck = i.check && !(useOwn && provider === 'openai');

      const once = async (again?: string[]) => {
        const got = useOwn ? null : await take(ctx, cfg, TOOL_PHOTO, 1);
        const prompt = studioPrompt({ product, variant: va ? String(va.title) : null, surface, logo, photos: i.photos.length, note: i.note, extra: tool.prompt, again });
        const r = (await ctx.server!.dellal!('studioImage', { provider, key: useOwn ? own.key : null, model, prompt, images }, ctx)) as any;
        if (!r?.ok) {
          if (got) await giveBack(ctx, got);
          const e = String(r?.error ?? '');
          throw bad(
            e === 'off'
              ? 'L’IA image de Pilotix n’est pas encore branchée (clé Google absente) : collez votre propre clé, ou demandez à Pilotix de l’activer.'
              : `L’IA n’a pas pu faire la photo : ${e.slice(0, 200) || 'réessayez'}`,
          );
        }
        return { image: String(r.image), w: num(r.w), h: num(r.h) };
      };
      const look = async (image: string) => {
        if (!canCheck) return null;
        const r = (await ctx.server!.dellal!('studioCheck', { provider: 'gemini', key: checkKey, model: STUDIO_CHECK_MODEL, prompt: checkPrompt({ product, logo, photos: i.photos.length }), images: [{ mime: 'image/jpeg', data: image }, ...i.photos] }, ctx).catch(() => null)) as any;
        return r?.ok ? readCheck(String(r.text)) : null;
      };

      let shot = await once();
      let check = await look(shot.image);
      let redone = false;
      if (check && !check.ok) {
        // made once more, told what was wrong; the better of the two is kept
        const second = await once(check.problems).catch(() => null);
        if (second) {
          const c2 = await look(second.image);
          redone = true;
          if (!c2 || c2.ok || c2.problems.length <= check.problems.length) {
            shot = second;
            check = c2;
          }
        }
      }
      return { demo: false as const, image: shot.image, w: shot.w, h: shot.h, check, checked: canCheck, redone, own: useOwn, model };
    },
  ),

  /**
   * The picked photo goes to the product: first among that colour's / size's HD photos (Dellal sends it), and its small
   * copy becomes the variant's picture (or the product's main picture: the poster, or a product without variants).
   */
  'createur.studioSave': proc(
    [...M],
    AddInput.omit({ kind: true }).extend({
      /** the small picture kept with the product / variant (WebP or JPEG, 320 px) */
      small: z.string().min(40).max(STUDIO.smallMax),
      main: z.boolean().default(false),
    }),
    async (ctx, i) => {
      if (!/^data:image\/(jpeg|webp);base64,/.test(i.small)) throw bad('Petite copie invalide.');
      await addHdPhoto(ctx, { productId: i.productId, variantId: i.main ? null : (i.variantId ?? null), kind: 'photo', data: i.data, w: i.w, h: i.h, thumb: i.thumb, mini: i.mini }, true);
      if (!i.main && i.variantId) await ctx.db.query(`UPDATE product_variants SET photo = $3 WHERE id = $1 AND product_id = $2`, [i.variantId, i.productId, i.small]);
      else await ctx.db.query(`UPDATE products SET photo = $2 WHERE id = $1`, [i.productId, i.small]);
      return { ok: true };
    },
  ),

  /** The poster's words, suggested by the AI (the shop edits them; prices, phone and colours are never the AI's). */
  'createur.studioTexts': proc([...M], z.object({ productId: Id, lang: z.enum(['ar', 'darija', 'fr']).default('ar') }), async (ctx, i) => {
    const pr = (await ctx.db.query(`SELECT name, description FROM products WHERE id = $1`, [i.productId]))[0];
    if (!pr) throw notFound('Produit introuvable');
    const example = {
      title: i.lang === 'fr' ? `${String(pr.name)} : la qualité au quotidien !` : 'أناقة ومتانة في كل يوم!',
      subtitle: '',
      features: i.lang === 'fr' ? ['Solide', 'Confortable', 'Facile à utiliser', 'Qualité garantie'] : ['متين', 'مريح', 'سهل الاستعمال', 'جودة مضمونة'],
    };
    if (!ctx.server?.dellal && !ctx.dellalAi) return { ...example, demo: true };
    const cfg = ctx.t && ctx.shop ? await creditsConfig(ctx.t) : DEFAULT_CREDITS;
    const got = await take(ctx, cfg, TOOL_TEXT, 1);
    const lang = i.lang === 'fr' ? 'en français simple' : i.lang === 'darija' ? 'en darija algérienne en lettres arabes' : 'en arabe simple et vendeur (comme les affiches des boutiques algériennes)';
    const system = [
      'Tu écris les mots d’une AFFICHE produit pour une boutique en ligne algérienne (paiement à la livraison).',
      `Écris ${lang}. Un titre court qui donne envie (3 à 6 mots, peut finir par « ! »), une ligne courte sous le titre (pour qui / l’âge / l’usage, ou vide), et 4 avantages très courts (1 à 3 mots chacun) que l’on voit vraiment sur le produit.`,
      'N’écris JAMAIS de prix, de numéro, de livraison ni de promesse fausse : Pilotix les ajoute lui-même.',
      'Réponds seulement en JSON : {"title": "…", "subtitle": "…", "features": ["…", "…", "…", "…"]}',
    ].join('\n');
    let raw: string | null = null;
    try {
      raw = await ask(ctx, system, `Produit : ${String(pr.name)}${pr.description ? `\nDescription : ${String(pr.description).slice(0, 600)}` : ''}`, 400, got.tool.model);
    } catch {
      raw = null;
    }
    const t = readPosterTexts(raw);
    if (!t) {
      await giveBack(ctx, got);
      return { ...example, demo: true };
    }
    return { ...t, demo: false };
  }),
};
