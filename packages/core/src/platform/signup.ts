// What the login page and the account menu do on a multi-shop server: the stores of a person, « Créer ma boutique »
// (confirmed by e-mail before anything is made), « Ajouter une boutique », « Mot de passe oublié » for an account,
// invitations made from the control room, and a store deleted by its owner (the only one who can).
import { z } from 'zod';
import { RESETS_PER_MONTH } from '../passwordReset';
import { hashPassword } from '../modules/users';
import { AppError, bad, forbidden, notFound } from '../rpc';
import {
  Account,
  accountByEmail,
  checkAccountPassword,
  completedResets,
  ensureAccount,
  isAdminSomewhere,
  makeAccountToken,
  membershipsOf,
  NO_ACCOUNT,
  normEmail,
  ownedAgencies,
  ownedMarketers,
  ownedPartners,
  ownedStores,
  ownerProfileId,
  randomToken,
  recentTokens,
  setPasswordFromLink,
  sha256Hex,
  takeAccountToken,
} from './accounts';
import { dropShopData, freeSlug, NAME_RESERVED, loadPlans, loadShop, ordersThisMonth, platformSettings, PlatformSettings, provisionShop, Shop, ShopInfoExtra, shopMaxOrders, shopStatus, slugOk } from './shops';
import { accountPhoneOrBad, checkSignupCode, setAccountPhone } from './phone';
import { shopUnread } from './support';
import type { Tenancy } from './tenancy';

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** First instant of the month (Algeria, UTC+1 all year) that contains `now`. */
function monthStart(now: number): number {
  const d = new Date(now + HOUR);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - HOUR;
}

async function journal(t: Tenancy, shopId: number | null, action: string, who: string, details: Record<string, unknown> = {}) {
  await t.platform.query('INSERT INTO platform.audit (staff_id, staff_name, shop_id, action, details) VALUES (NULL, $1, $2, $3, $4)', [who, shopId, action, JSON.stringify(details)]);
}

// ---------------------------------------------------------------- the stores of a person (login, « Changer de boutique »)
export interface StoreChoice {
  id: number;
  name: string;
  slug: string;
  state: string;
  locked: boolean;
  owner: boolean;
  primary: boolean;
  profileId: number;
  /** a store, or a partner's own space (a confirmation agency, a marketer) */
  kind: 'store' | 'agency' | 'marketer';
}

/** The stores (and the partner spaces: agency, marketer) this e-mail can open, its own first. */
export async function storeChoices(t: Tenancy, email: string, now = Date.now()): Promise<StoreChoice[]> {
  const set = await platformSettings(t);
  const acc = await accountByEmail(t, email);
  const out: StoreChoice[] = [];
  for (const m of await membershipsOf(t, email)) {
    // a partner's person (agency, marketer) works for its sellers from the partner's space, never inside the store itself
    if (m.agencyId) continue;
    const s = await loadShop(t, { id: m.shopId });
    if (!s || s.demo) continue;
    const st = shopStatus(s, now, set.trial.graceDays);
    out.push({ id: s.id, name: s.name, slug: s.slug, state: st.state, locked: st.locked, owner: !!acc && s.ownerAccountId === acc.id, primary: s.primary, profileId: m.profileId, kind: s.kind });
  }
  // the person's own first, then their partner spaces (agency, marketer), then the stores they work for
  return out.sort((a, b) => Number(b.owner) - Number(a.owner) || Number(b.kind !== 'store') - Number(a.kind !== 'store') || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- the name of a new store
/** Is this name free for a new store's links? (format, the app's own words, another store) */
export async function storeNameCheck(t: Tenancy, name: string, slug?: string): Promise<{ slug: string; free: boolean; reason: string | null }> {
  const want = (slug ?? '').trim().toLowerCase();
  if (want) {
    if (NAME_RESERVED.includes(want)) return { slug: want, free: false, reason: 'Ce nom est réservé par Pilotix, choisissez-en un autre' };
    if (!slugOk(want)) return { slug: want, free: false, reason: 'Nom dans le lien : 2 à 40 lettres minuscules, chiffres et tirets (ex. ma-boutique)' };
    const taken = (await t.platform.query('SELECT 1 FROM platform.shops WHERE slug = $1', [want])).length > 0;
    return { slug: want, free: !taken, reason: taken ? 'Ce nom est déjà pris par une autre boutique' : null };
  }
  return { slug: await freeSlug(t, name || 'boutique'), free: true, reason: null };
}

/** The plan and trial a store made by its owner starts with (the control room's « Essai gratuit » settings). */
async function startPlan(t: Tenancy, set: PlatformSettings) {
  const plans = (await loadPlans(t)).filter((p) => p.active && !p.system);
  return plans.find((p) => p.code === set.trial.planCode) ?? plans.find((p) => p.public) ?? plans[0] ?? null;
}

// ---------------------------------------------------------------- « Créer ma boutique »
export const SignupInput = z.object({
  name: z.string().trim().min(2, 'Votre nom : au moins 2 lettres').max(80),
  email: z.string().trim().email('E-mail invalide').max(200),
  password: z.string().min(8, 'Le mot de passe doit contenir au moins 8 caractères').max(200),
  /** the person's own mobile (required: one number = one account) */
  phone: z.string().trim().min(1, 'Votre numéro de téléphone est obligatoire').max(30),
  /** the WhatsApp code sent to it (when Pilotix asks the code) */
  phoneCode: z.string().trim().max(12).optional(),
  /** empty (a store only): just the account; the person adds their first store once inside. A partner always gives its name. */
  storeName: z.string().trim().max(80).default(''),
  slug: z.string().trim().toLowerCase().max(40).optional(),
  language: z.enum(['fr', 'en', 'ar']).default('fr'),
  referral: z.string().trim().toUpperCase().max(12).optional(),
  /** the terms of use and the privacy policy, accepted */
  terms: z.literal(true, { errorMap: () => ({ message: 'Acceptez les conditions d’utilisation pour continuer' }) }),
  /**
   * The account asked for: a store, « Créer mon agence » (a confirmation agency) or « Créer mon espace marketer »
   * (storeName is then the agency's or the marketer's name)
   */
  kind: z.enum(['store', 'agency', 'marketer']).default('store'),
});

/** What to e-mail after a sign-up: the link that makes the store (or the partner's space), or « you already have an account ». */
export type SignupMail =
  | { kind: 'confirm'; token: string; email: string; name: string; language: string; store: string; agency: boolean; marketer: boolean }
  | { kind: 'exists'; email: string; name: string; language: string };

const firstError = (e: z.ZodError) => e.issues[0]?.message || 'Formulaire incomplet';

/**
 * Keeps the sign-up and gives the e-mail to send (null: nothing to send, e.g. too many tries this hour). The answer to
 * the page is the same in every case: nobody learns which e-mails already have an account.
 */
export async function startSignup(t: Tenancy, raw: unknown, ip: string | null, now = Date.now(), opts: { otp?: boolean } = {}): Promise<SignupMail | null> {
  const set = await platformSettings(t);
  if (!set.signup.open) throw bad('Les inscriptions sont fermées pour le moment. Écrivez à Pilotix.');
  const p = SignupInput.safeParse(raw);
  if (!p.success) throw bad(firstError(p.error));
  const i = p.data;
  // a partner's space (agency, marketer): no landing pages, no plan, no referral
  const partner = i.kind !== 'store';
  const email = normEmail(i.email);
  if (NO_ACCOUNT.test(email)) throw bad('E-mail invalide');
  // a store without a name: only the account (the first store is added once inside); a partner always gives its name
  const accountOnly = !partner && !i.storeName;
  if (!accountOnly && i.storeName.length < 2) throw bad(partner ? 'Nom : au moins 2 lettres' : 'Nom de la boutique : au moins 2 lettres');
  if (!accountOnly) {
    // a partner has no landing pages: the name in its links is made from its name
    const name = await storeNameCheck(t, i.storeName, partner ? undefined : i.slug);
    if (!name.free) throw bad(name.reason ?? 'Nom indisponible');
  }
  if (!partner && i.referral && !(await t.platform.query(`SELECT 1 FROM platform.shops WHERE referral_code = $1 AND status <> 'deleted'`, [i.referral])).length)
    throw bad('Code de parrainage inconnu (laissez vide si vous n’en avez pas)');
  // one number = one account
  const phone = accountPhoneOrBad(i.phone);
  const phoneOwner = (await t.platform.query('SELECT email FROM platform.accounts WHERE phone = $1', [phone]))[0];
  if (phoneOwner && phoneOwner.email !== email) throw bad('Ce numéro est déjà utilisé par un autre compte');
  // the WhatsApp code (when Pilotix asks it): the number is proven before the account is opened
  if (opts.otp && !phoneOwner) await checkSignupCode(t, phone, i.phoneCode ?? '', now);
  // 3 sign-ups an hour per e-mail: nobody can fill someone's inbox
  const recent = Number((await t.platform.query('SELECT count(*)::int AS n FROM platform.signup_requests WHERE email = $1 AND created_at > $2::timestamptz', [email, iso(now - HOUR)]))[0]?.n ?? 0);
  if (recent >= 3) return null;
  const acc = await accountByEmail(t, email);
  if (acc) {
    // counted like a sign-up (the same limit), then « you already have an account »
    await t.platform.query(
      `INSERT INTO platform.signup_requests (token_hash, email, name, store_name, password_hash, language, terms_at, ip, expires_at, used_at) VALUES ($1,$2,$3,$4,'-',$5,$6::timestamptz,$7,$6::timestamptz,$6::timestamptz)`,
      [await sha256Hex(randomToken()), email, i.name, i.storeName, i.language, iso(now), ip],
    );
    return { kind: 'exists', email, name: acc.name || i.name, language: acc.language || i.language };
  }
  const token = randomToken();
  await t.platform.query(
    `INSERT INTO platform.signup_requests (token_hash, email, name, phone, store_name, slug, password_hash, language, referral_code, terms_at, ip, expires_at, kind, phone_verified)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11,$12::timestamptz,$13,$14)`,
    [
      await sha256Hex(token),
      email,
      i.name,
      phone,
      i.storeName,
      partner ? null : i.slug || null,
      await hashPassword(i.password),
      i.language,
      partner ? null : i.referral || null,
      iso(now),
      ip,
      iso(now + 48 * HOUR),
      i.kind,
      !!opts.otp,
    ],
  );
  return { kind: 'confirm', token, email, name: i.name, language: i.language, store: i.storeName, agency: i.kind === 'agency', marketer: i.kind === 'marketer' };
}

/**
 * The link of the sign-up e-mail: the account and its store are made now (the e-mail is proven), on the trial plan.
 * `exists`: this e-mail got an account meanwhile (it logs in instead).
 */
export async function confirmSignup(t: Tenancy, token: string, now = Date.now()): Promise<{ shop: Shop | null; account: Account } | { exists: true; email: string }> {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw bad('Ce lien n’est plus valable. Inscrivez-vous à nouveau.');
  const row = (
    await t.platform.query(
      `UPDATE platform.signup_requests SET used_at = $2::timestamptz WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2::timestamptz AND password_hash <> '-' RETURNING *`,
      [await sha256Hex(token), iso(now)],
    )
  )[0];
  if (!row) throw bad('Ce lien n’est plus valable. Inscrivez-vous à nouveau.');
  if (await accountByEmail(t, row.email)) return { exists: true, email: row.email };
  const kind: 'store' | 'agency' | 'marketer' = row.kind === 'agency' || row.kind === 'marketer' ? row.kind : 'store';
  const partner = kind !== 'store';
  // a store sign-up without a store name: only the account, proven; the person adds their first store from the picker
  if (!partner && !String(row.store_name ?? '').trim()) {
    const { account } = await ensureAccount(t, { email: row.email, name: row.name, language: row.language, passwordHash: row.password_hash, verified: true });
    return { shop: null, account: await signupPhone(t, account, row.phone, !!row.phone_verified) };
  }
  const set = await platformSettings(t);
  // a partner (agency, marketer) is free (no plan, no trial); Pilotix checks it before it works with stores
  const plan = partner ? null : await startPlan(t, set);
  const name = await storeNameCheck(t, row.store_name, row.slug ?? undefined);
  const slug = name.free ? name.slug : (await storeNameCheck(t, row.store_name)).slug;
  const referrer = !partner && row.referral_code ? ((await t.platform.query(`SELECT id FROM platform.shops WHERE referral_code = $1 AND status <> 'deleted'`, [row.referral_code]))[0]?.id ?? null) : null;
  const shop = await provisionShop(t, {
    name: row.store_name,
    slug,
    planId: plan?.id ?? null,
    trialDays: set.trial.days,
    owner: { name: row.name, email: row.email, phone: row.phone, language: row.language },
    passwordHash: row.password_hash,
    verified: true,
    selfSignup: true,
    referredBy: referrer ? Number(referrer) : null,
    kind,
    now,
  });
  await t.platform.query('UPDATE platform.signup_requests SET shop_id = $2 WHERE id = $1', [row.id, shop.id]);
  if (referrer) await t.platform.query('INSERT INTO platform.referrals (referrer_shop_id, referred_shop_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [referrer, shop.id]);
  await journal(t, shop.id, partner ? `${kind}.signup` : 'shop.signup', row.email, { name: shop.name, plan: plan?.name ?? null, referredBy: referrer });
  const account = await signupPhone(t, (await accountByEmail(t, row.email))!, row.phone, !!row.phone_verified);
  return { shop, account };
}

/** The number given at sign-up becomes the account's (proven when its WhatsApp code was typed). Taken meanwhile: asked at the first login. */
async function signupPhone(t: Tenancy, account: Account, phone: string | null, verified: boolean): Promise<Account> {
  if (!phone || account.phone) return account;
  return (await setAccountPhone(t, account.id, phone, verified).catch(() => null)) ?? account;
}

// ---------------------------------------------------------------- « Continuer avec Google / Facebook »
/**
 * A person proven by Google or Facebook (the server checked their token): their account, made now when they have none
 * (a sign-up: the e-mail is proven by Google / Facebook, so no e-mail to confirm; no password — « Mot de passe oublié »
 * gives one). They then enter their store, or the picker where a new person creates their first store.
 */
export async function socialAccount(t: Tenancy, p: { email: string; name: string; language?: string }): Promise<{ account: Account; created: boolean }> {
  const email = normEmail(p.email);
  if (!email || NO_ACCOUNT.test(email)) throw bad('Cet e-mail ne peut pas ouvrir de compte');
  let acc = await accountByEmail(t, email);
  let created = false;
  if (!acc) {
    const set = await platformSettings(t);
    if (!set.signup.open) throw bad('Les inscriptions sont fermées pour le moment. Écrivez à Pilotix.');
    const lang = p.language === 'en' || p.language === 'ar' ? p.language : 'fr';
    ({ account: acc, created } = await ensureAccount(t, { email, name: (p.name || email.split('@')[0]).trim(), language: lang, passwordHash: null, verified: true }));
  }
  // the e-mail is proven now
  await t.platform.query('UPDATE platform.accounts SET email_verified_at = COALESCE(email_verified_at, now()), last_login_at = now() WHERE id = $1', [acc.id]);
  return { account: (await accountByEmail(t, email))!, created };
}

// ---------------------------------------------------------------- « Ajouter une boutique »
export const AddStoreInput = z.object({
  name: z.string().trim().min(2, 'Nom de la boutique : au moins 2 lettres').max(80),
  slug: z.string().trim().toLowerCase().max(40).optional(),
  /**
   * « Créer mon agence » / « Créer mon espace marketer » from the account menu: a partner's space (one of each per
   * person)
   */
  kind: z.enum(['store', 'agency', 'marketer']).default('store'),
});

/** How many stores this person may own. */
export const storeLimit = (a: Account, set: PlatformSettings) => a.maxStores ?? set.signup.maxStores;

/** A new store for a logged-in person, who owns it (their e-mail must be proven; at most their limit of stores). */
export async function addStore(t: Tenancy, account: Account, raw: unknown, now = Date.now()): Promise<Shop> {
  const set = await platformSettings(t);
  if (!set.signup.open) throw bad('Les nouvelles boutiques sont fermées pour le moment. Écrivez à Pilotix.');
  const p = AddStoreInput.safeParse(raw);
  if (!p.success) throw bad(firstError(p.error));
  if (!account.verified) throw new AppError('forbidden', 'VERIFY_EMAIL');
  const kind = p.data.kind;
  const partner = kind !== 'store';
  if (kind !== 'store') {
    if ((await ownedPartners(t, account.id, kind)) > 0) throw bad(kind === 'agency' ? 'Vous avez déjà une agence de confirmation' : 'Vous avez déjà un espace marketer');
  } else {
    const limit = storeLimit(account, set);
    if ((await ownedStores(t, account.id)) >= limit) throw bad(`Vous avez déjà ${limit} boutique${limit > 1 ? 's' : ''} : c’est le maximum. Écrivez à Pilotix pour en avoir plus.`);
  }
  const name = await storeNameCheck(t, p.data.name, partner ? undefined : p.data.slug);
  if (!name.free) throw bad(name.reason ?? 'Nom indisponible');
  const plan = partner ? null : await startPlan(t, set);
  // the first store after an account-only sign-up: the phone and the referral code given at sign-up
  const first = !partner && (await ownedStores(t, account.id)) === 0;
  const su = first
    ? (await t.platform.query(`SELECT phone, referral_code FROM platform.signup_requests WHERE email = $1 AND used_at IS NOT NULL AND password_hash <> '-' AND shop_id IS NULL ORDER BY created_at DESC LIMIT 1`, [account.email]))[0]
    : null;
  const referrer = su?.referral_code ? ((await t.platform.query(`SELECT id FROM platform.shops WHERE referral_code = $1 AND status <> 'deleted'`, [su.referral_code]))[0]?.id ?? null) : null;
  const shop = await provisionShop(t, {
    name: p.data.name,
    slug: name.slug,
    planId: plan?.id ?? null,
    trialDays: set.trial.days,
    owner: { name: account.name || account.email, email: account.email, phone: su?.phone ?? null, language: account.language },
    verified: true,
    selfSignup: true,
    referredBy: referrer ? Number(referrer) : null,
    kind,
    now,
  });
  if (referrer) await t.platform.query('INSERT INTO platform.referrals (referrer_shop_id, referred_shop_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [referrer, shop.id]);
  await journal(t, shop.id, partner ? `${kind}.added` : 'shop.added', account.email, { name: shop.name, plan: plan?.name ?? null, referredBy: referrer });
  return shop;
}

// ---------------------------------------------------------------- a store deleted by its owner
/** Only the owner, with their password and the store's exact name. Its data is gone for good; its row stays. */
export async function deleteStoreByOwner(t: Tenancy, account: Account, shopId: number, password: string, confirmName: string): Promise<void> {
  const s = await loadShop(t, { id: shopId });
  if (!s || s.status === 'deleted') throw notFound('Boutique introuvable');
  if (s.primary || s.demo) throw forbidden('Cette boutique ne peut pas être supprimée');
  if (s.ownerAccountId !== account.id) throw forbidden('Seul le propriétaire de la boutique peut la supprimer');
  if (!(await checkAccountPassword(t, account.email, password))) throw bad('Mot de passe incorrect');
  if (String(confirmName ?? '').trim().toLowerCase() !== s.name.trim().toLowerCase()) throw bad('Tapez exactement le nom de la boutique pour confirmer');
  await dropShopData(t, s.id, s.schema);
  await t.platform.query(
    `UPDATE platform.shops SET status = 'deleted', deleted_at = now(), slug = 'deleted-' || id, referral_code = NULL, status_reason = 'Supprimée par son propriétaire' WHERE id = $1`,
    [s.id],
  );
  await journal(t, s.id, 'shop.deleted', account.email, { name: s.name, slug: s.slug });
}

// ---------------------------------------------------------------- « Mot de passe oublié » (one account, every store)
export type AccountResetMail = { kind: 'link'; token: string; name: string; email: string; language: string } | { kind: 'limit'; name: string; email: string; language: string };

/**
 * A new-password link for this e-mail, or null when there is nothing to send (no account, too many links this hour).
 * People who are nobody's administrator: 2 changes a month with this link (then « ask your supervisor »).
 */
export async function accountResetRequest(t: Tenancy, email: string, now = Date.now()): Promise<AccountResetMail | null> {
  const acc = await accountByEmail(t, email);
  if (!acc) return null;
  if ((await recentTokens(t, acc.id, 'reset', now - HOUR)) >= 3) return null;
  if (acc.hasPassword && !(await isAdminSomewhere(t, acc)) && (await completedResets(t, acc.id, monthStart(now))) >= RESETS_PER_MONTH) {
    // counted like a link (3 an hour), so this e-mail cannot be used to flood an inbox either
    await t.platform.query(`INSERT INTO platform.account_tokens (token_hash, account_id, kind, created_at, expires_at, used_at) VALUES ($1, $2, 'reset', $3::timestamptz, $3::timestamptz, $3::timestamptz)`, [
      await sha256Hex(randomToken()),
      acc.id,
      iso(now),
    ]);
    return { kind: 'limit', name: acc.name, email: acc.email, language: acc.language };
  }
  return { kind: 'link', token: await makeAccountToken(t, acc.id, 'reset', now), name: acc.name, email: acc.email, language: acc.language };
}

/** The new password from a link (« Mot de passe oublié » or an invitation): for every store of the person. */
export async function passwordFromLink(t: Tenancy, token: string, password: string, now = Date.now()): Promise<Account> {
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw bad('Le mot de passe doit contenir au moins 8 caractères');
  const r = await takeAccountToken(t, ['reset', 'invite'], token, now);
  if (!r) throw bad('Ce lien n’est plus valable. Demandez un nouveau lien.');
  return (await setPasswordFromLink(t, r.account.id, password))!;
}

/** The e-mail check link: the account's e-mail is proven. */
export async function verifyFromLink(t: Tenancy, token: string, now = Date.now()): Promise<Account> {
  const r = await takeAccountToken(t, ['verify'], token, now);
  if (!r) throw bad('Ce lien n’est plus valable. Demandez un nouveau lien.');
  await t.platform.query('UPDATE platform.accounts SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1', [r.account.id]);
  return (await accountByEmail(t, r.account.email))!;
}

/** Is this an invitation link still waiting? (the page says « choose your password » instead of « new password ») */
export async function linkKind(t: Tenancy, token: string, now = Date.now()): Promise<'reset' | 'invite' | null> {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const r = (await t.platform.query('SELECT kind FROM platform.account_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2::timestamptz', [await sha256Hex(token), iso(now)]))[0];
  return r?.kind === 'invite' || r?.kind === 'reset' ? r.kind : null;
}

// ---------------------------------------------------------------- what the app knows of the person in this store
/** The owner flag, the person's other stores, whether they can add one, this month's orders and unread answers. */
export async function shopInfoExtra(t: Tenancy, s: Shop, email: string, set: PlatformSettings): Promise<ShopInfoExtra> {
  const acc = await accountByEmail(t, email);
  // the stores a partner's person works for are reached from the partner's space: not other stores of theirs
  const mem = acc ? (await membershipsOf(t, acc.email)).filter((m) => !m.agencyId) : [];
  return {
    owner: !!acc && s.ownerAccountId === acc.id,
    ownerProfileId: await ownerProfileId(t, s),
    stores: Math.max(0, mem.length - 1),
    canAddStore: !!acc && set.signup.open && !s.demo && (await ownedStores(t, acc.id)) < storeLimit(acc, set),
    canAddAgency: !!acc && set.signup.open && !s.demo && (await ownedAgencies(t, acc.id)) === 0,
    canAddMarketer: !!acc && set.signup.open && !s.demo && (await ownedMarketers(t, acc.id)) === 0,
    ordersMonth: shopMaxOrders(s) !== null ? await ordersThisMonth(t.shop(s.schema)) : null,
    supportUnread: await shopUnread(t, s.id),
  };
}
