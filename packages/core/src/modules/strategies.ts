// Marketing › Stratégies: each product gets its type for the ads (1 the shop's own, 2 like a competitor's, 3 exactly a
// competitor's), and Pilotix recommends the video formats that fit it best, from the control room's strategies library
// (platform/credits.ts: each format says the types and the funnel stages it fits). « Envoyer à l'Espace créateur »
// opens Espace créateur with the product, the stage and the formats chosen (in the browser: nothing is kept here).
import { CIRCLE_FROM_SETTINGS, CIRCLE_SETTING, CIRCLE_STEPS, CircleChecks, CircleFromSetting, circleBad, circleField, circleTestAdsBad, circleValues } from '@pilotix/shared';
import { z } from 'zod';
import { Db, num, numOrNull } from '../db';
import { bad, Ctx, proc } from '../rpc';
import { getRaw, setRaw } from './admin';
import { checkRules, checkSettings } from './pilotchecks';
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
const CIRCLE_KEY = CIRCLE_SETTING;
async function circleSaved(ctx: Ctx): Promise<Record<string, unknown>> {
  const v = await getRaw<unknown>(ctx.db, CIRCLE_KEY, null);
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * The numbers the circle's rules take from Pilot Checks, as the shop has them now. They are set there only (by the
 * admins); the circle shows them to everyone who plans the ads, so the two pages always say the same.
 */
export async function circleChecks(db: Db): Promise<CircleChecks> {
  const settings = new Map((await checkSettings(db)).map((x) => [x.key, x.v]));
  const kpi = new Map((await checkRules(db)).map((r) => [r.id, r]));
  const set = Object.fromEntries(CIRCLE_FROM_SETTINGS.map((k) => [k, settings.get(k) ?? null])) as Record<CircleFromSetting, number | null>;
  const cost = kpi.get('D1');
  return {
    set,
    good: cost?.g ?? null,
    bad: cost?.v ?? null,
    stop: cost?.s ?? null,
    brakeAt: kpi.get('D7')?.v ?? null,
    stockStop: kpi.get('O20')?.s ?? null,
    freezeEdits: kpi.get('M5')?.v ?? null,
    ideasMin: kpi.get('M3')?.v ?? null,
    budgetWait: cost?.wait ?? null,
  };
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
   * « Life ad circle »: the five steps, the shop's value for every setting of the circle (its own, else the default),
   * and the numbers its rules take from Pilot Checks.
   */
  'strat.circle': proc(['vendeur', 'marketer'], z.object({}), async (ctx) => {
    return { steps: [...CIRCLE_STEPS], values: circleValues(await circleSaved(ctx)), checks: await circleChecks(ctx.db) };
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
      const saved = await circleSaved(ctx);
      const next = { ...saved, [f.key]: i.value };
      // a test holds one ad at least, and never more than Pilot Checks allows in a test ad set (videos + images)
      if (f.key === 'testVideos' || f.key === 'testImages') {
        const cap = (await circleChecks(ctx.db)).set.testAds;
        const ads = circleTestAdsBad(circleValues(next), cap, circleValues(saved));
        if (ads === 'none') throw bad('Un test a au moins une pub : une vidéo ou une image');
        if (ads === 'over') throw bad(`Un test a ${cap} pubs au plus (vidéos + images) : ce chiffre se règle dans Pilot Checks`);
      }
      await setRaw(ctx.db, CIRCLE_KEY, next, ctx.session.profile.id);
      return { values: circleValues(next) };
    },
  ),
};
