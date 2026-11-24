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
 * The chief of a confirmation agency (its administrator) or one of its chefs d'équipe, working in a store: for the
 * agency's orders there, like a store's agent manager — sees every one (the free ones too) and gives them to the
 * agency's agents (« Attribuer »). Who leads comes from the person's roles in the agency (agencywork.ts: storeCtx).
 */
export function agencyLead(ctx: Ctx): boolean {
  return agencyOf(ctx) !== null && !!ctx.session.profile.agencyLead && !ctx.session.roles.includes('marketer');
}

/**
 * A plain agent of an agency (not its chief, not a chef d'équipe), in Confirmation: only the orders given to him — by
 * a chief of the agency or the agency's Répartition. Like a store's own agent, he never takes a free one.
 */
function agencyMineSql(ctx: Ctx, alias: string, task: 'conf' | 'follow', free = false): string {
  if (agencyLead(ctx)) return '';
  const me = Number(ctx.session.profile.id);
  if (!Number.isSafeInteger(me) || me <= 0) throw forbidden();
  return ` AND ${task === 'conf' ? `${alias}.agent_id = ${me}` : followMineSql(ctx, alias, free)}`;
}

/**
 * SQL on an orders row (alias `o`) of the orders an agency's agent may open: its confirmation agents the orders the
 * agency confirms (a plain agent: those given to him), its suivi agents the ones it follows. '' for everyone else
 * (no limit from agencies).
 */
export function agencyRowSql(ctx: Ctx, alias = 'o'): string {
  const a = agencyOf(ctx);
  if (a === null) return '';
  const parts = (['conf', 'follow'] as const)
    .filter((k) => ctx.session.roles.includes(ROLE[k]))
    .map((k) => `(${alias}.${COL[k]} = ${a}${agencyMineSql(ctx, alias, k)})`);
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
 * SQL of one work queue (confirmation or suivi): an agency's people get its agency's orders (in Confirmation, a plain
 * agent those given to him), the store's own agents the orders no agency handles, managers and administrators every
 * order ('').
 */
export function queueSql(ctx: Ctx, task: 'conf' | 'follow', alias = 'o', opts: { free?: boolean } = {}): string {
  const a = agencyOf(ctx);
  // an agency's people: the agency shares its orders out itself (its chiefs by hand, or its Répartition)
  if (a !== null) return ctx.session.roles.includes(ROLE[task]) ? `${alias}.${COL[task]} = ${a}${agencyMineSql(ctx, alias, task, !!opts.free)}${productSql(ctx, alias)}` : 'false';
  const who = task === 'conf' ? confSeeSql(ctx, alias, !!opts.free) : followMineSql(ctx, alias, !!opts.free);
  const join = (x: string) => [x, who].filter(Boolean).join(' AND ');
  if (ctx.session.isAdmin || hasRole(ctx.session, 'agent_manager', 'vendeur')) return who;
  return join(`${alias}.${COL[task]} IS NULL`);
}

/**
 * Who sees which orders in Confirmation:
 * - the owner (Vendeur) and the administrators: every order of the shop ('');
 * - an agent manager: the orders of his team's agents and his own, and the orders no agent has yet (to give them out),
 *   never another agent manager's team;
 * - an agent: only the orders given to him — by his manager or the automatic assignment. He never takes an order
 *   nobody has yet (`free` is for the managers: « Commande suivante » may give them one).
 */
export function confSeeSql(ctx: Ctx, alias = 'o', free = false): string {
  if (ctx.session.isAdmin || ctx.session.roles.includes('vendeur')) return '';
  const me = Number(ctx.session.profile.id);
  // built into SQL: only a whole positive number goes there
  if (!Number.isSafeInteger(me) || me <= 0) throw forbidden();
  if (ctx.session.roles.includes('agent_manager'))
    return `(${alias}.agent_id IS NULL OR ${alias}.agent_id = ${me} OR ${alias}.agent_id IN (SELECT a.v::bigint FROM settings s, jsonb_array_elements(CASE WHEN jsonb_typeof(s.value) = 'array' THEN s.value ELSE '[]'::jsonb END) t, jsonb_array_elements_text(COALESCE(t->'agentIds', '[]'::jsonb)) a(v) WHERE s.key = 'teams' AND (t->>'managerId') = '${me}'))`;
  return `${alias}.agent_id = ${me}`;
}

function followMineSql(ctx: Ctx, alias: string, free = false): string {
  if (ctx.session.isAdmin || ctx.session.roles.includes('vendeur')) return '';
  const me = Number(ctx.session.profile.id);
  if (!Number.isSafeInteger(me) || me <= 0) throw forbidden();
  const assigned = `${alias}.follow_agent_id`;
  if (ctx.session.roles.includes('agent_manager'))
    return `(${assigned} IS NULL OR ${assigned} = ${me} OR ${assigned} IN (SELECT a.v::bigint FROM settings s,
      jsonb_array_elements(CASE WHEN jsonb_typeof(s.value) = 'array' THEN s.value ELSE '[]'::jsonb END) t,
      jsonb_array_elements_text(COALESCE(t->'agentIds', '[]'::jsonb)) a(v) WHERE s.key = 'teams' AND (t->>'managerId') = '${me}'))`;
  return `(${assigned} = ${me}${free ? ` OR ${assigned} IS NULL` : ''} OR (${alias}.locked_by = ${me} AND ${alias}.locked_until > now()))`;
}

/** Roles that need to open orders across the store. */
const WIDE_WORK = ['depot', 'livreur', 'agent_manager', 'vendeur'];

function storeAgentOnly(ctx: Ctx): boolean {
  const s = ctx.session;
  return !s.isAdmin && agencyOf(ctx) === null && !s.roles.some((r) => WIDE_WORK.includes(r))
    && s.roles.some((r) => r === 'confirmation' || r === 'suivi' || r === 'sav');
}

/**
 * SQL on an orders row (alias `o`) of the orders such an agent may open: given to him or handled by him (agent_id),
 * typed by him (created_by), the one he holds now (« Commande suivante », nobody's yet), and the orders of the SAV
 * tickets given to him or made by him. '' for everyone else (no limit).
 */
export function ownRowSql(ctx: Ctx, alias = 'o'): string {
  const s = ctx.session;
  if (!storeAgentOnly(ctx)) return '';
  const me = Number(ctx.session.profile.id);
  // built into SQL: only a whole positive number goes there
  if (!Number.isSafeInteger(me) || me <= 0) throw forbidden();
  return `(${alias}.agent_id = ${me} OR ${alias}.follow_agent_id = ${me} OR ${alias}.created_by = ${me} OR ((${alias}.agent_id IS NULL OR ${s.roles.includes('suivi')}) AND ${alias}.locked_by = ${me} AND ${alias}.locked_until > now()) OR ${alias}.id IN (SELECT c.order_id FROM complaints c WHERE (c.assigned_to = ${me} OR c.created_by = ${me}) AND c.order_id IS NOT NULL))`;
}

/** The orders an agency's agent or a store's confirmation agent may open ('' for everyone else). */
export const rowScopeSql = (ctx: Ctx, alias = 'o') => agencyRowSql(ctx, alias) || ownRowSql(ctx, alias);

/** `sql` with one more condition (WHERE … AND cond), for queries written with a WHERE already or none. */
export const andSql = (cond: string) => (cond ? ` AND ${cond}` : '');
export const whereSql = (cond: string) => (cond ? ` WHERE ${cond}` : '');

// ---------------------------------------------------------------- what an agency's agent may call inside a store
type Gate = (ctx: Ctx, input: any) => Promise<void> | void;

const nums = (v: unknown): number[] => (Array.isArray(v) ? v : [v]).filter((x): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x > 0);

const NOT_AGENCY = 'Cette commande n’est pas confiée à votre agence';
const NOT_MINE = 'Cette commande est donnée à un autre agent';
/** a plain confirmation agent of an agency: the order is another agent's, nobody's yet, or not the agency's */
const NOT_GIVEN = 'Cette commande ne vous est pas donnée, ou elle n’est pas confiée à votre agence';
const notOursText = (ctx: Ctx) => (agencyOf(ctx) === null ? NOT_MINE : !agencyLead(ctx) && ctx.session.roles.includes('confirmation') ? NOT_GIVEN : NOT_AGENCY);

/** These orders must all be the agency's, or the store's confirmation agent's own (an unknown id counts as not theirs). */
async function ownOrders(ctx: Ctx, ids: number[]) {
  const want = [...new Set(ids)];
  const scope = rowScopeSql(ctx);
  if (!want.length || !scope) return;
  const n = num((await ctx.db.query(`SELECT count(*)::int AS n FROM orders o WHERE o.id = ANY($1) AND ${scope}`, [want]))[0]?.n);
  if (n !== want.length) throw forbidden(notOursText(ctx));
}

const free: Gate = () => {};
const order =
  (key: string): Gate =>
  (ctx, i) =>
    ownOrders(ctx, nums(i?.[key]));

/** A claim (Réclamations) on one of the agency's orders. */
const claim =
  (key: string): Gate =>
  async (ctx, i) => {
    const ids = nums(i?.[key]);
    if (!ids.length) return;
    if (!rowScopeSql(ctx)) return;
    const rows = await ctx.db.query('SELECT order_id FROM claims WHERE id = ANY($1)', [ids]);
    if (rows.length !== new Set(ids).size || rows.some((r: any) => !r.order_id)) throw forbidden(agencyOf(ctx) !== null ? 'Cette réclamation n’est pas sur une commande de votre agence' : 'Cette réclamation n’est pas sur une de vos commandes');
    await ownOrders(ctx, rows.map((r: any) => num(r.order_id)));
  };

/** The SAV tickets of a store's confirmation agent: on one of his orders, given to him, or made by him ('' for others). */
export function ownTicketSql(ctx: Ctx, alias = 'c'): string {
  const own = ownRowSql(ctx);
  if (!own) return '';
  const me = Number(ctx.session.profile.id);
  return `(${alias}.assigned_to = ${me} OR ${alias}.created_by = ${me} OR ${alias}.order_id IN (SELECT o.id FROM orders o WHERE ${own}))`;
}
const ticket =
  (key: string): Gate =>
  async (ctx, i) => {
    const scope = ownTicketSql(ctx);
    const ids = [...new Set(nums(i?.[key]))];
    if (!scope || !ids.length) return;
    const n = num((await ctx.db.query(`SELECT count(*)::int AS n FROM complaints c WHERE c.id = ANY($1) AND ${scope}`, [ids]))[0]?.n);
    if (n !== ids.length) throw forbidden('Ce ticket SAV est donné à un autre agent');
  };
/** A delivery message (Pilot Automations) about one of the store's confirmation agent's own orders. */
const message =
  (key: string): Gate =>
  async (ctx, i) => {
    const own = ownRowSql(ctx);
    const ids = [...new Set(nums(i?.[key]))];
    if (!own || !ids.length) return;
    const n = num((await ctx.db.query(`SELECT count(*)::int AS n FROM notifications n JOIN orders o ON o.id = n.order_id WHERE n.id = ANY($1) AND ${own}`, [ids]))[0]?.n);
    if (n !== ids.length) throw forbidden(NOT_MINE);
  };
/** Both orders of a swap (the parcel coming back, the order that gets it) are the agency's. */
const swapPair: Gate = (ctx, i) => ownOrders(ctx, [...nums(i?.fromId), ...nums(i?.toId)]);

/**
 * « Attribuer »: the agency's chief and its chefs d'équipe give the agency's orders to one of its own confirmation
 * agents here (one given the products of those orders), or take them back (nobody's). Never to the store's team.
 */
const give: Gate = async (ctx, i) => {
  if (!agencyLead(ctx)) throw forbidden('Seul le chef de l’agence ou un chef d’équipe donne les commandes');
  const ids = [...new Set(nums(i?.ids))];
  await ownOrders(ctx, ids);
  if (i?.agentId === null || i?.agentId === undefined) return;
  const p = (await ctx.db.query(`SELECT name, agency_products FROM profiles WHERE id = $1 AND active AND agency_id = $2 AND 'confirmation' = ANY(roles)`, [i.agentId, agencyOf(ctx)]))[0];
  if (!p) throw forbidden('Cette personne n’est pas un agent de confirmation de votre agence chez ce vendeur');
  const products = idsOrNull(p.agency_products);
  if (!products) return;
  const out = (await ctx.db.query('SELECT ref FROM orders WHERE id = ANY($1) AND (route_product_id IS NULL OR NOT (route_product_id = ANY($2))) LIMIT 1', [ids, products]))[0];
  if (out) throw bad(`${p.name} ne travaille pas sur le produit de ${out.ref}`);
};

/**
 * A customer the agency calls (one of its orders), or one of the store's confirmation agent's own customers. The id and
 * the phone are each checked: the action reads the id first, so a phone of one's own never opens another customer.
 */
const customer: Gate = async (ctx, i) => {
  const scope = rowScopeSql(ctx);
  if (!scope) return;
  const phone = typeof i?.phone === 'string' && i.phone.trim() ? normalizePhone(i.phone) : null;
  const id = i?.id === undefined || i?.id === null ? null : (nums(i.id)[0] ?? 0);
  const text = agencyOf(ctx) !== null ? 'Ce client n’est pas un client de votre agence' : 'Ce client n’est pas un de vos clients';
  if (typeof i?.phone === 'string' && i.phone.trim() && !phone) throw forbidden(text);
  if (id === null && !phone) return;
  if (id !== null && !(await ctx.db.query(`SELECT 1 FROM orders o WHERE o.customer_id = $1 AND ${scope} LIMIT 1`, [id])).length) throw forbidden(text);
  if (phone && !(await ctx.db.query(`SELECT 1 FROM orders o WHERE (o.phone = $1 OR o.customer_id IN (SELECT c.id FROM customers c WHERE c.phone = $1)) AND ${scope} LIMIT 1`, [phone])).length) throw forbidden(text);
};

/** The confirmation and suivi work, and the agent's own account. */
const savRole: Gate = async (ctx) => {
  if (!ctx.session.roles.includes('sav')) throw forbidden('Le SAV n’est pas confié à votre rôle');
};

export const AGENCY_AGENT_PROCS: Record<string, Gate> = {
  'me.get': free,
  'me.language': free,
  'me.password': free,
  'me.ui': free,
  'me.setUi': free,
  'me.update': free,
  'me.seen': free,
  'users.list': free,
  // the lists of the filter bars (the agency's own people and products only)
  'filters.options': free,
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
  'orders.reorderLink': order('id'),
  'orders.customerMessage': order('id'),
  'orders.setFollow': order('ids'),
  // « Attribuer »: the agency's chiefs give its orders to its agents
  'orders.assignAgent': give,
  // « ↶ Annuler »: the last change of one of the agency's orders
  'orders.lastChange': order('id'),
  'orders.undo': order('id'),
  'orders.undoMany': order('ids'),
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
  'catalog.assigned': free,
  // a product's sales guide during the call (the proc keeps to the agency's products)
  'catalog.guide': free,
  // Produits & stock › Guide de vente: the agency's people read and write the guides of the agency's products (the procs
  // keep to them)
  'catalog.guides': free,
  'catalog.saveGuide': free,
  'catalog.guidePhotoAdd': free,
  'catalog.guidePhoto': free,
  'catalog.guideFacts': free,
  'catalog.translateGuide': free,
  'catalog.guideDraft': free,
  'confirmation.deskOptions': free,
  'confirmation.mine': free,
  'confirmation.banner': free,
  'confirmation.gridFee': order('id'),
  'confirmation.release': order('id'),
  // « Envoyer des photos »: the catalogue's photos (its products only), the page for one of its orders
  'confirmation.photoThumbs': free,
  // the small pictures of the cart's lines and « Ajouter un produit » (the proc keeps to the agency's products)
  'confirmation.thumbs': free,
  'confirmation.photoShare': order('orderId'),
  'confirmation.setTry': order('ids'),
  'confirmation.block': order('ids'),
  'customers.history': customer,
  'customers.setBlacklist': customer,
  'delivery.stopdesks': free,
  'sav.list': savRole,
  'sav.kpis': savRole,
  'sav.get': savRole,
  'sav.orderNote': savRole,
  'sav.catalog': savRole,
  'sav.create': savRole,
  'sav.update': savRole,
  'sav.exchange': savRole,
  'sav.settle': savRole,
  'sav.rate': savRole,
  'sav.findOrder': savRole,
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
  // Swap: a parcel coming back given to another of the agency's orders
  'suivi.swapCandidates': order('fromId'),
  'suivi.swap': swapPair,
  'suivi.swapTarget': order('id'),
  // Réclamations with the delivery companies, on the agency's orders
  'suivi.contacts': free,
  'suivi.findOrders': free,
  'suivi.claims': free,
  'suivi.claimCreate': order('orderId'),
  'suivi.claimPush': claim('id'),
  'suivi.claimCategories': free,
  'suivi.claimRemind': claim('id'),
  'suivi.claimSync': claim('id'),
  'suivi.claimUpdate': claim('id'),
  'parcel.info': order('orderId'),
  'parcel.changeSync': order('orderId'),
};

/**
 * What a store's own confirmation agent opens or changes by its id (orders, customers, claims, SAV tickets, delivery
 * messages): only his own (ownRowSql). The lists keep to them too (orders, customers, search, SAV, messages).
 */
const OWN_AGENT_GATES: Record<string, Gate> = {
  'orders.get': order('id'),
  'orders.events': order('id'),
  'orders.update': order('id'),
  'orders.note': order('id'),
  'orders.logCall': order('id'),
  'orders.setConf': order('ids'),
  'orders.reasons': order('ids'),
  'orders.companyFees': order('ids'),
  'orders.duplicate': order('ids'),
  'orders.confirmCheck': order('id'),
  'orders.lastChange': order('id'),
  'orders.undo': order('id'),
  'orders.undoMany': order('ids'),
  'orders.sync': (ctx, i) => ownOrders(ctx, nums(Array.isArray(i?.actions) ? i.actions.map((a: any) => a?.id) : [])),
  'orders.assignAgent': order('ids'),
  'orders.assignCompany': order('ids'),
  'confirmation.gridFee': order('id'),
  'confirmation.setTry': order('ids'),
  'confirmation.block': order('ids'),
  'confirmation.hold': order('id'),
  'customers.history': customer,
  'customers.setBlacklist': customer,
  'parcel.info': order('orderId'),
  'parcel.changeSync': order('orderId'),
  'suivi.act': order('id'),
  'suivi.treat': order('id'),
  'suivi.unassign': order('id'),
  'suivi.resolve': order('id'),
  'suivi.stuckDone': order('id'),
  'suivi.claimCreate': order('orderId'),
  'suivi.claimPush': claim('id'),
  'suivi.claimRemind': claim('id'),
  'suivi.claimSync': claim('id'),
  'suivi.claimUpdate': claim('id'),
  'sav.create': order('orderId'),
  'sav.get': ticket('id'),
  'sav.update': ticket('id'),
  'sav.exchange': ticket('id'),
  'sav.settle': ticket('id'),
  'sav.rate': ticket('id'),
  'notify.markSent': message('id'),
  'notify.sendNow': message('id'),
  'notify.skip': message('id'),
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
  'inbox.list': free,
  'inbox.read': free,
  'inbox.readAll': free,
  'ads.overview': free,
  'ads.months': free,
  'ads.closeMonth': free,
  'ads.adset': free,
  'ads.link': free,
  'ads.sync': free,
  // Pilot Ads: their ad sets' buttons, Pilote auto's suggestions, their launches (adsmgr.ts / adslaunch.ts check the scope)
  'ads.ctl.state': free,
  'ads.ctl.act': free,
  'ads.ctl.actions': free,
  'ads.ctl.undo': free,
  'ads.pilot.state': free,
  'ads.pilot.decide': free,
  'ads.report.where': free,
  'ads.aud.list': free,
  'ads.launch.options': free,
  'ads.launch.copy': free,
  'ads.launch.save': free,
  'ads.launch.list': free,
  'ads.launch.get': free,
  'ads.launch.check': free,
  'ads.launch.go': free,
  'ads.launch.remove': free,
  'ads.media.list': free,
  'ads.media.photo': free,
  // « Photo du produit »: a product they are given only (adslaunch.ts checks it)
  'ads.media.productPhoto': free,
  'ads.media.videoStart': free,
  'ads.media.videoDone': free,
  'mk.overview': free,
  'mk.adset': free,
};
/** The work on a seller's ads, asked from the marketer's own space: it runs inside that store (agencywork.ts). */
export const MARKETER_SELLER_PROCS = new Set(Object.keys(MARKETER_AGENT_PROCS).filter((n) => !n.startsWith('me.')));
/** The actions a partner's space runs inside its sellers' stores. */
export const sellerProcsOf = (kind: 'agency' | 'marketer') => (kind === 'marketer' ? MARKETER_SELLER_PROCS : SELLER_PROCS);

const MANAGEMENT_PROCS = new Set(['management.plans', 'management.planSave', 'management.planClone', 'management.planAssign', 'management.planArchive', 'management.planDelete', 'management.bonuses', 'management.bonusSave', 'management.bonusClone', 'management.bonusDelete', 'management.bonusAssign', 'management.bonusRespond', 'management.bonusOfferAgent', 'management.billingTargets', 'management.billingPropose', 'management.payroll', 'management.payrollClose', 'management.agentScores']);

const AGENCY_INBOX = new Set(['inbox.list', 'inbox.read', 'inbox.readAll', 'inbox.run', 'push.key', 'push.subscribe', 'push.unsubscribe', 'push.test', 'push.devices', 'push.device.checkIn', 'push.device.remove']);
/** What a partner's own space answers (its own team and account; the rest are the agency.* actions). */
const AGENCY_SPACE = new Set(['me.get', 'me.language', 'me.password', 'me.ui', 'me.setUi', 'me.update', 'me.seen', 'me.delete', 'management.myBonuses', 'users.list', 'users.create', 'users.update', 'users.phoneCheck', 'admin.users.resetPassword', 'boutiques.list', 'boutiques.slugCheck', 'boutiques.save']);

/**
 * Checked before every action: a partner's space (agency, marketer) runs only its own actions; an agency's agent inside
 * a store only the confirmation and suivi work on the agency's orders, a marketer's person only the ads of their ad
 * sets; agency.* never runs in a store, partners.* never in a partner's space.
 */
export async function agencyGate(name: string, ctx: Ctx, input: unknown): Promise<void> {
  const kind = ctx.shop?.kind;
  if (kind === 'agency' || kind === 'marketer') {
    if (kind === 'agency' && AGENCY_INBOX.has(name)) return;
    if (name.startsWith('agency.') || AGENCY_SPACE.has(name)) return;
    // Only these plan actions belong to the agency itself; role checks still run before this gate.
    if (kind === 'agency' && MANAGEMENT_PROCS.has(name)) return;
    // an agency pays its people with the agent pay (Facturation › Paie, « Mes gains »)
    if (kind === 'agency' && name.startsWith('pay.')) return;
    if (sellerProcsOf(kind).has(name)) throw bad('Choisissez un vendeur en haut de la page');
    throw forbidden(kind === 'agency' ? 'Pas dans l’espace d’une agence' : 'Pas dans l’espace d’un marketer');
  }
  if (name.startsWith('agency.')) throw forbidden('Réservé aux agences de confirmation et aux marketers');
  if (agencyOf(ctx) === null) {
    // the store's own confirmation agent: only his orders, customers, tickets and messages
    if (storeAgentOnly(ctx)) await OWN_AGENT_GATES[name]?.(ctx, input);
    return;
  }
  // a marketer partner's person has the marketer role only (an agency's agents never have it)
  const g = (ctx.session.roles.includes('marketer') ? MARKETER_AGENT_PROCS : AGENCY_AGENT_PROCS)[name];
  if (!g) throw forbidden('Réservé à l’équipe de la boutique');
  await g(ctx, input);
}
