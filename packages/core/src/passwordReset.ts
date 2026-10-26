// "Mot de passe oublié": makes and uses one-time reset links. The e-mail itself is sent by the server.
// Works the same on PostgreSQL and in the browser preview (Web Crypto, no Node module).
import { Db } from './db';
import { hashPassword } from './modules/users';
import { AppError } from './rpc';

/** How long a link works. */
export const RESET_MINUTES = 30;
/** At most this many links per account per hour (a stranger cannot fill someone's inbox). */
const PER_HOUR = 3;
/** Password changes by e-mail per person per calendar month (Algeria time); administrators are not limited. */
export const RESETS_PER_MONTH = 2;

/** First instant of the month (Algeria, UTC+1 all year) that contains `now`. */
function monthStart(now: number): number {
  const d = new Date(now + 3_600_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 3_600_000;
}

const iso = (ms: number) => new Date(ms).toISOString();

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(text: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('');
}

export interface PasswordResetLink {
  token: string;
  name: string;
  email: string;
  language: string;
}

/** What to e-mail: the link, or "you already changed it twice this month, ask your supervisor". */
export type PasswordResetMail = ({ kind: 'link' } & PasswordResetLink) | { kind: 'limit'; name: string; email: string; language: string };

/**
 * A new reset link for this e-mail, or null when there is nothing to send (no such account, account turned off,
 * too many links this hour). The caller answers the same way in every case: nobody learns which e-mails exist.
 */
export async function createPasswordReset(db: Db, email: string, now = Date.now()): Promise<PasswordResetMail | null> {
  const r = (await db.query('SELECT id, name, email, language, active, roles FROM profiles WHERE email = $1', [String(email).trim().toLowerCase()]))[0];
  if (!r || !r.active) return null;
  const recent = Number((await db.query('SELECT count(*)::int AS n FROM password_resets WHERE profile_id = $1 AND created_at > $2::timestamptz', [r.id, iso(now - 3_600_000)]))[0]?.n ?? 0);
  if (recent >= PER_HOUR) return null;
  if (!(r.roles as string[]).includes('admin')) {
    const done = Number(
      (await db.query('SELECT count(*)::int AS n FROM password_resets WHERE profile_id = $1 AND completed_at >= $2::timestamptz', [r.id, iso(monthStart(now))]))[0]?.n ?? 0,
    );
    if (done >= RESETS_PER_MONTH) {
      // counted like a link (3 an hour), so this e-mail cannot be used to flood an inbox either
      await db.query('INSERT INTO password_resets (profile_id, token_hash, expires_at, used_at, created_at) VALUES ($1, $2, $3::timestamptz, $3::timestamptz, $3::timestamptz)', [
        r.id,
        await sha256(base64url(globalThis.crypto.getRandomValues(new Uint8Array(32)))),
        iso(now),
      ]);
      return { kind: 'limit', name: r.name, email: r.email, language: r.language };
    }
  }
  const token = base64url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  // only the newest link works
  await db.query('UPDATE password_resets SET used_at = $2::timestamptz WHERE profile_id = $1 AND used_at IS NULL', [r.id, iso(now)]);
  await db.query('INSERT INTO password_resets (profile_id, token_hash, expires_at, created_at) VALUES ($1, $2, $3::timestamptz, $4::timestamptz)', [
    r.id,
    await sha256(token),
    iso(now + RESET_MINUTES * 60_000),
    iso(now),
  ]);
  return { kind: 'link', token, name: r.name, email: r.email, language: r.language };
}

const EXPIRED = 'Ce lien n’est plus valable. Demandez un nouveau lien.';

/** Sets a new password with a reset link (once). Every session of the account is logged out. */
export async function resetPassword(db: Db, token: string, password: string, now = Date.now()): Promise<{ email: string }> {
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw new AppError('bad_request', 'Le mot de passe doit contenir au moins 8 caractères');
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new AppError('bad_request', EXPIRED);
  // taken in one statement: two clicks on the same link cannot both work
  const row = (
    await db.query('UPDATE password_resets SET used_at = $2::timestamptz, completed_at = $2::timestamptz WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2::timestamptz RETURNING profile_id', [
      await sha256(token),
      iso(now),
    ])
  )[0];
  if (!row) throw new AppError('bad_request', EXPIRED);
  const p = await db.query('UPDATE profiles SET password_hash = $2, token_version = token_version + 1 WHERE id = $1 AND active RETURNING email', [row.profile_id, await hashPassword(password)]);
  if (!p.length) throw new AppError('bad_request', EXPIRED);
  return { email: p[0].email };
}
