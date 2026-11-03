// The lists every filter bar picks from (Commandes, Suivi, SAV, Dépôt, Caisse): the people with their roles, the teams,
// the products with their variants, the delivery companies, the livreurs, and the reasons given when orders were
// cancelled at the confirmation or came back. One call, kept a few minutes by the app.
import { CONF_DONE_BAD } from '@pilotix/shared';
import { z } from 'zod';
import { num } from '../db';
import { Ctx, hasRole, proc } from '../rpc';
import { getSetting } from '../settings';
import { agencyOf } from './agencyscope';
import { assignedProductIds } from './productscope';

export interface FilterOptions {
  /** the people who work on orders (confirmation, suivi, depot, managers, owner, admins), the active ones first */
  agents: { id: number; name: string; roles: string[]; active: boolean }[];
  teams: { id: string; name: string }[];
  /** variants only when the product has colours or sizes */
  products: { id: number; name: string; active: boolean; variants: { id: number; title: string }[] }[];
  companies: { id: number; name: string; kind: string; active: boolean }[];
  livreurs: { id: number; name: string; active: boolean }[];
  /** the reasons people gave (the most used first): cancelled at the confirmation (conf), parcel sent back (back) */
  reasons: { conf: { text: string; n: number }[]; back: { text: string; n: number }[] };
}

const EMPTY: FilterOptions = { agents: [], teams: [], products: [], companies: [], livreurs: [], reasons: { conf: [], back: [] } };

/** The most used reasons of the last year (the first words of the status change's note, as the lists match them). */
async function reasonsOf(ctx: Ctx, kind: 'conf_status' | 'follow_status', to: string[]): Promise<{ text: string; n: number }[]> {
  const rows = await ctx.db.query(
    `SELECT split_part(e.note, ' — ', 1) AS text, count(DISTINCT e.order_id)::int AS n
       FROM order_events e
      WHERE e.kind = $1 AND e.to_value = ANY($2) AND e.at > now() - interval '365 days' AND coalesce(e.note, '') <> ''
      GROUP BY 1 HAVING split_part(e.note, ' — ', 1) <> '' ORDER BY n DESC, text LIMIT 40`,
    [kind, to],
  );
  return rows.map((r: any) => ({ text: String(r.text), n: num(r.n) }));
}

export async function filterOptions(ctx: Ctx): Promise<FilterOptions> {
  // a livreur or a marketer alone works on no list with these filters
  if (!hasRole(ctx.session, 'confirmation', 'suivi', 'depot', 'agent_manager', 'vendeur')) return EMPTY;
  const agency = agencyOf(ctx);
  const allowed = await assignedProductIds(ctx);
  const [people, teams, prods, companies, livreurs] = await Promise.all([
    // an agency's people see their own agency's team only
    ctx.db.query(
      `SELECT id, name, roles, active FROM profiles
        WHERE roles && '{admin,vendeur,agent_manager,confirmation,suivi,depot}'::text[]${agency !== null ? ' AND agency_id = $1' : ''}
        ORDER BY active DESC, name`,
      agency !== null ? [agency] : [],
    ),
    agency !== null ? Promise.resolve([]) : getSetting(ctx.db, 'teams'),
    ctx.db.query(
      `SELECT id, name, active FROM products WHERE ($1::bigint[] IS NULL OR id = ANY($1))
        ORDER BY archived_at IS NOT NULL, active DESC, name LIMIT 3000`,
      [allowed],
    ),
    ctx.db.query('SELECT id, name, kind, active FROM delivery_companies ORDER BY active DESC, name'),
    agency !== null ? Promise.resolve([]) : ctx.db.query(`SELECT id, name, active FROM profiles WHERE 'livreur' = ANY(roles) ORDER BY active DESC, name`),
  ]);
  const pids = prods.map((p: any) => num(p.id));
  const vars = pids.length ? await ctx.db.query('SELECT id, product_id, title, sku FROM product_variants WHERE product_id = ANY($1) ORDER BY id', [pids]) : [];
  const byProduct = new Map<number, { id: number; title: string }[]>();
  for (const v of vars as any[]) {
    const pid = num(v.product_id);
    byProduct.set(pid, [...(byProduct.get(pid) ?? []), { id: num(v.id), title: String(v.title || v.sku || '').trim() }]);
  }
  return {
    agents: people.map((p: any) => ({ id: num(p.id), name: String(p.name), roles: (p.roles ?? []) as string[], active: !!p.active })),
    teams: (teams as { id: string; name: string }[]).map((t) => ({ id: t.id, name: t.name })),
    products: prods.map((p: any) => {
      const vs = byProduct.get(num(p.id)) ?? [];
      // a product without colours or sizes has one plain variant: nothing to choose
      return { id: num(p.id), name: String(p.name), active: !!p.active, variants: vs.length > 1 || vs.some((v) => v.title) ? vs.filter((v) => v.title) : [] };
    }),
    companies: companies.map((c: any) => ({ id: num(c.id), name: String(c.name), kind: String(c.kind), active: !!c.active })),
    livreurs: (livreurs as any[]).map((l) => ({ id: num(l.id), name: String(l.name), active: !!l.active })),
    reasons:
      agency !== null
        ? { conf: [], back: [] }
        : { conf: await reasonsOf(ctx, 'conf_status', CONF_DONE_BAD), back: await reasonsOf(ctx, 'follow_status', ['returning']) },
  };
}

export const filterProcs = {
  /** The lists of the filter bars. */
  'filters.options': proc(null, z.object({}), (ctx) => filterOptions(ctx)),
};
