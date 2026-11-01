// Product knowledge follows work assignments. An empty scope never means the entire catalog.
import { num } from '../db';
import { Ctx, forbidden, hasRole } from '../rpc';
import { getSetting } from '../settings';
import { agencyOf } from './agencyscope';

export const seesPurchaseCosts = (ctx: Ctx) => agencyOf(ctx) === null && hasRole(ctx.session, 'vendeur', 'depot');

/** null: store owner/depot; []: no assigned work. Agency contracts and person scopes intersect. */
export async function assignedProductIds(ctx: Ctx): Promise<number[] | null> {
  if (seesPurchaseCosts(ctx)) return null;
  const agency = agencyOf(ctx);
  if (agency !== null) {
    const rows = await ctx.db.query(
      `SELECT p.id FROM products p WHERE p.archived_at IS NULL
       AND EXISTS (SELECT 1 FROM agency_routes r WHERE r.agency_id = $1 AND r.task = ANY($2)
         AND (r.product_id IS NULL OR r.product_id = p.id))
       AND ($3::bigint[] IS NULL OR p.id = ANY($3))`,
      [agency, ctx.session.roles, ctx.session.profile.agencyProducts ?? null],
    );
    return rows.map((r) => num(r.id));
  }
  if (!hasRole(ctx.session, 'confirmation', 'suivi')) return [];
  const config = (await getSetting(ctx.db, 'autoAssign')).agents?.[String(ctx.session.profile.id)];
  const explicit = config?.products;
  if (explicit?.length) return [...new Set(explicit)].filter((p) => Number.isSafeInteger(p) && p > 0);
  // Without a product assignment, only products in orders actually given to this person are known.
  return (await ctx.db.query(
    `SELECT DISTINCT i.product_id AS id FROM order_items i JOIN orders o ON o.id = i.order_id
     WHERE ($2 AND o.agent_id = $1 AND o.conf_agency_id IS NULL)
        OR ($3 AND o.follow_agent_id = $1 AND o.follow_agency_id IS NULL)`,
    [ctx.session.profile.id, ctx.session.roles.includes('confirmation'), ctx.session.roles.includes('suivi')],
  )).map((r) => num(r.id)).filter((p) => p > 0);
}

export async function requireAssignedProducts(ctx: Ctx, ids: number[]) {
  const allowed = await assignedProductIds(ctx);
  if (allowed && ids.some((p) => !allowed.includes(p))) throw forbidden('Ce produit ne vous est pas confié');
}

/** Last boundary for every RPC response, including nested order lines, variants and service add-ons. */
export function withoutPurchaseCosts(value: unknown): any {
  if (Array.isArray(value)) return value.map(withoutPurchaseCosts);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !['cost', 'purchasePrice', 'purchase_price', 'unitCost', 'unit_cost'].includes(k)).map(([k, v]) => [k, withoutPurchaseCosts(v)]));
}
