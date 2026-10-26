// The control room's actions (Pilotix staff only): shops, trials, payments, plans and their menus, staff, settings,
// the journal and the demo shop. Same shape as the shops' actions (input checked, roles checked), own registry.
import { DEMO_ACCOUNTS, FEATURE_KEYS } from '@pilotix/shared';
import bcrypt from 'bcryptjs';
import { z, ZodTypeAny } from 'zod';
import { isoOrNull, num, numOrNull } from '../db';
import { AppError, bad, forbidden, notFound } from '../rpc';
import { STORE_RESERVED } from '../modules/landingquery';
import { hashPassword } from '../modules/users';
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
  shopMaxUsers,
  shopStatus,
  shopUsage,
  slugify,
  slugOk,
  SYSTEM_PLAN,
  toPlan,
} from './shops';
import type { Tenancy } from './tenancy';

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

/** The staff member of a token, if still active with the same token version. */
export async function staffById(t: Tenancy, id: number, tv: number): Promise<StaffSession | null> {
  const r = (await t.platform.query('SELECT * FROM platform.staff WHERE id = $1', [id]))[0];
  return r && r.active && num(r.token_version) === tv ? toStaff(r) : null;
}

/** Is this e-mail also a Pilotix staff account? (the shop menu then shows the way to the control room) */
export async function isStaffEmail(t: Tenancy, email: string): Promise<boolean> {
  return (await t.platform.query('SELECT 1 FROM platform.staff WHERE email = $1 AND active', [email.trim().toLowerCase()])).length > 0;
}

/** Who Pilotix support acts as when it opens a shop: its first active administrator. */
export async function supportProfile(t: Tenancy, s: Shop): Promise<{ id: number; tv: number; name: string } | null> {
  const r = (await t.shop(s.schema).query(`SELECT id, name, token_version FROM profiles WHERE active AND 'admin' = ANY(roles) AND email NOT LIKE '%@pilotix.invalid' ORDER BY id LIMIT 1`))[0];
  return r ? { id: num(r.id), tv: num(r.token_version), name: r.name } : null;
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

const usageCache = new WeakMap<Tenancy, Map<number, { at: number; v: Awaited<ReturnType<typeof shopUsage>> }>>();
async function usage(ctx: PCtx, s: Shop, fresh = false) {
  let m = usageCache.get(ctx.t);
  if (!m) usageCache.set(ctx.t, (m = new Map()));
  const hit = m.get(s.id);
  if (!fresh && hit && ctx.now() - hit.at < 60_000) return hit.v;
  const v = await shopUsage(ctx.t, s).catch(() => ({ users: 0, ordersMonth: 0, ordersTotal: 0, lastOrderAt: null }));
  m.set(s.id, { at: ctx.now(), v });
  return v;
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
  };
}

const IsoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'date invalide');
const Id = z.number().int().positive();
const Features = z.array(z.string().max(60)).max(200);

const SLUG_HELP = 'Nom dans les liens invalide : 2 à 40 lettres minuscules, chiffres et tirets (ex. ma-boutique)';
/** the shop's name in its links: the format, and not a word of the app (api, live, assets…) */
function checkSlug(slug: string) {
  if (STORE_RESERVED.includes(slug)) throw bad('Ce nom est réservé par Pilotix, choisissez-en un autre');
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
    const shops = (await loadShops(ctx.t)).map((s) => shopRow(s, set, now));
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
    return {
      counts: { total: real.length, trial: count('trial'), active: count('active'), grace: count('grace'), expired: count('expired'), suspended: count('suspended'), archived: count('archived'), newThisMonth: createdThisMonth },
      mrr: real.filter((s) => s.state === 'active').reduce((a, s) => a + (s.plan?.priceMonth ?? 0), 0),
      revenue: { thisMonth: byMonth.find((b) => b.month === month)?.amount ?? 0, lastMonth: byMonth.find((b) => b.month === prev)?.amount ?? 0, byMonth },
      trialsEnding: real.filter((s) => s.state === 'trial' && (s.daysLeft ?? 99) <= 3).sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0)),
      renewSoon: real.filter((s) => s.state === 'active' && (s.daysLeft ?? 99) <= 7).sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0)),
      late: real.filter((s) => s.state === 'grace' || s.state === 'expired').sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0)),
      recent: recent.map(auditRow),
    };
  }),

  'p.shops.list': pproc(ALL, z.object({ q: z.string().max(100).optional(), state: z.string().max(20).optional() }), async (ctx, i) => {
    const now = ctx.now();
    const set = await platformSettings(ctx.t);
    const all = await loadShops(ctx.t);
    const q = (i.q ?? '').trim().toLowerCase();
    const rows = [];
    for (const s of all) {
      const r = shopRow(s, set, now);
      if (i.state && i.state !== 'all' && r.state !== i.state && !(i.state === 'late' && (r.state === 'grace' || r.state === 'expired'))) continue;
      if (q && ![s.name, s.slug, s.ownerName, s.ownerEmail, s.ownerPhone, s.city].some((v) => v?.toLowerCase().includes(q))) continue;
      rows.push({ ...r, usage: await usage(ctx, s) });
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
    const admins =
      s.status === 'archived'
        ? []
        : await ctx.t.shop(s.schema).query(`SELECT id, name, email, phone, active, last_seen_at FROM profiles WHERE 'admin' = ANY(roles) AND email NOT LIKE '%@pilotix.invalid' ORDER BY id`).catch(() => []);
    return {
      ...shopRow(s, set, now),
      notes: s.notes,
      featuresOn: s.featuresOn,
      featuresOff: s.featuresOff,
      planFeatures: s.primary || s.plan?.system ? ['*'] : s.plan?.features ?? [],
      features: shopFeatures(s),
      maxUsers: s.maxUsers,
      maxUsersEffective: shopMaxUsers(s),
      maxOrdersMonth: s.plan?.maxOrdersMonth ?? null,
      resetAt: s.resetAt,
      usage: await usage(ctx, s, true),
      admins: admins.map((a: any) => ({ id: num(a.id), name: a.name as string, email: a.email as string, phone: (a.phone as string | null) ?? null, active: !!a.active, lastSeenAt: isoOrNull(a.last_seen_at) })),
      payments: payments.map(paymentRow),
      log: log.map(auditRow),
    };
  }),

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
      password: z.string().min(10).max(200).optional(),
      notes: z.string().max(2000).optional(),
    }),
    async (ctx, i) => {
      const plan = (await loadPlans(ctx.t)).find((p) => p.id === i.planId);
      if (!plan) throw bad('Formule introuvable');
      if (i.slug) checkSlug(i.slug);
      const password = i.password || makePassword();
      let shop: Shop;
      try {
        shop = await provisionShop(ctx.t, {
          name: i.name,
          slug: i.slug || undefined,
          planId: plan.id,
          trialDays: i.trialDays,
          owner: { name: i.ownerName, email: i.ownerEmail, phone: i.ownerPhone ?? null },
          password,
          city: i.city ?? null,
          notes: i.notes ?? '',
          createdBy: ctx.staff.id,
          now: ctx.now(),
        });
      } catch (e) {
        shopError(e);
      }
      await audit(ctx, 'shop.create', shop.id, { name: shop.name, plan: plan.name, trialDays: i.trialDays, email: i.ownerEmail.toLowerCase() });
      return { id: shop.id, slug: shop.slug, name: shop.name, email: i.ownerEmail.trim().toLowerCase(), password };
    },
  ),

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
    }),
    async (ctx, i) => {
      const s = await needShop(ctx, i.id);
      if (s.primary && (i.planId !== undefined || i.trialEndsAt !== undefined || i.paidUntil !== undefined)) throw bad('Votre propre boutique n’a ni formule ni échéance : elle ne s’arrête jamais');
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
    if (s.primary && i.status !== 'active') throw bad('Votre propre boutique ne peut pas être suspendue');
    if (s.status === i.status) return { ok: true };
    await ctx.t.platform.query('UPDATE platform.shops SET status = $2, status_reason = $3 WHERE id = $1', [s.id, i.status, i.status === 'active' ? null : i.reason || null]);
    await audit(ctx, `shop.${i.status === 'active' ? 'reactivate' : i.status === 'suspended' ? 'suspend' : 'archive'}`, s.id, { from: s.status, reason: i.reason ?? null });
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

  /** A shop's administrator forgot the password (no e-mail): a new one, shown once. Their open sessions end. */
  'p.shops.resetAdminPassword': pproc(MANAGERS, z.object({ id: Id, profileId: Id }), async (ctx, i) => {
    const s = await needShop(ctx, i.id);
    if (s.status === 'archived') throw bad('Boutique archivée');
    const password = makePassword();
    const r = (
      await ctx.t
        .shop(s.schema)
        .query(`UPDATE profiles SET password_hash = $2, token_version = token_version + 1 WHERE id = $1 AND 'admin' = ANY(roles) RETURNING email, name`, [i.profileId, await hashPassword(password)])
    )[0];
    if (!r) throw notFound('Administrateur introuvable');
    await audit(ctx, 'shop.adminPassword', s.id, { email: r.email });
    return { email: r.email as string, name: r.name as string, password };
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
      const out = await ctx.t.platform.tx(async (db) => {
        const cur = (await db.query('SELECT status FROM platform.shops WHERE id = $1 FOR UPDATE', [s.id]))[0];
        // from today, or from the end of the trial / of the period already paid when it is still ahead
        const p = (
          await db.query(
            `INSERT INTO platform.payments (shop_id, amount, method, reference, months, plan_id, period_from, period_to, paid_at, note, created_by)
             SELECT $1, $2, $3, $4, $5, $6, x.f, x.f + make_interval(months => $5), COALESCE($7::timestamptz, now()), $8, $9
               FROM (SELECT GREATEST(now(), paid_until, trial_ends_at) AS f FROM platform.shops WHERE id = $1) x
             RETURNING id, period_to`,
            [s.id, i.amount, i.method, i.reference || null, i.months, i.planId ?? s.planId, i.paidAt ? new Date(i.paidAt).toISOString() : null, i.note || null, ctx.staff.id],
          )
        )[0];
        await db.query(
          `UPDATE platform.shops sh SET paid_until = p.period_to, plan_id = COALESCE($3, sh.plan_id),
             status = CASE WHEN sh.status = 'suspended' THEN 'active' ELSE sh.status END,
             status_reason = CASE WHEN sh.status = 'suspended' THEN NULL ELSE sh.status_reason END
             FROM platform.payments p WHERE sh.id = $1 AND p.id = $2`,
          [s.id, p.id, i.planId ?? null],
        );
        return { id: num(p.id), paidUntil: isoOrNull(p.period_to), reactivated: cur.status === 'suspended' };
      });
      await audit(ctx, 'payment.add', s.id, { amount: i.amount, method: i.method, months: i.months, paidUntil: out.paidUntil, reference: i.reference ?? null, reactivated: out.reactivated });
      return out;
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
      maxOrdersMonth: z.number().int().min(1).max(10_000_000).nullable().optional(),
      description: z.string().max(400).optional(),
      public: z.boolean(),
      active: z.boolean(),
    }),
    async (ctx, i) => {
      const old = i.id ? (await loadPlans(ctx.t)).find((p) => p.id === i.id) : null;
      if (i.id && !old) throw notFound('Formule introuvable');
      const features = old?.system ? ['*'] : cleanFeatures(i.features, true);
      const vals = [i.name, i.priceMonth, i.priceYear ?? null, JSON.stringify(features), i.maxUsers ?? null, i.maxOrdersMonth ?? null, i.description ?? '', old?.system ? false : i.public, old?.system ? true : i.active];
      let id = i.id ?? 0;
      if (old) {
        await ctx.t.platform.query(
          `UPDATE platform.plans SET name=$2, price_month=$3, price_year=$4, features=$5, max_users=$6, max_orders_month=$7, description=$8, public=$9, active=$10 WHERE id=$1`,
          [old.id, ...vals],
        );
      } else {
        let code = slugify(i.name);
        for (let k = 2; (await ctx.t.platform.query('SELECT 1 FROM platform.plans WHERE code = $1', [code])).length; k++) code = `${slugify(i.name)}-${k}`;
        const sort = num((await ctx.t.platform.query('SELECT COALESCE(max(sort), 0) + 1 AS s FROM platform.plans'))[0]?.s);
        id = num(
          (
            await ctx.t.platform.query(
              `INSERT INTO platform.plans (code, name, price_month, price_year, features, max_users, max_orders_month, description, public, active, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
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
    }),
    async (ctx, i) => {
      for (const k of ['trial', 'payment', 'notice', 'demo'] as const) if (i[k]) await setPlatformSetting(ctx.t, k, i[k] as any);
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
};

function paymentRow(r: any) {
  return {
    id: num(r.id),
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
