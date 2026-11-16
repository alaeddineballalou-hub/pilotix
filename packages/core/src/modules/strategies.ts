// Marketing › Stratégies: each product gets its type for the ads (1 the shop's own, 2 like a competitor's, 3 exactly a
// competitor's), and Pilotix recommends the video formats that fit it best, from the control room's strategies library
// (platform/credits.ts: each format says the types and the funnel stages it fits). « Envoyer à l'Espace créateur »
// opens Espace créateur with the product, the stage and the formats chosen (in the browser: nothing is kept here).
import { CIRCLE_STEPS, circleBad, circleField, circleValues } from '@pilotix/shared';
import { z } from 'zod';
import { num, numOrNull } from '../db';
import { bad, Ctx, proc } from '../rpc';
import { getRaw, setRaw } from './admin';
import { CreditStrategy, creditsConfig, DEFAULT_CREDITS, FUNNEL_STAGES, FunnelStage, PRODUCT_TYPES, ProductType } from '../platform/credits';

export interface StratFormat {
  key: string;
  name: string;
  desc: string;
  kind: CreditStrategy['kind'];
  style: CreditStrategy['style'];
  credits: number;
  trend: boolean;
  types: ProductType[];
  stages: FunnelStage[];
}

/**
 * The formats for a product type, best first: the recipes made for this type (a format made for this type only is the
 * most precise), then « tendance », then the library's order. The editing styles (Ugly ads, Propre) are not formats:
 * they draw any of them, so they are left out.
 */
export function recommend(list: StratFormat[], type: ProductType, stage?: FunnelStage): StratFormat[] {
  return list
    .map((x, i) => ({ x, i }))
    .filter(({ x }) => x.kind === 'recipe' && x.types.includes(type) && (!stage || x.stages.includes(stage)))
    // with a stage: the formats made for that stage only come first too
    .sort((a, b) => a.x.types.length - b.x.types.length || (stage ? a.x.stages.length - b.x.stages.length : 0) || Number(b.x.trend) - Number(a.x.trend) || a.i - b.i)
    .map(({ x }) => x);
}

async function formats(ctx: Ctx): Promise<StratFormat[]> {
  const cfg = ctx.t && ctx.shop ? await creditsConfig(ctx.t) : DEFAULT_CREDITS;
  return cfg.strategies
    .filter((x) => x.on)
    .map((x) => ({ key: x.key, name: x.name, desc: x.desc, kind: x.kind, style: x.style, credits: cfg.on ? x.credits : 0, trend: x.trend, types: x.types, stages: x.stages }));
}

const Type = z.union([z.literal(1), z.literal(2), z.literal(3)]);

/** The shop's « Life ad circle » settings are one settings row; a field never saved keeps its default. */
const CIRCLE_KEY = 'ad_circle';
/** Next test's products: picked a week early, sent to Espace créateur, ticked when their videos are done. */
export interface CircleNext { ids: number[]; sentAt: string | null; done: number[] }
function circleNext(saved: Record<string, unknown>): CircleNext {
  const n = saved.next && typeof saved.next === 'object' ? (saved.next as Record<string, unknown>) : {};
  const list = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is number => Number.isInteger(x) && (x as number) > 0))] : []);
  const ids = list(n.ids);
  return { ids, sentAt: typeof n.sentAt === 'string' && ids.length ? n.sentAt : null, done: list(n.done).filter((id) => ids.includes(id)) };
}
const CIRCLE_PICKS = 200;
const circleProducts = (ctx: Ctx) =>
  ctx.db.query(`SELECT id, name, photo FROM products WHERE active AND NOT is_service AND archived_at IS NULL ORDER BY lower(name) LIMIT 500`);

async function circleSaved(ctx: Ctx): Promise<Record<string, unknown>> {
  const v = await getRaw<unknown>(ctx.db, CIRCLE_KEY, null);
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export const strategiesProcs = {
  /** The shop's products with their type, the formats library, and the recommended formats for each type. */
  'strat.state': proc(['vendeur', 'marketer'], z.object({}), async (ctx) => {
    const rows = await ctx.db.query(
      `SELECT id, name, price, photo, product_type FROM products WHERE active AND NOT is_service AND archived_at IS NULL ORDER BY lower(name) LIMIT 500`,
    );
    const list = await formats(ctx);
    const byType = Object.fromEntries(PRODUCT_TYPES.map((t) => [t, recommend(list, t).map((x) => x.key)])) as Record<ProductType, string[]>;
    // « 2-top »: the formats for a type 2 product at the awareness stage, best first
    const byStage: Record<string, string[]> = {};
    for (const t of PRODUCT_TYPES) for (const st of FUNNEL_STAGES) byStage[`${t}-${st}`] = recommend(list, t, st).map((x) => x.key);
    return {
      products: rows.map((r: any) => ({
        id: num(r.id),
        name: String(r.name),
        price: num(r.price),
        photo: typeof r.photo === 'string' && r.photo.length < 2000 ? (r.photo as string) : null,
        type: numOrNull(r.product_type) as ProductType | null,
      })),
      formats: list,
      byType,
      byStage,
    };
  }),

  /** Sets (or clears) a product's type. */
  'strat.setType': proc(['vendeur', 'marketer'], z.object({ id: z.number().int().positive(), type: Type.nullable() }), async (ctx, i) => {
    const r = await ctx.db.query('UPDATE products SET product_type = $2 WHERE id = $1 AND archived_at IS NULL RETURNING id', [i.id, i.type]);
    if (!r[0]) throw bad('Produit introuvable');
    return { ok: true };
  }),

  /**
   * « Life ad circle »: the five steps, the shop's value for every setting (its own, else the default), its products,
   * and the ones picked for the next test (a product archived since is left out).
   */
  'strat.circle': proc(['vendeur', 'marketer'], z.object({}), async (ctx) => {
    const saved = await circleSaved(ctx);
    const rows = await circleProducts(ctx);
    const products = rows.map((r: any) => ({ id: num(r.id), name: String(r.name), photo: typeof r.photo === 'string' && r.photo.length < 2000 ? (r.photo as string) : null }));
    const have = new Set(products.map((p) => p.id));
    const next = circleNext(saved);
    const ids = next.ids.filter((id) => have.has(id));
    return { steps: [...CIRCLE_STEPS], values: circleValues(saved), products, next: { ids, sentAt: ids.length ? next.sentAt : null, done: next.done.filter((id) => have.has(id)) } };
  }),

  /** Picks a product for the next test, or takes it back out. */
  'strat.circlePick': proc(['vendeur', 'marketer'], z.object({ id: z.number().int().positive(), on: z.boolean() }), async (ctx, i) => {
    const saved = await circleSaved(ctx);
    const next = circleNext(saved);
    if (i.on) {
      if (!(await ctx.db.query('SELECT 1 FROM products WHERE id = $1 AND active AND NOT is_service AND archived_at IS NULL', [i.id]))[0]) throw bad('Produit introuvable');
      if (!next.ids.includes(i.id)) {
        if (next.ids.length >= CIRCLE_PICKS) throw bad(`Pas plus de ${CIRCLE_PICKS} produits`);
        next.ids.push(i.id);
      }
    } else {
      next.ids = next.ids.filter((id) => id !== i.id);
      next.done = next.done.filter((id) => id !== i.id);
      if (!next.ids.length) next.sentAt = null;
    }
    await setRaw(ctx.db, CIRCLE_KEY, { ...saved, next }, ctx.session.profile.id);
    return { next };
  }),

  /** Sends the picked products to Espace créateur: from then on its page shows them as videos to make. */
  'strat.circleSend': proc(['vendeur', 'marketer'], z.object({}), async (ctx) => {
    const saved = await circleSaved(ctx);
    const next = circleNext(saved);
    if (!next.ids.length) throw bad('Choisissez au moins un produit');
    next.sentAt = new Date(ctx.now()).toISOString();
    await setRaw(ctx.db, CIRCLE_KEY, { ...saved, next }, ctx.session.profile.id);
    return { next };
  }),

  /** Ticks a picked product when its videos are done (or unticks it). */
  'strat.circleDone': proc(['vendeur', 'marketer'], z.object({ id: z.number().int().positive(), on: z.boolean() }), async (ctx, i) => {
    const saved = await circleSaved(ctx);
    const next = circleNext(saved);
    if (!next.ids.includes(i.id)) throw bad('Ce produit n’est pas dans le prochain test');
    next.done = i.on ? [...new Set([...next.done, i.id])] : next.done.filter((id) => id !== i.id);
    await setRaw(ctx.db, CIRCLE_KEY, { ...saved, next }, ctx.session.profile.id);
    return { next };
  }),

  /** The test has started: the list is emptied for the week after. */
  'strat.circleClear': proc(['vendeur', 'marketer'], z.object({}), async (ctx) => {
    const saved = await circleSaved(ctx);
    const next: CircleNext = { ids: [], sentAt: null, done: [] };
    await setRaw(ctx.db, CIRCLE_KEY, { ...saved, next }, ctx.session.profile.id);
    return { next };
  }),

  /** Changes one setting of the circle. An empty value is kept only where the setting may stay « not chosen ». */
  'strat.circleSet': proc(
    ['vendeur', 'marketer'],
    z.object({ key: z.string().max(40), value: z.union([z.number(), z.boolean(), z.null()]) }),
    async (ctx, i) => {
      const f = circleField(i.key);
      if (!f) throw bad('Réglage inconnu');
      const why = circleBad(f, i.value);
      if (why === 'empty') throw bad('Ce réglage ne peut pas rester vide');
      if (why === 'range') throw bad(f.kind === 'day' ? 'Jour inconnu' : `Valeur entre ${f.min} et ${f.max}`);
      if (why) throw bad('Valeur incorrecte');
      const next = { ...(await circleSaved(ctx)), [f.key]: i.value };
      await setRaw(ctx.db, CIRCLE_KEY, next, ctx.session.profile.id);
      return { values: circleValues(next) };
    },
  ),
};
