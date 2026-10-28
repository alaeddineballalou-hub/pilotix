// The phone number of an account: required for every person who logs in, one number = one account, and proven with a
// 6-digit code sent by WhatsApp once Pilotix turned the code on (control room › Réglages › Code WhatsApp).
//   - Code off: the person only gives a number nobody else has (the number already in one of their stores counts).
//   - Code on: the number must be proven once; until then the login stops at « Vérifiez votre numéro ».
// The codes are kept hashed, live 10 minutes, allow 5 tries; one code a minute and 5 an hour per account.
import { normalizeAccountPhone } from '@pilotix/shared';
import { bad } from '../rpc';
import { Account, accountById, NO_ACCOUNT, schemasOf, sha256Hex } from './accounts';
import type { Tenancy } from './tenancy';

export const PHONE_CODE = { ttlMs: 10 * 60_000, tries: 5, perHour: 5, gapMs: 60_000 };

const iso = (ms: number) => new Date(ms).toISOString();
const BAD_PHONE = 'Numéro invalide : un mobile algérien (05, 06 ou 07) ou un numéro étranger avec son + (ex. +33 6…)';
const TAKEN = 'Ce numéro est déjà utilisé par un autre compte';

/** A number written by a person → the account's form of it (or the error to show). */
export function accountPhoneOrBad(raw: unknown): string {
  const p = normalizeAccountPhone(String(raw ?? ''));
  if (!p) throw bad(BAD_PHONE);
  return p;
}

/** Does another account already have this number? */
export async function phoneTaken(t: Tenancy, phone: string, accountId: number | null): Promise<boolean> {
  return (await t.platform.query('SELECT 1 FROM platform.accounts WHERE phone = $1 AND id IS DISTINCT FROM $2', [phone, accountId])).length > 0;
}

/**
 * Gives the account its number (proven or not) and writes it in every store of the person. A new number is not proven
 * until its code is checked.
 */
export async function setAccountPhone(t: Tenancy, accountId: number, raw: string, verified: boolean): Promise<Account> {
  const phone = accountPhoneOrBad(raw);
  if (await phoneTaken(t, phone, accountId)) throw bad(TAKEN);
  let r: any;
  try {
    r = (
      await t.platform.query(
        `UPDATE platform.accounts SET phone_verified_at = CASE WHEN $3 THEN now() WHEN phone IS DISTINCT FROM $2 THEN NULL ELSE phone_verified_at END,
           phone = $2 WHERE id = $1 RETURNING email`,
        [accountId, phone, verified],
      )
    )[0];
  } catch (e: any) {
    if (String(e?.code) === '23505') throw bad(TAKEN);
    throw e;
  }
  if (!r) throw bad('Compte introuvable');
  for (const s of await schemasOf(t, r.email)) await t.shop(s).query('UPDATE profiles SET phone = $2 WHERE email = $1 AND phone IS DISTINCT FROM $2', [r.email, phone]).catch(() => null);
  return (await accountById(t, accountId))!;
}

/** A number the person already gave in one of their stores (their profile), free for this account. */
async function knownPhone(t: Tenancy, acc: Account): Promise<string | null> {
  for (const s of await schemasOf(t, acc.email)) {
    const rows = await t.shop(s).query('SELECT phone FROM profiles WHERE email = $1 AND phone IS NOT NULL', [acc.email]).catch(() => []);
    for (const r of rows as any[]) {
      const p = normalizeAccountPhone(String(r.phone ?? ''));
      if (p && !(await phoneTaken(t, p, acc.id))) return p;
    }
  }
  return null;
}

/** What the login still needs before the person enters: nothing (null), or their number (and its code when `otp`). */
export interface PhoneStep {
  /** the number already known (to prove), or null (the person types it) */
  current: string | null;
  /** a code is sent by WhatsApp to prove it */
  otp: boolean;
}

/**
 * Must this person give (or prove) their number before entering? Code off: a number the person already gave in one of
 * their stores is taken as theirs, without asking. The demo accounts and closed accounts never are asked.
 */
export async function phoneStep(t: Tenancy, acc: Account, otp: boolean): Promise<PhoneStep | null> {
  if (NO_ACCOUNT.test(acc.email)) return null;
  if (acc.phone && (!otp || acc.phoneVerified)) return null;
  const known = acc.phone ?? (await knownPhone(t, acc));
  if (!otp && known) {
    const ok = await setAccountPhone(t, acc.id, known, false).catch(() => null);
    if (ok) return null;
  }
  return { current: known, otp };
}

/** Six random digits. */
function sixDigits(): string {
  const a = globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(a).padStart(6, '0');
}
const codeHash = (accountId: number, phone: string, code: string) => sha256Hex(`${accountId}:${phone}:${code}`);

/**
 * A new code for this number (the earlier ones stop working). Returns the number in the account's form and the code,
 * which the server sends by WhatsApp and never shows anywhere else.
 */
export async function newPhoneCode(t: Tenancy, acc: Account, raw: string, now = Date.now()): Promise<{ phone: string; code: string; id: number }> {
  const phone = accountPhoneOrBad(raw);
  if (await phoneTaken(t, phone, acc.id)) throw bad(TAKEN);
  const last = (await t.platform.query('SELECT created_at FROM platform.phone_codes WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1', [acc.id]))[0];
  const since = last ? now - Date.parse(new Date(last.created_at).toISOString()) : Infinity;
  if (since < PHONE_CODE.gapMs) throw bad(`Attendez ${Math.ceil((PHONE_CODE.gapMs - since) / 1000)} secondes avant de demander un nouveau code`);
  const hour = Number((await t.platform.query('SELECT count(*)::int AS n FROM platform.phone_codes WHERE account_id = $1 AND created_at > $2::timestamptz', [acc.id, iso(now - 3_600_000)]))[0]?.n ?? 0);
  if (hour >= PHONE_CODE.perHour) throw bad('Trop de codes demandés. Réessayez dans une heure.');
  const code = sixDigits();
  await t.platform.query('UPDATE platform.phone_codes SET used_at = $2::timestamptz WHERE account_id = $1 AND used_at IS NULL', [acc.id, iso(now)]);
  const r = await t.platform.query(
    'INSERT INTO platform.phone_codes (account_id, phone, code_hash, created_at, expires_at) VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz) RETURNING id',
    [acc.id, phone, await codeHash(acc.id, phone, code), iso(now), iso(now + PHONE_CODE.ttlMs)],
  );
  return { phone, code, id: Number(r[0].id) };
}

/** The code could not be sent: it does not count (no wait, not in the hour's 5). */
export async function dropPhoneCode(t: Tenancy, id: number): Promise<void> {
  await t.platform.query('DELETE FROM platform.phone_codes WHERE id = $1', [id]);
}

/** The code typed by the person: right → the number is theirs, proven. */
export async function checkPhoneCode(t: Tenancy, acc: Account, raw: string, code: string, now = Date.now()): Promise<Account> {
  const phone = accountPhoneOrBad(raw);
  const typed = String(code ?? '').replace(/\D/g, '');
  const row = (
    await t.platform.query(
      'SELECT id, code_hash, attempts FROM platform.phone_codes WHERE account_id = $1 AND phone = $2 AND used_at IS NULL AND expires_at > $3::timestamptz ORDER BY created_at DESC LIMIT 1',
      [acc.id, phone, iso(now)],
    )
  )[0];
  if (!row) throw bad('Ce code a expiré : demandez un nouveau code');
  if (Number(row.attempts) >= PHONE_CODE.tries) throw bad('Trop d’essais : demandez un nouveau code');
  if (typed.length !== 6 || (await codeHash(acc.id, phone, typed)) !== row.code_hash) {
    const left = PHONE_CODE.tries - Number(row.attempts) - 1;
    await t.platform.query('UPDATE platform.phone_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
    throw bad(left > 0 ? `Code incorrect (encore ${left} essai${left > 1 ? 's' : ''})` : 'Code incorrect : demandez un nouveau code');
  }
  await t.platform.query('UPDATE platform.phone_codes SET used_at = $2::timestamptz WHERE id = $1', [row.id, iso(now)]);
  return setAccountPhone(t, acc.id, phone, true);
}
