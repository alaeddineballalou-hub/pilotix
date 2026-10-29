// The control room's actions (Pilotix staff only): shops, trials, payments, plans and their menus, staff, settings,
// the journal, sign-ups, messages from stores and the demo shop. Same shape as the shops' actions (input checked, roles
// checked), own registry. Pilotix never sees what is inside a store: only its numbers (accounts, livreurs, orders).
import { DEMO_ACCOUNTS, FEATURE_KEYS } from '@pilotix/shared';
import bcrypt from 'bcryptjs';
import { z, ZodTypeAny } from 'zod';
import { isoOrNull, num, numOrNull } from '../db';
import { AppError, bad, forbidden, notFound } from '../rpc';
import { hashPassword } from '../modules/users';
import { courierCatalog } from '../couriers/catalog';
import { clearCourierTestKeys, courierTestState, saveCourierTestKeys } from './courierTests';
import { addWatchItems, courierUsage, removeCourier, removedCouriers, removeWatchItem, restoreCourier, setWatchStatus, watchState } from './courierWatch';
import { protectionStats } from './reputation';
import { syncAgency } from '../modules/agencies';
import { accountById, makeAccountToken, sha256Hex } from './accounts';
import { rewardReferrer, ReferralReward } from './reminders';
import { staffReply, staffSetStatus, staffThread, staffThreads, staffUnread } from './support';
import {
  cleanFeatures,
  freeSlug,
  loadPlans,
  loadShop,
  loadShops,
  makePassword,
  platformSettings,
  PlatformSettings,
  provisionShop,
  resetDemoShop,
  setPlatformSetting,
  setShopStore,
  Shop,
  shopFeatures,
  shopMaxDrivers,
  shopMaxOrders,
  shopMaxUsers,
  shopStatus,
  shopUsage,
  ShopUsage,
  slugify,
  slugOk,
  NAME_RESERVED,
  SYSTEM_PLAN,
  toPlan,
} from './shops';
import type { Tenancy } from './tenancy';
import * as pilot from '../modules/pilotlearn';
import { pilotConfig, savePilotConfig } from './pilotai';
import { AI_FEATURES, aiBill, aiUsageOfMonth, aiUsageSince, monthOf, saveAiBill } from './aiusage';

export const STAFF_ROLES = ['owner', 'manager', 'support'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
export interface StaffSession {
  id: number;
  name: string;
  email: string;
  role: StaffRole;
}

export interface PCtx {
  t: Tenancy;
  staff: StaffSession;
  now: () => number;
}

export interface PProcedure<S extends ZodTypeAny = ZodTypeAny, R = unknown> {
  /** who may run it (the owner always may) */
  roles: StaffRole[];
  input: S;
  run: (ctx: PCtx, input: z.infer<S>) => Promise<R>;
}
const pproc = <S extends ZodTypeAny, R>(roles: StaffRole[], input: S, run: (ctx: PCtx, input: z.infer<S>) => Promise<R>): PProcedure<S, R> => ({ roles, input, run });

const ALL: StaffRole[] = ['owner', 'manager', 'support'];
const MANAGERS: StaffRole[] = ['owner', 'manager'];
const OWNER: StaffRole[] = ['owner'];

export const PAYMENT_METHODS = ['baridimob', 'ccp', 'cash', 'virement', 'autre'] as const;

// ---------------------------------------------------------------- staff login
const toStaff = (r: any): StaffSession => ({ id: num(r.id), name: r.name, email: r.email, role: r.role });
let dummy: Promise<string> | null = null;

/** Pilotix staff login: e-mail + password → the staff session and its token version. */
export async function staffLogin(t: Tenancy, email: string, password: string): Promise<{ staff: StaffSession; tv: number }> {
  const r = (await t.platform.query('SELECT * FROM platform.staff WHERE email = $1', [email.trim().toLowerCase()]))[0];
  const ok = r ? await bcrypt.compare(password, r.password_hash) : await bcrypt.compare(password, await (dummy ??= bcrypt.hash('not-a-real-password', 12)));
  if (!r || !ok) throw new AppError('unauthorized', 'Email ou mot de passe incorrect');
  if (!r.active) throw new AppError('unauthorized', 'Votre compte est désactivé');
  await t.platform.query('UPDATE platform.staff SET last_login_at = now() WHERE id = $1', [r.id]);
  return { staff: toStaff(r), tv: num(r.token_version) };
}

/** The control room's two-step login: a 6-digit code e-mailed at each login (10 minutes, 5 tries, once). */
export async function makeStaffCode(t: Tenancy, staffId: number, now = Date.now()): Promise<string> {
  const r = globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  const code = String(r).padStart(6, '0');
  await t.platform.query('UPDATE platform.staff_codes SET used_at = $2::timestamptz WHERE staff_id = $1 AND used_at IS NULL', [staffId, new Date(now).toISOString()]);
  await t.platform.query('INSERT INTO platform.staff_codes (staff_id, code_hash, created_at, expires_at) VALUES ($1, $2, $3::timestamptz, $4::timestamptz)', [
    staffId,
    await sha256Hex(`${staffId}:${code}`),
    new Date(now).toISOString(),
    new Date(now + 10 * 60_000).toISOString(),
  ]);
  return code;
}
export async function checkStaffCode(t: Tenancy, staffId: number, code: string, now = Date.now()): Promise<boolean> {
  const r = (
    await t.platform.query('SELECT id, code_hash, attempts FROM platform.staff_codes WHERE staff_id = $1 AND used_at IS NULL AND expires_at > $2::timestamptz ORDER BY id DESC LIMIT 1', [
      staffId,
      new Date(now).toISOString(),
    ])
  )[0];
  if (!r) return false;
  if (num(r.attempts) >= 5) return false;
  if (r.code_hash !== (await sha256Hex(`${staffId}:${String(code).trim()}`))) {
    await t.platform.query('UPDATE platform.staff_codes SET attempts = attempts + 1 WHERE id = $1', [r.id]);
    return false;
  }
  await t.platform.query('UPDATE platform.staff_codes SET used_at = $2::timestamptz WHERE id = $1', [r.id, new Date(now).toISOString()]);
  return true;
}

/** The staff member of a token, if still active with the same token version. */
export async function staffById(t: Tenancy, id: number, tv: number): Promise<StaffSession | null> {
  const r = (await t.platform.query('SELECT * FROM platform.staff WHERE id = $1', [id]))[0];
  return r && r.active && num(r.token_version) === tv ? toStaff(r) : null;
}

/** Is this e-mail also a Pilotix staff account? (the shop menu then shows the way to the control room) */
export async function isStaffEmail(t: Tenancy, email: string): Promise<boolean> {
  return (await t.platform.query('SELECT 1 FROM platform.staff WHERE email = $1 AND active', [email.trim().toLowerCase()])).length > 0;
}

// ---------------------------------------------------------------- helpers
/** Writes one line of the control room's journal. */
export async function recordAudit(t: Tenancy, staff: StaffSession, action: string, shopId: number | null, details: Record<string, unknown> = {}) {
  await t.platform.query('INSERT INTO platform.audit (staff_id, staff_name, shop_id, action, details) VALUES ($1,$2,$3,$4,$5)', [staff.id, staff.name, shopId, action, JSON.stringify(details)]);
}
const audit = (ctx: PCtx, action: string, shopId: number | null, details: Record<string, unknown> = {}) => recordAudit(ctx.t, ctx.staff, action, shopId, details);

async function needShop(ctx: PCtx, id: number): Promise<Shop> {
  const s = await loadShop(ctx.t, { id });
  if (!s) throw notFound('Boutique introuvable');
  return s;
}

const usageCache = new WeakMap<Tenancy, Map<number, { at: number; v: ShopUsage }>>();
/** A store's numbers (kept a minute: the list asks for every store). */
async function usage(ctx: PCtx, s: Shop, fresh = false): Promise<ShopUsage> {
  let m = usageCache.get(ctx.t);
  if (!m) usageCache.set(ctx.t, (m = new Map()));
  const hit = m.get(s.id);
  if (!fresh && hit && ctx.now() - hit.at < 60_000) return hit.v;
  const v = await shopUsage(ctx.t, s).catch(() => ({ users: 0, drivers: 0, ordersMonth: 0, ordersLastMonth: 0, ordersTotal: 0, ownerStores: 0 }));
  m.set(s.id, { at: ctx.now(), v });
  return v;
}

/** The store's limits and whether it is over one (its numbers against its plan). */
function limitsOf(s: Shop, u: ShopUsage) {
  const maxUsers = shopMaxUsers(s);
  const maxDrivers = shopMaxDrivers(s);
  const maxOrders = shopMaxOrders(s);
  return {
    maxUsers,
    maxDrivers,
    maxOrdersMonth: maxOrders,
    over: {
      users: maxUsers !== null && u.users > maxUsers,
      drivers: maxDrivers !== null && u.drivers > maxDrivers,
      orders: maxOrders !== null && u.ordersMonth > maxOrders,
    },
  };
}

const stateOf = (s: Shop, set: PlatformSettings, now: number) => shopStatus(s, now, set.trial.graceDays);

function shopRow(s: Shop, set: PlatformSettings, now: number) {
  const st = stateOf(s, set, now);
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    primary: s.primary,
    demo: s.demo,
    status: s.status,
    statusReason: s.statusReason,
    state: st.state,
    daysLeft: st.daysLeft,
    locked: st.locked,
    plan: s.plan ? { id: s.plan.id, name: s.plan.name, code: s.plan.code, priceMonth: s.plan.priceMonth, system: s.plan.system } : null,
    trialEndsAt: s.trialEndsAt,
    paidUntil: s.paidUntil,
    neverExpires: s.neverExpires,
    createdAt: s.createdAt,
    lastActiveAt: s.lastActiveAt,
    owner: { name: s.ownerName, email: s.ownerEmail, phone: s.ownerPhone },
    city: s.city,
    changes: s.featuresOn.length + s.featuresOff.length,
    selfSignup: s.selfSignup,
    deletedAt: s.deletedAt,
    /** its own domain for its landing pages */
    domain: s.domain ? { name: s.domain, status: s.domainStatus } : null,
  };
}

const IsoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'date invalide');

/**
 * An e-mail the server sends after an action (the control room never sees its link): the owner's invitation (choose a
 * password), « a store was added to your account », a payment receipt, an answer to a message, a referral reward.
 */
export type OwnerMail =
  | { kind: 'invite'; to: string; name: string; language: string; store: string; token: string }
  | { kind: 'added'; to: string; name: string; language: string; store: string }
  | { kind: 'receipt'; to: string; name: string; language: string; paymentId: number }
  | { kind: 'reward'; to: string; name: string; language: string; reward: ReferralReward }
  | { kind: 'answer'; to: string; name: string; language: string; shop: string; subject: string; body: string };
const Id = z.number().int().positive();
const Features = z.array(z.string().max(60)).max(200);

const SLUG_HELP = 'Nom dans les liens invalide : 2 à 40 lettres minuscules, chiffres et tirets (ex. ma-boutique)';
/** the shop's name in its links: the format, and not a word of the app (api, live, assets…) */
function checkSlug(slug: string) {
  if (NAME_RESERVED.includes(slug)) throw bad('Ce nom est réservé par Pilotix, choisissez-en un autre');
  if (!slugOk(slug)) throw bad(SLUG_HELP);
}

function shopError(e: any): never {
  const m = String(e?.message ?? '');
  if (String(e?.code) === '23505') throw bad('Ce nom est déjà pris par une autre boutique');
  if (m === 'SLUG_TAKEN') throw bad('Ce nom est déjà pris par une autre boutique');
  if (m === 'BAD_SLUG') throw bad(SLUG_HELP);
  throw e;
}

// ---------------------------------------------------------------- the actions
export const PLATFORM_REGISTRY = {
  'p.me': pproc(ALL, z.object({}), async (ctx) => ctx.staff),

  /** Delivery companies: what Pilotix does through each one's API (Done) and what is still missing (To do). */
  'p.couriers': pproc(ALL, z.object({}), async () => courierCatalog()),

  /** The team's test keys of each company (which ones are set, never their values) and each one's last test. */
  'p.couriers.tests': pproc(ALL, z.object({}), async (ctx) => courierTestState(ctx.t)),

  /**
   * « Pilotix Protection System »: the protection of every store, as it grows — the network's size (numbers and devices
   * the stores ended badly with, those 2 different businesses agree on), the landing orders of all stores day by day
   * (blocked, to check, caught by the network), each store's last 30 days. Numbers only: no customer, no number.
   */
  'p.protection': pproc(MANAGERS, z.object({ days: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30) }), async (ctx, i) => protectionStats(ctx.t, ctx.now(), i.days)),

  /** Saves a company's test keys (an empty key keeps the saved one) and its settings (API address…). */
  'p.couriers.saveKeys': pproc(
    MANAGERS,
    z.object({ company: z.string().max(40), secret: z.record(z.string().max(500)).default({}), settings: z.record(z.union([z.string().max(500), z.boolean()])).default({}) }),
    async (ctx, i) => {
      const co = courierCatalog().find((c) => c.key === i.company);
      if (!co?.kind) throw bad('Société inconnue');
      const secretKeys = new Set(co.fields.filter((f) => f.type === 'secret').map((f) => f.key));
      const otherKeys = new Set(co.fields.filter((f) => f.type !== 'secret').map((f) => f.key));
      const secret = Object.fromEntries(Object.entries(i.secret).filter(([k]) => secretKeys.has(k)));
      const settings = Object.fromEntries(Object.entries(i.settings).filter(([k]) => otherKeys.has(k)));
      await saveCourierTestKeys(ctx.t, co.key, secret, settings, ctx.staff.name ?? null);
      await audit(ctx, 'couriers.keys', null, { company: co.key });
      return { ok: true };
    },
  ),

  'p.couriers.clearKeys': pproc(MANAGERS, z.object({ company: z.string().max(40) }), async (ctx, i) => {
    await clearCourierTestKeys(ctx.t, i.company);
    await audit(ctx, 'couriers.keysCleared', null, { company: i.company });
    return { ok: true };
  }),

  /** Companies removed from Pilotix, and « Changements API » (the to-do list of what changed at each company's API). */
  'p.couriers.state': pproc(ALL, z.object({}), async (ctx) => {
    const [removed, watch] = await Promise.all([removedCouriers(ctx.t), watchState(ctx.t)]);
    return { removed, watch: { items: watch.items, last: watch.last, running: watch.running } };
  }),

  /** How many stores use a company now (before removing it): a number, never which ones. */
  'p.couriers.usage': pproc(MANAGERS, z.object({ company: z.string().max(40) }), async (ctx, i) => {
    const co = courierCatalog().find((c) => c.key === i.company);
    if (!co) throw bad('Société inconnue');
    return { stores: await courierUsage(ctx.t, co) };
  }),

  /**
   * Removes a company from Pilotix: the shops can no longer add it (those that use it keep it: their parcels keep
   * moving). Asked twice on the page; `confirm` must be sent too. It can be put back (« Restaurer »).
   */
  'p.couriers.remove': pproc(MANAGERS, z.object({ company: z.string().max(40), confirm: z.literal(true) }), async (ctx, i) => {
    const co = courierCatalog().find((c) => c.key === i.company);
    if (!co) throw bad('Société inconnue');
    await removeCourier(ctx.t, co.key, ctx.staff.name ?? null);
    await audit(ctx, 'couriers.removed', null, { company: co.key, name: co.name });
    return { ok: true };
  }),

  'p.couriers.restore': pproc(MANAGERS, z.object({ company: z.string().max(40) }), async (ctx, i) => {
    const co = courierCatalog().find((c) => c.key === i.company);
    if (!co) throw bad('Société inconnue');
    await restoreCourier(ctx.t, co.key);
    await audit(ctx, 'couriers.restored', null, { company: co.key, name: co.name });
    return { ok: true };
  }),

  /** A line of « Changements API »: « Résolu », or « À faire » again. */
  'p.couriers.todo.set': pproc(MANAGERS, z.object({ id: Id, status: z.enum(['open', 'resolved']) }), async (ctx, i) => {
    const it = await setWatchStatus(ctx.t, i.id, i.status, ctx.staff.name ?? null);
    if (!it) throw notFound('Ligne introuvable');
    await audit(ctx, i.status === 'resolved' ? 'couriers.todoResolved' : 'couriers.todoReopened', null, { id: it.id, company: it.company, title: it.title });
    return it;
  }),

  /** A line added by hand (a call to make, a question asked to a company…). */
  'p.couriers.todo.add': pproc(
    MANAGERS,
    z.object({ company: z.string().max(40), title: z.string().trim().min(2).max(200), detail: z.string().trim().max(1500).default('') }),
    async (ctx, i) => {
      const co = courierCatalog().find((c) => c.key === i.company);
      if (!co) throw bad('Société inconnue');
      const key = `manual:${co.key}:${Date.now().toString(36)}`;
      const [it] = await addWatchItems(ctx.t, [{ company: co.key, kind: 'manual', key, title: i.title, detail: i.detail, link: null, by: ctx.staff.name ?? null }]);
      await audit(ctx, 'couriers.todoAdded', null, { id: it?.id, company: co.key, title: i.title });
      return it;
    },
  ),

  /** Removes a line added by hand (the lines Pilotix found are marked « Résolu », never removed). */
  'p.couriers.todo.remove': pproc(MANAGERS, z.object({ id: Id }), async (ctx, i) => {
    const st = await watchState(ctx.t);
    const it = st.items.find((x) => x.id === i.id);
    if (!it) throw notFound('Ligne introuvable');
    if (it.kind !== 'manual') throw bad('Seules les lignes ajoutées à la main se suppriment : marquez celle-ci « Résolu »');
    await removeWatchItem(ctx.t, i.id);
    await audit(ctx, 'couriers.todoRemoved', null, { id: it.id, company: it.company, title: it.title });
    return { ok: true };
  }),

  'p.me.password': pproc(ALL, z.object({ current: z.string().min(1).max(200), next: z.string().min(10).max(200) }), async (ctx, i) => {
    const r = (await ctx.t.platform.query('SELECT password_hash FROM platform.staff WHERE id = $1', [ctx.staff.id]))[0];
    if (!r || !(await bcrypt.compare(i.current, r.password_hash))) throw bad('Mot de passe actuel incorrect');
    await ctx.t.platform.query('UPDATE platform.staff SET password_hash = $2, token_version = token_version + 1 WHERE id = $1', [ctx.staff.id, await hashPassword(i.next)]);
    await audit(ctx, 'staff.password', null, {});
    return { ok: true };
  }),

  /** The control room's first page: shops by state, who needs attention, money in. */
  'p.dashboard': pproc(ALL, z.object({}), async (ctx) => {
    const now = ctx.now();
    const set = await platformSettings(ctx.t);
    // partners (confirmation agencies, marketers) are not stores (free, their own page)
    const shops = (await loadShops(ctx.t)).filter((s) => s.kind === 'store').map((s) => shopRow(s, set, now));
    const real = shops.filter((s) => !s.primary && !s.demo);
    const count = (st: string) => real.filter((s) => s.state === st).length;
    const pay = await ctx.t.platform.query(
      `SELECT to_char(date_trunc('month', paid_at), 'YYYY-MM') AS m, sum(amount)::bigint AS amount, count(*)::int AS n
         FROM platform.payments WHERE void_at IS NULL AND paid_at >= date_trunc('month', now()) - interval '11 months' GROUP BY 1 ORDER BY 1`,
    );
    const month = new Date(now).toISOString().slice(0, 7);
    const prev = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    const byMonth = pay.map((r: any) => ({ month: r.m as string, amount: num(r.amount), count: num(r.n) }));
    const recent = await ctx.t.platform.query(`SELECT a.*, s.name AS shop_name FROM platform.audit a LEFT JOIN platform.shops s ON s.id = a.shop_id ORDER BY a.id DESC LIMIT 8`);
    const createdThisMonth = real.filter((s) => s.createdAt.slice(0, 7) === month).length;
    // sign-ups: stores made by their owners, sign-ups waiting for their e-mail, trials that became paying stores
    const week = now - 7 * 86_400_000;
    const pending = num(
      (await ctx.t.platform.query(`SELECT count(*)::int AS n FROM platform.signup_requests WHERE used_at IS NULL AND expires_at > now() AND password_hash <> '-'`))[0]?.n,
    );
    const since = now - 90 * 86_400_000;
    const recentStores = real.filter((s) => Date.parse(s.createdAt) >= since);
    const paidIds = new Set((await ctx.t.platform.query('SELECT DISTINCT shop_id FROM platform.payments WHERE void_at IS NULL')).map((r: any) => num(r.shop_id)));
    const converted = recentStores.filter((s) => paidIds.has(s.id)).length;
    return {
      signups: {
        week: real.filter((s) => s.selfSignup && Date.parse(s.createdAt) >= week).length,
        month: real.filter((s) => s.selfSignup && s.createdAt.slice(0, 7) === month).length,
        pending,
        made90: recentStores.length,
        paid90: converted,
        rate: recentStores.length ? Math.round((converted / recentStores.length) * 100) : null,
      },
      messages: await staffUnread(ctx.t),
      // Sociétés de livraison › « Changements API » not resolved yet (companies still in Pilotix)
      couriers: await (async () => {
        const [w, gone] = await Promise.all([watchState(ctx.t), removedCouriers(ctx.t)]);
        return w.items.filter((i) => i.status === 'open' && !gone[i.company]).length;
      })(),
      overLimit: await (async () => {
        let n = 0;
        for (const s of await loadShops(ctx.t)) {
          if (s.primary || s.demo || s.kind !== 'store' || s.status === 'deleted' || s.status === 'archived') continue;
          const l = limitsOf(s, await usage(ctx, s));
          if (l.over.users || l.over.drivers || l.over.orders) n++;
        }
        return n;
      })(),
      counts: { total: real.length, trial: count('trial'), active: count('active'), grace: count('grace'), expired: count('expired'), suspended: count('suspended'), archived: count('archived'), newThisMonth: createdThisMonth },
      mrr: real.filter((s) => s.state === 'active').reduce((a, s) => a + (s.plan?.priceMonth ?? 0), 0),
      revenue: { thisMonth: byMonth.find((b) => b.month === month)?.amount ?? 0, lastMonth: byMonth.find((b) => b.month === prev)?.amount ?? 0, byMonth },
      trialsEnding: real.filter((s) => s.state === 'trial' && (s.daysLeft ?? 99) <= 3).sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0)),
      renewSoon: real.filter((s) => s.state === 'active' && (s.daysLeft ?? 99) <= 7).sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0)),
      late: real.filter((s) => s.state === 'grace' || s.state === 'expired').sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0)),
      recent: recent.map(auditRow),
    };
  }),

  /** Stores by state (or « over »: over one of their plan's limits), with their numbers — never what is inside. */
  'p.shops.list': pproc(ALL, z.object({ q: z.string().max(100).optional(), state: z.string().max(20).optional() }), async (ctx, i) => {
    const now = ctx.now();
    const set = await platformSettings(ctx.t);
    const all = await loadShops(ctx.t);
    const q = (i.q ?? '').trim().toLowerCase();
    const st = i.state && i.state !== 'all' ? i.state : null;
    const rows = [];
    for (const s of all) {
      if (s.kind !== 'store') continue; // « Partenaires » lists the agencies and marketers
      const r = shopRow(s, set, now);
      // deleted stores only when asked for
      if (s.status === 'deleted' && st !== 'deleted') continue;
      if (st && st !== 'over' && r.state !== st && !(st === 'late' && (r.state === 'grace' || r.state === 'expired'))) continue;
      if (q && ![s.name, s.slug, s.ownerName, s.ownerEmail, s.ownerPhone, s.city].some((v) => v?.toLowerCase().includes(q))) continue;
      const u = await usage(ctx, s);
      const limits = limitsOf(s, u);
      if (st === 'over' && !(limits.over.users || limits.over.drivers || limits.over.orders)) continue;
      rows.push({ ...r, usage: u, limits });
    }
    const last = await ctx.t.platform.query(`SELECT shop_id, max(paid_at) AS at FROM platform.payments WHERE void_at IS NULL GROUP BY shop_id`);
    const lastPay = new Map(last.map((r: any) => [num(r.shop_id), isoOrNull(r.at)]));
    return rows.map((r) => ({ ...r, lastPaymentAt: lastPay.get(r.id) ?? null }));
  }),

  'p.shops.get': pproc(ALL, z.object({ id: Id }), async (ctx, i) => {
    const now = ctx.now();
    const s = await needShop(ctx, i.id);
    const set = await platformSettings(ctx.t);
    const payments = await ctx.t.platform.query('SELECT p.*, st.name AS by_name FROM platform.payments p LEFT JOIN platform.staff st ON st.id = p.created_by WHERE p.shop_id = $1 ORDER BY p.paid_at DESC, p.id DESC', [s.id]);
    const log = await ctx.t.platform.query('SELECT a.*, NULL AS shop_name FROM platform.audit a WHERE a.shop_id = $1 ORDER BY a.id DESC LIMIT 40', [s.id]);
    const u = await usage(ctx, s, true);
    // the owner: the account that made the store (its e-mail, whether it chose its password, how many stores it has)
    const acc = s.ownerAccountId ? await accountById(ctx.t, s.ownerAccountId) : null;
    const brought = await ctx.t.platform.query('SELECT r.*, s.name FROM platform.referrals r JOIN platform.shops s ON s.id = r.referred_shop_id WHERE r.referrer_shop_id = $1 ORDER BY r.id DESC', [s.id]);
    const by = s.referredBy ? await loadShop(ctx.t, { id: s.referredBy }) : null;
    return {
      ...shopRow(s, set, now),
      notes: s.notes,
      featuresOn: s.featuresOn,
      featuresOff: s.featuresOff,
      planFeatures: s.primary || s.plan?.system ? ['*'] : s.plan?.features ?? [],
      features: shopFeatures(s),
      maxUsers: s.maxUsers,
      maxUsersEffective: shopMaxUsers(s),
      maxDrivers: s.maxDrivers,
      maxDriversEffective: shopMaxDrivers(s),
      maxOrdersMonth: shopMaxOrders(s),
      resetAt: s.resetAt,
      usage: u,
      limits: limitsOf(s, u),
      ownerAccount: acc
        ? { email: acc.email, name: acc.name, invited: !acc.hasPassword, verified: acc.verified, stores: u.ownerStores, maxStores: acc.maxStores, maxStoresDefault: set.signup.maxStores, lastLoginAt: acc.lastLoginAt }
        : null,
      referralCode: s.referralCode,
      referredBy: by ? { id: by.id, name: by.name } : null,
      referrals: brought.map((r: any) => ({ shopId: num(r.referred_shop_id), name: r.name as string, at: isoOrNull(r.created_at), rewardedAt: isoOrNull(r.rewarded_at), months: num(r.reward_months) })),
      payments: payments.map(paymentRow),
      log: log.map(auditRow),
    };
  }),

  /**
   * A store made for a client. Pilotix never knows its password: the owner gets an e-mail to choose it (an e-mail that
   * already has a Pilotix account gets « a new store was added to your account » and keeps its password). The
   * e-mail to send comes back in `mail` (the server sends it and never returns its link).
   */
  'p.shops.create': pproc(
    MANAGERS,
    z.object({
      name: z.string().trim().min(2).max(80),
      slug: z.string().trim().toLowerCase().max(40).optional(),
      ownerName: z.string().trim().min(2).max(80),
      ownerEmail: z.string().trim().email().max(200),
      ownerPhone: z.string().trim().max(30).nullable().optional(),
      city: z.string().trim().max(60).nullable().optional(),
      planId: Id,
      trialDays: z.number().int().min(0).max(90),
      language: z.enum(['fr', 'en', 'ar']).default('fr'),
      notes: z.string().max(2000).optional(),
    }),
    async (ctx, i) => {
      const plan = (await loadPlans(ctx.t)).find((p) => p.id === i.planId);
      if (!plan) throw bad('Formule introuvable');
      if (i.slug) checkSlug(i.slug);
      const email = i.ownerEmail.trim().toLowerCase();
      if (/@(pilotix\.invalid|demo\.pilotix\.dz)$/.test(email)) throw bad('E-mail invalide');
      let shop: Shop;
      try {
        shop = await provisionShop(ctx.t, {
          name: i.name,
          slug: i.slug || undefined,
          planId: plan.id,
          trialDays: i.trialDays,
          owner: { name: i.ownerName, email, phone: i.ownerPhone ?? null, language: i.language },
          city: i.city ?? null,
          notes: i.notes ?? '',
          createdBy: ctx.staff.id,
          now: ctx.now(),
        });
      } catch (e) {
        shopError(e);
      }
      const acc = (await accountById(ctx.t, shop.ownerAccountId!))!;
      const mail: OwnerMail = acc.hasPassword
        ? { kind: 'added', to: acc.email, name: acc.name || i.ownerName, language: acc.language, store: shop.name }
        : { kind: 'invite', to: acc.email, name: acc.name || i.ownerName, language: acc.language, store: shop.name, token: await makeAccountToken(ctx.t, acc.id, 'invite', ctx.now()) };
      await audit(ctx, 'shop.create', shop.id, { name: shop.name, plan: plan.name, trialDays: i.trialDays, email, invited: mail.kind === 'invite' });
      return { id: shop.id, slug: shop.slug, name: shop.name, email, invited: mail.kind === 'invite', mail };
    },
  ),

  /** The owner never chose a password (the e-mail got lost): a new invitation link, by e-mail only. */
  'p.shops.resendInvite': pproc(MANAGERS, z.object({ id: Id }), async (ctx, i) => {
    const s = await needShop(ctx, i.id);
    const acc = s.ownerAccountId ? await accountById(ctx.t, s.ownerAccountId) : null;
    if (!acc) throw bad('Cette boutique n’a pas de propriétaire connu');
    if (acc.hasPassword) throw bad('Le propriétaire a déjà choisi son mot de passe : il se connecte, ou utilise « Mot de passe oublié »');
    const mail: OwnerMail = { kind: 'invite', to: acc.email, name: acc.name, language: acc.language, store: s.name, token: await makeAccountToken(ctx.t, acc.id, 'invite', ctx.now()) };
    await audit(ctx, 'shop.invite', s.id, { email: acc.email });
    return { ok: true, email: acc.email, mail };
  }),

  'p.shops.update': pproc(
    MANAGERS,
    z.object({
      id: Id,
      name: z.string().trim().min(2).max(80).optional(),
      slug: z.string().trim().toLowerCase().max(40).optional(),
      ownerName: z.string().trim().max(80).nullable().optional(),
      ownerEmail: z.string().trim().max(200).nullable().optional(),
      ownerPhone: z.string().trim().max(30).nullable().optional(),
      city: z.string().trim().max(60).nullable().optional(),
      planId: Id.optional(),
      trialEndsAt: IsoDate.nullable().optional(),
      paidUntil: IsoDate.nullable().optional(),
      maxUsers: z.number().int().min(1).max(10_000).nullable().optional(),
      maxDrivers: z.number().int().min(0).max(10_000).nullable().optional(),
      /** stores its owner may have (null = the platform's setting) */
      ownerMaxStores: z.number().int().min(1).max(100).nullable().optional(),
    }),
    async (ctx, i) => {
      const s = await needShop(ctx, i.id);
      if (s.status === 'deleted') throw bad('Boutique supprimée par son propriétaire');
      if (s.primary && (i.planId !== undefined || i.trialEndsAt !== undefined || i.paidUntil !== undefined)) throw bad('Votre propre boutique n’a ni formule ni échéance : elle ne s’arrête jamais');
      if (i.ownerMaxStores !== undefined && s.ownerAccountId) {
        await ctx.t.platform.query('UPDATE platform.accounts SET max_stores = $2 WHERE id = $1', [s.ownerAccountId, i.ownerMaxStores]);
        await audit(ctx, 'shop.ownerStores', s.id, { maxStores: i.ownerMaxStores });
      }
      if (i.slug !== undefined && i.slug !== s.slug) {
        checkSlug(i.slug);
        if ((await freeSlug(ctx.t, i.slug, s.id)) !== i.slug) throw bad('Ce nom est déjà pris par une autre boutique');
      }
      if (i.planId !== undefined && !(await loadPlans(ctx.t)).some((p) => p.id === i.planId)) throw bad('Formule introuvable');
      const sets: string[] = [];
      const vals: unknown[] = [s.id];
      const changes: Record<string, unknown> = {};
      const put = (col: string, v: unknown, label: string, old: unknown) => {
        if (v === undefined || v === old) return;
        vals.push(v);
        sets.push(`${col} = $${vals.length}`);
        changes[label] = { from: old ?? null, to: v };
      };
      put('name', i.name, 'name', s.name);
      put('slug', i.slug, 'slug', s.slug);
      put('owner_name', i.ownerName === undefined ? undefined : i.ownerName || null, 'ownerName', s.ownerName);
      put('owner_email', i.ownerEmail === undefined ? undefined : i.ownerEmail?.toLowerCase() || null, 'ownerEmail', s.ownerEmail);
      put('owner_phone', i.ownerPhone === undefined ? undefined : i.ownerPhone || null, 'ownerPhone', s.ownerPhone);
      put('city', i.city === undefined ? undefined : i.city || null, 'city', s.city);
      put('plan_id', i.planId, 'plan', s.planId);
      put('trial_ends_at', i.trialEndsAt === undefined ? undefined : i.trialEndsAt && new Date(i.trialEndsAt).toISOString(), 'trialEndsAt', s.trialEndsAt);
      put('paid_until', i.paidUntil === undefined ? undefined : i.paidUntil && new Date(i.paidUntil).toISOString(), 'paidUntil', s.paidUntil);
      put('max_users', i.maxUsers, 'maxUsers', s.maxUsers);
      put('max_drivers', i.maxDrivers, 'maxDrivers', s.maxDrivers);
      if (!sets.length) return { ok: true };
      await ctx.t.platform.query(`UPDATE platform.shops SET ${sets.join(', ')} WHERE id = $1`, vals);
      // the new name is the store's part of its links (shop #1: its « Lien des pages » too)
      if (changes.slug && s.status !== 'archived') await setShopStore(ctx.t.shop(s.schema), i.slug!);
      await audit(ctx, 'shop.update', s.id, changes);
      return { ok: true };
    },
  ),

  'p.shops.notes': pproc(ALL, z.object({ id: Id, notes: z.string().max(5000) }), async (ctx, i) => {
    await needShop(ctx, i.id);
    await ctx.t.platform.query('UPDATE platform.shops SET notes = $2 WHERE id = $1', [i.id, i.notes]);
    return { ok: true };
  }),

  /** Suspend (locked at once), reactivate, or archive (closed, its data kept). Never the owner's own shop. */
  'p.shops.setStatus': pproc(MANAGERS, z.object({ id: Id, status: z.enum(['active', 'suspended', 'archived']), reason: z.string().trim().max(300).optional() }), async (ctx, i) => {
    const s = await needShop(ctx, i.id);
    if (s.status === 'deleted') throw bad('Boutique supprimée par son propriétaire');
    if (s.primary && i.status !== 'active') throw bad('Votre propre boutique ne peut pas être suspendue');
    if (s.status === i.status) return { ok: true };
    await ctx.t.platform.query('UPDATE platform.shops SET status = $2, status_reason = $3 WHERE id = $1', [s.id, i.status, i.status === 'active' ? null : i.reason || null]);
    await audit(ctx, `shop.${i.status === 'active' ? 'reactivate' : i.status === 'suspended' ? 'suspend' : 'archive'}`, s.id, { from: s.status, reason: i.reason ?? null });
    // a suspended partner's people stop in every store at once (and start again when it is reactivated)
    if (s.kind !== 'store') await syncAgency(ctx.t, s.id);
    return { ok: true };
  }),

  /** Partners (confirmation agencies, marketers): checked by Pilotix or not, their sellers (contracts, requests), their owner. */
  'p.agencies.list': pproc(ALL, z.object({ q: z.string().max(100).optional(), kind: z.enum(['agency', 'marketer']).optional() }), async (ctx, i) => {
    const q = (i.q ?? '').trim().toLowerCase();
    const rows = await ctx.t.platform.query(
      `SELECT s.*, (SELECT count(*) FROM platform.agency_links l WHERE l.agency_id = s.id AND l.status = 'active')::int AS active_links,
              (SELECT count(*) FROM platform.agency_links l WHERE l.agency_id = s.id AND l.status = 'pending')::int AS pending_links
         FROM platform.shops s WHERE s.kind IN ('agency', 'marketer') AND ($1::text IS NULL OR s.kind = $1) AND s.status <> 'deleted' ORDER BY (s.agency_verified_at IS NULL) DESC, s.created_at DESC`,
      [i.kind ?? null],
    );
    return rows
      .filter((r: any) => !q || [r.name, r.public_code, r.owner_name, r.owner_email, r.owner_phone].some((v) => String(v ?? '').toLowerCase().includes(q)))
      .map((r: any) => ({
        id: num(r.id),
        kind: (r.kind === 'marketer' ? 'marketer' : 'agency') as 'agency' | 'marketer',
        name: r.name as string,
        code: (r.public_code as string | null) ?? null,
        status: r.status as string,
        statusReason: (r.status_reason as string | null) ?? null,
        verifiedAt: isoOrNull(r.agency_verified_at),
        owner: { name: (r.owner_name as string) ?? '', email: (r.owner_email as string) ?? '', phone: (r.owner_phone as string | null) ?? null },
        createdAt: new Date(r.created_at).toISOString(),
        lastActiveAt: isoOrNull(r.last_active_at),
        activeLinks: num(r.active_links),
        pendingLinks: num(r.pending_links),
        // Pro marketers: paid until (null: never), asked « Passer Pro » (waiting for staff), shown on the list
        pro: r.kind === 'marketer' ? { until: isoOrNull(r.pro_until), askedAt: isoOrNull(r.pro_asked_at), active: !!r.pro_until && new Date(r.pro_until).getTime() > ctx.now() } : null,
      }));
  }),

  /** Pro marketers: a payment received turns Pro on (or prolongs it) for `months`, from today or the end of the paid months. */
  'p.pro.activate': pproc(
    MANAGERS,
    z.object({
      id: Id,
      months: z.number().int().min(1).max(36),
      amount: z.number().int().min(0).max(100_000_000),
      method: z.enum(PAYMENT_METHODS),
      note: z.string().trim().max(500).optional(),
    }),
    async (ctx, i) => {
      const s = await needShop(ctx, i.id);
      if (s.kind !== 'marketer') throw bad('Le compte Pro est réservé aux espaces marketer');
      const v = (await ctx.t.platform.query('SELECT agency_verified_at FROM platform.shops WHERE id = $1', [s.id]))[0];
      if (!v?.agency_verified_at) throw bad('Vérifiez d’abord ce marketer');
      const out = await ctx.t.platform.tx(async (db) => {
        const p = (
          await db.query(
            `INSERT INTO platform.pro_payments (shop_id, amount, method, months, period_from, period_to, note, created_by)
             SELECT $1, $2, $3, $4, x.f, x.f + make_interval(months => $4), $5, $6
               FROM (SELECT GREATEST(now(), COALESCE(pro_until, now())) AS f FROM platform.shops WHERE id = $1 FOR UPDATE) x
             RETURNING id, period_to`,
            [s.id, i.amount, i.method, i.months, i.note || null, ctx.staff.id],
          )
        )[0];
        await db.query('UPDATE platform.shops SET pro_until = $2, pro_asked_at = NULL WHERE id = $1', [s.id, p.period_to]);
        return { id: num(p.id), until: isoOrNull(p.period_to) };
      });
      await audit(ctx, 'pro.activate', s.id, { months: i.months, amount: i.amount, method: i.method, until: out.until });
      return out;
    },
  ),

  /** Stops a marketer's Pro now (it leaves the list at once), or refuses its request. */
  'p.pro.stop': pproc(MANAGERS, z.object({ id: Id }), async (ctx, i) => {
    const s = await needShop(ctx, i.id);
    if (s.kind !== 'marketer') throw bad('Le compte Pro est réservé aux espaces marketer');
    await ctx.t.platform.query('UPDATE platform.shops SET pro_until = CASE WHEN pro_until > now() THEN now() ELSE pro_until END, pro_asked_at = NULL WHERE id = $1', [s.id]);
    await audit(ctx, 'pro.stop', s.id, {});
    return { ok: true };
  }),

  /** A marketer's Pro payments, the newest first. */
  'p.pro.payments': pproc(MANAGERS, z.object({ id: Id }), async (ctx, i) =>
    (await ctx.t.platform.query('SELECT * FROM platform.pro_payments WHERE shop_id = $1 ORDER BY id DESC LIMIT 50', [i.id])).map((r: any) => ({
      id: num(r.id),
      amount: num(r.amount),
      method: r.method as string,
      months: num(r.months),
      from: new Date(r.period_from).toISOString(),
      to: new Date(r.period_to).toISOString(),
      note: (r.note as string | null) ?? null,
      at: new Date(r.created_at).toISOString(),
    })),
  ),

  /** « Vérifier » a partner (it may then work with stores), or take the check back (its people stop at once). */
  'p.agencies.verify': pproc(MANAGERS, z.object({ id: Id, verified: z.boolean() }), async (ctx, i) => {
    const s = await needShop(ctx, i.id);
    if (s.kind === 'store') throw bad('Ce n’est pas une agence de confirmation ni un marketer');
    await ctx.t.platform.query('UPDATE platform.shops SET agency_verified_at = CASE WHEN $2 THEN COALESCE(agency_verified_at, now()) END WHERE id = $1', [s.id, i.verified]);
    await audit(ctx, `${s.kind}.${i.verified ? 'verify' : 'unverify'}`, s.id, {});
    await syncAgency(ctx.t, s.id);
    return { ok: true };
  }),

  /** This shop's own menus: turned on or off on top of its plan. */
  'p.shops.features': pproc(MANAGERS, z.object({ id: Id, on: Features, off: Features }), async (ctx, i) => {
    const s = await needShop(ctx, i.id);
    const on = cleanFeatures(i.on, false);
    const off = cleanFeatures(i.off, false).filter((k) => !on.includes(k));
    await ctx.t.platform.query('UPDATE platform.shops SET features_on = $2, features_off = $3 WHERE id = $1', [s.id, JSON.stringify(on), JSON.stringify(off)]);
    await audit(ctx, 'shop.features', s.id, { on, off, before: { on: s.featuresOn, off: s.featuresOff } });
    return { ok: true };
  }),

  'p.shops.extendTrial': pproc(MANAGERS, z.object({ id: Id, days: z.number().int().min(1).max(90) }), async (ctx, i) => {
    const s = await needShop(ctx, i.id);
    if (s.primary) throw bad('Votre propre boutique ne s’arrête jamais');
    const r = (await ctx.t.platform.query(`UPDATE platform.shops SET trial_ends_at = GREATEST(now(), COALESCE(trial_ends_at, now())) + make_interval(days => $2) WHERE id = $1 RETURNING trial_ends_at`, [s.id, i.days]))[0];
    await audit(ctx, 'shop.trial', s.id, { days: i.days, from: s.trialEndsAt, to: isoOrNull(r?.trial_ends_at) });
    return { trialEndsAt: isoOrNull(r?.trial_ends_at) };
  }),

  // ---------------------------------------------------------------- payments
  /** A payment received (BaridiMob, CCP, cash…): the paid period grows by `months`, from today or the end of the trial / the current period. */
  'p.payments.add': pproc(
    MANAGERS,
    z.object({
      shopId: Id,
      amount: z.number().int().min(0).max(100_000_000),
      method: z.enum(PAYMENT_METHODS),
      months: z.number().int().min(1).max(36),
      reference: z.string().trim().max(120).optional(),
      note: z.string().trim().max(500).optional(),
      paidAt: IsoDate.optional(),
      planId: Id.optional(),
    }),
    async (ctx, i) => {
      const s = await needShop(ctx, i.shopId);
      if (s.primary || s.demo) throw bad('Pas de paiement pour cette boutique');
      if (i.planId !== undefined && !(await loadPlans(ctx.t)).some((p) => p.id === i.planId)) throw bad('Formule introuvable');
      const set = await platformSettings(ctx.t);
      const out = await ctx.t.platform.tx(async (db) => {
        const cur = (await db.query('SELECT status FROM platform.shops WHERE id = $1 FOR UPDATE', [s.id]))[0];
        // receipts are numbered per year, one after the other (one payment at a time takes its number)
        await db.query('SELECT pg_advisory_xact_lock(7340211)');
        const year = new Date(i.paidAt ? Date.parse(i.paidAt) : ctx.now()).getUTCFullYear();
        const seq = num((await db.query(`SELECT COALESCE(max(substring(receipt_no from 9)::int), 0) AS n FROM platform.payments WHERE receipt_no LIKE $1`, [`PX-${year}-%`]))[0]?.n) + 1;
        const receiptNo = `PX-${year}-${String(seq).padStart(4, '0')}`;
        // from today, or from the end of the trial / of the period already paid when it is still ahead
        const p = (
          await db.query(
            `INSERT INTO platform.payments (shop_id, amount, method, reference, months, plan_id, period_from, period_to, paid_at, note, created_by, receipt_no)
             SELECT $1, $2, $3, $4, $5, $6, x.f, x.f + make_interval(months => $5), COALESCE($7::timestamptz, now()), $8, $9, $10
               FROM (SELECT GREATEST(now(), paid_until, trial_ends_at) AS f FROM platform.shops WHERE id = $1) x
             RETURNING id, period_to`,
            [s.id, i.amount, i.method, i.reference || null, i.months, i.planId ?? s.planId, i.paidAt ? new Date(i.paidAt).toISOString() : null, i.note || null, ctx.staff.id, receiptNo],
          )
        )[0];
        await db.query(
          `UPDATE platform.shops sh SET paid_until = p.period_to, plan_id = COALESCE($3, sh.plan_id),
             status = CASE WHEN sh.status = 'suspended' THEN 'active' ELSE sh.status END,
             status_reason = CASE WHEN sh.status = 'suspended' THEN NULL ELSE sh.status_reason END
             FROM platform.payments p WHERE sh.id = $1 AND p.id = $2`,
          [s.id, p.id, i.planId ?? null],
        );
        // the first payment of a store another one brought: that one gets its free months
        const reward = await rewardReferrer(db, set, s.id, num(p.id));
        return { id: num(p.id), paidUntil: isoOrNull(p.period_to), reactivated: cur.status === 'suspended', receiptNo, reward };
      });
      await audit(ctx, 'payment.add', s.id, { amount: i.amount, method: i.method, months: i.months, paidUntil: out.paidUntil, reference: i.reference ?? null, reactivated: out.reactivated, receipt: out.receiptNo });
      if (out.reward) await audit(ctx, 'referral.reward', out.reward.referrerShopId, { months: out.reward.months, from: s.name, paidUntil: out.reward.paidUntil });
      const mails: OwnerMail[] = [];
      if (out.reward?.to) mails.push({ kind: 'reward', to: out.reward.to, name: out.reward.name, language: out.reward.language, reward: out.reward });
      return { id: out.id, paidUntil: out.paidUntil, reactivated: out.reactivated, receiptNo: out.receiptNo, rewarded: out.reward ? { shop: out.reward.shop, months: out.reward.months } : null, mails };
    },
  ),

  'p.payments.list': pproc(MANAGERS, z.object({ shopId: Id.optional(), month: z.string().regex(/^\d{4}-\d{2}$/).optional(), method: z.enum(PAYMENT_METHODS).optional(), withVoid: z.boolean().default(false) }), async (ctx, i) => {
    const rows = await ctx.t.platform.query(
      `SELECT p.*, s.name AS shop_name, s.slug AS shop_slug, st.name AS by_name FROM platform.payments p
         JOIN platform.shops s ON s.id = p.shop_id LEFT JOIN platform.staff st ON st.id = p.created_by
        WHERE ($1::int IS NULL OR p.shop_id = $1) AND ($2::text IS NULL OR to_char(p.paid_at, 'YYYY-MM') = $2)
          AND ($3::text IS NULL OR p.method = $3) AND ($4 OR p.void_at IS NULL)
        ORDER BY p.paid_at DESC, p.id DESC LIMIT 500`,
      [i.shopId ?? null, i.month ?? null, i.method ?? null, i.withVoid],
    );
    const list = rows.map((r: any) => ({ ...paymentRow(r), shop: { id: num(r.shop_id), name: r.shop_name as string, slug: r.shop_slug as string } }));
    const live = list.filter((p) => !p.voidAt);
    return { rows: list, total: live.reduce((a, p) => a + p.amount, 0), count: live.length, byMethod: PAYMENT_METHODS.map((m) => ({ method: m, amount: live.filter((p) => p.method === m).reduce((a, p) => a + p.amount, 0) })) };
  }),

  /** A payment's receipt (printed, or saved as PDF from the browser): who paid, what, for which period. */
  'p.payments.receipt': pproc(MANAGERS, z.object({ id: Id }), async (ctx, i) => receiptOf(ctx.t, i.id)),

  /** E-mails the receipt to the store's owner. */
  'p.payments.mailReceipt': pproc(MANAGERS, z.object({ id: Id }), async (ctx, i) => {
    const r = await receiptOf(ctx.t, i.id);
    if (!r.shop.ownerEmail) throw bad('Pas d’e-mail pour le propriétaire de cette boutique');
    await audit(ctx, 'payment.receipt', r.shop.id, { receipt: r.receiptNo, to: r.shop.ownerEmail });
    const mail: OwnerMail = { kind: 'receipt', to: r.shop.ownerEmail, name: r.shop.ownerName ?? '', language: r.language, paymentId: r.id };
    return { ok: true, email: r.shop.ownerEmail, mail };
  }),

  /** A payment typed by mistake: cancelled (kept in the history). The paid period goes back if it was the last one. */
  'p.payments.void': pproc(OWNER, z.object({ id: Id, reason: z.string().trim().min(2).max(300) }), async (ctx, i) => {
    const r = await ctx.t.platform.tx(async (db) => {
      const p = (await db.query('SELECT * FROM platform.payments WHERE id = $1 FOR UPDATE', [i.id]))[0];
      if (!p) throw notFound('Paiement introuvable');
      if (p.void_at) throw bad('Paiement déjà annulé');
      await db.query('UPDATE platform.payments SET void_at = now(), void_by = $2, void_reason = $3 WHERE id = $1', [i.id, ctx.staff.id, i.reason]);
      const back = await db.query(
        'UPDATE platform.shops sh SET paid_until = p.period_from FROM platform.payments p WHERE p.id = $1 AND sh.id = p.shop_id AND sh.paid_until = p.period_to RETURNING sh.id',
        [i.id],
      );
      return { shopId: num(p.shop_id), amount: num(p.amount), periodBack: back.length > 0 };
    });
    await audit(ctx, 'payment.void', r.shopId, { payment: i.id, amount: r.amount, reason: i.reason, periodBack: r.periodBack });
    return { ok: true, periodBack: r.periodBack };
  }),

  // ---------------------------------------------------------------- plans
  'p.plans.list': pproc(ALL, z.object({}), async (ctx) => {
    const plans = await loadPlans(ctx.t);
    const used = await ctx.t.platform.query(`SELECT plan_id, count(*)::int AS n FROM platform.shops WHERE NOT primary_shop AND NOT is_demo AND status <> 'archived' GROUP BY plan_id`);
    const n = new Map(used.map((r: any) => [num(r.plan_id), num(r.n)]));
    return plans.map((p) => ({ ...p, shops: n.get(p.id) ?? 0 }));
  }),

  'p.plans.save': pproc(
    OWNER,
    z.object({
      id: Id.optional(),
      name: z.string().trim().min(2).max(40),
      priceMonth: z.number().int().min(0).max(10_000_000),
      priceYear: z.number().int().min(0).max(100_000_000).nullable().optional(),
      features: Features,
      maxUsers: z.number().int().min(1).max(10_000).nullable().optional(),
      maxDrivers: z.number().int().min(0).max(10_000).nullable().optional(),
      maxOrdersMonth: z.number().int().min(1).max(10_000_000).nullable().optional(),
      description: z.string().max(400).optional(),
      public: z.boolean(),
      active: z.boolean(),
    }),
    async (ctx, i) => {
      const old = i.id ? (await loadPlans(ctx.t)).find((p) => p.id === i.id) : null;
      if (i.id && !old) throw notFound('Formule introuvable');
      const features = old?.system ? ['*'] : cleanFeatures(i.features, true);
      const vals = [i.name, i.priceMonth, i.priceYear ?? null, JSON.stringify(features), i.maxUsers ?? null, i.maxOrdersMonth ?? null, i.description ?? '', old?.system ? false : i.public, old?.system ? true : i.active, i.maxDrivers ?? null];
      let id = i.id ?? 0;
      if (old) {
        await ctx.t.platform.query(
          `UPDATE platform.plans SET name=$2, price_month=$3, price_year=$4, features=$5, max_users=$6, max_orders_month=$7, description=$8, public=$9, active=$10, max_drivers=$11 WHERE id=$1`,
          [old.id, ...vals],
        );
      } else {
        let code = slugify(i.name);
        for (let k = 2; (await ctx.t.platform.query('SELECT 1 FROM platform.plans WHERE code = $1', [code])).length; k++) code = `${slugify(i.name)}-${k}`;
        const sort = num((await ctx.t.platform.query('SELECT COALESCE(max(sort), 0) + 1 AS s FROM platform.plans'))[0]?.s);
        id = num(
          (
            await ctx.t.platform.query(
              `INSERT INTO platform.plans (code, name, price_month, price_year, features, max_users, max_orders_month, description, public, active, max_drivers, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
              [code, ...vals, sort],
            )
          )[0].id,
        );
      }
      await audit(ctx, old ? 'plan.update' : 'plan.create', null, { plan: i.name, priceMonth: i.priceMonth, features: features.length });
      return { id };
    },
  ),

  // ---------------------------------------------------------------- staff
  'p.staff.list': pproc(OWNER, z.object({}), async (ctx) =>
    (await ctx.t.platform.query('SELECT * FROM platform.staff ORDER BY id')).map((r: any) => ({ ...toStaff(r), active: !!r.active, lastLoginAt: isoOrNull(r.last_login_at), createdAt: isoOrNull(r.created_at) })),
  ),

  'p.staff.save': pproc(
    OWNER,
    z.object({ id: Id.optional(), name: z.string().trim().min(2).max(80), email: z.string().trim().email().max(200), role: z.enum(STAFF_ROLES), active: z.boolean(), password: z.string().min(10).max(200).optional() }),
    async (ctx, i) => {
      const email = i.email.toLowerCase();
      const taken = (await ctx.t.platform.query('SELECT id FROM platform.staff WHERE email = $1', [email]))[0];
      if (taken && num(taken.id) !== i.id) throw bad('Cet email est déjà un compte de l’équipe');
      if (i.id) {
        const cur = (await ctx.t.platform.query('SELECT * FROM platform.staff WHERE id = $1', [i.id]))[0];
        if (!cur) throw notFound();
        const owners = num((await ctx.t.platform.query(`SELECT count(*)::int AS n FROM platform.staff WHERE role = 'owner' AND active AND id <> $1`, [i.id]))[0]?.n);
        if (cur.role === 'owner' && cur.active && (!i.active || i.role !== 'owner') && owners === 0) throw bad('Il faut au moins un propriétaire actif');
        await ctx.t.platform.query(
          `UPDATE platform.staff SET name=$2, email=$3, role=$4, active=$5, password_hash=COALESCE($6, password_hash),
             token_version = token_version + CASE WHEN $6::text IS NOT NULL OR NOT $5 OR role <> $4 THEN 1 ELSE 0 END WHERE id=$1`,
          [i.id, i.name, email, i.role, i.active, i.password ? await hashPassword(i.password) : null],
        );
        await audit(ctx, 'staff.update', null, { email, role: i.role, active: i.active, password: !!i.password });
        return { id: i.id };
      }
      if (!i.password) throw bad('Mot de passe obligatoire (10 caractères au moins)');
      const id = num((await ctx.t.platform.query('INSERT INTO platform.staff (name, email, password_hash, role, active) VALUES ($1,$2,$3,$4,$5) RETURNING id', [i.name, email, await hashPassword(i.password), i.role, i.active]))[0].id);
      await audit(ctx, 'staff.create', null, { email, role: i.role });
      return { id };
    },
  ),

  // ---------------------------------------------------------------- settings, journal
  'p.settings.get': pproc(ALL, z.object({}), async (ctx) => platformSettings(ctx.t)),

  'p.settings.save': pproc(
    OWNER,
    z.object({
      trial: z.object({ days: z.number().int().min(0).max(90), graceDays: z.number().int().min(0).max(30), planCode: z.string().max(60) }).optional(),
      payment: z.object({ text: z.string().max(1500), phone: z.string().max(40), whatsapp: z.string().max(40) }).optional(),
      notice: z.object({ text: z.string().max(400), tone: z.enum(['info', 'warn']), until: IsoDate.nullable() }).optional(),
      demo: z.object({ public: z.boolean() }).optional(),
      signup: z.object({ open: z.boolean(), maxStores: z.number().int().min(1).max(100) }).optional(),
      reminders: z.object({ on: z.boolean(), daysBefore: z.number().int().min(1).max(30) }).optional(),
      referral: z.object({ on: z.boolean(), months: z.number().int().min(0).max(12) }).optional(),
      security: z.object({ twoStep: z.boolean() }).optional(),
      company: z.object({ name: z.string().trim().max(120), address: z.string().trim().max(300), phone: z.string().trim().max(40), email: z.string().trim().max(200), taxId: z.string().trim().max(80) }).optional(),
      legal: z.object({ text: z.string().max(30_000) }).optional(),
      login: z.object({ designs: z.array(z.number().int().min(1).max(20)).min(1, 'Gardez au moins un design').max(20) }).optional(),
      social: z
        .object({
          googleClientId: z.string().trim().max(200).regex(/^$|^[\w.-]+\.apps\.googleusercontent\.com$/, 'ID client Google : il finit par .apps.googleusercontent.com'),
          facebookAppId: z.string().trim().max(40).regex(/^\d*$/, 'ID de l’app Facebook : des chiffres seulement'),
        })
        .optional(),
      pro: z.object({ on: z.boolean(), price: z.number().int().min(0).max(1_000_000) }).optional(),
    }),
    async (ctx, i) => {
      for (const k of ['trial', 'payment', 'notice', 'demo', 'signup', 'reminders', 'referral', 'security', 'company', 'legal', 'login', 'social', 'pro'] as const) if (i[k]) await setPlatformSetting(ctx.t, k, i[k] as any);
      await audit(ctx, 'settings.save', null, { keys: Object.keys(i) });
      return platformSettings(ctx.t);
    },
  ),

  'p.audit.list': pproc(MANAGERS, z.object({ shopId: Id.optional(), before: Id.optional(), limit: z.number().int().min(1).max(200).default(60) }), async (ctx, i) => {
    const rows = await ctx.t.platform.query(
      `SELECT a.*, s.name AS shop_name FROM platform.audit a LEFT JOIN platform.shops s ON s.id = a.shop_id
        WHERE ($1::int IS NULL OR a.shop_id = $1) AND ($2::bigint IS NULL OR a.id < $2) ORDER BY a.id DESC LIMIT $3`,
      [i.shopId ?? null, i.before ?? null, i.limit],
    );
    return rows.map(auditRow);
  }),

  // ---------------------------------------------------------------- sign-ups (#4)
  /** Sign-ups waiting for their e-mail, and the stores their owners made lately. */
  'p.signups.list': pproc(ALL, z.object({}), async (ctx) => {
    const pending = await ctx.t.platform.query(
      `SELECT id, email, name, store_name, created_at, expires_at FROM platform.signup_requests
        WHERE used_at IS NULL AND expires_at > now() AND password_hash <> '-' ORDER BY created_at DESC LIMIT 100`,
    );
    const made = await ctx.t.platform.query(
      `SELECT s.id, s.name, s.slug, s.created_at, s.status, s.trial_ends_at, s.paid_until, a.email,
              EXISTS (SELECT 1 FROM platform.payments p WHERE p.shop_id = s.id AND p.void_at IS NULL) AS paid
         FROM platform.shops s LEFT JOIN platform.accounts a ON a.id = s.owner_account_id
        WHERE s.self_signup ORDER BY s.created_at DESC LIMIT 100`,
    );
    return {
      pending: pending.map((r: any) => ({ id: num(r.id), email: r.email as string, name: r.name as string, store: r.store_name as string, at: isoOrNull(r.created_at)!, expiresAt: isoOrNull(r.expires_at)! })),
      made: made.map((r: any) => ({ id: num(r.id), name: r.name as string, slug: r.slug as string, email: (r.email as string | null) ?? null, at: isoOrNull(r.created_at)!, status: r.status as string, paid: !!r.paid })),
    };
  }),

  // ---------------------------------------------------------------- messages from stores (#5)
  'p.support.list': pproc(ALL, z.object({ status: z.enum(['open', 'closed', 'all']).default('open'), shopId: Id.optional() }), async (ctx, i) => staffThreads(ctx.t, i)),
  'p.support.get': pproc(ALL, z.object({ id: Id }), async (ctx, i) => staffThread(ctx.t, i.id)),
  /** Pilotix answers: the store sees it in « Contacter Pilotix », its author gets an e-mail. */
  'p.support.reply': pproc(ALL, z.object({ id: Id, body: z.string().max(5000) }), async (ctx, i) => {
    const r = await staffReply(ctx.t, i.id, ctx.staff.name, { body: i.body });
    await audit(ctx, 'support.reply', r.shopId, { subject: r.subject });
    const mail: OwnerMail = { kind: 'answer', to: r.to, name: r.name, language: 'fr', shop: r.shop, subject: r.subject, body: r.body };
    return { ok: true, mail };
  }),
  'p.support.setStatus': pproc(ALL, z.object({ id: Id, status: z.enum(['open', 'closed']) }), async (ctx, i) => {
    await staffSetStatus(ctx.t, i.id, i.status);
    return { ok: true };
  }),

  // ---------------------------------------------------------------- the server (#6): sizes only
  /** The database's size, and each store's (numbers only). */
  'p.health.db': pproc(MANAGERS, z.object({}), async (ctx) => {
    const total = num((await ctx.t.platform.query('SELECT pg_database_size(current_database())::bigint AS n'))[0]?.n);
    const rows = await ctx.t.platform.query(
      `SELECT n.nspname AS schema, sum(pg_total_relation_size(c.oid))::bigint AS bytes
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'm') AND (n.nspname = 'public' OR n.nspname = 'platform' OR n.nspname LIKE 'shop\\_%')
        GROUP BY n.nspname`,
    );
    const shops = await loadShops(ctx.t);
    const bySchema = new Map(rows.map((r: any) => [r.schema as string, num(r.bytes)]));
    return {
      total,
      platform: bySchema.get('platform') ?? 0,
      shops: shops
        .filter((x) => x.status !== 'deleted')
        .map((x) => ({ id: x.id, name: x.name, bytes: bySchema.get(x.schema) ?? 0 }))
        .sort((a, b) => b.bytes - a.bytes),
    };
  }),

  // ---------------------------------------------------------------- the demo shop
  'p.demo.get': pproc(ALL, z.object({}), async (ctx) => {
    const set = await platformSettings(ctx.t);
    const s = (await loadShops(ctx.t)).find((x) => x.demo && !x.primary && x.status !== 'archived') ?? null;
    return {
      shop: s ? { id: s.id, slug: s.slug, name: s.name, resetAt: s.resetAt, lastActiveAt: s.lastActiveAt, usage: await usage(ctx, s) } : null,
      public: set.demo.public,
      accounts: DEMO_ACCOUNTS.map((a) => ({ key: a.key, name: a.name, email: a.email, role: a.roles[0] })),
    };
  }),

  'p.demo.create': pproc(MANAGERS, z.object({}), async (ctx) => {
    if ((await loadShops(ctx.t)).some((x) => x.demo && !x.primary && x.status !== 'archived')) throw bad('La boutique démo existe déjà');
    const plans = await loadPlans(ctx.t);
    const plan = plans.find((p) => p.code === 'business') ?? plans.find((p) => p.code === SYSTEM_PLAN) ?? null;
    const s = await provisionShop(ctx.t, { name: 'Boutique démo', slug: await freeSlug(ctx.t, 'demo'), planId: plan?.id ?? null, trialDays: 0, owner: { name: 'Démo', email: 'admin@demo.pilotix.dz' }, password: makePassword(), demo: true, createdBy: ctx.staff.id, now: ctx.now() });
    await audit(ctx, 'demo.create', s.id, {});
    return { id: s.id };
  }),

  'p.demo.reset': pproc(MANAGERS, z.object({}), async (ctx) => {
    const s = (await loadShops(ctx.t)).find((x) => x.demo && !x.primary && x.status !== 'archived');
    if (!s) throw notFound('Pas de boutique démo');
    await resetDemoShop(ctx.t, s.id, ctx.now());
    await audit(ctx, 'demo.reset', s.id, {});
    return { ok: true };
  }),

  // ---------------------------------------------------------------- Pilot AI (Dellal's learning): settings, the coach, books
  /** Everything the Pilot AI page shows: settings (never the key), last night, lessons waiting, books and the test. */
  'p.pilot.state': pproc(ALL, z.object({}), async (ctx) => {
    const pdb = ctx.t.platform;
    const [config, night, candidates, approved, books, sharing, shops] = await Promise.all([
      pilotConfig(ctx.t),
      pilot.lastNight(pdb),
      pilot.listCandidates(pdb, { status: 'candidate', limit: 50 }),
      pilot.listCandidates(pdb, { status: 'approved', limit: 50 }),
      pilot.listBooks(pdb),
      pdb.query(`SELECT count(DISTINCT shop_id)::int AS shops, count(*)::int AS cases FROM platform.pilot_cases`),
      loadShops(ctx.t),
    ]);
    const per = new Map((await pdb.query(`SELECT shop_id, count(*)::int AS n FROM platform.pilot_cases GROUP BY shop_id`)).map((r: any) => [num(r.shop_id), num(r.n)]));
    const stores = shops
      .filter((s) => s.kind === 'store' && s.status !== 'archived' && s.status !== 'deleted' && !s.demo)
      .map((s) => ({ id: s.id, name: s.name, slug: s.slug, share: config.shops.includes(s.id), cases: per.get(s.id) ?? 0 }));
    return { config, night, candidates, approved, books, sharing: { shops: num(sharing[0]?.shops), cases: num(sharing[0]?.cases) }, shops: stores };
  }),
  'p.pilot.save': pproc(
    MANAGERS,
    z.object({ enabled: z.boolean(), maxUsd: z.number().min(0).max(5), share: z.number().min(0.05).max(0.5), key: z.string().max(300).nullable().optional() }),
    async (ctx, i) => {
      const key = i.key === undefined ? undefined : i.key === null ? null : i.key.trim() || undefined;
      if (typeof key === 'string' && !/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) throw bad('Clé Anthropic invalide (elle commence par sk-ant-)');
      await savePilotConfig(ctx.t, { enabled: i.enabled, maxUsd: i.maxUsd, share: i.share }, key);
      await audit(ctx, 'pilot.settings', null, { enabled: i.enabled, maxUsd: i.maxUsd, share: i.share, key: key === undefined ? 'kept' : key === null ? 'removed' : 'new' });
      return pilotConfig(ctx.t);
    },
  ),
  /** Which shops teach Dellal: chosen here only. Turning a shop off deletes what Pilot AI kept of its chats at once. */
  'p.pilot.share': pproc(MANAGERS, z.object({ shopId: z.number().int().positive(), share: z.boolean() }), async (ctx, i) => {
    const c = await pilotConfig(ctx.t);
    const shops = i.share ? [...new Set([...c.shops, i.shopId])] : c.shops.filter((x) => x !== i.shopId);
    await savePilotConfig(ctx.t, { ...c, shops });
    const forgot = i.share ? null : await pilot.forgetShop(ctx.t.platform, i.shopId);
    await audit(ctx, 'pilot.share', i.shopId, { share: i.share });
    return { shops, forgot };
  }),
  /** The coach: approve (optionally with a new text), edit, or reject a lesson. Every text is checked again. */
  'p.pilot.lesson': pproc(
    ALL,
    z.object({ id: z.number().int().positive(), action: z.enum(['approve', 'edit', 'reject']), text: z.string().max(400).optional(), note: z.string().max(300).optional() }),
    async (ctx, i) => {
      const by = ctx.staff.name || ctx.staff.email;
      const pdb = ctx.t.platform;
      const r =
        i.action === 'reject'
          ? await pilot.rejectLesson(pdb, i.id, by, i.note)
          : i.action === 'edit'
            ? await pilot.editLesson(pdb, i.id, by, i.text ?? '')
            : await pilot.approveLesson(pdb, i.id, by, i.text);
      if (!r.ok) throw bad(lessonErr(r));
      return r;
    },
  ),
  /** One anonymized chat behind a lesson (the coach checks the evidence). */
  'p.pilot.case': pproc(ALL, z.object({ shopId: z.number().int().positive(), convId: z.number().int().positive() }), async (ctx, i) => {
    const c = await pilot.caseText(ctx.t.platform, i.shopId, i.convId);
    if (!c) throw notFound('Conversation introuvable');
    return c;
  }),
  /** A new book from the approved lessons: tried on a share of new chats against the current one. */
  'p.pilot.publish': pproc(MANAGERS, z.object({ note: z.string().max(300).optional() }), async (ctx, i) => {
    const c = await pilotConfig(ctx.t);
    const r = await pilot.publishBook(ctx.t.platform, { by: ctx.staff.name || ctx.staff.email, share: c.share, note: i.note, now: new Date(ctx.now()) });
    if (!r.ok) throw bad(lessonErr(r));
    await audit(ctx, 'pilot.publish', null, { book: (r as any).bookId ?? null });
    return r;
  }),
  'p.pilot.promote': pproc(MANAGERS, z.object({ testId: z.number().int().positive() }), async (ctx, i) => {
    const r = await pilot.promote(ctx.t.platform, i.testId, ctx.staff.name || ctx.staff.email, { now: new Date(ctx.now()) });
    if (!r.ok) throw bad(lessonErr(r));
    await audit(ctx, 'pilot.promote', null, { test: i.testId });
    return r;
  }),
  'p.pilot.stop': pproc(MANAGERS, z.object({ testId: z.number().int().positive(), reason: z.string().max(300).optional() }), async (ctx, i) => {
    const r = await pilot.stopTest(ctx.t.platform, i.testId, ctx.staff.name || ctx.staff.email, i.reason, { now: new Date(ctx.now()) });
    if (!r.ok) throw bad(lessonErr(r));
    await audit(ctx, 'pilot.stop', null, { test: i.testId });
    return r;
  }),
  'p.pilot.rollback': pproc(MANAGERS, z.object({}), async (ctx) => {
    const r = await pilot.rollback(ctx.t.platform, ctx.staff.name || ctx.staff.email, { now: new Date(ctx.now()) });
    if (!r.ok) throw bad(lessonErr(r));
    await audit(ctx, 'pilot.rollback', null, {});
    return r;
  }),

  /**
   * What each shop's AI cost Pilotix in a month (Algeria's days), to bill it: Dellal, the CM AI agent and AI Spy, in USD
   * at Anthropic's list price, and in DA at the owner's rate. Only answers paid with Pilotix's key count in « to bill »;
   * answers a shop paid with its own key are shown apart. The night learning (Pilot AI) is Pilotix's own cost.
   */
  'p.ai.costs': pproc(MANAGERS, z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }), async (ctx, i) => {
    const month = i.month ?? monthOf(ctx.now());
    const [rows, since, bill, shops, nights] = await Promise.all([
      aiUsageOfMonth(ctx.t, month),
      aiUsageSince(ctx.t),
      aiBill(ctx.t),
      loadShops(ctx.t),
      ctx.t.platform
        .query(
          `SELECT coalesce(sum(spend_usd), 0) AS usd FROM platform.pilot_nights
            WHERE night >= ($1 || '-01')::date AND night < (($1 || '-01')::date + interval '1 month')`,
          [month],
        )
        .catch(() => [{ usd: 0 }]),
    ]);
    const names = new Map(shops.map((s) => [s.id, s]));
    type Line = { calls: number; usd: number };
    const zero = (): Line => ({ calls: 0, usd: 0 });
    const per = new Map<number, { dellal: Line; cm: Line; spy: Line; other: Line; pilotixUsd: number; shopUsd: number }>();
    for (const r of rows) {
      const p = per.get(r.shopId) ?? { dellal: zero(), cm: zero(), spy: zero(), other: zero(), pilotixUsd: 0, shopUsd: 0 };
      if (r.payer === 'pilotix') {
        p[r.feature].calls += r.calls;
        p[r.feature].usd += r.usd;
        p.pilotixUsd += r.usd;
      } else p.shopUsd += r.usd;
      per.set(r.shopId, p);
    }
    const list = [...per.entries()]
      .map(([id, p]) => {
        const s = names.get(id);
        return { id, name: s?.name ?? `#${id}`, slug: s?.slug ?? '', ...p, da: bill.rate ? Math.round(p.pilotixUsd * bill.rate) : null };
      })
      .sort((a, b) => b.pilotixUsd - a.pilotixUsd || a.name.localeCompare(b.name));
    const sum = (k: 'pilotixUsd' | 'shopUsd') => list.reduce((a, x) => a + x[k], 0);
    const total = sum('pilotixUsd');
    return {
      month,
      since,
      rate: bill.rate,
      features: AI_FEATURES,
      shops: list,
      total: { usd: total, da: bill.rate ? Math.round(total * bill.rate) : null, shopUsd: sum('shopUsd') },
      nightUsd: num(nights[0]?.usd),
    };
  }),
  /** The owner's billing rate: how many DA for 1 $ (0 = shown in USD only). */
  'p.ai.rate': pproc(MANAGERS, z.object({ rate: z.number().min(0).max(10_000) }), async (ctx, i) => {
    const r = await saveAiBill(ctx.t, { rate: i.rate });
    await audit(ctx, 'ai.rate', null, { rate: r.rate });
    return r;
  }),
};

/** The engine's refusals, in the control room's words. */
const LESSON_ERR: Record<string, string> = {
  who: 'Personne connectée inconnue',
  not_found: 'Introuvable',
  empty: 'Le texte est vide',
  lint: 'Cette leçon n’est pas sûre',
  duplicate: 'Cette leçon existe déjà',
  no_change: 'Rien à changer : aucune leçon approuvée de plus que le livre actuel',
  not_approved: 'Seules les leçons approuvées entrent dans un livre',
  test_running: 'Un test est déjà en cours : arrêtez-le ou attendez son résultat',
  not_running: 'Aucun test en cours',
  not_proven: 'Le test n’a pas encore prouvé que le nouveau livre vend au moins aussi bien',
  nothing_to_roll_back: 'Pas de livre précédent',
};
const lessonErr = (r: { error?: string; problems?: string[] }) =>
  (LESSON_ERR[r.error ?? ''] ?? 'Impossible') + (r.problems?.length ? ` (${r.problems.join(', ')})` : '');

/** Everything a payment's receipt shows. */
async function receiptOf(t: Tenancy, id: number) {
  const r = (
    await t.platform.query(
      `SELECT p.*, s.name AS shop_name, s.slug AS shop_slug, s.owner_name, s.owner_email, s.owner_phone, s.city, pl.name AS plan_name,
              a.email AS acc_email, a.name AS acc_name, a.language AS acc_lang
         FROM platform.payments p JOIN platform.shops s ON s.id = p.shop_id LEFT JOIN platform.plans pl ON pl.id = p.plan_id
         LEFT JOIN platform.accounts a ON a.id = s.owner_account_id WHERE p.id = $1`,
      [id],
    )
  )[0];
  if (!r) throw notFound('Paiement introuvable');
  const set = await platformSettings(t);
  return {
    ...paymentRow(r),
    plan: (r.plan_name as string | null) ?? null,
    language: (r.acc_lang as string | null) ?? 'fr',
    shop: {
      id: num(r.shop_id),
      name: r.shop_name as string,
      slug: r.shop_slug as string,
      ownerName: ((r.acc_name as string | null) || (r.owner_name as string | null)) ?? null,
      ownerEmail: ((r.acc_email as string | null) || (r.owner_email as string | null)) ?? null,
      ownerPhone: (r.owner_phone as string | null) ?? null,
      city: (r.city as string | null) ?? null,
    },
    company: set.company,
  };
}

function paymentRow(r: any) {
  return {
    id: num(r.id),
    receiptNo: (r.receipt_no as string | null) ?? null,
    shopId: num(r.shop_id),
    amount: num(r.amount),
    method: r.method as (typeof PAYMENT_METHODS)[number],
    reference: (r.reference as string | null) ?? null,
    months: num(r.months),
    periodFrom: isoOrNull(r.period_from),
    periodTo: isoOrNull(r.period_to),
    paidAt: isoOrNull(r.paid_at),
    note: (r.note as string | null) ?? null,
    by: (r.by_name as string | null) ?? null,
    voidAt: isoOrNull(r.void_at),
    voidReason: (r.void_reason as string | null) ?? null,
  };
}

function auditRow(r: any) {
  return {
    id: num(r.id),
    at: isoOrNull(r.at),
    staff: (r.staff_name as string | null) ?? null,
    shopId: numOrNull(r.shop_id),
    shop: (r.shop_name as string | null) ?? null,
    action: r.action as string,
    details: (typeof r.details === 'string' ? JSON.parse(r.details) : r.details ?? {}) as Record<string, unknown>,
  };
}

export type PlatformRegistry = typeof PLATFORM_REGISTRY;
export type PlatformProcName = keyof PlatformRegistry;

/** Runs one control-room action for a staff member (role and input checked). */
export async function platformCall(name: string, ctx: PCtx, raw: unknown): Promise<unknown> {
  const p = (PLATFORM_REGISTRY as unknown as Record<string, PProcedure>)[name];
  if (!p) throw notFound(`Action inconnue : ${name}`);
  if (ctx.staff.role !== 'owner' && !p.roles.includes(ctx.staff.role)) throw forbidden('Réservé au propriétaire de Pilotix');
  const parsed = p.input.safeParse(raw ?? {});
  if (!parsed.success) {
    const iss = parsed.error.issues[0];
    throw bad(`Champ invalide : ${iss.path.join('.') || 'entrée'} (${iss.message})`);
  }
  return p.run(ctx, parsed.data);
}

export { FEATURE_KEYS, toPlan };
