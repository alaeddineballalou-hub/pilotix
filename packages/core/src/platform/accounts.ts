// Accounts on a multi-shop server: one person = one e-mail and one password, whatever the number of stores they work
// in. Each store keeps its own team list (profiles: name, roles, language); the account is the key to all of them.
// The account's password is copied into each of the person's profiles, so every store checks the same password.
// Who may set a password: the person (Mon profil, « Mot de passe oublié », an invitation link); a store's admin only for
// someone who works in that store alone and is not its owner.
// A password a store's admin chose (a new team member, a password given by the admin) is not the person's own: it opens
// the stores of that seller only (password_by 'admin', password_owner), never a store the person creates, and it goes
// when the person proves their e-mail with Google. Only a link sent to the e-mail makes a password the person's own.
import bcrypt from 'bcryptjs';
import { isoOrNull, num, numOrNull } from '../db';
import { hashPassword } from '../modules/users';
import type { Tenancy } from './tenancy';

const DAY = 86_400_000;

export interface Account {
  id: number;
  email: string;
  name: string;
  language: string;
  /** false: invited, the password is not chosen yet */
  hasPassword: boolean;
  tokenVersion: number;
  /** the e-mail was proven (a link opened, a sign-up confirmed, or the account existed before accounts) */
  verified: boolean;
  /** stores this person may own (null = the platform's setting) */
  maxStores: number | null;
  /** the person's own phone number (one number = one account) */
  phone: string | null;
  /** the phone was proven with a code sent to it */
  phoneVerified: boolean;
  /**
   * who chose the password: the person ('self': through a link sent to the e-mail, or at sign-up), a store's admin
   * ('admin': it opens the stores of `passwordOwner` only), or not known (null: before this was kept; no password)
   */
  passwordBy: 'self' | 'admin' | null;
  /** with 'admin': the seller (their account) whose store's admin chose it */
  passwordOwner: number | null;
  createdAt: string;
  lastLoginAt: string | null;
}

const toAccount = (r: any): Account => ({
  id: num(r.id),
  email: r.email,
  name: r.name ?? '',
  language: r.language ?? 'fr',
  hasPassword: !!r.password_hash,
  tokenVersion: num(r.token_version),
  verified: !!r.email_verified_at,
  maxStores: numOrNull(r.max_stores),
  phone: r.phone ?? null,
  phoneVerified: !!r.phone_verified_at,
  passwordBy: r.password_by === 'self' || r.password_by === 'admin' ? r.password_by : null,
  passwordOwner: numOrNull(r.password_owner),
  createdAt: new Date(r.created_at).toISOString(),
  lastLoginAt: isoOrNull(r.last_login_at),
});

export const normEmail = (e: unknown) => String(e ?? '').trim().toLowerCase();
/** Closed accounts and the demo shop's shared accounts never get an account of their own. */
export const NO_ACCOUNT = /@(pilotix\.invalid|demo\.pilotix\.dz)$/i;

export async function accountByEmail(t: Tenancy, email: string): Promise<Account | null> {
  const r = (await t.platform.query('SELECT * FROM platform.accounts WHERE email = $1', [normEmail(email)]))[0];
  return r ? toAccount(r) : null;
}

export async function accountById(t: Tenancy, id: number): Promise<Account | null> {
  const r = (await t.platform.query('SELECT * FROM platform.accounts WHERE id = $1', [id]))[0];
  return r ? toAccount(r) : null;
}

export async function accountHash(t: Tenancy, id: number): Promise<string | null> {
  return ((await t.platform.query('SELECT password_hash FROM platform.accounts WHERE id = $1', [id]))[0]?.password_hash as string | null) ?? null;
}

/**
 * A password nobody knows, for a store's copy of an account that has none yet (Google, an invitation not opened): never
 * a bcrypt hash (every check of it fails), and recognisable (« ! »).
 */
export const unusableHash = () => `!${randomToken()}`;
export const isUnusableHash = (h: unknown) => typeof h === 'string' && h.startsWith('!');

/** The seller (their account) who owns the store with this schema. */
async function ownerOfSchema(t: Tenancy, schema: string): Promise<number | null> {
  return numOrNull((await t.platform.query('SELECT owner_account_id FROM platform.shops WHERE schema_name = $1', [schema]))[0]?.owner_account_id);
}

/**
 * May this account's password open this store? A password a store's admin chose opens the stores of that seller only
 * (their own stores too, if the person has some): a former admin who knows it never opens anything else.
 */
export async function passwordOpens(t: Tenancy, acc: Account, shopId: number): Promise<boolean> {
  if (acc.passwordBy !== 'admin') return true;
  const owner = numOrNull((await t.platform.query('SELECT owner_account_id FROM platform.shops WHERE id = $1', [shopId]))[0]?.owner_account_id);
  return owner !== null && (owner === acc.passwordOwner || owner === acc.id);
}

/**
 * A password someone else may know (a store's admin chose it, or it was set before the e-mail was ever proven) goes:
 * the account has none (Google, or a link to choose one), every session of the person ends, and their stores' copies
 * never open anything.
 */
export async function dropForeignPassword(t: Tenancy, accountId: number): Promise<Account | null> {
  const r = (
    await t.platform.query(`UPDATE platform.accounts SET password_hash = NULL, password_by = NULL, password_owner = NULL, token_version = token_version + 1 WHERE id = $1 RETURNING *`, [accountId])
  )[0];
  if (!r) return null;
  for (const schema of await schemasOf(t, r.email)) await t.shop(schema).query('UPDATE profiles SET password_hash = $2, token_version = token_version + 1 WHERE email = $1', [r.email, unusableHash()]);
  return toAccount(r);
}

/** Its password may be known by someone else than the person (see dropForeignPassword). */
export const foreignPassword = (a: Account) => a.hasPassword && (a.passwordBy === 'admin' || !a.verified);

let dummy: Promise<string> | null = null;
const dummyHash = () => (dummy ??= bcrypt.hash('not-a-real-password', 12));

/**
 * E-mail + password → the account, or null. An unknown e-mail, or an invited person without a password yet, takes as
 * long as a real check: nobody learns which e-mails have an account.
 */
export async function checkAccountPassword(t: Tenancy, email: string, password: string): Promise<Account | null> {
  const r = (await t.platform.query('SELECT * FROM platform.accounts WHERE email = $1', [normEmail(email)]))[0];
  const hash = (r?.password_hash as string | null) ?? null;
  const ok = hash ? await bcrypt.compare(String(password), hash) : (await bcrypt.compare(String(password), await dummyHash()), false);
  if (!r || !ok) return null;
  await t.platform.query('UPDATE platform.accounts SET last_login_at = now() WHERE id = $1', [r.id]);
  return toAccount(r);
}

/** One store where this person has an active account. */
export interface Membership {
  shopId: number;
  schema: string;
  profileId: number;
  roles: string[];
  /** an agent of this confirmation agency working in the store (null: the store's own person) */
  agencyId: number | null;
}

/**
 * The stores of an e-mail (from the login index), with the person's account in each — active only, in stores that
 * still exist (not archived or deleted). Suspended or unpaid stores are listed: they open on their lock screen.
 */
export async function membershipsOf(t: Tenancy, email: string): Promise<Membership[]> {
  const e = normEmail(email);
  const rows = await t.platform.query(
    `SELECT s.id, s.schema_name FROM platform.logins l JOIN platform.shops s ON s.id = l.shop_id
      WHERE l.email = $1 AND s.status NOT IN ('archived', 'deleted') ORDER BY s.primary_shop DESC, s.id`,
    [e],
  );
  const out: Membership[] = [];
  for (const r of rows as any[]) {
    const p = (await t.shop(r.schema_name).query('SELECT id, roles, active, agency_id FROM profiles WHERE email = $1', [e]).catch(() => []))[0];
    if (p?.active) out.push({ shopId: num(r.id), schema: r.schema_name, profileId: num(p.id), roles: p.roles as string[], agencyId: numOrNull(p.agency_id) });
  }
  return out;
}

/** Every schema where this e-mail has a profile (active or not), stores that still exist. */
export async function schemasOf(t: Tenancy, email: string): Promise<string[]> {
  const rows = await t.platform.query(
    `SELECT s.schema_name FROM platform.logins l JOIN platform.shops s ON s.id = l.shop_id WHERE l.email = $1 AND s.status NOT IN ('archived', 'deleted')`,
    [normEmail(email)],
  );
  return rows.map((r: any) => r.schema_name as string);
}

/**
 * Makes sure an e-mail has an account. A new one takes `passwordHash` (null: invited, the person chooses it from the
 * e-mail); an existing one is left as it is.
 */
export async function ensureAccount(
  t: Tenancy,
  a: { email: string; name: string; language?: string; passwordHash: string | null; verified?: boolean; passwordBy?: 'self' | 'admin' | null; passwordOwner?: number | null },
): Promise<{ account: Account; created: boolean }> {
  const email = normEmail(a.email);
  // a store's copy that never opens anything is no password for the account
  const hash = isUnusableHash(a.passwordHash) ? null : a.passwordHash;
  const made = (
    await t.platform.query(
      `INSERT INTO platform.accounts (email, name, language, password_hash, email_verified_at, password_by, password_owner) VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() END, $6, $7)
       ON CONFLICT (email) DO NOTHING RETURNING *`,
      [email, a.name.trim().slice(0, 120), a.language ?? 'fr', hash, !!a.verified, hash ? (a.passwordBy ?? null) : null, hash && a.passwordBy === 'admin' ? (a.passwordOwner ?? null) : null],
    )
  )[0];
  if (made) return { account: toAccount(made), created: true };
  return { account: (await accountByEmail(t, email))!, created: false };
}

/**
 * A store's profile just made, or given another e-mail: it is linked to the person's account. Someone who already has
 * an account keeps their own password (a store's admin never sets it): with none yet (Google, an invitation not
 * opened), the password the admin typed never opens anything. A new person gets an account with the password the admin
 * chose, which opens that seller's stores only. Returns whether the account existed before (null: an e-mail that never
 * gets an account).
 */
export async function attachProfile(t: Tenancy, schema: string, profileId: number, opts: { verified?: boolean } = {}): Promise<{ existing: boolean; account: Account } | null> {
  const db = t.shop(schema);
  const p = (await db.query('SELECT id, email, name, language, password_hash FROM profiles WHERE id = $1', [profileId]))[0];
  if (!p || NO_ACCOUNT.test(p.email)) return null;
  const owner = await ownerOfSchema(t, schema);
  const { account, created } = await ensureAccount(t, { email: p.email, name: p.name, language: p.language, passwordHash: p.password_hash, verified: opts.verified, passwordBy: owner ? 'admin' : null, passwordOwner: owner });
  if (!created) {
    const h = await accountHash(t, account.id);
    if (h) {
      if (h !== p.password_hash) await db.query('UPDATE profiles SET password_hash = $2, token_version = token_version + 1 WHERE id = $1', [profileId, h]);
    } else if (!isUnusableHash(p.password_hash)) await db.query('UPDATE profiles SET password_hash = $2, token_version = token_version + 1 WHERE id = $1', [profileId, unusableHash()]);
  }
  return { existing: !created, account };
}

/**
 * A new password for the person, in every store they work in: every session everywhere ends. `verify`: the person
 * proved the e-mail is theirs (a link opened).
 */
export async function setAccountPassword(t: Tenancy, accountId: number, hash: string, opts: { verify?: boolean } = {}): Promise<Account | null> {
  // chosen through a link sent to the e-mail (or at sign-up): the person's own, it opens every store of theirs
  const r = (
    await t.platform.query(
      `UPDATE platform.accounts SET password_hash = $2, token_version = token_version + 1, password_by = 'self', password_owner = NULL,
         email_verified_at = CASE WHEN $3 THEN COALESCE(email_verified_at, now()) ELSE email_verified_at END
       WHERE id = $1 RETURNING *`,
      [accountId, hash, !!opts.verify],
    )
  )[0];
  if (!r) return null;
  for (const schema of await schemasOf(t, r.email)) await t.shop(schema).query('UPDATE profiles SET password_hash = $2, token_version = token_version + 1 WHERE email = $1', [r.email, hash]);
  return toAccount(r);
}

/**
 * The person's password changed in one store (Mon profil, or set by the admin of their only store): the account and
 * every other store follow. `by`: 'admin' — the store's admin chose it (it opens that seller's stores only); 'self' —
 * the person through a link sent to their e-mail; 'keep' — the person in Mon profil (whoever chose the old one: a
 * password chosen there never becomes « their own » without the e-mail, the old one may be known by an admin).
 */
export async function propagateProfilePassword(t: Tenancy, schema: string, profileId: number, by: 'admin' | 'self' | 'keep' = 'keep'): Promise<void> {
  const p = (await t.shop(schema).query('SELECT email, name, language, password_hash FROM profiles WHERE id = $1', [profileId]))[0];
  if (!p || NO_ACCOUNT.test(p.email) || isUnusableHash(p.password_hash)) return;
  const owner = by === 'admin' ? await ownerOfSchema(t, schema) : null;
  // a store without a known owner: nothing to limit the password to
  const who = by === 'admin' && owner === null ? 'keep' : by;
  const { account, created } = await ensureAccount(t, { email: p.email, name: p.name, language: p.language, passwordHash: p.password_hash, passwordBy: who === 'keep' ? null : who, passwordOwner: owner });
  if (created) return;
  await t.platform.query(
    `UPDATE platform.accounts SET password_hash = $2, token_version = token_version + 1,
       password_by = CASE $3::text WHEN 'keep' THEN password_by ELSE $3::text END, password_owner = CASE $3::text WHEN 'keep' THEN password_owner ELSE $4::int END WHERE id = $1`,
    [account.id, p.password_hash, who, owner],
  );
  for (const s of await schemasOf(t, p.email)) {
    if (s === schema) continue;
    await t.shop(s).query('UPDATE profiles SET password_hash = $2, token_version = token_version + 1 WHERE email = $1 AND password_hash IS DISTINCT FROM $2', [p.email, p.password_hash]);
  }
}

/** The owner's profile in a store (null: no owner known, or the owner has no account in it any more). */
export async function ownerProfileId(t: Tenancy, s: { schema: string; ownerAccountId: number | null }): Promise<number | null> {
  if (!s.ownerAccountId) return null;
  const a = await accountById(t, s.ownerAccountId);
  if (!a) return null;
  const r = (await t.shop(s.schema).query('SELECT id FROM profiles WHERE email = $1', [a.email]).catch(() => []))[0];
  return r ? num(r.id) : null;
}

/**
 * May a store's administrator (or a team manager) set this person's password? Only for someone who works in this
 * store alone and is not its owner: otherwise they would open the person's other stores.
 */
export async function adminMaySetPassword(t: Tenancy, shopId: number, email: string): Promise<boolean> {
  const e = normEmail(email);
  if (NO_ACCOUNT.test(e)) return true;
  const shops = await t.platform.query('SELECT l.shop_id, s.schema_name FROM platform.logins l JOIN platform.shops s ON s.id = l.shop_id WHERE l.email = $1', [e]);
  for (const r of shops as any[]) {
    if (num(r.shop_id) === shopId) continue;
    // a confirmation agency's agent inside a store the agency works for: still the agency's own person
    const p = (await t.shop(r.schema_name).query('SELECT agency_id FROM profiles WHERE lower(email) = $1', [e]).catch(() => []))[0];
    if (p && num(p.agency_id) === shopId) continue;
    return false;
  }
  const owns = await t.platform.query('SELECT 1 FROM platform.shops s JOIN platform.accounts a ON a.id = s.owner_account_id WHERE a.email = $1 AND s.status <> $2', [e, 'deleted']);
  return owns.length === 0;
}

/** Stores this account owns (deleted ones do not count; nor its partner spaces: agency, marketer). */
export async function ownedStores(t: Tenancy, accountId: number): Promise<number> {
  return num((await t.platform.query(`SELECT count(*)::int AS n FROM platform.shops WHERE owner_account_id = $1 AND status <> 'deleted' AND kind = 'store'`, [accountId]))[0]?.n);
}

/** Partner spaces of this kind (confirmation agency, marketer) this account owns (one of each at most). */
export async function ownedPartners(t: Tenancy, accountId: number, kind: 'agency' | 'marketer'): Promise<number> {
  return num((await t.platform.query(`SELECT count(*)::int AS n FROM platform.shops WHERE owner_account_id = $1 AND status <> 'deleted' AND kind = $2`, [accountId, kind]))[0]?.n);
}
/** Confirmation agencies this account owns (one at most). */
export const ownedAgencies = (t: Tenancy, accountId: number) => ownedPartners(t, accountId, 'agency');
/** Marketer spaces this account owns (one at most). */
export const ownedMarketers = (t: Tenancy, accountId: number) => ownedPartners(t, accountId, 'marketer');

// ---------------------------------------------------------------- one-time links (new password, invitation, e-mail check)
export type AccountTokenKind = 'reset' | 'invite' | 'verify';
const TOKEN_MINUTES: Record<AccountTokenKind, number> = { reset: 30, invite: 7 * 24 * 60, verify: 3 * 24 * 60 };

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export async function sha256Hex(text: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('');
}
export const randomToken = () => base64url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
const iso = (ms: number) => new Date(ms).toISOString();

/** A new link of this kind for the account (only the newest one works). */
export async function makeAccountToken(t: Tenancy, accountId: number, kind: AccountTokenKind, now = Date.now()): Promise<string> {
  const token = randomToken();
  await t.platform.query('UPDATE platform.account_tokens SET used_at = $3::timestamptz WHERE account_id = $1 AND kind = $2 AND used_at IS NULL', [accountId, kind, iso(now)]);
  await t.platform.query('INSERT INTO platform.account_tokens (token_hash, account_id, kind, created_at, expires_at) VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz)', [
    await sha256Hex(token),
    accountId,
    kind,
    iso(now),
    iso(now + TOKEN_MINUTES[kind] * 60_000),
  ]);
  return token;
}

/** Uses a link once (two clicks cannot both work): its account, or null when unknown, used or too old. */
export async function takeAccountToken(t: Tenancy, kinds: AccountTokenKind[], token: string, now = Date.now()): Promise<{ account: Account; kind: AccountTokenKind } | null> {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const r = (
    await t.platform.query(
      `UPDATE platform.account_tokens SET used_at = $2::timestamptz, completed_at = $2::timestamptz
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2::timestamptz AND kind = ANY($3) RETURNING account_id, kind`,
      [await sha256Hex(token), iso(now), kinds],
    )
  )[0];
  if (!r) return null;
  const account = await accountById(t, num(r.account_id));
  return account ? { account, kind: r.kind } : null;
}

/** Links of this kind made for the account since `since` (a stranger cannot fill someone's inbox). */
export async function recentTokens(t: Tenancy, accountId: number, kind: AccountTokenKind, since: number): Promise<number> {
  return num((await t.platform.query('SELECT count(*)::int AS n FROM platform.account_tokens WHERE account_id = $1 AND kind = $2 AND created_at > $3::timestamptz', [accountId, kind, iso(since)]))[0]?.n);
}

/** Password changes done with « Mot de passe oublié » since `since`. */
export async function completedResets(t: Tenancy, accountId: number, since: number): Promise<number> {
  return num(
    (await t.platform.query(`SELECT count(*)::int AS n FROM platform.account_tokens WHERE account_id = $1 AND kind = 'reset' AND completed_at >= $2::timestamptz`, [accountId, iso(since)]))[0]?.n,
  );
}

/** Is this person an administrator somewhere, or a store's owner? (« Mot de passe oublié » is then never limited) */
export async function isAdminSomewhere(t: Tenancy, account: Account): Promise<boolean> {
  if ((await ownedStores(t, account.id)) > 0 || (await ownedAgencies(t, account.id)) > 0 || (await ownedMarketers(t, account.id)) > 0) return true;
  return (await membershipsOf(t, account.email)).some((m) => m.roles.includes('admin'));
}

// ---------------------------------------------------------------- the first start of accounts (every start: safe to repeat)
/**
 * Every person already in a store gets an account (their current password, e-mail taken as proven), then every store
 * copies its people's password from their account. Stores that were made before owners existed get theirs.
 */
export async function backfillAccounts(t: Tenancy): Promise<void> {
  const shops = await t.platform.query(`SELECT id, schema_name, primary_shop, owner_email, owner_account_id FROM platform.shops WHERE status NOT IN ('archived', 'deleted') AND NOT is_demo ORDER BY primary_shop DESC, id`);
  for (const s of shops as any[]) {
    const db = t.shop(s.schema_name);
    const rows = await db
      .query(`SELECT email, name, language, password_hash FROM profiles WHERE active AND email NOT LIKE '%@pilotix.invalid' AND email NOT LIKE '%@demo.pilotix.dz' ORDER BY id`)
      .catch(() => []);
    for (const p of rows as any[])
      await t.platform.query(
        `INSERT INTO platform.accounts (email, name, language, password_hash, email_verified_at) VALUES (lower($1), $2, $3, $4, now()) ON CONFLICT (email) DO NOTHING`,
        [p.email, p.name ?? '', p.language ?? 'fr', p.password_hash],
      );
    await db
      .query(
        `UPDATE profiles p SET password_hash = a.password_hash FROM platform.accounts a
          WHERE a.email = lower(p.email) AND a.password_hash IS NOT NULL AND p.password_hash IS DISTINCT FROM a.password_hash`,
      )
      .catch(() => {});
    if (!s.owner_account_id) {
      // shop #1: its first administrator (the platform's owner); the others: the e-mail they were made for
      const email = s.primary_shop
        ? ((await db.query(`SELECT email FROM profiles WHERE active AND 'admin' = ANY(roles) AND email NOT LIKE '%@pilotix.invalid' AND email NOT LIKE '%@demo.pilotix.dz' ORDER BY id LIMIT 1`).catch(() => []))[0]?.email as string | undefined)
        : (s.owner_email as string | null);
      if (email) await t.platform.query('UPDATE platform.shops SET owner_account_id = (SELECT id FROM platform.accounts WHERE email = lower($2)) WHERE id = $1', [s.id, email]);
    }
  }
}

/** A new password chosen from a link (« Mot de passe oublié », an invitation): kept for every store. */
export async function setPasswordFromLink(t: Tenancy, accountId: number, password: string): Promise<Account | null> {
  return setAccountPassword(t, accountId, await hashPassword(password), { verify: true });
}

export const ACCOUNT_DAY = DAY;
