// « Pilot Auto Assign » (Sociétés de livraison): who delivers each order.
//  - « Manuel »: the team chooses. With « la société par défaut compte » (Préférences) a new order gets the shop's
//    default company; otherwise it waits in « À attribuer » for a manager.
//  - « Pilot Auto Assign »: the seller's rules choose (shared/pilot.ts). A rule whose company does not deliver there
//    (switched off, no price for that wilaya at home / at a bureau; our livreurs: home only) is skipped and the next
//    rules decide. No rule: the default company, if it delivers there. Otherwise — or a clash the seller sent to
//    « À attribuer » — no company: a person chooses.
//  - A chosen bureau decides the company. Pilot runs when the order arrives, and again when its wilaya, commune,
//    bureau or products change, until its products are picked — never on an order a person gave a company.
//  - Saving rules: every clash between two strict (or two soft) rules needs the seller's answer; « Déplacer les N
//    commandes en attente aussi ? » (orders sent, given by hand, or waiting for a person never move).
//  - « Livraison privée » orders that wait in « À attribuer » longer than the Préférences time go to the backup
//    company, when it delivers there; otherwise they stay and the managers are told.
//  - Who changes an order's company by hand: Préférences (agents, agency agents, depot, managers; admins always); with
//    « Règles strictes verrouillées », an order placed by a strict rule only managers and admins.
//  - Who writes the rules: admins, and the kinds of people ticked in Préférences (« Qui peut changer les règles Pilot »).
import { ALL_WILAYAS, clashesOf, type Clash, personIs, pickRule, type PilotBy, type PilotConfig, type PilotRule, ruleNumber, WILAYAS } from '@pilotix/shared';
import { z } from 'zod';
import { Db, num, numOrNull } from '../db';
import { bad, Ctx, forbidden, proc } from '../rpc';
import { getSetting, setSetting } from '../settings';
import { serves } from './confirmcheck';
import { asDepot, dispatchOrders, READY_SQL } from './dispatch';
import { managers } from './livreur';
import { addEvent } from './orders';
import { getPrefs, type Prefs } from './prefs';
import { sendPush } from './push';

export interface Pick {
  companyId: number | null;
  by: PilotBy;
  rule: string | null;
  /** why it waits for a person: 'conflict:2,4' | 'nobody' | 'manual' */
  why: string | null;
}
export interface PickInput {
  wilayaId: number | null;
  commune: string | null;
  isStopdesk: boolean;
  stopdeskId: number | null;
  productIds: number[];
}
/** What several picks in a row share (the rules, the default company, which company delivers where). */
export interface PickCache {
  cfg?: PilotConfig;
  def?: number | null;
  prefs?: Prefs;
  take?: Map<string, boolean>;
  kinds?: Map<number, { kind: string; active: boolean } | null>;
}

export async function pilotConfig(db: Db): Promise<PilotConfig> {
  const c = await getSetting(db, 'pilot');
  return { mode: c?.mode === 'auto' ? 'auto' : 'manual', rules: Array.isArray(c?.rules) ? c.rules : [], clashes: Array.isArray(c?.clashes) ? c.clashes : [] };
}

/** Can this company take this order? Switched on, a price there (home / bureau), our livreurs at home only. */
async function canTake(db: Db, companyId: number, o: { wilayaId: number; isStopdesk: boolean }, cache: PickCache): Promise<boolean> {
  const take = (cache.take ??= new Map());
  const key = `${companyId}:${o.wilayaId}:${o.isStopdesk ? 1 : 0}`;
  if (take.has(key)) return take.get(key)!;
  const kinds = (cache.kinds ??= new Map());
  if (!kinds.has(companyId)) {
    const c = (await db.query('SELECT kind, active FROM delivery_companies WHERE id = $1', [companyId]))[0];
    kinds.set(companyId, c ? { kind: String(c.kind), active: !!c.active } : null);
  }
  const c = kinds.get(companyId);
  const ok = !!c && c.active && !(o.isStopdesk && c.kind === 'own') && (await serves(db, companyId, o.wilayaId, o.isStopdesk)).ok;
  take.set(key, ok);
  return ok;
}

/** Who delivers this order, and why. */
export async function pilotPick(db: Db, o: PickInput, cache: PickCache = {}): Promise<Pick> {
  if (o.isStopdesk && o.stopdeskId) {
    const d = (await db.query('SELECT company_id FROM stopdesks WHERE id = $1', [o.stopdeskId]))[0];
    if (d) return { companyId: num(d.company_id), by: 'bureau', rule: null, why: null };
  }
  if (cache.def === undefined) cache.def = (await getSetting(db, 'shop')).defaultCompanyId ?? null;
  const def = cache.def;
  const cfg = (cache.cfg ??= await pilotConfig(db));
  if (cfg.mode !== 'auto') {
    const p = (cache.prefs ??= await getPrefs(db));
    if (p.manualDefault && def) return { companyId: def, by: 'default', rule: null, why: null };
    return { companyId: null, by: 'none', rule: null, why: 'manual' };
  }
  // the place is not known yet (an order to complete): the default company for now, Pilot runs again then
  if (!o.wilayaId) return def ? { companyId: def, by: 'default', rule: null, why: null } : { companyId: null, by: 'none', rule: null, why: 'nobody' };
  const place = { wilayaId: o.wilayaId, isStopdesk: o.isStopdesk };
  const usable = new Set<number>();
  for (const to of new Set(cfg.rules.filter((r) => r.on).map((r) => r.to))) if (await canTake(db, to, place, cache)) usable.add(to);
  const res = pickRule(cfg, { wilayaId: o.wilayaId, commune: o.commune, productIds: o.productIds }, (r) => usable.has(r.to));
  if ('rule' in res) return { companyId: res.rule.to, by: res.rule.strict ? 'strict' : 'rule', rule: res.rule.id, why: null };
  if ('conflict' in res) return { companyId: null, by: 'none', rule: null, why: `conflict:${ruleNumber(cfg.rules, res.conflict[0])},${ruleNumber(cfg.rules, res.conflict[1])}` };
  if (def && (await canTake(db, def, place, cache))) return { companyId: def, by: 'default', rule: null, why: null };
  return { companyId: null, by: 'none', rule: null, why: 'nobody' };
}

/** A person gave this order its company (the rules leave it alone): Pilot's own mark, or, before Pilot, a person's history. */
export async function givenByHand(db: Db, orderId: number, pilotBy: string | null): Promise<boolean> {
  if (pilotBy) return pilotBy === 'hand';
  return !!(await db.query(`SELECT 1 FROM order_events WHERE order_id = $1 AND kind = 'company' AND user_id IS NOT NULL LIMIT 1`, [orderId]))[0];
}

/** Pilot may still choose for this order: not picked yet, not at a courier, not given by hand. */
export async function pilotMayRun(db: Db, cur: any): Promise<boolean> {
  if (cur.follow_status && cur.follow_status !== 'to_prepare') return false;
  if (cur.tracking || cur.shipped_at) return false;
  return !(await givenByHand(db, num(cur.id), cur.pilot_by ?? null));
}

/** Writes Pilot's choice on an order; a new company forgets the livreur and goes in the order's history. */
export async function setPick(db: Db, cur: { id: number | string; company_id: unknown }, pick: Pick, userId: number | null, note: string | null = null) {
  const was = numOrNull(cur.company_id);
  const changed = was !== pick.companyId;
  await db.query(
    `UPDATE orders SET company_id = $2, livreur_id = CASE WHEN $3 THEN NULL ELSE livreur_id END, pilot_by = $4, pilot_rule = $5, pilot_why = $6, updated_at = now() WHERE id = $1`,
    [cur.id, pick.companyId, changed, pick.by, pick.rule, pick.why],
  );
  if (changed) await addEvent(db, num(cur.id), userId, 'company', was ? String(was) : null, pick.companyId ? String(pick.companyId) : null, note);
}

/**
 * May this person change this order's company by hand? null: yes; otherwise why not. Choosing a company for an order
 * that has none is not a change.
 */
export async function companyLock(ctx: Ctx, db: Db, cur: { company_id: unknown; pilot_by?: string | null }): Promise<string | null> {
  if (ctx.session.isAdmin || !numOrNull(cur.company_id)) return null;
  const p = await getPrefs(db);
  const manager = p.changeCompany.manager && personIs(ctx.session, { confirmation: false, agency: false, depot: false, manager: true });
  if (p.strictLock && cur.pilot_by === 'strict')
    return manager ? null : 'Société choisie par une règle stricte de Pilot : seuls les managers et les admins la changent.';
  const ok = ctx.session.roles.includes('suivi') || personIs(ctx.session, p.changeCompany);
  return ok ? null : 'Vous ne pouvez pas changer la société de livraison de cette commande (Préférences).';
}

// ---------------------------------------------------------------- rules: checks, waiting orders
/** Admins, and the kinds of people ticked in Préférences (« Qui peut changer les règles Pilot »). */
export async function canRules(ctx: Ctx): Promise<boolean> {
  return ctx.session.isAdmin || personIs(ctx.session, (await getPrefs(ctx.db)).rulesBy);
}
const needRules = async (ctx: Ctx) => {
  if (!(await canRules(ctx))) throw forbidden('Seuls les admins et les personnes choisies dans Préférences changent les règles de Pilot');
};

const RuleIn = z.object({
  id: z.string().regex(/^r\d{1,6}$/),
  wilayas: z.array(z.number().int().min(1).max(69)).max(69),
  except: z.boolean(),
  communes: z.array(z.object({ w: z.number().int().min(1).max(69), c: z.string().trim().min(1).max(80) })).max(400),
  products: z.array(z.number().int().positive()).max(500),
  to: z.number().int().positive(),
  strict: z.boolean(),
  on: z.boolean(),
});
const ConfigIn = z.object({
  mode: z.enum(['auto', 'manual']),
  rules: z.array(RuleIn).max(100),
  clashes: z.array(z.object({ a: z.string().max(10), b: z.string().max(10), win: z.string().max(10) })).max(5000),
});

/** The rules as saved: one id each, an existing company, communes inside the rule's wilayas. */
async function cleanConfig(db: Db, i: z.infer<typeof ConfigIn>): Promise<PilotConfig> {
  const ids = new Set<string>();
  const cos = new Map((await db.query('SELECT id, name, active FROM delivery_companies')).map((c: any) => [num(c.id), { name: String(c.name), active: !!c.active }]));
  const rules: PilotRule[] = i.rules.map((r, k) => {
    if (ids.has(r.id)) throw bad(`Règle ${k + 1} : identifiant en double`);
    ids.add(r.id);
    if (!cos.has(r.to)) throw bad(`Règle ${k + 1} : société de livraison introuvable`);
    const wilayas = [...new Set(r.wilayas)].sort((a, b) => a - b);
    if (r.except && !wilayas.length) throw bad(`Règle ${k + 1} : « Toutes sauf… » sans wilaya à enlever`);
    const communes = r.except ? [] : r.communes.filter((c) => wilayas.includes(c.w));
    return { id: r.id, wilayas, except: r.except, communes, products: [...new Set(r.products)], to: r.to, strict: r.strict, on: r.on };
  });
  return { mode: i.mode, rules, clashes: i.clashes };
}

/** The clashes of these rules, each with the seller's answer (only answers that still mean something are kept). */
function withAnswers(cfg: PilotConfig): { clashes: Clash[]; keep: PilotConfig['clashes'] } {
  const clashes = clashesOf(cfg);
  const keep = clashes.filter((c) => c.kind === 'ask' && c.win).map((c) => ({ a: c.a, b: c.b, win: c.win! }));
  return { clashes, keep };
}

/**
 * Orders still waiting (not picked, not sent, not given by hand, with a company) that the new rules send elsewhere than
 * the rules before did — the change of rules moves them, nothing else.
 */
async function waitingMoves(db: Db, prev: PilotConfig, cfg: PilotConfig, limit = 5000) {
  if (cfg.mode !== 'auto') return [];
  const rows = await db.query(
    `SELECT o.id, o.ref, o.company_id, o.wilaya_id, o.commune, o.is_stopdesk, o.stopdesk_id, o.pilot_by,
            ARRAY(SELECT i.product_id FROM order_items i WHERE i.order_id = o.id AND i.product_id IS NOT NULL) AS pids
       FROM orders o
      WHERE (o.follow_status IS NULL OR o.follow_status = 'to_prepare') AND o.conf_status NOT IN ('cancelled', 'duplicate', 'wrong_number', 'fake')
        AND o.tracking IS NULL AND o.shipped_at IS NULL AND NOT o.is_exchange AND o.company_id IS NOT NULL
        AND NOT (o.is_stopdesk AND o.stopdesk_id IS NOT NULL)
        AND o.pilot_by IS DISTINCT FROM 'hand'
        AND NOT (o.pilot_by IS NULL AND EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.kind = 'company' AND e.user_id IS NOT NULL))
      ORDER BY o.id LIMIT $1`,
    [limit],
  );
  const take = new Map<string, boolean>();
  const kinds = new Map();
  const before: PickCache = { cfg: prev, take, kinds };
  const after: PickCache = { cfg, take, kinds };
  const out: { id: number; ref: string; from: number; pick: Pick }[] = [];
  for (const r of rows) {
    const o = { wilayaId: numOrNull(r.wilaya_id), commune: r.commune ?? null, isStopdesk: !!r.is_stopdesk, stopdeskId: numOrNull(r.stopdesk_id), productIds: (r.pids ?? []).map(Number) };
    const pick = await pilotPick(db, o, after);
    if (!pick.companyId || pick.companyId === num(r.company_id)) continue;
    if ((await pilotPick(db, o, before)).companyId === pick.companyId) continue;
    out.push({ id: num(r.id), ref: String(r.ref), from: num(r.company_id), pick });
  }
  return out;
}

// ---------------------------------------------------------------- « Livraison privée » waiting too long
/**
 * « Livraison privée » orders waiting in « À attribuer » longer than the Préférences time: to the backup company (then
 * to « En dispatch », the parcel created there), when it delivers there; otherwise they stay and the managers are told
 * (once per order).
 */
export async function privateBackupRun(ctx: Ctx): Promise<{ moved: number; stuck: number }> {
  const p = await getPrefs(ctx.db);
  const b = p.privateBackup;
  if (!b.on || !b.companyId) return { moved: 0, stuck: 0 };
  const since = new Date(ctx.now() - b.hours * 3_600_000).toISOString();
  const rows = await ctx.db.query(
    `SELECT o.id, o.ref, o.company_id, o.wilaya_id, o.is_stopdesk FROM orders o JOIN delivery_companies c ON c.id = o.company_id
      WHERE ${READY_SQL} AND c.kind = 'own' AND o.livreur_id IS NULL AND COALESCE(o.assign_wait_since, o.confirmed_at, o.created_at) <= $1::timestamptz
      ORDER BY o.id LIMIT 500`,
    [since],
  );
  const cache: PickCache = {};
  const go: any[] = [];
  const stuck: any[] = [];
  for (const r of rows) ((await canTake(ctx.db, b.companyId, { wilayaId: num(r.wilaya_id), isStopdesk: !!r.is_stopdesk }, cache)) ? go : stuck).push(r);
  const goIds = go.map((r) => num(r.id));
  for (const r of go) await setPick(ctx.db, r, { companyId: b.companyId, by: 'backup', rule: null, why: null }, null, `Livraison privée : plus de ${b.hours} h sans livreur, partie chez la société de secours`);
  if (goIds.length) await dispatchOrders(asDepot(ctx), goIds);
  // the backup company does not deliver there: the managers are told, once per order
  const told = 'Société de secours : elle ne livre pas ici, choisissez un livreur';
  const fresh: any[] = [];
  for (const r of stuck)
    if (!(await ctx.db.query(`SELECT 1 FROM order_events WHERE order_id = $1 AND kind = 'note' AND note = $2 LIMIT 1`, [r.id, told]))[0]) {
      fresh.push(r);
      await addEvent(ctx.db, num(r.id), null, 'note', null, 'event', told);
    }
  if (fresh.length)
    await sendPush(ctx, await managers(ctx.db), {
      title: fresh.length > 1 ? `${fresh.length} commandes privées attendent un livreur` : `${fresh[0].ref} attend un livreur`,
      body: `Plus de ${b.hours} h dans « À attribuer », et la société de secours ne livre pas là-bas.`,
      tag: 'private-backup',
      url: '#/depot/preparer',
    });
  if (goIds.length) ctx.emit({ type: 'orders' });
  return { moved: goIds.length, stuck: stuck.length };
}

// ---------------------------------------------------------------- procs
const wName = (id: number) => `${String(id).padStart(2, '0')} ${WILAYAS[id - 1] ?? ''}`.trim();

export const pilotProcs = {
  /** The mode, the rules and their clashes, the companies (where each delivers at home), the products, the default. */
  'pilot.get': proc(null, z.object({}), async (ctx) => {
    const cfg = await pilotConfig(ctx.db);
    const companies = await ctx.db.query(
      `SELECT c.id, c.name, c.kind, c.active,
              (SELECT count(*)::int FROM delivery_fees f WHERE f.company_id = c.id) AS n,
              ARRAY(SELECT f.wilaya_id FROM delivery_fees f WHERE f.company_id = c.id AND f.home > 0 ORDER BY f.wilaya_id) AS home
         FROM delivery_companies c ORDER BY c.active DESC, c.id`,
    );
    const products = await ctx.db.query(`SELECT id, name FROM products WHERE active AND NOT is_service ORDER BY name LIMIT 2000`);
    return {
      ...cfg,
      clashes: cfg.clashes,
      found: clashesOf(cfg),
      canEdit: await canRules(ctx),
      defaultCompanyId: (await getSetting(ctx.db, 'shop')).defaultCompanyId ?? null,
      companies: companies.map((c: any) => {
        const free = c.kind === 'own' || c.kind === 'manual' || num(c.n) === 0;
        return { id: num(c.id), name: String(c.name), kind: String(c.kind), active: !!c.active, own: c.kind === 'own', serves: free ? ALL_WILAYAS : (c.home ?? []).map(Number) };
      }),
      products: products.map((p: any) => ({ id: num(p.id), name: String(p.name) })),
    };
  }),

  /** Before saving: the clashes (with the answers given), and the waiting orders the new rules would move. */
  'pilot.preview': proc(null, ConfigIn, async (ctx, i) => {
    await needRules(ctx);
    const cfg = await cleanConfig(ctx.db, i);
    const { clashes, keep } = withAnswers(cfg);
    const moves = await waitingMoves(ctx.db, await pilotConfig(ctx.db), { ...cfg, clashes: keep });
    const names = new Map((await ctx.db.query('SELECT id, name FROM delivery_companies')).map((c: any) => [num(c.id), String(c.name)]));
    return {
      clashes,
      waiting: moves.length,
      sample: moves.slice(0, 5).map((m) => ({ id: m.id, ref: m.ref, from: names.get(m.from) ?? '', to: names.get(m.pick.companyId!) ?? '' })),
    };
  }),

  /** Save the mode and the rules (every clash answered); `move`: the waiting orders follow the new rules too. */
  'pilot.save': proc(null, ConfigIn.extend({ move: z.boolean().default(false), defaultCompanyId: z.number().int().positive().nullable().optional() }), async (ctx, i) => {
    await needRules(ctx);
    const cfg = await cleanConfig(ctx.db, i);
    const { clashes, keep } = withAnswers(cfg);
    const open = clashes.find((c) => c.kind === 'ask' && !c.win);
    if (open) throw bad(`Les règles ${ruleNumber(cfg.rules, open.a)} et ${ruleNumber(cfg.rules, open.b)} se contredisent : choisissez qui gagne, ou « À attribuer ».`);
    const prev = await pilotConfig(ctx.db);
    if (i.defaultCompanyId !== undefined) {
      if (i.defaultCompanyId && !(await ctx.db.query('SELECT 1 FROM delivery_companies WHERE id = $1', [i.defaultCompanyId]))[0]) throw bad('Société par défaut introuvable');
      const shop = await getSetting(ctx.db, 'shop');
      await setSetting(ctx.db, 'shop', { ...shop, defaultCompanyId: i.defaultCompanyId }, ctx.session.profile.id);
    }
    await setSetting(ctx.db, 'pilot', { mode: cfg.mode, rules: cfg.rules, clashes: keep }, ctx.session.profile.id);
    let moved = 0;
    if (i.move) {
      const saved = { ...cfg, clashes: keep };
      for (const m of await waitingMoves(ctx.db, prev, saved)) {
        await setPick(ctx.db, { id: m.id, company_id: m.from }, m.pick, ctx.session.profile.id, `Pilot : nouvelles règles${m.pick.rule ? ` (règle ${ruleNumber(saved.rules, m.pick.rule)})` : ''}`);
        moved++;
      }
      if (moved) ctx.emit({ type: 'orders' });
    }
    return { ok: true, moved };
  }),

  /** « Tester une commande »: who would deliver it, and why — with the rules on screen (saved or not). */
  'pilot.test': proc(
    null,
    ConfigIn.extend({
      wilayaId: z.number().int().min(1).max(69),
      commune: z.string().max(80).nullable(),
      isStopdesk: z.boolean().default(false),
      productIds: z.array(z.number().int().positive()).max(20),
      /** the default company on screen (saved or not) */
      defaultCompanyId: z.number().int().positive().nullable().optional(),
    }),
    async (ctx, i) => {
      const cfg = await cleanConfig(ctx.db, i);
      const cache: PickCache = { cfg: { ...cfg, clashes: withAnswers(cfg).keep } };
      if (i.defaultCompanyId !== undefined) cache.def = i.defaultCompanyId;
      const pick = await pilotPick(ctx.db, { wilayaId: i.wilayaId, commune: i.commune, isStopdesk: i.isStopdesk, stopdeskId: null, productIds: i.productIds }, cache);
      const name = pick.companyId ? ((await ctx.db.query('SELECT name FROM delivery_companies WHERE id = $1', [pick.companyId]))[0]?.name ?? null) : null;
      return { ...pick, companyName: name as string | null, ruleNo: pick.rule ? ruleNumber(cfg.rules, pick.rule) : null, place: wName(i.wilayaId) };
    },
  ),

  /** The scheduled run: « Livraison privée » orders waiting too long go to the backup company. */
  'pilot.run': proc([], z.object({}), (ctx) => privateBackupRun(ctx)),
};

