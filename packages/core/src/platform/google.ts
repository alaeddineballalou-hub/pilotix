// « Continuer avec Google »: who Google says this is. Two kinds of proof reach the server:
// - 'access': the key Google's window gives Pilotix's own plain button (« Continuer avec Google », never a name or a
//   photo on it: 26 Nov 2026, the login page showed « Continue as Ala Eddine » to whoever used the computer);
// - 'id': the ID token Google's own button gave (the old button: a page still open on an old version).
// Either must have been made for Pilotix's own app (aud = its client id): a proof another site got for the same person
// must never open their Pilotix. The e-mail must be one Google proved.

export type GoogleProof = 'id' | 'access';
type GetJson = (url: string, headers?: Record<string, string>) => Promise<any | null>;

const fetchJson: GetJson = async (url, headers) => {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) }).catch(() => null);
  return res?.ok ? ((await res.json().catch(() => null)) as any) : null;
};

const proven = (v: unknown) => v === true || v === 'true';

/** The proven e-mail and the name, or null: not a valid proof for this app. `get`: Google's answers (tests). */
export async function googleIdentity(token: string, kind: GoogleProof, clientId: string, get: GetJson = fetchJson): Promise<{ email: string; name: string } | null> {
  const id = clientId.trim();
  if (!id || !token) return null;
  if (kind === 'id') {
    const j = await get(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`);
    if (!j || j.aud !== id || !['accounts.google.com', 'https://accounts.google.com'].includes(j.iss)) return null;
    if (!proven(j.email_verified) || !j.email) return null;
    return { email: String(j.email), name: String(j.name || '') };
  }
  // the key: Google says which app it was given to (an expired or unknown key: no answer)
  const j = await get(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
  if (!j || j.aud !== id || (j.azp !== undefined && j.azp !== id)) return null;
  if (!proven(j.email_verified) || !j.email) return null;
  // the name, for a new account (the app and the e-mail are already checked): Google's userinfo, with the same key
  const u = await get('https://openidconnect.googleapis.com/v1/userinfo', { Authorization: `Bearer ${token}` });
  const name = u && u.sub && u.sub === j.sub ? String(u.name || '') : '';
  return { email: String(j.email), name };
}
