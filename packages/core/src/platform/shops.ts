// Shops of a multi-shop server: reading them, their subscription state, creating one (its own schema), the demo shop,
// and the first start (the server owner's shop becomes shop #1, its first admin the platform owner).
import { effectiveFeatures, isFeatureKey, ShopInfo, ShopState } from '@pilotix/shared';
import { Db, isoOrNull, migrate, num, numOrNull } from '../db';
import type { ShopCtx } from '../rpc';
import { landingSettings, landingStore, STORE_RESERVED } from '../modules/landingquery';
import { seedBase, seedDemo } from '../seed';
import { DEFAULT_SETTINGS, setSetting } from '../settings';
import { ensureLoginTrigger, migratePlatform } from './schema';
import { schemaOf, SCHEMA_RE, Tenancy } from './tenancy';

const DAY = 86_400_000;

export interface Plan {
  id: number;
  code: string;
  name: string;
  priceMonth: number;
  priceYear: number | null;
  /** feature list (see @pilotix/shared features.ts): menu items, '-item/sub' sub-menus taken out, '*' = everything */
  features: string[];
  maxUsers: number | null;
  maxOrdersMonth: number | null;
  description: string;
  /** offered to new shops (false: the internal plan) */
  public: boolean;
  active: boolean;
  sort: number;
  /** the internal plan of the owner's shop: always everything */
  system: boolean;
}

export interface Shop {
  id: number;
  slug: string;
  name: string;
  schema: string;
  planId: number | null;
  plan: Plan | null;
  status: 'active' | 'suspended' | 'archived';
  statusReason: string | null;
  trialEndsAt: string | null;
  paidUntil: string | null;
  neverExpires: boolean;
  demo: boolean;
  primary: boolean;
  featuresOn: string[];
  featuresOff: string[];
  /** this shop's own limit (null = the plan's) */
  maxUsers: number | null;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerPhone: string | null;
  city: string | null;
  notes: string;
  lastActiveAt: string | null;
  resetAt: string | null;
  createdAt: string;
}

const json = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);
const list = (v: unknown): string[] => (Array.isArray(json(v)) ? (json(v) as unknown[]).map(String) : []);

export const SYSTEM_PLAN = 'interne';

export const toPlan = (r: any): Plan => ({
  id: num(r.id),
  code: r.code,
  name: r.name,
  priceMonth: num(r.price_month),
  priceYear: numOrNull(r.price_year),
  features: list(r.features),
  maxUsers: numOrNull(r.max_users),
  maxOrdersMonth: numOrNull(r.max_orders_month),
  description: r.description ?? '',
  public: !!r.public,
  active: !!r.active,
  sort: num(r.sort),
  system: r.code === SYSTEM_PLAN,
});

const SHOP_SELECT = `SELECT s.*, row_to_json(p.*) AS plan_row FROM platform.shops s LEFT JOIN platform.plans p ON p.id = s.plan_id`;

export const toShop = (r: any): Shop => ({
  id: num(r.id),
  slug: r.slug,
  name: r.name,
  schema: r.schema_name,
  planId: numOrNull(r.plan_id),
  plan: r.plan_row ? toPlan(json(r.plan_row)) : null,
  status: r.status,
  statusReason: r.status_reason ?? null,
  trialEndsAt: isoOrNull(r.trial_ends_at),
  paidUntil: isoOrNull(r.paid_until),
  neverExpires: !!r.never_expires,
  demo: !!r.is_demo,
  primary: !!r.primary_shop,
  featuresOn: list(r.features_on),
  featuresOff: list(r.features_off),
  maxUsers: numOrNull(r.max_users),
  ownerName: r.owner_name ?? null,
  ownerEmail: r.owner_email ?? null,
  ownerPhone: r.owner_phone ?? null,
  city: r.city ?? null,
  notes: r.notes ?? '',
  lastActiveAt: isoOrNull(r.last_active_at),
  resetAt: isoOrNull(r.reset_at),
  createdAt: new Date(r.created_at).toISOString(),
});

export async function loadPlans(t: Tenancy): Promise<Plan[]> {
  return (await t.platform.query('SELECT * FROM platform.plans ORDER BY sort, id')).map(toPlan);
}

export async function loadShops(t: Tenancy): Promise<Shop[]> {
  return (await t.platform.query(`${SHOP_SELECT} ORDER BY s.primary_shop DESC, s.id`)).map(toShop);
}

export async function loadShop(t: Tenancy, by: { id: number } | { slug: string } | { primary: true }): Promise<Shop | null> {
  const r =
    'id' in by
      ? await t.platform.query(`${SHOP_SELECT} WHERE s.id = $1`, [by.id])
      : 'slug' in by
        ? await t.platform.query(`${SHOP_SELECT} WHERE s.slug = $1`, [by.slug])
        : await t.platform.query(`${SHOP_SELECT} WHERE s.primary_shop`);
  return r[0] ? toShop(r[0]) : null;
}

/** The shop of an account's e-mail (null = no shop knows it). */
export async function shopIdOfEmail(t: Tenancy, email: string): Promise<number | null> {
  const r = await t.platform.query('SELECT shop_id FROM platform.logins WHERE email = $1', [email.trim().toLowerCase()]);
  return r[0] ? num(r[0].shop_id) : null;
}

// ---------------------------------------------------------------- settings of the platform
export interface PlatformSettings {
  /** new shops: free trial days, days of grace after the end before the lock, plan offered by default */
  trial: { days: number; graceDays: number; planCode: string };
  /** how shops pay (shown to them): free text (BaridiMob RIP, CCP account…), phone, WhatsApp */
  payment: { text: string; phone: string; whatsapp: string };
  /** a message shown to every shop until `until` (empty = none) */
  notice: { text: string; tone: 'info' | 'warn'; until: string | null };
  /** the demo shop: its button on the login page */
  demo: { public: boolean };
}

export const PLATFORM_DEFAULTS: PlatformSettings = {
  trial: { days: 14, graceDays: 3, planCode: 'pro' },
  payment: { text: '', phone: '', whatsapp: '' },
  notice: { text: '', tone: 'info', until: null },
  demo: { public: false },
};

export async function platformSettings(t: Tenancy): Promise<PlatformSettings> {
  const rows = await t.platform.query<{ key: string; value: unknown }>('SELECT key, value FROM platform.settings');
  const out = structuredClone(PLATFORM_DEFAULTS) as any;
  for (const r of rows) if (r.key in out) out[r.key] = { ...out[r.key], ...json(r.value) };
  return out as PlatformSettings;
}

export async function setPlatformSetting<K extends keyof PlatformSettings>(t: Tenancy, key: K, value: PlatformSettings[K]) {
  await t.platform.query(
    `INSERT INTO platform.settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

// ---------------------------------------------------------------- subscription state
export interface ShopStatus {
  state: ShopState;
  /** days left in the trial / the paid period; in grace: days before the lock */
  daysLeft: number | null;
  locked: boolean;
}

/**
 * Trial until trial_ends_at, active while paid_until is ahead, then `graceDays` of grace (works, red banner), then
 * locked until a payment. Suspended / archived by Pilotix: locked. The owner's shop never expires.
 */
export function shopStatus(s: Pick<Shop, 'status' | 'trialEndsAt' | 'paidUntil' | 'neverExpires'>, now: number, graceDays: number): ShopStatus {
  if (s.status === 'archived') return { state: 'archived', daysLeft: null, locked: true };
  if (s.status === 'suspended') return { state: 'suspended', daysLeft: null, locked: true };
  if (s.neverExpires) return { state: 'active', daysLeft: null, locked: false };
  const paid = s.paidUntil ? Date.parse(s.paidUntil) : 0;
  const trial = s.trialEndsAt ? Date.parse(s.trialEndsAt) : 0;
  if (paid > now) return { state: 'active', daysLeft: Math.ceil((paid - now) / DAY), locked: false };
  if (trial > now) return { state: 'trial', daysLeft: Math.ceil((trial - now) / DAY), locked: false };
  const end = Math.max(paid, trial);
  const lock = end + Math.max(0, graceDays) * DAY;
  if (end && now < lock) return { state: 'grace', daysLeft: Math.ceil((lock - now) / DAY), locked: false };
  return { state: 'expired', daysLeft: 0, locked: true };
}

/** The shop's features after its own changes (null = everything). */
export const shopFeatures = (s: Shop): string[] | null => (s.primary || s.plan?.system ? effectiveFeatures(['*'], s.featuresOn, s.featuresOff) : effectiveFeatures(s.plan?.features ?? [], s.featuresOn, s.featuresOff));

export const shopMaxUsers = (s: Shop): number | null => s.maxUsers ?? s.plan?.maxUsers ?? null;

/** What a request of this shop carries (rules checked by the core). */
export function shopCtx(s: Shop, st: ShopStatus): ShopCtx {
  return { id: s.id, slug: s.slug, primary: s.primary, features: shopFeatures(s), locked: st.locked, demo: s.demo, maxUsers: shopMaxUsers(s) };
}

/** What the app shows of the shop: its plan, its state, how to pay, Pilotix's message. */
export function shopInfo(s: Shop, st: ShopStatus, settings: PlatformSettings, now: number, support: string | null = null): ShopInfo {
  const n = settings.notice;
  const noticeOn = !!n.text.trim() && (!n.until || Date.parse(n.until) > now);
  const pay = settings.payment;
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    primary: s.primary,
    demo: s.demo,
    state: st.state,
    plan: s.plan && !s.plan.system ? s.plan.name : null,
    planPrice: s.plan && !s.plan.system ? s.plan.priceMonth : null,
    trialEndsAt: s.trialEndsAt,
    paidUntil: s.paidUntil,
    daysLeft: st.daysLeft,
    locked: st.locked,
    features: shopFeatures(s),
    maxUsers: shopMaxUsers(s),
    payment: s.primary || s.demo || (!pay.text.trim() && !pay.phone.trim() && !pay.whatsapp.trim()) ? null : { text: pay.text, phone: pay.phone, whatsapp: pay.whatsapp },
    notice: noticeOn ? { text: n.text, tone: n.tone } : null,
    support,
  };
}

// ---------------------------------------------------------------- creating shops
/**
 * A shop's name on the platform, unique, is also the first part of its links: site/<store>/<page> for its landing pages,
 * /api/s/<store>/… for its webhooks. 2 to 40 latin letters, digits and dashes, never a word the app uses itself.
 */
export function slugify(s: string): string {
  const out = s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  if (out.length < 2) return 'boutique';
  return STORE_RESERVED.includes(out) ? `${out}-boutique` : out;
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
/** a name a shop can have (the format, and not a word of the app: api, live, assets…) */
export const slugOk = (s: string): boolean => SLUG_RE.test(s) && !STORE_RESERVED.includes(s);

export async function freeSlug(t: Tenancy, wanted: string, exceptId?: number): Promise<string> {
  const base = slugify(wanted);
  for (let i = 1; i < 500; i++) {
    const s = i === 1 ? base : `${base.slice(0, 36)}-${i}`;
    const r = await t.platform.query('SELECT id FROM platform.shops WHERE slug = $1', [s]);
    if (!r.length || num(r[0].id) === exceptId) return s;
  }
  throw new Error('No free slug');
}

/** A password easy to read and send by WhatsApp: Pilotix-XXXX-XXXX (no 0/O, 1/I/L). */
export function makePassword(): string {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const r = globalThis.crypto.getRandomValues(new Uint32Array(8));
  const part = (o: number) => Array.from({ length: 4 }, (_, i) => A[r[o + i] % A.length]).join('');
  return `Pilotix-${part(0)}-${part(4)}`;
}

/** Applies the shops' migrations to one schema and keeps its login index. */
export async function migrateShop(t: Tenancy, schema: string): Promise<string[]> {
  const applied = await migrate(t.shop(schema), (sql) => t.exec(schema, sql));
  await ensureLoginTrigger(t, schema);
  return applied;
}

export interface NewShop {
  name: string;
  slug?: string;
  planId: number | null;
  trialDays: number;
  owner: { name: string; email: string; phone?: string | null };
  /** the first administrator's password (≥ 10 characters) */
  password: string;
  city?: string | null;
  notes?: string;
  demo?: boolean;
  createdBy?: number | null;
  now?: number;
}

/**
 * A new shop: its row, its own schema with every table, its first administrator and default depot (the demo shop: the
 * demo data instead). Undone completely if any step fails.
 */
export async function provisionShop(t: Tenancy, n: NewShop): Promise<Shop> {
  const email = n.owner.email.trim().toLowerCase();
  if (!n.demo && (await shopIdOfEmail(t, email))) throw new Error('EMAIL_TAKEN');
  const slug = n.slug ? n.slug : await freeSlug(t, n.name);
  if (!slugOk(slug)) throw new Error('BAD_SLUG');
  if ((await t.platform.query('SELECT 1 FROM platform.shops WHERE slug = $1', [slug])).length) throw new Error('SLUG_TAKEN');
  const now = n.now ?? Date.now();
  const trialEnds = n.trialDays > 0 ? new Date(now + n.trialDays * DAY).toISOString() : null;
  const row = (
    await t.platform.query(
      `WITH n AS (SELECT nextval(pg_get_serial_sequence('platform.shops', 'id'))::int AS id)
       INSERT INTO platform.shops (id, slug, name, schema_name, plan_id, trial_ends_at, never_expires, is_demo, owner_name, owner_email, owner_phone, city, notes, created_by)
       SELECT n.id, $1, $2, 'shop_' || n.id, $3, $4, $5, $5, $6, $7, $8, $9, $10, $11 FROM n RETURNING id, schema_name`,
      [slug, n.name.trim(), n.planId, trialEnds, !!n.demo, n.owner.name.trim(), email, n.owner.phone?.trim() || null, n.city?.trim() || null, n.notes ?? '', n.createdBy ?? null],
    )
  )[0];
  const id = num(row.id);
  const schema = row.schema_name as string;
  if (schema !== schemaOf(id) || !SCHEMA_RE.test(schema)) throw new Error('Invalid schema');
  try {
    await t.exec('platform', `CREATE SCHEMA ${schema}`);
    await migrateShop(t, schema);
    const db = t.shop(schema);
    if (n.demo) await fillDemo(db, n.name.trim(), now);
    else {
      await seedBase(db, { email, password: n.password, name: n.owner.name.trim() || undefined });
      await setSetting(db, 'shop', { ...DEFAULT_SETTINGS.shop, name: n.name.trim() });
    }
    await setShopStore(db, slug);
    if (n.demo) await t.platform.query('UPDATE platform.shops SET reset_at = now() WHERE id = $1', [id]);
  } catch (e) {
    await dropShopData(t, id, schema).catch(() => {});
    await t.platform.query('DELETE FROM platform.shops WHERE id = $1', [id]).catch(() => {});
    throw e;
  }
  return (await loadShop(t, { id }))!;
}

async function fillDemo(db: Db, name: string, now: number) {
  await seedDemo(db, { orders: 600, now });
  await setSetting(db, 'shop', { ...DEFAULT_SETTINGS.shop, name });
}

async function dropShopData(t: Tenancy, id: number, schema: string) {
  if (!/^shop_\d+$/.test(schema)) throw new Error('Only a shop_<id> schema can be dropped');
  await t.platform.query('DELETE FROM platform.logins WHERE shop_id = $1', [id]);
  await t.exec('platform', `DROP SCHEMA IF EXISTS ${schema} CASCADE`);
}

/** The demo shop starts again from fresh demo data (every change made by visitors is gone). */
export async function resetDemoShop(t: Tenancy, id: number, now = Date.now()): Promise<void> {
  const s = await loadShop(t, { id });
  if (!s || !s.demo || s.primary) throw new Error('Not a demo shop');
  await dropShopData(t, s.id, s.schema);
  await t.exec('platform', `CREATE SCHEMA ${s.schema}`);
  await migrateShop(t, s.schema);
  await fillDemo(t.shop(s.schema), s.name, now);
  await setShopStore(t.shop(s.schema), s.slug);
  await t.platform.query('UPDATE platform.shops SET reset_at = now() WHERE id = $1', [s.id]);
}

/** Active accounts and orders of a shop (this month, all time), for the control room. */
export async function shopUsage(t: Tenancy, s: Shop) {
  if (s.status === 'archived') return { users: 0, ordersMonth: 0, ordersTotal: 0, lastOrderAt: null as string | null };
  const r = (
    await t.shop(s.schema).query(
      `SELECT (SELECT count(*) FROM profiles WHERE active AND email NOT LIKE '%@pilotix.invalid')::int AS users,
              (SELECT count(*) FROM orders WHERE NOT is_exchange AND created_at >= date_trunc('month', now()))::int AS month,
              (SELECT count(*) FROM orders WHERE NOT is_exchange)::int AS total,
              (SELECT max(created_at) FROM orders) AS last`,
    )
  )[0];
  return { users: num(r?.users), ordersMonth: num(r?.month), ordersTotal: num(r?.total), lastOrderAt: isoOrNull(r?.last) };
}

// ---------------------------------------------------------------- first start
/** Plans offered at the start (prices are examples: the owner changes them in the control room). */
const DEFAULT_PLANS = [
  { code: SYSTEM_PLAN, name: 'Interne', price: 0, features: ['*'], users: null, orders: null, pub: false, desc: 'Votre propre boutique : tout est inclus, sans fin.' },
  {
    code: 'essentiel',
    name: 'Essentiel',
    price: 3900,
    features: ['dashboard', 'commandes', 'scanner', 'sav', 'tournee', 'produits', 'clients', 'caisse', 'macaisse', 'livraison', 'management'],
    users: 5,
    orders: 1500,
    pub: true,
    desc: 'Commandes, confirmation, dépôt, livraison, stock, caisse.',
  },
  {
    code: 'pro',
    name: 'Pro',
    price: 7900,
    features: ['dashboard', 'commandes', 'scanner', 'sav', 'tournee', 'produits', 'pilotai', '-pilotai/cm', '-pilotai/messages', 'clients', 'marketing', '-marketing/spy', 'landing', 'caisse', 'macaisse', 'livraison', 'management'],
    users: 15,
    orders: 6000,
    pub: true,
    desc: 'Essentiel + landing pages, publicité, marketeurs, Delivery AI agent.',
  },
  { code: 'business', name: 'Business', price: 14900, features: ['*'], users: null, orders: null, pub: true, desc: 'Tout Pilotix : Message AI agent, CM AI agent, AI Spy…' },
];

/**
 * Makes the platform ready (every start, safe to repeat): the plans, the owner's shop as shop #1 (schema "public",
 * never expires), its e-mails in the login index and the trigger that keeps them, and — once the shop has an
 * administrator — that administrator as the platform owner (same e-mail and password).
 */
export async function bootstrapPlatform(t: Tenancy): Promise<void> {
  if (!(await t.platform.query('SELECT 1 FROM platform.plans LIMIT 1')).length)
    for (const [i, p] of DEFAULT_PLANS.entries())
      await t.platform.query(
        `INSERT INTO platform.plans (code, name, price_month, features, max_users, max_orders_month, description, public, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (code) DO NOTHING`,
        [p.code, p.name, p.price, JSON.stringify(p.features), p.users, p.orders, p.desc, p.pub, i],
      );
  if (!(await loadShop(t, { primary: true }))) {
    const sys = (await t.platform.query('SELECT id FROM platform.plans WHERE code = $1', [SYSTEM_PLAN]))[0];
    const named = (await t.shop('public').query(`SELECT value->>'name' AS name FROM settings WHERE key = 'shop'`).catch(() => []))[0]?.name;
    const name = String(named || 'Ma boutique').trim() || 'Ma boutique';
    await t.platform.query(
      `INSERT INTO platform.shops (slug, name, schema_name, plan_id, never_expires, primary_shop) VALUES ($1, $2, 'public', $3, true, true)`,
      [await freeSlug(t, name), name, sys ? num(sys.id) : null],
    );
  }
  const primary = (await loadShop(t, { primary: true }))!;
  await t.platform.query(
    `INSERT INTO platform.logins (email, shop_id)
     SELECT lower(email), $1 FROM public.profiles WHERE email NOT LIKE '%@pilotix.invalid' AND email NOT LIKE '%@demo.pilotix.dz'
     ON CONFLICT (email) DO NOTHING`,
    [primary.id],
  );
  await ensureLoginTrigger(t, 'public');
  await ensureOwnerStaff(t);
  await syncPrimaryStore(t);
}

/**
 * Any shop but #1: the store's part of its links (site/<store>/<page>) is its name on the platform. Kept in its own
 * settings, so its pages and its llms.txt name it; the shop cannot change it (its webhooks use the same name).
 */
export async function setShopStore(db: Db, slug: string): Promise<void> {
  const s = await landingSettings(db);
  if (s.storeSlug !== slug) await setSetting(db, 'landing', { ...s, storeSlug: slug });
}

/**
 * Shop #1 chooses the store's part of its links itself (Landing pages › Réglages; empty = made from the shop's name):
 * its name on the platform follows, so every shop has one name, unique. If another shop already has that name, shop #1
 * keeps the one it had (written in its settings, so its links do not move).
 */
export async function syncPrimaryStore(t: Tenancy): Promise<void> {
  const p = await loadShop(t, { primary: true });
  if (!p) return;
  const db = t.shop('public');
  const s = await landingSettings(db);
  const want = await landingStore(db, s);
  if (want === p.slug) return;
  const taken = !slugOk(want) || (await t.platform.query('SELECT 1 FROM platform.shops WHERE slug = $1 AND NOT primary_shop', [want])).length > 0;
  if (!taken) await t.platform.query('UPDATE platform.shops SET slug = $1 WHERE primary_shop', [want]);
  else await setSetting(db, 'landing', { ...s, storeSlug: p.slug });
}

/** No staff yet: the owner's shop's first administrator becomes the platform owner (same e-mail and password). */
export async function ensureOwnerStaff(t: Tenancy): Promise<void> {
  if ((await t.platform.query('SELECT 1 FROM platform.staff LIMIT 1')).length) return;
  await t.platform.query(
    `INSERT INTO platform.staff (name, email, password_hash, role)
     SELECT name, lower(email), password_hash, 'owner' FROM public.profiles
      WHERE active AND 'admin' = ANY(roles) AND email NOT LIKE '%@demo.pilotix.dz' AND email NOT LIKE '%@pilotix.invalid'
      ORDER BY id LIMIT 1
     ON CONFLICT (email) DO NOTHING`,
  );
}

/**
 * Everything a start needs, in order: the platform's tables, shop #1's tables, the first start, then every other
 * shop's tables. Returns what was applied, per schema.
 */
export async function migrateAll(t: Tenancy): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  out.platform = await migratePlatform(t);
  out.public = await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await bootstrapPlatform(t);
  for (const s of await loadShops(t)) {
    if (s.primary || s.status === 'archived') continue;
    out[s.schema] = await migrateShop(t, s.schema);
    await setShopStore(t.shop(s.schema), s.slug);
  }
  return out;
}

/** Checks a feature list written by an editor (plan or shop): known keys only. */
export function cleanFeatures(keys: readonly string[], allowStar: boolean): string[] {
  const out: string[] = [];
  for (const k of keys) {
    if (allowStar && k === '*') out.push(k);
    else if (k.startsWith('-') ? k.includes('/') && isFeatureKey(k.slice(1)) : isFeatureKey(k)) out.push(k);
  }
  return [...new Set(out)];
}
