// The stores' partners and the stores they work for, both sides of the link: confirmation agencies (confirmation,
// suivi) and marketers (the stores' ads). A partner is a shop of its own kind: its team logs in on the same page as a
// store's and lands in the partner's space. The two find each other by code (a store: K7Q-29X, an agency: AG-7K2Q, a
// marketer: MK-7K2Q) and ask; the other side accepts or refuses. What follows says « agency »; a marketer works the
// same way, except:
// - it does no confirmation nor suivi: the store gives it products, and ad sets to its people (Marketing › Marketer);
//   its people work on the ads of those ad sets from the marketer's space (agencyscope.ts);
// - several marketers may work on the same products (each one is judged on its own ad sets);
// - its prices are its own pieces (per delivered order, per ad set « réussi », a part of the net profit, a fixed
//   amount) and its month counts its ad sets (marketers.ts).
//
// - Only the agency sets its prices. A change waits for the store's yes; the old prices stay until then.
// - Only the store chooses what it gives: the tasks (confirmation, suivi) and its products (all of them: also the new
//   ones). An order goes by its first product; products given to nobody stay with the store's own team.
// - The agency's chief picks the agents who work for each store: they get an account inside the store that opens only
//   the agency's orders, with the confirmation and suivi screens (see agencyscope.ts).
// - Pilotix counts each month's numbers; the agency asks to be paid, the store pays outside Pilotix and says so, the
//   agency confirms it received the money. What the agency pays its own agents stays inside the agency.
// - Pilotix checks an agency before it can work (verified), and can suspend it: its agents then stop at once and the
//   orders it had not finished go back to each store's own team.
import {
  AGENCY_TASKS,
  AgencyBillInfo,
  AgencyCounts,
  AgencyLinkInfo,
  AgencySellerWork,
  AgencyTask,
  cleanCode,
  CONF_TODO,
  FOLLOW_FINAL,
  hasPrice,
  NO_AGENCY_PRICES,
  NO_COUNTS,
  PartnerKind,
  partnerBill,
} from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, isoOrNull, num } from '../db';
import { bad, Ctx, forbidden, notFound, proc } from '../rpc';
import { cleanPrices } from '../platform/shops';
import { sellersOrNull } from './agencyscope';
import { marketerMonth } from './marketers';
import { SCHEMA_RE, type Tenancy } from '../platform/tenancy';

const HOUR = 3_600_000;
/** Every task a link can carry (an agency: confirmation, suivi; a marketer: its ads). */
const ALL_TASKS = ['confirmation', 'suivi', 'marketing'] as const;
const NO_SERVER = 'Les agences de confirmation et les marketers fonctionnent sur le serveur Pilotix (pas dans cet aperçu)';
const notVerified = (kind: PartnerKind) => (kind === 'marketer' ? 'Votre espace marketer doit d’abord être vérifié par Pilotix' : 'Votre agence doit d’abord être vérifiée par Pilotix');
const TASK_FR: Record<AgencyTask, string> = { confirmation: 'confirmation', suivi: 'suivi', marketing: 'publicité' };
/** A partner's name in a sentence: « l’agence X », « le marketer X ». */
const partnerFr = (kind: PartnerKind) => (kind === 'marketer' ? 'ce marketer' : 'cette agence');

// ---------------------------------------------------------------- inputs
const Id = z.number().int().positive();
/** The tasks asked (checked against the partner's kind by tasksFor) */
const Tasks = z.array(z.enum(ALL_TASKS)).min(1, 'Choisissez au moins une tâche').max(3);
/** The tasks of a link, for a partner of this kind: an agency confirmation and / or suivi, a marketer its ads. */
function tasksFor(kind: PartnerKind, v: readonly AgencyTask[]): AgencyTask[] {
  if (kind === 'marketer') return ['marketing'];
  const out = AGENCY_TASKS.filter((k) => v.includes(k));
  if (!out.length) throw bad('Choisissez au moins une tâche');
  return out;
}
const Money = z.number().int().min(0).max(10_000_000);
const PricesIn = z.object({
  perConfirmed: Money,
  perDelivered: Money,
  perUpsell: Money,
  monthly: Money,
  bonusRate: z.object({ min: z.number().int().min(0).max(100), amount: Money }),
  bonusVolume: z.object({ above: z.number().int().min(0).max(1_000_000), amount: Money }),
  /** marketers: per ad set « réussi » */
  perSuccess: Money.default(0),
  /** marketers: % of the net profit */
  profitRate: z.number().int().min(0).max(100).default(0),
});
/** null: every product (also the new ones) */
const Products = z.array(Id).max(2000).nullable();
const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mois invalide (AAAA-MM)');

// ---------------------------------------------------------------- months (Algeria: UTC+1 all year)
export function monthBounds(ym: string): { from: string; to: string } {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7)) - 1;
  return { from: new Date(Date.UTC(y, m, 1) - HOUR).toISOString(), to: new Date(Date.UTC(y, m + 1, 1) - HOUR).toISOString() };
}
export function monthNow(now: number): string {
  const d = new Date(now + HOUR);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- who calls
function tOf(ctx: Ctx): Tenancy {
  if (!ctx.t || !ctx.shop) throw bad(NO_SERVER);
  return ctx.t;
}
/** A partner's own space: an agency's or a marketer's (its chief, unless said). */
function asAgency(ctx: Ctx): { t: Tenancy; id: number; kind: PartnerKind } {
  const t = tOf(ctx);
  const kind = ctx.shop!.kind;
  if (kind !== 'agency' && kind !== 'marketer') throw forbidden('Réservé aux agences de confirmation et aux marketers');
  return { t, id: ctx.shop!.id, kind };
}
/** A store's administrator. */
function asStore(ctx: Ctx): { t: Tenancy; id: number } {
  const t = tOf(ctx);
  if (ctx.shop!.kind === 'agency' || ctx.shop!.kind === 'marketer') throw forbidden('Réservé aux boutiques');
  if (ctx.shop!.demo) throw forbidden('Pas dans la boutique démo : ses comptes sont partagés par tous les visiteurs');
  return { t, id: ctx.shop!.id };
}

// ---------------------------------------------------------------- links
const json = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);
const tasksOf = (v: unknown): AgencyTask[] => {
  const a = json(v);
  return ALL_TASKS.filter((k) => Array.isArray(a) && a.includes(k));
};
const productsOf = (v: unknown): number[] | null => {
  const a = json(v);
  return Array.isArray(a) ? a.map(Number).filter((x) => Number.isSafeInteger(x) && x > 0) : null;
};

export const LINK_SQL = `SELECT l.*, a.kind AS a_kind, a.name AS a_name, a.public_code AS a_code, a.agency_verified_at AS a_verified, a.status AS a_status, a.schema_name AS a_schema,
    s.name AS s_name, s.public_code AS s_code, s.status AS s_status, s.schema_name AS s_schema
  FROM platform.agency_links l JOIN platform.shops a ON a.id = l.agency_id JOIN platform.shops s ON s.id = l.store_id`;

export interface Link {
  info: AgencyLinkInfo;
  agencySchema: string;
  storeSchema: string;
  /** the agency may work: not suspended, checked by Pilotix */
  agencyOk: boolean;
  /** the store still exists */
  storeOk: boolean;
}

export function toLink(r: any): Link {
  const kind: PartnerKind = r.a_kind === 'marketer' ? 'marketer' : 'agency';
  return {
    info: {
      id: num(r.id),
      kind,
      status: r.status,
      requestedBy: r.requested_by,
      agency: { id: num(r.agency_id), name: r.a_name, code: r.a_code ?? null, verified: !!r.a_verified, suspended: r.a_status !== 'active' },
      store: { id: num(r.store_id), name: r.s_name, code: r.s_code ?? null },
      tasks: kind === 'marketer' ? ['marketing'] : tasksOf(r.tasks).filter((k) => k !== 'marketing'),
      prices: cleanPrices(json(r.prices), kind),
      pricesNew: r.prices_new ? cleanPrices(json(r.prices_new), kind) : null,
      products: productsOf(r.products),
      agents: [],
      createdAt: iso(r.created_at),
      startedAt: isoOrNull(r.started_at),
      endedAt: isoOrNull(r.ended_at),
      endedBy: r.ended_by ?? null,
    },
    agencySchema: r.a_schema,
    storeSchema: r.s_schema,
    agencyOk: r.a_status === 'active' && !!r.a_verified,
    storeOk: r.s_status !== 'archived' && r.s_status !== 'deleted',
  };
}

// ---------------------------------------------------------------- the agency's people and the sellers they work for
/** One person of an agency's team (its own space), with the sellers they work for (null: every seller). */
export interface AgencyPerson {
  id: number;
  name: string;
  email: string;
  roles: string[];
  hash: string;
  language: string;
  sellers: AgencySellerWork[] | null;
}
/** The agency's chief and managers do every task the seller gives; the others the tasks of their roles. */
export const isLead = (roles: string[]) => roles.includes('admin') || roles.includes('agent_manager');
/** Can this person of the partner work for a seller with these tasks? (a marketer's people: the marketer role) */
const fits = (kind: PartnerKind, roles: string[], tasks: AgencyTask[]) => isLead(roles) || (kind === 'marketer' ? roles.includes('marketer') : tasks.some((k) => roles.includes(k)));

/**
 * The agency's active people (its space's database), the system accounts left out. `schema`: read them through another
 * database's connection (a store's transaction: see syncLink).
 */
export async function agencyPeople(db: Db, schema?: string): Promise<AgencyPerson[]> {
  if (schema !== undefined && !SCHEMA_RE.test(schema)) throw new Error('Invalid schema');
  const table = schema === undefined ? 'profiles' : `${schema}.profiles`;
  const rows = await db.query(`SELECT id, name, email, roles, password_hash, language, agency_sellers FROM ${table} WHERE active AND email NOT LIKE '%@pilotix.invalid' ORDER BY name`);
  return rows.map((p: any) => ({
    id: num(p.id),
    name: p.name as string,
    email: String(p.email).toLowerCase(),
    roles: (p.roles ?? []) as string[],
    hash: p.password_hash as string,
    language: (p.language as string) ?? 'fr',
    sellers: sellersOrNull(p.agency_sellers),
  }));
}
/** Does this person work for this store, and on which products there? (undefined: not for this store) */
export function workFor(p: { sellers: AgencySellerWork[] | null }, storeId: number): { products: number[] | null } | undefined {
  if (p.sellers === null) return { products: null };
  const w = p.sellers.find((x) => x.store === storeId);
  return w ? { products: w.products } : undefined;
}
/** The people of the agency who work for each of these links (filled into `info.agents`). */
async function withAgents(t: Tenancy, links: Link[]): Promise<Link[]> {
  const bySchema = new Map<string, AgencyPerson[]>();
  for (const L of links) {
    if (!bySchema.has(L.agencySchema)) bySchema.set(L.agencySchema, await agencyPeople(t.shop(L.agencySchema)));
    const people = bySchema.get(L.agencySchema)!;
    L.info.agents = people.flatMap((p) => {
      const w = workFor(p, L.info.store.id);
      // their role must fit one of the seller's tasks (the chief and supervisors: every task)
      return w && fits(L.info.kind, p.roles, L.info.tasks) ? [{ profileId: p.id, name: p.name, products: w.products }] : [];
    });
  }
  return links;
}

async function loadLink(t: Tenancy, id: number): Promise<Link> {
  const r = (await t.platform.query(`${LINK_SQL} WHERE l.id = $1`, [id]))[0];
  if (!r) throw notFound('Lien introuvable');
  return toLink(r);
}
/** A link of this agency / of this store (another one is « not found »: nobody learns it exists). */
async function agencyLink(t: Tenancy, agencyId: number, id: number) {
  const L = await loadLink(t, id);
  if (L.info.agency.id !== agencyId) throw notFound('Lien introuvable');
  return L;
}
async function storeLink(t: Tenancy, storeId: number, id: number) {
  const L = await loadLink(t, id);
  if (L.info.store.id !== storeId) throw notFound('Lien introuvable');
  return L;
}

/** The store's products (to check a choice, and to name them). */
async function productNames(db: Db, ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  return new Map((await db.query('SELECT id, name FROM products WHERE id = ANY($1)', [ids])).map((r: any) => [num(r.id), r.name as string]));
}
async function checkProducts(db: Db, products: number[] | null): Promise<number[] | null> {
  if (products === null) return null;
  const ids = [...new Set(products)];
  if (!ids.length) throw bad('Choisissez au moins un produit (ou « Tous les produits »)');
  const known = await productNames(db, ids);
  if (known.size !== ids.length) throw bad('Produit introuvable');
  return ids.sort((a, b) => a - b);
}

/**
 * Two agencies never get the same product for the same task (one may have « every product », the others named
 * products: those go to them). Returns why not, or null.
 */
async function clash(t: Tenancy, db: Db, storeId: number, exceptId: number, tasks: AgencyTask[], products: number[] | null, kind: PartnerKind = 'agency'): Promise<string | null> {
  // marketers share products: each one is judged on its own ad sets
  if (kind === 'marketer') return null;
  const others = (await t.platform.query(`${LINK_SQL} WHERE l.store_id = $1 AND l.status = 'active' AND l.id <> $2 AND a.kind = 'agency'`, [storeId, exceptId])).map(toLink);
  for (const o of others) {
    const both = tasks.filter((k) => o.info.tasks.includes(k));
    if (!both.length) continue;
    const what = both.map((k) => TASK_FR[k]).join(' et ');
    if (products === null && o.info.products === null) return `${o.info.agency.name} a déjà tous les produits pour la ${what}. Donnez des produits précis à l’une des deux agences.`;
    if (products && o.info.products) {
      const same = products.filter((p) => o.info.products!.includes(p));
      if (same.length) {
        const names = await productNames(db, same);
        return `Déjà confié${same.length > 1 ? 's' : ''} à ${o.info.agency.name} pour la ${what} : ${same.map((p) => names.get(p) ?? `#${p}`).join(', ')}`;
      }
    }
  }
  return null;
}

/**
 * The sellers an agency's person works for, as the chief chose them in Utilisateurs: sellers the agency works with
 * (or asked), and for each one all the agency's products there (null) or some of them. null: every seller.
 */
export async function checkSellers(ctx: Ctx, v: AgencySellerWork[] | null): Promise<AgencySellerWork[] | null> {
  if (v === null) return null;
  const { t, id } = asAgency(ctx);
  const links = (await t.platform.query(`${LINK_SQL} WHERE l.agency_id = $1 AND l.status IN ('pending', 'active')`, [id])).map(toLink);
  const out: AgencySellerWork[] = [];
  for (const w of v) {
    if (out.some((x) => x.store === w.store)) continue;
    const L = links.find((l) => l.info.store.id === w.store);
    if (!L) throw bad('Vendeur introuvable : il ne travaille pas (ou plus) avec vous');
    const products = w.products === null ? null : [...new Set(w.products)].sort((a, b) => a - b);
    if (products && !products.length) throw bad(`${L.info.store.name} : choisissez au moins un produit (ou « Tous les produits »)`);
    if (products && L.info.products && products.some((x) => !L.info.products!.includes(x))) throw bad(`${L.info.store.name} : ce produit ne vous est pas confié`);
    if (products && !L.info.products && (await productNames(t.shop(L.storeSchema), products)).size !== products.length) throw bad('Produit introuvable');
    out.push({ store: w.store, products });
  }
  return out;
}

// ---------------------------------------------------------------- the store follows its links
/** The orders of a task the agency no longer does go back to the store's own team (those not finished). */
async function releaseOrders(db: Db, agencyId: number, task: AgencyTask) {
  const theirs = '(SELECT id FROM profiles WHERE agency_id = $1)';
  if (task === 'confirmation')
    await db.query(
      `UPDATE orders SET conf_agency_id = NULL,
         agent_id = CASE WHEN agent_id IN ${theirs} THEN NULL ELSE agent_id END,
         assigned_at = CASE WHEN agent_id IN ${theirs} THEN NULL ELSE assigned_at END,
         locked_by = CASE WHEN locked_by IN ${theirs} THEN NULL ELSE locked_by END
       WHERE conf_agency_id = $1 AND conf_status = ANY($2)`,
      [agencyId, CONF_TODO],
    );
  else
    await db.query(
      `UPDATE orders SET follow_agency_id = NULL, follow_agent_id = CASE WHEN follow_agent_id IN ${theirs} THEN NULL ELSE follow_agent_id END
       WHERE follow_agency_id = $1 AND (follow_status IS NULL OR NOT (follow_status = ANY($2)))`,
      [agencyId, FOLLOW_FINAL],
    );
}

/**
 * Makes the store match the link (safe to run again): which products go to the agency, its agents' accounts in the
 * store (opened, closed, their tasks), and the orders it no longer works on. Returns what could not be done.
 * One sync of a partner in a store at a time: a second one (the chief and the store changing things at the same
 * moment) waits for the first, then reads the link and the team as the first one left them — all in the store's
 * transaction (the link and the team are read through it, by their schema).
 */
export async function syncLink(t: Tenancy, linkId: number): Promise<string[]> {
  const first = await loadLink(t, linkId);
  if (!first.storeOk) return [];
  const db = t.shop(first.storeSchema);
  return db.tx(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`partner-sync:${first.storeSchema}:${first.info.agency.id}`]);
    const row = (await tx.query(`${LINK_SQL} WHERE l.id = $1`, [linkId]))[0];
    if (!row) return [];
    const L = toLink(row);
    const on = L.info.status === 'active' && L.agencyOk && L.storeOk;
    const people = on ? await agencyPeople(tx, L.agencySchema) : [];
    return L.info.kind === 'marketer' ? syncMarketer(tx, L, people, on) : syncAgencyLink(tx, L, people, on);
  });
}

/** A confirmation agency in a store (inside syncLink's transaction). */
async function syncAgencyLink(db: Db, L: Link, people: AgencyPerson[], on: boolean): Promise<string[]> {
  const A = L.info.agency.id;
  const tasks = on ? L.info.tasks : [];
  const problems: string[] = [];
  // which products go to the agency, for each task
  await db.query('DELETE FROM agency_routes WHERE agency_id = $1', [A]);
  for (const task of tasks)
    for (const pid of L.info.products ?? [null]) await db.query('INSERT INTO agency_routes (agency_id, task, product_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [A, task, pid]);
  // its people who work for this seller: an account in the store with the tasks they can do (the chief and its
  // managers: every task the seller gives) and, when the chief chose, their products there
  const want = new Map<string, { name: string; hash: string; language: string; roles: AgencyTask[]; products: number[] | null }>();
  for (const p of people) {
    const w = workFor(p, L.info.store.id);
    if (!w) continue;
    const roles = tasks.filter((k) => isLead(p.roles) || p.roles.includes(k));
    // products the seller no longer gives fall out (none left: the person stops working here)
    const products = w.products && L.info.products ? w.products.filter((x) => L.info.products!.includes(x)) : w.products;
    if (roles.length && (!products || products.length)) want.set(p.email, { name: p.name, hash: p.hash, language: p.language, roles, products });
  }
  for (const [email, w] of want) {
    const cur = (await db.query('SELECT id, agency_id FROM profiles WHERE lower(email) = $1', [email]))[0];
    if (!cur)
      await db.query('INSERT INTO profiles (name, email, password_hash, roles, language, agency_id, agency_products, active) VALUES ($1, $2, $3, $4, $5, $6, $7, true)', [w.name, email, w.hash, w.roles, w.language, A, w.products]);
    else if (num(cur.agency_id) === A)
      await db.query('UPDATE profiles SET name = $2, roles = $3, password_hash = $4, agency_products = $5, active = true, archived_at = NULL WHERE id = $1', [cur.id, w.name, w.roles, w.hash, w.products]);
    else problems.push(`${w.name} (${email}) a déjà un compte dans ${L.info.store.name} : il ne peut pas y travailler pour l’agence`);
  }
  // the others of this agency: closed now (their sessions end)
  await db.query('UPDATE profiles SET active = false, token_version = token_version + 1 WHERE agency_id = $1 AND active AND NOT (lower(email) = ANY($2))', [A, [...want.keys()]]);
  // orders of a task it no longer does: back to the store's team
  for (const task of AGENCY_TASKS) if (!tasks.includes(task)) await releaseOrders(db, A, task);
  await releaseStuck(db, A);
  return problems;
}

/**
 * A marketer in a store (inside syncLink's transaction): its people who work for this seller get an account there with
 * the marketer role, on the products the store gave the marketer (those the chief chose for them, among them), with the
 * marketer's price per ad set « réussi ». The store gives them ad sets (Marketing › Marketer); the others of the marketer
 * are closed (their ad sets stay theirs: the store gives them to someone else).
 */
async function syncMarketer(db: Db, L: Link, people: AgencyPerson[], on: boolean): Promise<string[]> {
  const A = L.info.agency.id;
  const problems: string[] = [];
  const want = new Map<string, { name: string; hash: string; language: string; products: number[] | null; lead: boolean }>();
  if (on)
    for (const p of people) {
      const w = workFor(p, L.info.store.id);
      if (!w || !fits('marketer', p.roles, L.info.tasks)) continue;
      // the chief's choice within what the store gives (none left: the person stops working here)
      const products = w.products ? (L.info.products ? w.products.filter((x) => L.info.products!.includes(x)) : w.products) : L.info.products;
      if (!products || products.length) want.set(p.email, { name: p.name, hash: p.hash, language: p.language, products, lead: isLead(p.roles) });
    }
  for (const [email, w] of want) {
    // the marketer's chief and managers see every ad set of the team here (agency_lead: see ads.ts)
    const cur = (await db.query('SELECT id, agency_id FROM profiles WHERE lower(email) = $1', [email]))[0];
    if (!cur)
      await db.query(`INSERT INTO profiles (name, email, password_hash, roles, language, agency_id, agency_products, agency_lead, active) VALUES ($1, $2, $3, '{marketer}', $4, $5, $6, $7, true)`, [
        w.name,
        email,
        w.hash,
        w.language,
        A,
        w.products,
        w.lead,
      ]);
    else if (num(cur.agency_id) === A)
      await db.query(`UPDATE profiles SET name = $2, roles = '{marketer}', password_hash = $3, agency_products = $4, agency_lead = $5, active = true, archived_at = NULL WHERE id = $1`, [cur.id, w.name, w.hash, w.products, w.lead]);
    else problems.push(`${w.name} (${email}) a déjà un compte dans ${L.info.store.name} : il ne peut pas y travailler pour votre espace marketer`);
  }
  await db.query('UPDATE profiles SET active = false, token_version = token_version + 1 WHERE agency_id = $1 AND active AND NOT (lower(email) = ANY($2))', [A, [...want.keys()]]);
  // the marketer's price per ad set « réussi » (the store's Marketer page judges its people's ad sets with it)
  await db.query(
    `INSERT INTO marketer_prices (profile_id, price, updated_at) SELECT id, $2, now() FROM profiles WHERE agency_id = $1
     ON CONFLICT (profile_id) DO UPDATE SET price = EXCLUDED.price, updated_at = now()`,
    [A, L.info.prices.perSuccess],
  );
  return problems;
}

/**
 * Unfinished orders held by one of the agency's people who stopped working here, or who no longer has their product:
 * free again for the agency's other agents.
 */
async function releaseStuck(db: Db, agencyId: number) {
  const gone = `SELECT p.id FROM profiles p WHERE p.agency_id = $1 AND (NOT p.active OR (p.agency_products IS NOT NULL AND NOT (o.route_product_id = ANY(p.agency_products))))`;
  await db.query(
    `UPDATE orders o SET agent_id = CASE WHEN o.agent_id IN (${gone}) THEN NULL ELSE o.agent_id END,
         assigned_at = CASE WHEN o.agent_id IN (${gone}) THEN NULL ELSE o.assigned_at END,
         locked_by = CASE WHEN o.locked_by IN (${gone}) THEN NULL ELSE o.locked_by END,
         locked_until = CASE WHEN o.locked_by IN (${gone}) THEN NULL ELSE o.locked_until END
      WHERE o.conf_agency_id = $1 AND o.conf_status = ANY($2) AND (o.agent_id IN (${gone}) OR o.locked_by IN (${gone}))`,
    [agencyId, CONF_TODO],
  );
  await db.query(`UPDATE orders o SET follow_agent_id = NULL WHERE o.follow_agency_id = $1 AND (o.follow_status IS NULL OR NOT (o.follow_status = ANY($2))) AND o.follow_agent_id IN (${gone})`, [agencyId, FOLLOW_FINAL]);
}

/** Every link of an agency follows it (checked, suspended, its team changed). */
export async function syncAgency(t: Tenancy, agencyId: number): Promise<void> {
  const rows = await t.platform.query(`SELECT id FROM platform.agency_links WHERE agency_id = $1 AND status = 'active' ORDER BY id`, [agencyId]);
  for (const r of rows as any[]) await syncLink(t, num(r.id));
}

// ---------------------------------------------------------------- numbers and bills
/** What Pilotix counts for an agency in a store over [from, to). */
export async function agencyCounts(db: Db, agencyId: number, from: string, to: string): Promise<AgencyCounts> {
  return { ...NO_COUNTS, ...(await countOrders(db, agencyId, from, to)) };
}
async function countOrders(db: Db, agencyId: number, from: string, to: string) {
  const r = (
    await db.query(
      `SELECT
         count(*) FILTER (WHERE conf_agency_id = $1 AND created_at >= $2 AND created_at < $3)::int AS received,
         count(*) FILTER (WHERE conf_agency_id = $1 AND confirmed_at >= $2 AND confirmed_at < $3)::int AS confirmed,
         count(*) FILTER (WHERE follow_status IN ('delivered','exchanged') AND delivered_at >= $2 AND delivered_at < $3)::int AS delivered,
         count(*) FILTER (WHERE follow_status IN ('returning','returned') AND coalesce(returning_at, returned_at, updated_at) >= $2 AND coalesce(returning_at, returned_at, updated_at) < $3)::int AS returned,
         count(*) FILTER (WHERE has_upsell AND follow_status IN ('delivered','exchanged') AND delivered_at >= $2 AND delivered_at < $3)::int AS upsells
       FROM sales WHERE conf_agency_id = $1 OR follow_agency_id = $1`,
      [agencyId, from, to],
    )
  )[0];
  return { received: num(r?.received), confirmed: num(r?.confirmed), delivered: num(r?.delivered), returned: num(r?.returned), upsells: num(r?.upsells) };
}

/** Did the link work during [from, to)? (the fixed monthly amount counts then) */
const workedIn = (l: AgencyLinkInfo, from: string, to: string) => !!l.startedAt && l.startedAt < to && (!l.endedAt || l.endedAt >= from);

/** A link's numbers for a month (YYYY-MM): an agency's orders, a marketer's ad sets. */
async function linkCounts(t: Tenancy, L: Link, month: string, now: number): Promise<AgencyCounts> {
  if (!L.storeOk) return { ...NO_COUNTS };
  const db = t.shop(L.storeSchema);
  if (L.info.kind === 'marketer') return marketerMonth(db, L.info.agency.id, month, now, L.info.products);
  const { from, to } = monthBounds(month);
  return agencyCounts(db, L.info.agency.id, from, to);
}

const toBill = (r: any): AgencyBillInfo => {
  const d = json(r.details) ?? {};
  return {
    id: num(r.id),
    linkId: num(r.link_id),
    month: r.month,
    amount: num(r.amount),
    lines: Array.isArray(d.lines) ? d.lines : [],
    counts: { ...NO_COUNTS, ...(d.counts ?? {}) },
    status: r.status,
    requestedAt: iso(r.requested_at),
    paidAt: isoOrNull(r.paid_at),
    receivedAt: isoOrNull(r.received_at),
  };
};
async function billsOf(t: Tenancy, linkId: number): Promise<AgencyBillInfo[]> {
  return (await t.platform.query('SELECT * FROM platform.agency_bills WHERE link_id = $1 ORDER BY month DESC', [linkId])).map(toBill);
}

/** One link: its numbers and bill for a month, and its payment requests (and who of the partner works for it). */
async function linkDetail(t: Tenancy, L: Link, month: string, now: number) {
  await withAgents(t, [L]);
  const { from, to } = monthBounds(month);
  const counts = await linkCounts(t, L, month, now);
  const bill = partnerBill(L.info.kind, L.info.prices, counts, { monthly: workedIn(L.info, from, to) });
  return { link: L.info, month, counts, bill, bills: await billsOf(t, L.info.id) };
}

/** This month's numbers of each link that works (or worked) with someone. */
async function monthCounts(t: Tenancy, links: Link[], now: number) {
  const month = monthNow(now);
  const { from, to } = monthBounds(month);
  const out: Record<string, AgencyCounts & { total: number }> = {};
  for (const L of links) {
    if (!L.info.startedAt || !L.storeOk || !workedIn(L.info, from, to)) continue;
    const c = await linkCounts(t, L, month, now);
    out[String(L.info.id)] = { ...c, total: partnerBill(L.info.kind, L.info.prices, c, { monthly: true }).total };
  }
  return { month, counts: out };
}

// ---------------------------------------------------------------- the agency itself
async function agencyRow(t: Tenancy, id: number) {
  const r = (await t.platform.query('SELECT id, kind, name, public_code, agency_verified_at, agency_prices, status FROM platform.shops WHERE id = $1', [id]))[0];
  if (!r) throw notFound('Partenaire introuvable');
  const kind: PartnerKind = r.kind === 'marketer' ? 'marketer' : 'agency';
  return {
    id: num(r.id),
    kind,
    name: r.name as string,
    code: (r.public_code as string | null) ?? null,
    verified: !!r.agency_verified_at,
    active: r.status === 'active',
    prices: r.agency_prices ? cleanPrices(json(r.agency_prices), kind) : null,
  };
}

async function setStatus(t: Tenancy, id: number, from: string, to: string, extra = ''): Promise<boolean> {
  return (await t.platform.query(`UPDATE platform.agency_links SET status = $3, answered_at = now()${extra} WHERE id = $1 AND status = $2 RETURNING id`, [id, from, to])).length > 0;
}

async function endLink(t: Tenancy, L: Link, by: 'agency' | 'store' | 'pilotix') {
  const done = await t.platform.query(`UPDATE platform.agency_links SET status = 'ended', ended_at = now(), ended_by = $2 WHERE id = $1 AND status = 'active' RETURNING id`, [L.info.id, by]);
  if (!done.length) throw bad('Ce contrat n’est plus actif');
  await syncLink(t, L.info.id);
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const requesterOf = (ctx: Ctx) => `${ctx.session.profile.name} <${ctx.session.profile.email}>`.slice(0, 200);

export const agencyProcs = {
  // ---------------------------------------------------------------- the agency's side (its space)
  /**
   * The agency's home: its code, whether Pilotix checked it, its usual prices, its sellers (requests, contracts, who
   * works for each) and this month's numbers. Its agents see only their sellers (agency.sellers), no prices, no money.
   */
  'agency.home': proc(null, z.object({}), async (ctx) => {
    const { t, id } = asAgency(ctx);
    const a = await agencyRow(t, id);
    const lead = ctx.session.isAdmin;
    const all = lead ? await withAgents(t, (await t.platform.query(`${LINK_SQL} WHERE l.agency_id = $1 ORDER BY l.id DESC`, [id])).map(toLink)) : [];
    const m = lead ? await monthCounts(t, all, ctx.now()) : { month: monthNow(ctx.now()), counts: {} };
    return {
      agency: { id: a.id, kind: a.kind, name: a.name, code: a.code, verified: a.verified, prices: lead ? a.prices : null },
      lead,
      month: m.month,
      counts: m.counts,
      links: all.map((l) => l.info),
    };
  }),

  /** Facturation: each seller's numbers and bill for a month, and where its payment request stands. */
  'agency.billing': proc([], z.object({ month: Month.optional() }), async (ctx, i) => {
    const { t, id } = asAgency(ctx);
    const month = i.month ?? monthNow(ctx.now());
    const { from, to } = monthBounds(month);
    const links = (await t.platform.query(`${LINK_SQL} WHERE l.agency_id = $1 AND l.started_at IS NOT NULL ORDER BY s.name, l.id`, [id])).map(toLink);
    const rows = [];
    for (const L of links) {
      if (!workedIn(L.info, from, to)) continue;
      const counts = await linkCounts(t, L, month, ctx.now());
      const b = (await t.platform.query('SELECT * FROM platform.agency_bills WHERE link_id = $1 AND month = $2', [L.info.id, month]))[0];
      rows.push({ link: L.info, counts, bill: partnerBill(L.info.kind, L.info.prices, counts, { monthly: true }), request: b ? toBill(b) : null });
    }
    return { month, rows };
  }),

  /** The agency's usual prices: what a store sees before working with it, and the start of a new request's prices. */
  'agency.prices': proc([], z.object({ prices: PricesIn }), async (ctx, i) => {
    const { t, id, kind } = asAgency(ctx);
    await t.platform.query('UPDATE platform.shops SET agency_prices = $2 WHERE id = $1', [id, JSON.stringify(cleanPrices(i.prices, kind))]);
    return { ok: true };
  }),

  /** A store by its code (its name only), and the link the agency already has with it. */
  'agency.find': proc([], z.object({ code: z.string().trim().min(4).max(20) }), async (ctx, i) => {
    const { t, id } = asAgency(ctx);
    const s = (await t.platform.query(`SELECT id, name, public_code FROM platform.shops WHERE public_code = $1 AND kind = 'store' AND NOT is_demo AND status = 'active'`, [cleanCode(i.code, 'store')]))[0];
    if (!s) throw notFound('Aucune boutique avec ce code');
    const open = (await t.platform.query(`SELECT id, status FROM platform.agency_links WHERE agency_id = $1 AND store_id = $2 AND status IN ('pending', 'active')`, [id, s.id]))[0];
    return { store: { id: num(s.id), name: s.name as string, code: s.public_code as string }, link: open ? { id: num(open.id), status: open.status as 'pending' | 'active' } : null };
  }),

  /** Asks a store to work with it: the tasks and the prices for this store (its usual prices to start with). */
  'agency.request': proc([], z.object({ storeId: Id, tasks: Tasks, prices: PricesIn.optional() }), async (ctx, i) => {
    const { t, id, kind } = asAgency(ctx);
    const a = await agencyRow(t, id);
    if (!a.verified) throw bad(notVerified(kind));
    const tasks = tasksFor(kind, i.tasks);
    const prices = cleanPrices(i.prices ?? a.prices ?? NO_AGENCY_PRICES, kind);
    if (!hasPrice(prices)) throw bad('Écrivez d’abord vos prix (au moins un montant)');
    const s = (await t.platform.query(`SELECT id FROM platform.shops WHERE id = $1 AND kind = 'store' AND NOT is_demo AND status = 'active'`, [i.storeId]))[0];
    if (!s) throw notFound('Boutique introuvable');
    try {
      const r = (
        await t.platform.query(
          `INSERT INTO platform.agency_links (agency_id, store_id, requested_by, requester, tasks, prices) VALUES ($1, $2, 'agency', $3, $4, $5) RETURNING id`,
          [id, i.storeId, requesterOf(ctx), JSON.stringify(tasks), JSON.stringify(prices)],
        )
      )[0];
      return { id: num(r.id) };
    } catch (e: any) {
      if (String(e?.code) === '23505' || /unique|duplicate/i.test(String(e?.message))) throw bad('Une demande ou un contrat existe déjà avec cette boutique');
      throw e;
    }
  }),

  /** Yes or no to a store's request. */
  'agency.answer': proc([], z.object({ id: Id, accept: z.boolean() }), async (ctx, i) => {
    const { t, id } = asAgency(ctx);
    const L = await agencyLink(t, id, i.id);
    if (L.info.status !== 'pending' || L.info.requestedBy !== 'store') throw bad('Cette demande n’attend plus votre réponse');
    if (!i.accept) {
      await setStatus(t, L.info.id, 'pending', 'refused');
      return { ok: true, problems: [] as string[] };
    }
    if (!L.agencyOk) throw bad(notVerified(L.info.kind));
    const why = await clash(t, t.shop(L.storeSchema), L.info.store.id, L.info.id, L.info.tasks, L.info.products, L.info.kind);
    if (why) throw bad(why);
    if (!(await setStatus(t, L.info.id, 'pending', 'active', ', started_at = now()'))) throw bad('Cette demande n’attend plus votre réponse');
    return { ok: true, problems: await syncLink(t, L.info.id) };
  }),

  /** Takes back its own request. */
  'agency.cancel': proc([], z.object({ id: Id }), async (ctx, i) => {
    const { t, id } = asAgency(ctx);
    const L = await agencyLink(t, id, i.id);
    if (L.info.requestedBy !== 'agency' || !(await setStatus(t, L.info.id, 'pending', 'cancelled'))) throw bad('Cette demande n’est plus en attente');
    return { ok: true };
  }),

  /**
   * New prices for one store: a request not answered yet takes them at once; a contract keeps its prices until the
   * store says yes to the new ones.
   */
  'agency.linkPrices': proc([], z.object({ id: Id, prices: PricesIn }), async (ctx, i) => {
    const { t, id } = asAgency(ctx);
    const L = await agencyLink(t, id, i.id);
    const p = cleanPrices(i.prices, L.info.kind);
    if (!hasPrice(p)) throw bad('Écrivez au moins un montant');
    if (L.info.status === 'pending' && L.info.requestedBy === 'agency') await t.platform.query('UPDATE platform.agency_links SET prices = $2 WHERE id = $1', [L.info.id, JSON.stringify(p)]);
    else if (L.info.status === 'active') await t.platform.query('UPDATE platform.agency_links SET prices_new = $2 WHERE id = $1', [L.info.id, sameJson(p, L.info.prices) ? null : JSON.stringify(p)]);
    else throw bad('Les prix de ce lien ne changent plus');
    return { ok: true };
  }),

  /** The sellers the agency works with (or asked), to choose each person's sellers in Utilisateurs. */
  'agency.sellerChoices': proc(null, z.object({}), async (ctx) => {
    const { t, id } = asAgency(ctx);
    if (!ctx.session.isAdmin && !ctx.session.canManageUsers) throw forbidden();
    const links = (await t.platform.query(`${LINK_SQL} WHERE l.agency_id = $1 AND l.status IN ('pending', 'active') ORDER BY s.name, l.id`, [id])).map(toLink);
    return links.map((L) => ({ store: L.info.store, status: L.info.status, tasks: L.info.tasks, products: L.info.products }));
  }),

  /** A seller's products the agency has (all of them, or the ones the seller gave): to give some to one person. */
  'agency.products': proc(null, z.object({ store: Id }), async (ctx, i) => {
    const { t, id } = asAgency(ctx);
    if (!ctx.session.isAdmin && !ctx.session.canManageUsers) throw forbidden();
    const L = (await t.platform.query(`${LINK_SQL} WHERE l.agency_id = $1 AND l.store_id = $2 AND l.status IN ('pending', 'active') ORDER BY l.id DESC LIMIT 1`, [id, i.store])).map(toLink)[0];
    if (!L || !L.storeOk) throw notFound('Vendeur introuvable');
    const db = t.shop(L.storeSchema);
    const rows = L.info.products
      ? await db.query('SELECT id, name FROM products WHERE id = ANY($1) ORDER BY name', [L.info.products])
      : await db.query('SELECT id, name FROM products WHERE active AND archived_at IS NULL ORDER BY name');
    return rows.map((r: any) => ({ id: num(r.id), name: r.name as string }));
  }),

  /** The agency's team, and the sellers each person works for (null: every seller), to choose who works where. */
  'agency.team': proc([], z.object({}), async (ctx) => {
    asAgency(ctx);
    const people = await agencyPeople(ctx.db);
    return people.map((p) => ({ id: p.id, name: p.name, email: p.email, roles: p.roles, sellers: p.sellers }));
  }),

  /**
   * Who works for this seller (people of the agency's team): each one keeps their other sellers and, here, the
   * products the chief gave them; their accounts in the store follow at once.
   */
  'agency.setAgents': proc([], z.object({ id: Id, people: z.array(Id).max(500) }), async (ctx, i) => {
    const { t, id } = asAgency(ctx);
    const L = await agencyLink(t, id, i.id);
    if (L.info.status !== 'pending' && L.info.status !== 'active') throw bad('Ce lien est terminé');
    const store = L.info.store.id;
    const want = new Set(i.people);
    const people = await agencyPeople(ctx.db);
    for (const p of people)
      if (want.has(p.id) && !fits(L.info.kind, p.roles, L.info.tasks))
        throw bad(`${p.name} n’a pas le rôle ${L.info.kind === 'marketer' ? 'Marketer' : L.info.tasks.map((k) => TASK_FR[k]).join(' ou ')} : changez son rôle dans Utilisateurs`);
    if ([...want].some((pid) => !people.some((p) => p.id === pid))) throw bad('Personne introuvable dans votre équipe (ou compte désactivé)');
    // « every seller » becomes the list of the sellers of today, without this one
    const open = (await t.platform.query(`SELECT store_id FROM platform.agency_links WHERE agency_id = $1 AND status IN ('pending', 'active') ORDER BY id`, [id])).map((r: any) => num(r.store_id));
    for (const p of people) {
      const has = workFor(p, store);
      if (want.has(p.id) === !!has) continue;
      const cur: AgencySellerWork[] = p.sellers ?? open.map((s) => ({ store: s, products: null }));
      const next = want.has(p.id) ? [...cur.filter((w) => w.store !== store), { store, products: null }] : cur.filter((w) => w.store !== store);
      await ctx.db.query('UPDATE profiles SET agency_sellers = $2 WHERE id = $1', [p.id, JSON.stringify(next)]);
    }
    return { ok: true, problems: await syncLink(t, L.info.id) };
  }),

  /** Ends a contract: its agents stop now; the orders it had not finished go back to the store's team. */
  'agency.end': proc([], z.object({ id: Id }), async (ctx, i) => {
    const { t, id } = asAgency(ctx);
    await endLink(t, await agencyLink(t, id, i.id), 'agency');
    return { ok: true };
  }),

  /** One store: its numbers and bill for a month, and the payment requests. */
  'agency.link': proc([], z.object({ id: Id, month: Month.optional() }), async (ctx, i) => {
    const { t, id } = asAgency(ctx);
    return linkDetail(t, await agencyLink(t, id, i.id), i.month ?? monthNow(ctx.now()), ctx.now());
  }),

  /** « Demander le paiement » of a month (asked again while not paid: counted again). */
  'agency.billRequest': proc([], z.object({ id: Id, month: Month }), async (ctx, i) => {
    const { t, id } = asAgency(ctx);
    const L = await agencyLink(t, id, i.id);
    if (!L.info.startedAt) throw bad('Ce lien n’a pas encore commencé');
    if (i.month > monthNow(ctx.now())) throw bad('Ce mois n’a pas commencé');
    if (i.month < monthNow(Date.parse(L.info.startedAt))) throw bad('Le contrat n’avait pas commencé ce mois-là');
    const d = await linkDetail(t, L, i.month, ctx.now());
    if (d.bill.total <= 0) throw bad('Rien à demander pour ce mois');
    const cur = (await t.platform.query('SELECT id, status FROM platform.agency_bills WHERE link_id = $1 AND month = $2', [L.info.id, i.month]))[0];
    if (cur && cur.status !== 'requested') throw bad('Ce mois est déjà payé');
    const details = JSON.stringify({ lines: d.bill.lines, counts: d.counts, prices: L.info.prices });
    if (cur) await t.platform.query('UPDATE platform.agency_bills SET amount = $2, details = $3, requested_at = now() WHERE id = $1', [cur.id, d.bill.total, details]);
    else await t.platform.query('INSERT INTO platform.agency_bills (link_id, month, amount, details) VALUES ($1, $2, $3, $4) ON CONFLICT (link_id, month) DO NOTHING', [L.info.id, i.month, d.bill.total, details]);
    return { ok: true, amount: d.bill.total };
  }),

  /** « Argent reçu »: the agency confirms the store's payment. */
  'agency.billReceived': proc([], z.object({ billId: Id }), async (ctx, i) => {
    const { t, id } = asAgency(ctx);
    const b = (await t.platform.query('SELECT b.id FROM platform.agency_bills b JOIN platform.agency_links l ON l.id = b.link_id WHERE b.id = $1 AND l.agency_id = $2', [i.billId, id]))[0];
    if (!b) throw notFound('Demande de paiement introuvable');
    await t.platform.query(`UPDATE platform.agency_bills SET status = 'received', received_at = now(), paid_at = COALESCE(paid_at, now()) WHERE id = $1 AND status <> 'received'`, [i.billId]);
    return { ok: true };
  }),

  // ---------------------------------------------------------------- the store's side (« Partenaires »: agencies, marketers)
  /** The store's code (to give to a partner), its partners (requests, contracts), this month's numbers, its products. */
  'partners.home': proc([], z.object({}), async (ctx) => {
    const { t, id } = asStore(ctx);
    const code = ((await t.platform.query('SELECT public_code FROM platform.shops WHERE id = $1', [id]))[0]?.public_code as string | null) ?? null;
    const links = await withAgents(t, (await t.platform.query(`${LINK_SQL} WHERE l.store_id = $1 ORDER BY l.id DESC`, [id])).map(toLink));
    const m = await monthCounts(t, links, ctx.now());
    const products = await ctx.db.query('SELECT id, name, active FROM products WHERE archived_at IS NULL ORDER BY name');
    return {
      code,
      month: m.month,
      counts: m.counts,
      links: links.map((l) => l.info),
      products: products.map((p: any) => ({ id: num(p.id), name: p.name as string, active: !!p.active })),
    };
  }),

  /** A partner by its code (an agency AG-7K2Q, a marketer MK-7K2Q): its name, whether Pilotix checked it, its prices. */
  'partners.find': proc([], z.object({ code: z.string().trim().min(4).max(20), kind: z.enum(['agency', 'marketer']).optional() }), async (ctx, i) => {
    const { t, id } = asStore(ctx);
    const kind: PartnerKind = i.kind ?? (/^\s*mk/i.test(i.code) ? 'marketer' : 'agency');
    const a = (await t.platform.query(`SELECT id FROM platform.shops WHERE public_code = $1 AND kind = $2 AND status = 'active'`, [cleanCode(i.code, kind), kind]))[0];
    if (!a) throw notFound(kind === 'marketer' ? 'Aucun marketer avec ce code' : 'Aucune agence avec ce code');
    const ag = await agencyRow(t, num(a.id));
    if (!ag.verified) throw bad(`${kind === 'marketer' ? 'Ce marketer n’est pas encore vérifié' : 'Cette agence n’est pas encore vérifiée'} par Pilotix`);
    const open = (await t.platform.query(`SELECT id, status FROM platform.agency_links WHERE agency_id = $1 AND store_id = $2 AND status IN ('pending', 'active')`, [ag.id, id]))[0];
    const prices = ag.prices ?? NO_AGENCY_PRICES;
    return { agency: { id: ag.id, kind: ag.kind, name: ag.name, code: ag.code, prices, priced: hasPrice(prices) }, link: open ? { id: num(open.id), status: open.status as 'pending' | 'active' } : null };
  }),

  /** Asks a partner to work for the store: its usual prices, the tasks (an agency) and products the store gives. */
  'partners.request': proc([], z.object({ agencyId: Id, tasks: Tasks, products: Products }), async (ctx, i) => {
    const { t, id } = asStore(ctx);
    const a = (await t.platform.query(`SELECT id FROM platform.shops WHERE id = $1 AND kind IN ('agency', 'marketer') AND status = 'active'`, [i.agencyId]))[0];
    if (!a) throw notFound('Partenaire introuvable');
    const ag = await agencyRow(t, i.agencyId);
    const who = ag.kind === 'marketer' ? 'Ce marketer' : 'Cette agence';
    if (!ag.verified) throw bad(`${who} n’est pas encore ${ag.kind === 'marketer' ? 'vérifié' : 'vérifiée'} par Pilotix`);
    if (!ag.prices || !hasPrice(ag.prices)) throw bad(`${who} n’a pas encore écrit ses prix`);
    const tasks = tasksFor(ag.kind, i.tasks);
    const products = await checkProducts(ctx.db, i.products);
    const why = await clash(t, ctx.db, id, 0, tasks, products, ag.kind);
    if (why) throw bad(why);
    try {
      const r = (
        await t.platform.query(
          `INSERT INTO platform.agency_links (agency_id, store_id, requested_by, requester, tasks, prices, products) VALUES ($1, $2, 'store', $3, $4, $5, $6) RETURNING id`,
          [i.agencyId, id, requesterOf(ctx), JSON.stringify(tasks), JSON.stringify(ag.prices), products === null ? null : JSON.stringify(products)],
        )
      )[0];
      return { id: num(r.id) };
    } catch (e: any) {
      if (String(e?.code) === '23505' || /unique|duplicate/i.test(String(e?.message))) throw bad(`Une demande ou un contrat existe déjà avec ${partnerFr(ag.kind)}`);
      throw e;
    }
  }),

  /** Yes (with the tasks and products the store gives) or no to an agency's request. */
  'partners.answer': proc([], z.object({ id: Id, accept: z.boolean(), tasks: Tasks.optional(), products: Products.optional() }), async (ctx, i) => {
    const { t, id } = asStore(ctx);
    const L = await storeLink(t, id, i.id);
    if (L.info.status !== 'pending' || L.info.requestedBy !== 'agency') throw bad('Cette demande n’attend plus votre réponse');
    if (!i.accept) {
      await setStatus(t, L.info.id, 'pending', 'refused');
      return { ok: true, problems: [] as string[] };
    }
    if (!L.agencyOk) throw bad(L.info.kind === 'marketer' ? 'Ce marketer ne peut pas travailler pour le moment' : 'Cette agence ne peut pas travailler pour le moment');
    const tasks = tasksFor(L.info.kind, i.tasks ?? L.info.tasks);
    const products = await checkProducts(ctx.db, i.products === undefined ? null : i.products);
    const why = await clash(t, ctx.db, id, L.info.id, tasks, products, L.info.kind);
    if (why) throw bad(why);
    await t.platform.query('UPDATE platform.agency_links SET tasks = $2, products = $3 WHERE id = $1 AND status = $4', [L.info.id, JSON.stringify(tasks), products === null ? null : JSON.stringify(products), 'pending']);
    if (!(await setStatus(t, L.info.id, 'pending', 'active', ', started_at = now()'))) throw bad('Cette demande n’attend plus votre réponse');
    return { ok: true, problems: await syncLink(t, L.info.id) };
  }),

  /** Takes back the store's own request. */
  'partners.cancel': proc([], z.object({ id: Id }), async (ctx, i) => {
    const { t, id } = asStore(ctx);
    const L = await storeLink(t, id, i.id);
    if (L.info.requestedBy !== 'store' || !(await setStatus(t, L.info.id, 'pending', 'cancelled'))) throw bad('Cette demande n’est plus en attente');
    return { ok: true };
  }),

  /** What the store gives the agency (tasks, products): new orders follow at once. */
  'partners.setWork': proc([], z.object({ id: Id, tasks: Tasks, products: Products }), async (ctx, i) => {
    const { t, id } = asStore(ctx);
    const L = await storeLink(t, id, i.id);
    const editable = L.info.status === 'active' || (L.info.status === 'pending' && L.info.requestedBy === 'store');
    if (!editable) throw bad('Ce lien ne change plus');
    const tasks = tasksFor(L.info.kind, i.tasks);
    const products = await checkProducts(ctx.db, i.products);
    const why = await clash(t, ctx.db, id, L.info.id, tasks, products, L.info.kind);
    if (why) throw bad(why);
    await t.platform.query('UPDATE platform.agency_links SET tasks = $2, products = $3 WHERE id = $1', [L.info.id, JSON.stringify(tasks), products === null ? null : JSON.stringify(products)]);
    return { ok: true, problems: L.info.status === 'active' ? await syncLink(t, L.info.id) : [] };
  }),

  /** Yes to the agency's new prices (no: the old prices stay; the store can also end the contract). */
  'partners.acceptPrices': proc([], z.object({ id: Id }), async (ctx, i) => {
    const { t, id } = asStore(ctx);
    const L = await storeLink(t, id, i.id);
    if (L.info.status !== 'active' || !L.info.pricesNew) throw bad('Pas de nouveaux prix à accepter');
    await t.platform.query('UPDATE platform.agency_links SET prices = prices_new, prices_new = NULL WHERE id = $1 AND prices_new IS NOT NULL', [L.info.id]);
    return { ok: true };
  }),

  /** Ends a contract: the agency's agents stop now; its unfinished orders come back to the store's team. */
  'partners.end': proc([], z.object({ id: Id }), async (ctx, i) => {
    const { t, id } = asStore(ctx);
    await endLink(t, await storeLink(t, id, i.id), 'store');
    return { ok: true };
  }),

  /** One agency: its numbers and bill for a month, and its payment requests. */
  'partners.link': proc([], z.object({ id: Id, month: Month.optional() }), async (ctx, i) => {
    const { t, id } = asStore(ctx);
    return linkDetail(t, await storeLink(t, id, i.id), i.month ?? monthNow(ctx.now()), ctx.now());
  }),

  /** « Payé »: the store paid the agency (outside Pilotix). */
  'partners.billPaid': proc([], z.object({ billId: Id }), async (ctx, i) => {
    const { t, id } = asStore(ctx);
    const b = (await t.platform.query('SELECT b.id, b.status FROM platform.agency_bills b JOIN platform.agency_links l ON l.id = b.link_id WHERE b.id = $1 AND l.store_id = $2', [i.billId, id]))[0];
    if (!b) throw notFound('Demande de paiement introuvable');
    if (b.status !== 'requested') return { ok: true };
    await t.platform.query(`UPDATE platform.agency_bills SET status = 'paid', paid_at = now() WHERE id = $1 AND status = 'requested'`, [i.billId]);
    return { ok: true };
  }),
};

