// Produits › « Prêt » / « À faire » (16 Nov 2026): Pilotix decides by itself whether a product may be sold. A product is
// Ready when it has all five: an HD main photo, its prices, a description, a live landing page and a sales guide. Until
// then it is in « À faire » and NOT sold: it is switched off (active = false), marked as switched off by Pilotix
// (ready_off), so nothing sells it (order form, landing pages, Dellal). The moment it has all five, it goes back on sale
// by itself. A product the seller switched off himself stays off (« Masqués »). Services are never checked.
// Every shop, every product: checked after each change that can make a product ready or not, when the Products page
// opens, and by the server every 10 minutes. Only what the shop can give is asked: no landing page when its plan has no
// landing pages, no HD photo on a server with nowhere to keep them (else nothing of it could ever sell).
import { featureOn } from '@pilotix/shared';
import { z } from 'zod';
import type { Db } from '../db';
import { num } from '../db';
import { bad, type Ctx, proc } from '../rpc';
import { HAS_GUIDE } from './guide';
import { photoStore } from './hdphotos';

/** The five things a product needs, in the order the screens show them. */
export const READY_CHECKS = ['photo', 'prices', 'description', 'landing', 'guide'] as const;
export type ReadyCheck = (typeof READY_CHECKS)[number];
/** An HD main photo: at least this wide (a 4:5 product photo is 1080 × 1350). */
export const HD_MIN_WIDTH = 1080;

/**
 * SQL: a product the shop works on: on sale, or kept off by Pilotix until it is Ready (« À faire »). The tools that make
 * a product ready list both (the landing page editor, the products without a page, the Studio); what sells (the order
 * form, the landing pages, Dellal, the catalogues) keeps to `active`.
 */
export const WORKED_ON = (alias: string) => `(${alias}.active OR ${alias}.ready_off)`;

/** What Pilotix asks of this shop's products: the checks the shop can meet (all five for most shops). */
export async function requiredChecks(ctx: Ctx): Promise<ReadyCheck[]> {
  const features = ctx.shop?.features;
  // no Produits & stock in its plan: nobody there could add what a product misses
  if (!featureOn(features, 'produits')) return [];
  const photos = (await photoStore(ctx)).kind !== 'off';
  return READY_CHECKS.filter((c) => (c === 'photo' ? photos : c === 'landing' ? featureOn(features, 'landing') : true));
}

/** What each product (not a service, not archived) still misses among these checks; missing nothing is Ready. */
export async function readinessOf(db: Db, ids?: number[], checks: readonly ReadyCheck[] = READY_CHECKS): Promise<Map<number, ReadyCheck[]>> {
  const rows = await db.query(
    `SELECT p.id,
       COALESCE((SELECT ph.w FROM product_photos ph WHERE ph.product_id = p.id AND ph.kind = 'photo' ORDER BY ph.position, ph.id LIMIT 1), 0) AS main_w,
       (p.price > 0 AND (COALESCE(p.cost, 0) > 0
          OR EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.active AND COALESCE(v.cost, 0) > 0))) AS priced,
       (length(btrim(COALESCE(p.description, ''))) > 0) AS described,
       EXISTS (SELECT 1 FROM landing_pages l WHERE l.product_id = p.id AND l.active) AS paged,
       ${HAS_GUIDE('p')} AS guided
     FROM products p
     WHERE p.archived_at IS NULL AND NOT p.is_service${ids ? ' AND p.id = ANY($1::bigint[])' : ''}`,
    ids ? [ids] : [],
  );
  const out = new Map<number, ReadyCheck[]>();
  for (const r of rows as any[]) {
    const has: Record<ReadyCheck, boolean> = { photo: num(r.main_w) >= HD_MIN_WIDTH, prices: !!r.priced, description: !!r.described, landing: !!r.paged, guide: !!r.guided };
    out.set(num(r.id), checks.filter((c) => !has[c]));
  }
  return out;
}

/**
 * Puts every product where its readiness says: not Ready and on sale → off (by Pilotix); Ready and off by Pilotix → on
 * sale again. Returns how many changed (the screens are told).
 */
export async function syncReadiness(ctx: Ctx): Promise<number> {
  const all = await readinessOf(ctx.db, undefined, await requiredChecks(ctx));
  const notReady: number[] = [];
  const ready: number[] = [];
  for (const [id, missing] of all) (missing.length ? notReady : ready).push(id);
  let changed = 0;
  if (notReady.length)
    changed += (await ctx.db.query(`UPDATE products SET active = false, ready_off = true WHERE id = ANY($1::bigint[]) AND active RETURNING id`, [notReady])).length;
  if (ready.length)
    changed += (await ctx.db.query(`UPDATE products SET active = true, ready_off = false WHERE id = ANY($1::bigint[]) AND ready_off RETURNING id`, [ready])).length;
  if (changed) ctx.emit({ type: 'stock' });
  return changed;
}

/** The changes after which a product can become Ready or stop being Ready (index.ts checks again after each). */
export const READY_TOUCH = new Set([
  'catalog.saveProduct',
  'catalog.setPrices',
  'catalog.importProducts',
  'catalog.saveGuide',
  'catalog.translateGuide',
  'photos.add',
  'photos.update',
  'photos.remove',
  'landing.save',
  'landing.remove',
  'landing.duplicate',
  'landing.quickCreate',
  'landing.restore',
  'archive.set',
  'archive.delete',
]);

/** The words of what is missing, as the seller reads them (French: the app translates the screens). */
const LABEL: Record<ReadyCheck, string> = {
  photo: `photo HD (${HD_MIN_WIDTH} px de large au moins)`,
  prices: 'prix de vente et d’achat',
  description: 'description',
  landing: 'landing page en ligne',
  guide: 'guide de vente',
};

/** Switching a product on by hand: refused while it is not Ready (it goes on sale by itself once it is). */
export async function assertReady(ctx: Ctx, productId: number) {
  const missing = (await readinessOf(ctx.db, [productId], await requiredChecks(ctx))).get(productId);
  if (missing?.length) throw bad(`Ce produit n’est pas prêt : il manque ${missing.map((m) => LABEL[m]).join(', ')}. Il se met en vente tout seul dès qu’il a tout.`);
}

export const readinessProcs = {
  /** Produits: what each product misses (the « À faire » tab), checked again first. */
  'catalog.readiness': proc(['depot'], z.object({}), async (ctx) => {
    await syncReadiness(ctx);
    const checks = await requiredChecks(ctx);
    const all = await readinessOf(ctx.db, undefined, checks);
    // waiting: off only until it is Ready (« À faire »); not waiting and off: the seller's choice (« Masqués »)
    const waiting = new Set((await ctx.db.query(`SELECT id FROM products WHERE ready_off`)).map((r: any) => num(r.id)));
    return { hdMinWidth: HD_MIN_WIDTH, checks, products: [...all].map(([id, missing]) => ({ id, missing, waiting: waiting.has(id) })) };
  }),
};
