// Marketing › Stratégies: each product gets its type for the ads (1 the shop's own, 2 like a competitor's, 3 exactly a
// competitor's), and Pilotix recommends the video formats that fit it best, from the control room's strategies library
// (platform/credits.ts: each format says the types it fits). Espace créateur then makes the videos.
import { z } from 'zod';
import { num, numOrNull } from '../db';
import { bad, Ctx, proc } from '../rpc';
import { CreditStrategy, creditsConfig, DEFAULT_CREDITS, PRODUCT_TYPES, ProductType } from '../platform/credits';

export interface StratFormat {
  key: string;
  name: string;
  desc: string;
  kind: CreditStrategy['kind'];
  style: CreditStrategy['style'];
  credits: number;
  trend: boolean;
  types: ProductType[];
}

/**
 * The formats for a product type, best first: the recipes made for this type (a format made for this type only is the
 * most precise), then « tendance », then the library's order. The editing styles (Ugly ads, Propre) are not formats:
 * they draw any of them, so they are left out.
 */
export function recommend(list: StratFormat[], type: ProductType): StratFormat[] {
  return list
    .map((x, i) => ({ x, i }))
    .filter(({ x }) => x.kind === 'recipe' && x.types.includes(type))
    .sort((a, b) => a.x.types.length - b.x.types.length || Number(b.x.trend) - Number(a.x.trend) || a.i - b.i)
    .map(({ x }) => x);
}

async function formats(ctx: Ctx): Promise<StratFormat[]> {
  const cfg = ctx.t && ctx.shop ? await creditsConfig(ctx.t) : DEFAULT_CREDITS;
  return cfg.strategies
    .filter((x) => x.on)
    .map((x) => ({ key: x.key, name: x.name, desc: x.desc, kind: x.kind, style: x.style, credits: cfg.on ? x.credits : 0, trend: x.trend, types: x.types }));
}

const Type = z.union([z.literal(1), z.literal(2), z.literal(3)]);

export const strategiesProcs = {
  /** The shop's products with their type, the formats library, and the recommended formats for each type. */
  'strat.state': proc(['vendeur', 'marketer'], z.object({}), async (ctx) => {
    const rows = await ctx.db.query(
      `SELECT id, name, price, photo, product_type FROM products WHERE active AND NOT is_service AND archived_at IS NULL ORDER BY lower(name) LIMIT 500`,
    );
    const list = await formats(ctx);
    const byType = Object.fromEntries(PRODUCT_TYPES.map((t) => [t, recommend(list, t).map((x) => x.key)])) as Record<ProductType, string[]>;
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
    };
  }),

  /** Sets (or clears) a product's type. */
  'strat.setType': proc(['vendeur', 'marketer'], z.object({ id: z.number().int().positive(), type: Type.nullable() }), async (ctx, i) => {
    const r = await ctx.db.query('UPDATE products SET product_type = $2 WHERE id = $1 AND archived_at IS NULL RETURNING id', [i.id, i.type]);
    if (!r[0]) throw bad('Produit introuvable');
    return { ok: true };
  }),
};
