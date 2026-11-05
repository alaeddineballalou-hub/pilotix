// « Se déconnecter » ends that session on the server too: its token's id (jti) is kept until the token would have
// ended anyway, and the server refuses it (the API and the live updates). Other devices stay logged in.
import type { Tenancy } from './tenancy';

/** This token (its id and end) stops now. */
export async function revokeToken(t: Tenancy, jti: string, exp: Date): Promise<void> {
  if (!jti || jti.length > 100) return;
  await t.platform.query('INSERT INTO platform.revoked_tokens (jti, exp) VALUES ($1, $2) ON CONFLICT (jti) DO NOTHING', [jti, exp.toISOString()]);
  // the ones that would have ended anyway are forgotten
  await t.platform.query('DELETE FROM platform.revoked_tokens WHERE exp < now()');
}

/** The tokens stopped since this moment (null: all that still matter), with their end (ms). */
export async function revokedSince(t: Tenancy, since: Date | null): Promise<{ jti: string; exp: number }[]> {
  const rows = since
    ? await t.platform.query<{ jti: string; exp: string }>('SELECT jti, exp FROM platform.revoked_tokens WHERE at >= $1 AND exp > now()', [since.toISOString()])
    : await t.platform.query<{ jti: string; exp: string }>('SELECT jti, exp FROM platform.revoked_tokens WHERE exp > now()');
  return rows.map((r) => ({ jti: String(r.jti), exp: new Date(r.exp).getTime() }));
}
