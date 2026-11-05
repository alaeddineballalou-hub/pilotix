// Shops of a multi-shop server: reading them, their subscription state, creating one (its own schema), the demo shop,
// and the first start (the server owner's shop becomes shop #1, its first admin the platform owner).
import { AgencyPrices, APP_PAGES, CODE_PREFIX, effectiveFeatures, isFeatureKey, isPartnerKind, PartnerKind, pricesOfKind, PUBLIC_ROOTS, ShopInfo, ShopKind, ShopState } from '@pilotix/shared';
import { Db, isoOrNull, migrate, num, numOrNull } from '../db';
import type { ShopCtx } from '../rpc';
import { sealPlatformSetting } from '../secretbox';
import { landingSettings, landingStore, STORE_RESERVED } from '../modules/landingquery';
import { hashPassword } from '../modules/users';
import { seedBase, seedDemo } from '../seed';
import { seedPilotDemo } from '../seeds/pilot';
import { DEFAULT_SETTINGS, setSetting } from '../settings';
import { backfillAccounts, ensureAccount, ownedStores } from './accounts';
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
  /** livreurs (drivers) the plan allows */
  maxDrivers: number | null;
  maxOrdersMonth: number | null;
  /** boutiques a seller on this plan may have (null: the platform's general number) — one plan for all of them */
  maxStores: number | null;
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
  /** deleted: by its owner (the data is gone; the row stays for the payments and the journal) */
  status: 'active' | 'suspended' | 'archived' | 'deleted';
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
  maxDrivers: number | null;
  /** the account that created the store: only its owner sees everything and can delete it */
  ownerAccountId: number | null;
  /**
   * One plan per seller: the seller's first boutique (its « boutique principale ») when this one is another of theirs.
   * Such a boutique follows it: its plan, trial, paid period, limits and suspension are the first one's (null: this
   * boutique holds its own — the first one, a partner's space, a store without owner).
   */
  mainShopId: number | null;
  mainShopName: string | null;
  /** made by its owner from the sign-up page (not from the control room) */
  selfSignup: boolean;
  /** a store made on the first sign-up page (before accounts): when its owner confirmed the e-mail */
  emailVerifiedAt: string | null;
  /** its own domain name for its landing pages (myshop.com) */
  domain: string | null;
  domainStatus: 'none' | 'pending' | 'ok';
  /** its code for bringing other stores (a free month when one of them first pays) */
  referralCode: string | null;
  referredBy: number | null;
  deletedAt: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerPhone: string | null;
  city: string | null;
  notes: string;
  lastActiveAt: string | null;
  resetAt: string | null;
  createdAt: string;
  /** a store, or a partner's own space: a confirmation agency or a marketer (sellers, team, prices, payments) */
  kind: ShopKind;
  /** the code others type to find it (a store: K7Q-29X; an agency: AG-7K2Q; a marketer: MK-7K2Q) */
  publicCode: string | null;
  /** a partner (agency, marketer) checked by Pilotix (null: not yet; it cannot work with stores before) */
  agencyVerifiedAt: string | null;
  /** a partner's usual prices (what a store sees before asking it to work) */
  agencyPrices: AgencyPrices | null;
}

const json = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);

/** A partner's prices as stored (any missing piece is 0); with its kind: only the pieces it uses. */
export function cleanPrices(v: any, kind?: PartnerKind): AgencyPrices {
  const n = (x: unknown) => (typeof x === 'number' && isFinite(x) && x > 0 ? Math.round(x) : 0);
  const p: AgencyPrices = {
    perConfirmed: n(v?.perConfirmed),
    perDelivered: n(v?.perDelivered),
    perUpsell: n(v?.perUpsell),
    monthly: n(v?.monthly),
    bonusRate: { min: Math.min(100, n(v?.bonusRate?.min)), amount: n(v?.bonusRate?.amount) },
    bonusVolume: { above: n(v?.bonusVolume?.above), amount: n(v?.bonusVolume?.amount) },
    perSuccess: n(v?.perSuccess),
    profitRate: Math.min(100, n(v?.profitRate)),
  };
  return kind ? pricesOfKind(kind, p) : p;
}
/** The kind of a shop row. */
export const kindOf = (v: unknown): ShopKind => (v === 'agency' || v === 'marketer' ? v : 'store');
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
  maxDrivers: numOrNull(r.max_drivers),
  maxOrdersMonth: numOrNull(r.max_orders_month),
  maxStores: numOrNull(r.max_stores),
  description: r.description ?? '',
  public: !!r.public,
  active: !!r.active,
  sort: num(r.sort),
  system: r.code === SYSTEM_PLAN,
});

/**
 * A seller's « boutique principale »: their first store still open (their own shop first when they own the server's
 * own one), not the demo's. Its plan and payments are the seller's: their other boutiques follow it.
 */
const MAIN_OF = (alias: string) =>
  `SELECT x.* FROM platform.shops x WHERE x.owner_account_id = ${alias}.owner_account_id AND x.kind = 'store' AND x.status NOT IN ('deleted', 'archived') AND NOT x.is_demo ORDER BY x.primary_shop DESC, x.id LIMIT 1`;

const SHOP_SELECT = `SELECT s.*, row_to_json(p.*) AS plan_row,
    m.id AS main_id, m.name AS main_name, m.plan_id AS main_plan_id, m.trial_ends_at AS main_trial_ends_at, m.paid_until AS main_paid_until,
    m.never_expires AS main_never_expires, m.status AS main_status, m.status_reason AS main_status_reason, m.max_users AS main_max_users,
    m.max_drivers AS main_max_drivers, row_to_json(mp.*) AS main_plan_row
  FROM platform.shops s
  LEFT JOIN LATERAL (${MAIN_OF('s')}) m ON s.kind = 'store' AND s.owner_account_id IS NOT NULL AND NOT s.is_demo AND s.status NOT IN ('deleted', 'archived') AND m.id <> s.id
  LEFT JOIN platform.plans p ON p.id = s.plan_id
  LEFT JOIN platform.plans mp ON mp.id = m.plan_id`;

export const toShop = (r: any): Shop => {
  // another boutique of a seller: the seller's plan, period and limits are their first boutique's
  const linked = r.main_id !== null && r.main_id !== undefined;
  const suspendedThere = linked && r.status === 'active' && r.main_status === 'suspended';
  return {
  id: num(r.id),
  slug: r.slug,
  name: r.name,
  schema: r.schema_name,
  planId: numOrNull(linked ? r.main_plan_id : r.plan_id),
  plan: linked ? (r.main_plan_row ? toPlan(json(r.main_plan_row)) : null) : r.plan_row ? toPlan(json(r.plan_row)) : null,
  status: suspendedThere ? 'suspended' : r.status,
  statusReason: suspendedThere ? (r.main_status_reason ?? null) : (r.status_reason ?? null),
  trialEndsAt: isoOrNull(linked ? r.main_trial_ends_at : r.trial_ends_at),
  paidUntil: isoOrNull(linked ? r.main_paid_until : r.paid_until),
  neverExpires: !!(linked ? r.main_never_expires : r.never_expires),
  demo: !!r.is_demo,
  primary: !!r.primary_shop,
  featuresOn: list(r.features_on),
  featuresOff: list(r.features_off),
  maxUsers: numOrNull(linked ? r.main_max_users : r.max_users),
  maxDrivers: numOrNull(linked ? r.main_max_drivers : r.max_drivers),
  ownerAccountId: numOrNull(r.owner_account_id),
  mainShopId: linked ? num(r.main_id) : null,
  mainShopName: linked ? String(r.main_name ?? '') : null,
  selfSignup: !!r.self_signup,
  emailVerifiedAt: isoOrNull(r.email_verified_at),
  domain: r.domain ?? null,
  domainStatus: r.domain ? (r.domain_status === 'ok' ? 'ok' : 'pending') : 'none',
  referralCode: r.referral_code ?? null,
  referredBy: numOrNull(r.referred_by),
  deletedAt: isoOrNull(r.deleted_at),
  ownerName: r.owner_name ?? null,
  ownerEmail: r.owner_email ?? null,
  ownerPhone: r.owner_phone ?? null,
  city: r.city ?? null,
  notes: r.notes ?? '',
  lastActiveAt: isoOrNull(r.last_active_at),
  resetAt: isoOrNull(r.reset_at),
  createdAt: new Date(r.created_at).toISOString(),
  kind: kindOf(r.kind),
  publicCode: r.public_code ?? null,
  agencyVerifiedAt: isoOrNull(r.agency_verified_at),
  agencyPrices: r.agency_prices ? cleanPrices(json(r.agency_prices), isPartnerKind(r.kind) ? r.kind : undefined) : null,
  };
};

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

/** The first shop of an e-mail (null = no shop knows it). One e-mail can be in several shops: see membershipsOf. */
export async function shopIdOfEmail(t: Tenancy, email: string): Promise<number | null> {
  return (await shopIdsOfEmail(t, email))[0] ?? null;
}

/** Every shop where this e-mail has an account (one person may work in several shops), oldest shop first. */
export async function shopIdsOfEmail(t: Tenancy, email: string): Promise<number[]> {
  const r = await t.platform.query('SELECT shop_id FROM platform.logins WHERE email = $1 ORDER BY shop_id', [email.trim().toLowerCase()]);
  return r.map((x: any) => num(x.shop_id));
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
  /** « Créer ma boutique » on the login page; stores one person may own (each account can have its own number) */
  signup: { open: boolean; maxStores: number };
  /** e-mails to the store's owner before the trial / the paid period ends, and when the store locks */
  reminders: { on: boolean; daysBefore: number };
  /** a store that brings another one gets free months when that one first pays */
  referral: { on: boolean; months: number };
  /** the control room asks for a code sent by e-mail at each login (when the server sends e-mails) */
  security: { twoStep: boolean };
  /** Pilotix's own details, printed on payment receipts */
  company: { name: string; address: string; phone: string; email: string; taxId: string };
  /** the terms of use and privacy page (empty = Pilotix's standard text) */
  legal: { text: string };
  /** the sign-in and sign-up pages: the designs turned on (1–20); each visit shows one of them at random */
  login: { designs: number[] };
  /** « Continuer avec Google / Facebook » on the sign-in pages: the public ids of Pilotix's Google and Facebook apps (empty = no button) */
  social: { googleClientId: string; facebookAppId: string };
  /** Pro marketers: shown on Pilotix's list of marketers while paid; its price by the month (DA), « Passer Pro » offered or not */
  pro: { on: boolean; price: number };
}

/** How many designs the sign-in pages have (numbered 1…LOGIN_DESIGNS). */
export const LOGIN_DESIGNS = 20;

export const PLATFORM_DEFAULTS: PlatformSettings = {
  trial: { days: 14, graceDays: 3, planCode: 'pro' },
  payment: { text: '', phone: '', whatsapp: '' },
  notice: { text: '', tone: 'info', until: null },
  demo: { public: false },
  signup: { open: true, maxStores: 3 },
  reminders: { on: true, daysBefore: 3 },
  referral: { on: true, months: 1 },
  security: { twoStep: true },
  company: { name: 'Pilotix', address: '', phone: '', email: '', taxId: '' },
  legal: { text: '' },
  login: { designs: Array.from({ length: LOGIN_DESIGNS }, (_, i) => i + 1) },
  social: { googleClientId: '', facebookAppId: '' },
  pro: { on: true, price: 2000 },
};

export async function platformSettings(t: Tenancy): Promise<PlatformSettings> {
  const rows = await t.platform.query<{ key: string; value: unknown }>('SELECT key, value FROM platform.settings');
  const out = structuredClone(PLATFORM_DEFAULTS) as any;
  for (const r of rows) if (r.key in out) out[r.key] = { ...out[r.key], ...json(r.value) };
  // saved by the first sign-up settings (stores per e-mail): kept until saved again
  const su = rows.find((r) => r.key === 'signup');
  if (su && !('maxStores' in (json(su.value) ?? {})) && Number(out.signup.maxShopsPerEmail) > 0) out.signup.maxStores = Number(out.signup.maxShopsPerEmail);
  delete out.signup.maxShopsPerEmail;
  delete out.signup.perIpPerDay;
  return out as PlatformSettings;
}

export async function setPlatformSetting<K extends keyof PlatformSettings>(t: Tenancy, key: K, value: PlatformSettings[K]) {
  await t.platform.query(
    `INSERT INTO platform.settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(sealPlatformSetting(key, value))],
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
  if (s.status === 'deleted') return { state: 'deleted', daysLeft: null, locked: true };
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
// a partner (confirmation agency, marketer) has no plan: its own screens are all there (what it may do is limited by
// agencyscope.ts)
export const shopFeatures = (s: Shop): string[] | null =>
  s.primary || s.plan?.system || s.kind !== 'store' ? effectiveFeatures(['*'], s.featuresOn, s.featuresOff) : effectiveFeatures(s.plan?.features ?? [], s.featuresOn, s.featuresOff);

export const shopMaxUsers = (s: Shop): number | null => (s.primary ? null : s.maxUsers ?? s.plan?.maxUsers ?? null);
export const shopMaxDrivers = (s: Shop): number | null => (s.primary ? null : s.maxDrivers ?? s.plan?.maxDrivers ?? null);
export const shopMaxOrders = (s: Shop): number | null => (s.primary ? null : s.plan?.maxOrdersMonth ?? null);

/** What a request of this shop carries (rules checked by the core). */
export function shopCtx(s: Shop, st: ShopStatus): ShopCtx {
  return { id: s.id, slug: s.slug, primary: s.primary, features: shopFeatures(s), locked: st.locked, demo: s.demo, maxUsers: shopMaxUsers(s), maxDrivers: shopMaxDrivers(s), kind: s.kind, code: s.publicCode };
}

/** What the app shows of the shop: its plan, its state, how to pay, Pilotix's message. */
/** What the server knows of the person and the store at login (the store's numbers, the person's other stores). */
export interface ShopInfoExtra {
  owner: boolean;
  ownerProfileId: number | null;
  stores: number;
  canAddStore: boolean;
  /** the stores the person owns and their limit (« 2 boutiques sur 3 ») */
  ownStores?: number;
  maxStores?: number | null;
  /** the boutiques billed together with this one (one plan per seller) */
  sellerStores?: number;
  /** « Créer mon agence »: the person has no confirmation agency yet */
  canAddAgency?: boolean;
  /** « Créer mon espace marketer »: the person has no marketer space yet */
  canAddMarketer?: boolean;
  ordersMonth: number | null;
  supportUnread: number;
}
export const NO_EXTRA: ShopInfoExtra = { owner: false, ownerProfileId: null, stores: 0, canAddStore: false, canAddAgency: false, canAddMarketer: false, ordersMonth: null, supportUnread: 0 };

/** What the app shows of the shop: its plan, its state, how to pay, Pilotix's message, its limits. */
export function shopInfo(s: Shop, st: ShopStatus, settings: PlatformSettings, now: number, extra: ShopInfoExtra = NO_EXTRA): ShopInfo {
  const n = settings.notice;
  const noticeOn = !!n.text.trim() && (!n.until || Date.parse(n.until) > now);
  const pay = settings.payment;
  const paid = s.plan && !s.plan.system;
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    primary: s.primary,
    demo: s.demo,
    state: st.state,
    plan: paid ? s.plan!.name : null,
    planPrice: paid ? s.plan!.priceMonth : null,
    planPriceYear: paid ? s.plan!.priceYear : null,
    trialEndsAt: s.trialEndsAt,
    paidUntil: s.paidUntil,
    daysLeft: st.daysLeft,
    locked: st.locked,
    features: shopFeatures(s),
    maxUsers: shopMaxUsers(s),
    maxDrivers: shopMaxDrivers(s),
    maxOrdersMonth: shopMaxOrders(s),
    ordersMonth: extra.ordersMonth,
    payment: s.primary || s.demo || (!pay.text.trim() && !pay.phone.trim() && !pay.whatsapp.trim()) ? null : { text: pay.text, phone: pay.phone, whatsapp: pay.whatsapp },
    notice: noticeOn ? { text: n.text, tone: n.tone } : null,
    owner: extra.owner,
    ownerProfileId: extra.ownerProfileId,
    stores: extra.stores,
    canAddStore: extra.canAddStore,
    ...(extra.ownStores !== undefined ? { ownStores: extra.ownStores, maxStores: extra.maxStores ?? null } : {}),
    mainShop: s.mainShopId ? { id: s.mainShopId, name: s.mainShopName ?? '' } : null,
    ...(extra.sellerStores !== undefined ? { sellerStores: extra.sellerStores } : {}),
    canAddAgency: !!extra.canAddAgency,
    canAddMarketer: !!extra.canAddMarketer,
    supportUnread: extra.supportUnread,
    domain: s.domain && s.domainStatus !== 'none' ? { name: s.domain, status: s.domainStatus } : null,
    kind: s.kind,
    code: s.publicCode,
    verified: s.kind !== 'store' ? !!s.agencyVerifiedAt : undefined,
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
/**
 * Names a new store cannot take: the app's own words (api, live…), the first words of its addresses (a boutique's link
 * name starts them: pilotix.online/<boutique>/<page>; pages open to everyone: /conditions, /inscription…) and names
 * that would pass for Pilotix itself.
 */
export const NAME_RESERVED = [
  ...new Set([...STORE_RESERVED, ...PUBLIC_ROOTS, ...APP_PAGES, 'pilotix', 'plateforme', 'support', 'help', 'contact', 'login', 'connexion', 'legal', 'privacy', 'terms', 'confidentialite', 'compte', 'account']),
];
/** a name a new shop can have (the format, and not a reserved word) */
export const slugOk = (s: string): boolean => SLUG_RE.test(s) && !NAME_RESERVED.includes(s);

export async function freeSlug(t: Tenancy, wanted: string, exceptId?: number): Promise<string> {
  let base = slugify(wanted);
  if (NAME_RESERVED.includes(base)) base = `${base}-boutique`;
  for (let i = 1; i < 500; i++) {
    const s = i === 1 ? base : `${base.slice(0, 36)}-${i}`;
    // a name another shop has, or had (its former links still lead to it), is not free
    const r = await t.platform.query('SELECT id FROM platform.shops WHERE slug = $1 UNION ALL SELECT shop_id FROM platform.shop_old_slugs WHERE slug = $1', [s]);
    if (r.every((x: any) => num(x.id) === exceptId)) return s;
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
  owner: { name: string; email: string; phone?: string | null; language?: string };
  /**
   * The owner's password for a new account: `password` (plain) or `passwordHash`. Neither: invited, the owner chooses
   * it from the e-mail. An e-mail that already has an account keeps its own password.
   */
  password?: string;
  passwordHash?: string | null;
  /** the owner proved the e-mail is theirs (a confirmed sign-up) */
  verified?: boolean;
  city?: string | null;
  notes?: string;
  demo?: boolean;
  createdBy?: number | null;
  /** made by its owner from the sign-up page */
  selfSignup?: boolean;
  /** the address it was signed up from */
  signupIp?: string | null;
  /** the store that brought this one */
  referredBy?: number | null;
  /** a partner's space instead of a store: a confirmation agency or a marketer (free: it never expires) */
  kind?: ShopKind;
  now?: number;
}

/** A store's code for bringing others: 6 letters and digits, easy to read and to type (no 0/O, 1/I/L). */
async function freeReferralCode(t: Tenancy): Promise<string> {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  for (let i = 0; i < 50; i++) {
    const r = globalThis.crypto.getRandomValues(new Uint32Array(6));
    const code = Array.from(r, (x) => A[x % A.length]).join('');
    if (!(await t.platform.query('SELECT 1 FROM platform.shops WHERE referral_code = $1', [code])).length) return code;
  }
  throw new Error('No free referral code');
}

/**
 * The code others type to find a store or a partner: hard to guess (nobody can try every store), easy to read and to
 * dictate on the phone (no 0/O, 1/I/L). A store: K7Q-29X; an agency: AG-7K2Q; a marketer: MK-7K2Q.
 */
export async function freePublicCode(t: Tenancy, kind: ShopKind): Promise<string> {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const pick = (n: number) => Array.from(globalThis.crypto.getRandomValues(new Uint32Array(n)), (x) => A[x % A.length]).join('');
  for (let i = 0; i < 50; i++) {
    const code = kind !== 'store' ? `${CODE_PREFIX[kind]}-${pick(4)}` : `${pick(3)}-${pick(3)}`;
    if (!(await t.platform.query('SELECT 1 FROM platform.shops WHERE public_code = $1', [code])).length) return code;
  }
  throw new Error('No free public code');
}

/**
 * A new shop: its row, its own schema with every table, its owner (an account: new, or the one this e-mail already has)
 * as first administrator and its default depot (the demo shop: the demo data instead). Undone completely if any step
 * fails.
 */
export async function provisionShop(t: Tenancy, n: NewShop): Promise<Shop> {
  const email = n.owner.email.trim().toLowerCase();
  const slug = n.slug ? n.slug : await freeSlug(t, n.name);
  if (!slugOk(slug)) throw new Error('BAD_SLUG');
  if ((await t.platform.query('SELECT 1 FROM platform.shops WHERE slug = $1 UNION ALL SELECT 1 FROM platform.shop_old_slugs WHERE slug = $1', [slug])).length) throw new Error('SLUG_TAKEN');
  const now = n.now ?? Date.now();
  const trialEnds = n.trialDays > 0 ? new Date(now + n.trialDays * DAY).toISOString() : null;
  const kind = n.kind ?? 'store';
  // a partner (agency, marketer) has no plan, no trial, no referral code: it is free
  const partner = kind !== 'store';
  const row = (
    await t.platform.query(
      `WITH n AS (SELECT nextval(pg_get_serial_sequence('platform.shops', 'id'))::int AS id)
       INSERT INTO platform.shops (id, slug, name, schema_name, plan_id, trial_ends_at, never_expires, is_demo, owner_name, owner_email, owner_phone, city, notes, created_by, self_signup, referred_by, signup_ip, kind)
       SELECT n.id, $1, $2, 'shop_' || n.id, $3, $4, $5 OR $15 <> 'store', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15 FROM n RETURNING id, schema_name`,
      [slug, n.name.trim(), partner ? null : n.planId, partner ? null : trialEnds, !!n.demo, n.owner.name.trim(), email, n.owner.phone?.trim() || null, n.city?.trim() || null, n.notes ?? '', n.createdBy ?? null, !!n.selfSignup, n.referredBy ?? null, n.signupIp ?? null, kind],
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
      // the owner's account first: an e-mail already known keeps its own password
      const hash = n.passwordHash !== undefined ? n.passwordHash : n.password ? await hashPassword(n.password) : null;
      // a password chosen by the person who proved the e-mail (a sign-up) is their own
      const { account } = await ensureAccount(t, { email, name: n.owner.name, language: n.owner.language, passwordHash: hash, verified: n.verified, passwordBy: n.verified && hash ? 'self' : null });
      await seedBase(db, { email, password: `${makePassword()}-${makePassword()}`, name: n.owner.name.trim() || undefined });
      const own = (await t.platform.query('SELECT password_hash FROM platform.accounts WHERE id = $1', [account.id]))[0]?.password_hash as string | null;
      if (own) await db.query('UPDATE profiles SET password_hash = $2 WHERE email = $1', [email, own]);
      if (n.owner.language) await db.query('UPDATE profiles SET language = $2 WHERE email = $1', [email, n.owner.language]);
      await setSetting(db, 'shop', { ...DEFAULT_SETTINGS.shop, name: n.name.trim() });
      await t.platform.query('UPDATE platform.shops SET owner_account_id = $2, referral_code = $3, public_code = $4 WHERE id = $1', [
        id,
        account.id,
        partner ? null : await freeReferralCode(t),
        await freePublicCode(t, kind),
      ]);
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
  await seedPilotDemo(db);
  await setSetting(db, 'shop', { ...DEFAULT_SETTINGS.shop, name });
}

/** Removes a store's data (its schema) and its e-mails from the login index. */
export async function dropShopData(t: Tenancy, id: number, schema: string) {
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

/**
 * A store's numbers for the control room — numbers only, never what is inside: active accounts, active livreurs,
 * orders this month and last month, and how many stores its owner has.
 */
export interface ShopUsage {
  users: number;
  drivers: number;
  ordersMonth: number;
  ordersLastMonth: number;
  ordersTotal: number;
  ownerStores: number;
}
export async function shopUsage(t: Tenancy, s: Shop): Promise<ShopUsage> {
  const ownerStores = s.ownerAccountId ? await ownedStores(t, s.ownerAccountId) : 0;
  if (s.status === 'archived' || s.status === 'deleted') return { users: 0, drivers: 0, ordersMonth: 0, ordersLastMonth: 0, ordersTotal: 0, ownerStores };
  const r = (
    await t.shop(s.schema).query(
      `SELECT (SELECT count(*) FROM profiles WHERE active AND agency_id IS NULL AND email NOT LIKE '%@pilotix.invalid')::int AS users,
              (SELECT count(*) FROM profiles WHERE active AND 'livreur' = ANY(roles) AND email NOT LIKE '%@pilotix.invalid')::int AS drivers,
              (SELECT count(*) FROM orders WHERE NOT is_exchange AND created_at >= (date_trunc('month', now() + interval '1 hour') - interval '1 hour'))::int AS month,
              (SELECT count(*) FROM orders WHERE NOT is_exchange AND created_at >= (date_trunc('month', now() + interval '1 hour') - interval '1 month' - interval '1 hour')
                                              AND created_at < (date_trunc('month', now() + interval '1 hour') - interval '1 hour'))::int AS last,
              (SELECT count(*) FROM orders WHERE NOT is_exchange)::int AS total`,
    )
  )[0];
  return { users: num(r?.users), drivers: num(r?.drivers), ordersMonth: num(r?.month), ordersLastMonth: num(r?.last), ordersTotal: num(r?.total), ownerStores };
}

/** Orders made this month (Algeria time) in one store: the plan's monthly number. */
export async function ordersThisMonth(db: Db): Promise<number> {
  return num(
    (await db.query(`SELECT count(*)::int AS n FROM orders WHERE NOT is_exchange AND created_at >= (date_trunc('month', now() + interval '1 hour') - interval '1 hour')`))[0]?.n,
  );
}

// ---------------------------------------------------------------- one plan per seller
/** A seller's « boutique principale »: their first store still open — it holds their plan and their payments. */
export async function mainShopOf(t: Tenancy, accountId: number): Promise<Shop | null> {
  const row = (
    await t.platform.query(
      `${SHOP_SELECT} WHERE s.owner_account_id = $1 AND s.kind = 'store' AND s.status NOT IN ('deleted', 'archived') AND NOT s.is_demo ORDER BY s.primary_shop DESC, s.id LIMIT 1`,
      [accountId],
    )
  )[0];
  return row ? toShop(row) : null;
}

/**
 * After one of a seller's boutiques closed (deleted, archived) or came back: when their first boutique is now another
 * one, it takes the plan, the period and the limits of the one before, so the seller's subscription goes on unchanged.
 */
export async function keepSellerBilling(t: Tenancy, ownerAccountId: number | null, before: Shop | null): Promise<void> {
  if (!ownerAccountId || !before) return;
  const after = await mainShopOf(t, ownerAccountId);
  if (!after || after.id === before.id) return;
  const r = (await t.platform.query('SELECT plan_id, trial_ends_at, paid_until, never_expires, max_users, max_drivers FROM platform.shops WHERE id = $1', [before.id]))[0];
  if (!r) return;
  await t.platform.query('UPDATE platform.shops SET plan_id = $2, trial_ends_at = $3, paid_until = $4, never_expires = $5, max_users = $6, max_drivers = $7 WHERE id = $1', [
    after.id,
    r.plan_id,
    r.trial_ends_at,
    r.paid_until,
    r.never_expires,
    r.max_users,
    r.max_drivers,
  ]);
}

/** The boutiques billed together with this one: the seller's stores still open (just this one when it has no owner). */
export async function sellerShops(t: Tenancy, s: Shop): Promise<Shop[]> {
  if (s.kind !== 'store' || !s.ownerAccountId || s.demo) return [s];
  const rows = await t.platform.query(`${SHOP_SELECT} WHERE s.owner_account_id = $1 AND s.kind = 'store' AND s.status NOT IN ('deleted', 'archived') AND NOT s.is_demo ORDER BY s.primary_shop DESC, s.id`, [s.ownerAccountId]);
  const list = rows.map(toShop);
  return list.some((x: Shop) => x.id === s.id) ? list : [s, ...list];
}

const SEAT_SQL = {
  // a confirmation agency's agents take no place: the agency brings them
  users: `SELECT lower(email) AS e FROM profiles WHERE active AND agency_id IS NULL AND email NOT LIKE '%@pilotix.invalid'`,
  drivers: `SELECT lower(email) AS e FROM profiles WHERE active AND 'livreur' = ANY(roles) AND email NOT LIKE '%@pilotix.invalid'`,
};

/**
 * The people who take a place in the seller's plan, over all their boutiques: each person once (the same e-mail in
 * two boutiques is one place).
 */
export async function sellerSeats(t: Tenancy, shops: Shop[], kind: 'users' | 'drivers'): Promise<Set<string>> {
  const out = new Set<string>();
  for (const x of shops) {
    if (x.status === 'archived' || x.status === 'deleted') continue;
    for (const r of (await t.shop(x.schema).query(SEAT_SQL[kind]).catch(() => [])) as any[]) out.add(String(r.e));
  }
  return out;
}

/** Orders made this month over all the seller's boutiques (the plan's monthly number is the seller's). */
export async function sellerOrdersThisMonth(t: Tenancy, s: Shop): Promise<number> {
  let n = 0;
  for (const x of await sellerShops(t, s)) n += await ordersThisMonth(t.shop(x.schema)).catch(() => 0);
  return n;
}

/** What the plan counts for this boutique's seller: people (each once), livreurs, orders of all their boutiques. */
export async function sellerUsage(t: Tenancy, s: Shop): Promise<ShopUsage> {
  const shops = await sellerShops(t, s);
  if (shops.length <= 1) return shopUsage(t, s);
  const parts = await Promise.all(shops.map((x) => shopUsage(t, x)));
  return {
    users: (await sellerSeats(t, shops, 'users')).size,
    drivers: (await sellerSeats(t, shops, 'drivers')).size,
    ordersMonth: parts.reduce((a, p) => a + p.ordersMonth, 0),
    ordersLastMonth: parts.reduce((a, p) => a + p.ordersLastMonth, 0),
    ordersTotal: parts.reduce((a, p) => a + p.ordersTotal, 0),
    ownerStores: parts[0]?.ownerStores ?? 0,
  };
}

// ---------------------------------------------------------------- first start
/** Plans offered at the start (prices are examples: the owner changes them in the control room). */
const DEFAULT_PLANS = [
  { code: SYSTEM_PLAN, name: 'Interne', price: 0, features: ['*'], users: null, orders: null, stores: 100, pub: false, desc: 'Votre propre boutique : tout est inclus, sans fin.' },
  {
    code: 'essentiel',
    name: 'Essentiel',
    price: 3900,
    features: ['dashboard', 'commandes', 'scanner', 'sav', 'tournee', 'produits', 'clients', 'caisse', 'macaisse', 'livraison', 'management'],
    users: 5,
    orders: 1500,
    stores: 1,
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
    stores: 3,
    pub: true,
    desc: 'Essentiel + landing pages, publicité, marketeurs, Delivery AI agent.',
  },
  { code: 'business', name: 'Business', price: 14900, features: ['*'], users: null, orders: null, stores: 10, pub: true, desc: 'Tout Pilotix : Message AI agent, CM AI agent, AI Spy…' },
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
        `INSERT INTO platform.plans (code, name, price_month, features, max_users, max_orders_month, max_stores, description, public, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (code) DO NOTHING`,
        [p.code, p.name, p.price, JSON.stringify(p.features), p.users, p.orders, p.stores, p.desc, p.pub, i],
      );
  if (!(await loadShop(t, { primary: true }))) {
    const sys = (await t.platform.query('SELECT id FROM platform.plans WHERE code = $1', [SYSTEM_PLAN]))[0];
    const named = (await t.shop('public').query(`SELECT value->>'name' AS name FROM settings WHERE key = 'shop'`).catch(() => []))[0]?.name;
    const name = String(named || 'Ma boutique').trim() || 'Ma boutique';
    // its link name: the one its landing pages already use (their links do not move), else made from its name
    const own = await landingStore(t.shop('public')).catch(() => '');
    await t.platform.query(
      `INSERT INTO platform.shops (slug, name, schema_name, plan_id, never_expires, primary_shop) VALUES ($1, $2, 'public', $3, true, true)`,
      [await freeSlug(t, own && slugOk(own) ? own : name), name, sys ? num(sys.id) : null],
    );
  }
  const primary = (await loadShop(t, { primary: true }))!;
  await t.platform.query(
    `INSERT INTO platform.logins (email, shop_id)
     SELECT lower(email), $1 FROM public.profiles WHERE email NOT LIKE '%@pilotix.invalid' AND email NOT LIKE '%@demo.pilotix.dz'
     ON CONFLICT DO NOTHING`,
    [primary.id],
  );
  await ensureLoginTrigger(t, 'public');
  await ensureOwnerStaff(t);
  await syncPrimaryStore(t);
  // accounts: everyone already in a store gets one; stores get their owner and their referral code
  await backfillAccounts(t);
  for (const r of await t.platform.query(`SELECT id FROM platform.shops WHERE referral_code IS NULL AND NOT is_demo AND status <> 'deleted' AND kind = 'store'`))
    await t.platform.query('UPDATE platform.shops SET referral_code = $2 WHERE id = $1 AND referral_code IS NULL', [r.id, await freeReferralCode(t)]);
  // every store and partner has its public code (typed to find each other)
  for (const r of await t.platform.query(`SELECT id, kind FROM platform.shops WHERE public_code IS NULL AND NOT is_demo AND status <> 'deleted'`))
    await t.platform.query('UPDATE platform.shops SET public_code = $2 WHERE id = $1 AND public_code IS NULL', [r.id, await freePublicCode(t, kindOf(r.kind))]);
  await numberOldPayments(t);
}

/**
 * Payments recorded before receipts existed get their number too (PX-<year of payment>-0001…, in the order they were
 * paid), so every payment has its receipt. Same lock as a new payment's number, after the year's last one: no double.
 */
async function numberOldPayments(t: Tenancy): Promise<void> {
  if (!(await t.platform.query('SELECT 1 FROM platform.payments WHERE receipt_no IS NULL LIMIT 1')).length) return;
  await t.platform.tx(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(7340211)');
    const todo = await db.query(`SELECT id, extract(year FROM paid_at AT TIME ZONE 'UTC')::int AS y FROM platform.payments WHERE receipt_no IS NULL ORDER BY paid_at, id`);
    const last = new Map<number, number>();
    for (const r of todo) {
      const y = num(r.y);
      if (!last.has(y)) last.set(y, num((await db.query('SELECT COALESCE(max(substring(receipt_no from 9)::int), 0) AS n FROM platform.payments WHERE receipt_no LIKE $1', [`PX-${y}-%`]))[0]?.n));
      const seq = last.get(y)! + 1;
      last.set(y, seq);
      await db.query('UPDATE platform.payments SET receipt_no = $2 WHERE id = $1', [r.id, `PX-${y}-${String(seq).padStart(4, '0')}`]);
    }
  });
}

/**
 * A shop's part of its links (site/<store>/<page>, and the app's pilotix.online/<store>/…) is its name on the platform:
 * chosen once when the shop is made, it never changes. Kept in its own settings, so its pages and its llms.txt name it.
 */
export async function setShopStore(db: Db, slug: string): Promise<void> {
  const s = await landingSettings(db);
  if (s.storeSlug !== slug) await setSetting(db, 'landing', { ...s, storeSlug: slug });
}

// ---------------------------------------------------------------- a shop's former links (« Mes boutiques »)
/** The shop whose former link this is (null: none). */
export async function shopIdByOldSlug(t: Tenancy, slug: string): Promise<number | null> {
  const r = (await t.platform.query('SELECT shop_id FROM platform.shop_old_slugs WHERE slug = $1', [slug.trim().toLowerCase()]))[0];
  return r ? num(r.shop_id) : null;
}

/** Is this link free for that shop (no other shop has it now, or had it)? A former link of its own is free for it. */
export async function slugTakenByOther(t: Tenancy, slug: string, shopId: number | null): Promise<boolean> {
  const now = await t.platform.query('SELECT 1 FROM platform.shops WHERE slug = $1 AND id IS DISTINCT FROM $2', [slug, shopId]);
  if (now.length) return true;
  return (await t.platform.query('SELECT 1 FROM platform.shop_old_slugs WHERE slug = $1 AND shop_id IS DISTINCT FROM $2', [slug, shopId])).length > 0;
}

/** Keeps a shop's former link (its pages and webhooks keep answering there): called whenever a shop's link changes. */
export async function keepOldSlug(t: Tenancy, shopId: number, oldSlug: string, newSlug: string) {
  if (!oldSlug || oldSlug === newSlug) return;
  await t.platform.query('DELETE FROM platform.shop_old_slugs WHERE slug = $1 AND shop_id = $2', [newSlug, shopId]);
  await t.platform.query('INSERT INTO platform.shop_old_slugs (slug, shop_id) VALUES ($1, $2) ON CONFLICT (slug) DO NOTHING', [oldSlug, shopId]);
}

/**
 * Shop #1's links: like every shop's, its name on the platform, never changed (neither « Mes boutiques », Landing pages ›
 * Réglages nor the control room changes it). Written in its own settings too, so a new shop name no longer moves them.
 */
export async function syncPrimaryStore(t: Tenancy): Promise<void> {
  const p = await loadShop(t, { primary: true });
  if (p) await setShopStore(t.shop('public'), p.slug);
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
    if (s.primary || s.status === 'archived' || s.status === 'deleted') continue;
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
