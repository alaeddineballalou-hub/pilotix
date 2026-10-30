// Who works on which orders, once a store works with confirmation agencies (and marketers).
// - An agency's agent works inside the store only on the orders the store gives the agency (its products, for its
//   tasks: confirmation, suivi), with the confirmation and suivi screens — nothing else of the store.
// - A marketer partner's person works inside the store only on the ads: the ad sets the store gave them, the products
//   the store gave the marketer — never an order, a customer, the team or the money of the store.
// - The store's own team works on the orders no agency handles; its managers and administrators see every order.
// - A partner's own space (its team, prices, sellers, payments) answers only the partner's own actions.
import { AgencySellerWork, normalizePhone } from '@pilotix/shared';
import { num } from '../db';
import { bad, Ctx, forbidden, hasRole } from '../rpc';

/** A list of ids from the database (bigint[]: numbers or strings), null kept. */
export function idsOrNull(v: unknown): number[] | null {
  if (v === null || v === undefined) return null;
  const a = Array.isArray(v) ? v : String(v).replace(/[{}]/g, '').split(',').filter(Boolean);
  return a.map(Number).filter((x) => Number.isSafeInteger(x) && x > 0);
}
/** An agency person's sellers (jsonb), null kept: every seller. */
export function sellersOrNull(v: unknown): AgencySellerWork[] | null {
  if (v === null || v === undefined) return null;
  const a = typeof v === 'string' ? JSON.parse(v) : v;
  if (!Array.isArray(a)) return null;
  return a
    .map((x: any) => ({ store: Number(x?.store), products: Array.isArray(x?.products) ? x.products.map(Number).filter((n: number) => Number.isSafeInteger(n) && n > 0) : null }))
    .filter((x) => Number.isSafeInteger(x.store) && x.store > 0);
}

/** The agency of this person in this store (null: the store's own team). */
export function agencyOf(ctx: Ctx): number | null {
  const a = ctx.session.profile.agencyId;
  if (a === null || a === undefined) return null;
  const n = Number(a);
  // built into SQL below: only a whole positive number ever goes there
  if (!Number.isSafeInteger(n) || n <= 0) throw forbidden();
  return n;
}

const COL = { conf: 'conf_agency_id', follow: 'follow_agency_id' } as const;
const ROLE = { conf: 'confirmation', follow: 'suivi' } as const;

/**
 * SQL on an orders row (alias `o`) of the orders an agency's agent may open: its confirmation agents the orders the
 * agency confirms, its suivi agents the ones it follows. '' for everyone else (no limit from agencies).
 */
export function agencyRowSql(ctx: Ctx, alias = 'o'): string {
  const a = agencyOf(ctx);
  if (a === null) return '';
  const parts = (['conf', 'follow'] as const).filter((k) => ctx.session.roles.includes(ROLE[k])).map((k) => `${alias}.${COL[k]} = ${a}`);
  return parts.length ? `(${parts.join(' OR ')})${productSql(ctx, alias)}` : 'false';
}

/** An agency's agent given some products only (Utilisateurs, in the agency): the orders that came for them. */
function productSql(ctx: Ctx, alias: string): string {
  const p = ctx.session.profile.agencyProducts;
  if (!p) return '';
  // built into SQL: only whole positive numbers go there
  const ids = p.filter((x) => Number.isSafeInteger(x) && x > 0);
  return ids.length ? ` AND ${alias}.route_product_id IN (${ids.join(',')})` : ' AND false';
}

/**
 * SQL of one work queue (confirmation or suivi): an agency's agent gets its agency's orders, the store's own agents
 * the orders no agency handles, managers and administrators every order ('').
 */
export function queueSql(ctx: Ctx, task: 'conf' | 'follow', alias = 'o', opts: { free?: boolean } = {}): string {
  const a = agencyOf(ctx);
  // an agency's people: the agency shares its orders out itself (step « Agences »)
  if (a !== null) return ctx.session.roles.includes(ROLE[task]) ? `${alias}.${COL[task]} = ${a}${productSql(ctx, alias)}` : 'false';
  const who = task === 'conf' ? confSeeSql(ctx, alias, !!opts.free) : '';
  const join = (x: string) => [x, who].filter(Boolean).join(' AND ');
  if (ctx.session.isAdmin || hasRole(ctx.session, 'agent_manager', 'vendeur')) return who;
  return join(`${alias}.${COL[task]} IS NULL`);
}

/**
 * Who sees which orders in Confirmation:
 * - the owner (Vendeur) and the administrators: every order of the shop ('');
 * - an agent manager: the orders of his team's agents and his own, and the orders no agent has yet (to give them out),
 *   never another agent manager's team;
 * - an agent: only the orders given to him. `free`: also the orders nobody has yet (« Commande suivante » gives the
 *   most urgent one, and it becomes his).
 */
export function confSeeSql(ctx: Ctx, alias = 'o', free = false): string {
  if (ctx.session.isAdmin || ctx.session.roles.includes('vendeur')) return '';
  const me = Number(ctx.session.profile.id);
  // built into SQL: only a whole positive number goes there
  if (!Number.isSafeInteger(me) || me <= 0) throw forbidden();
  if (ctx.session.roles.includes('agent_manager'))
    return `(${alias}.agent_id IS NULL OR ${alias}.agent_id = ${me} OR ${alias}.agent_id IN (SELECT a.v::bigint FROM settings s, jsonb_array_elements(CASE WHEN jsonb_typeof(s.value) = 'array' THEN s.value ELSE '[]'::jsonb END) t, jsonb_array_elements_text(COALESCE(t->'agentIds', '[]'::jsonb)) a(v) WHERE s.key = 'teams' AND (t->>'managerId') = '${me}'))`;
  return free ? `(${alias}.agent_id IS NULL OR ${alias}.agent_id = ${me})` : `${alias}.agent_id = ${me}`;
}

/** `sql` with one more condition (WHERE … AND cond), for queries written with a WHERE already or none. */
export const andSql = (cond: string) => (cond ? ` AND ${cond}` : '');
export const whereSql = (cond: string) => (cond ? ` WHERE ${cond}` : '');

// ---------------------------------------------------------------- what an agency's agent may call inside a store
type Gate = (ctx: Ctx, input: any) => Promise<void> | void;

const nums = (v: unknown): number[] => (Array.isArray(v) ? v : [v]).filter((x): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x > 0);

/** These orders must all be the agency's (an unknown id counts as not theirs). */
async function ownOrders(ctx: Ctx, ids: number[]) {
  const want = [...new Set(ids)];
  if (!want.length) return;
  const n = num((await ctx.db.query(`SELECT count(*)::int AS n FROM orders o WHERE o.id = ANY($1) AND ${agencyRowSql(ctx)}`, [want]))[0]?.n);
  if (n !== want.length) throw forbidden('Cette commande n’est pas confiée à votre agence');
}

const free: Gate = () => {};
const order =
  (key: string): Gate =>
  (ctx, i) =>
    ownOrders(ctx, nums(i?.[key]));

/** A customer the agency calls (one of its orders): by id or phone. */
const customer: Gate = async (ctx, i) => {
  const phone = typeof i?.phone === 'string' ? normalizePhone(i.phone) : null;
  const id = nums(i?.id)[0] ?? null;
  if (!id && !phone) return;
  const ok = await ctx.db.query(`SELECT 1 FROM sales o WHERE (o.customer_id = $1 OR o.phone = $2) AND ${agencyRowSql(ctx)} LIMIT 1`, [id, phone]);
  if (!ok.length) throw forbidden('Ce client n’est pas un client de votre agence');
};

/** The confirmation and suivi work, and the agent's own account. */
export const AGENCY_AGENT_PROCS: Record<string, Gate> = {
  'me.get': free,
  'me.language': free,
  'me.password': free,
  'me.ui': free,
  'me.setUi': free,
  'me.update': free,
  'me.seen': free,
  'users.list': free,
  'orders.uiMeta': free,
  'orders.lookups': free,
  'orders.formData': free,
  'orders.quote': free,
  'orders.list': free,
  'orders.counts': free,
  'orders.next': free,
  'orders.get': order('id'),
  'orders.events': order('id'),
  'orders.update': order('id'),
  'orders.note': order('id'),
  'orders.logCall': order('id'),
  'orders.setSub': order('id'),
  'orders.setConf': order('ids'),
  'orders.setFollow': order('ids'),
  'orders.reasons': order('ids'),
  'orders.companyFees': order('ids'),
  'orders.sync': (ctx, i) => ownOrders(ctx, nums(Array.isArray(i?.actions) ? i.actions.map((a: any) => a?.id) : [])),
  'confirmation.meta': free,
  'confirmation.colPresets': free,
  'confirmation.colActive': free,
  'confirmation.setColActive': free,
  'confirmation.counts': free,
  'confirmation.list': free,
  'confirmation.catalog': free,
  'confirmation.deskOptions': free,
  'confirmation.mine': free,
  'confirmation.banner': free,
  'confirmation.gridFee': order('id'),
  'confirmation.release': order('id'),
  'confirmation.setTry': order('ids'),
  'confirmation.block': order('ids'),
  'customers.history': customer,
  'customers.setBlacklist': customer,
  'delivery.stopdesks': free,
  'suivi.counts': free,
  'suivi.list': free,
  'suivi.treat': order('id'),
  'suivi.unassign': order('id'),
  'suivi.act': order('id'),
  'suivi.resolve': order('id'),
  'suivi.stuckDone': order('id'),
  'suivi.motifs': free,
  'suivi.motifStats': free,
  'suivi.claimsLate': free,
  'suivi.next': free,
  'suivi.release': order('id'),
};

/**
 * The work on a seller's orders, asked from the agency's own space (with the seller chosen at the top of the page):
 * it runs inside that store (agencywork.ts). The person's own account stays in the agency.
 */
export const SELLER_PROCS = new Set(Object.keys(AGENCY_AGENT_PROCS).filter((n) => !n.startsWith('me.')));

/**
 * A marketer partner's person inside a store: the ads of the ad sets the store gave them (Publicité, Marketer), the
 * products the store gave the marketer (ads.ts checks them), and their own account.
 */
export const MARKETER_AGENT_PROCS: Record<string, Gate> = {
  'me.get': free,
  'me.language': free,
  'me.password': free,
  'me.ui': free,
  'me.setUi': free,
  'me.update': free,
  'me.seen': free,
  'ads.overview': free,
  'ads.months': free,
  'ads.closeMonth': free,
  'ads.adset': free,
  'ads.link': free,
  'ads.sync': free,
  'mk.overview': free,
  'mk.adset': free,
};
/** The work on a seller's ads, asked from the marketer's own space: it runs inside that store (agencywork.ts). */
export const MARKETER_SELLER_PROCS = new Set(Object.keys(MARKETER_AGENT_PROCS).filter((n) => !n.startsWith('me.')));
/** The actions a partner's space runs inside its sellers' stores. */
export const sellerProcsOf = (kind: 'agency' | 'marketer') => (kind === 'marketer' ? MARKETER_SELLER_PROCS : SELLER_PROCS);

/** What a partner's own space answers (its own team and account; the rest are the agency.* actions). */
const AGENCY_SPACE = new Set(['me.get', 'me.language', 'me.password', 'me.ui', 'me.setUi', 'me.update', 'me.seen', 'me.delete', 'users.list', 'users.create', 'users.update', 'users.phoneCheck', 'admin.users.resetPassword']);

/**
 * Checked before every action: a partner's space (agency, marketer) runs only its own actions; an agency's agent inside
 * a store only the confirmation and suivi work on the agency's orders, a marketer's person only the ads of their ad
 * sets; agency.* never runs in a store, partners.* never in a partner's space.
 */
export async function agencyGate(name: string, ctx: Ctx, input: unknown): Promise<void> {
  const kind = ctx.shop?.kind;
  if (kind === 'agency' || kind === 'marketer') {
    if (name.startsWith('agency.') || AGENCY_SPACE.has(name)) return;
    if (sellerProcsOf(kind).has(name)) throw bad('Choisissez un vendeur en haut de la page');
    throw forbidden(kind === 'agency' ? 'Pas dans l’espace d’une agence' : 'Pas dans l’espace d’un marketer');
  }
  if (name.startsWith('agency.')) throw forbidden('Réservé aux agences de confirmation et aux marketers');
  if (agencyOf(ctx) === null) return;
  // a marketer partner's person has the marketer role only (an agency's agents never have it)
  const g = (ctx.session.roles.includes('marketer') ? MARKETER_AGENT_PROCS : AGENCY_AGENT_PROCS)[name];
  if (!g) throw forbidden('Réservé à l’équipe de la boutique');
  await g(ctx, input);
}
