// Saved secrets (couriers' API keys, Meta / TikTok / WhatsApp tokens, AI keys, the control room's own keys) are kept
// sealed in the database: a copy of the database alone (a backup, a dump, a table read by mistake) shows none of them.
// The server seals them with its DATA_KEY (deploy/.env, never in the database) as they are written, and opens them as
// they are read (apps/server/src/secretbox.ts: every value the database gives back that starts with the seal's mark).
// Without a sealer (the demo in the browser, the tests that do not set one), values are kept as they are.

/** The mark of a sealed value (what follows: the sealed bytes, base64url). */
export const SEALED = 'enc:v1:';

let sealer: ((plain: string) => string) | null = null;

/** The server gives its sealer once, at its start (null: none). */
export function useSecretSealer(fn: ((plain: string) => string) | null): void {
  sealer = fn;
}

export const sealingOn = (): boolean => sealer !== null;

/** A secret as it is kept: sealed (a value already sealed, or empty, stays as it is). */
export function sealString(s: string): string {
  return sealer && typeof s === 'string' && s !== '' && !s.startsWith(SEALED) ? sealer(s) : s;
}

/** Every text inside (an object's values, a list's items), sealed; numbers, booleans and null as they are. */
export function sealDeep<T>(v: T): T {
  if (!sealer) return v;
  if (typeof v === 'string') return sealString(v) as T;
  if (Array.isArray(v)) return v.map((x) => sealDeep(x)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, sealDeep(x)])) as T;
  return v;
}

/** The shop's settings whose whole value is secret (their names start with secret_: tokens, keys; the pages' own key). */
export const isSecretSetting = (key: string): boolean => key.startsWith('secret_') || key === 'landing_secret';

/** A shop's setting as it is kept: sealed when it is a secret one. */
export const sealSetting = <T>(key: string, value: T): T => (isSecretSetting(key) ? sealDeep(value) : value);

/** In an object (a control-room setting), the fields that are secrets, sealed (the rest stays readable). */
export function sealFields<T>(v: T, fields: readonly string[]): T {
  if (!sealer || !v || typeof v !== 'object' || Array.isArray(v)) return v;
  const o = { ...(v as Record<string, unknown>) };
  for (const f of fields) if (typeof o[f] === 'string') o[f] = sealString(o[f] as string);
  return o as T;
}

/**
 * The control room's settings that hold secrets: the fields sealed in each ('all': every text inside). The others (the
 * plans, the sign-up rules…) stay readable as they are.
 */
export const PLATFORM_SECRETS: Readonly<Record<string, readonly string[] | 'all'>> = {
  pilot_key: ['key'],
  pilot_voice_key: ['key'],
  spy_key_scrapecreators: ['key'],
  spy_key_searchapi: ['key'],
  social_secrets: 'all',
  social_apps: ['verifyToken'],
  courier_test_keys: 'all',
  fraud_reputation_pepper: 'all',
  cloudflare_turnstile: ['token'],
  whatsapp_otp: ['token'],
  backup_offsite: ['keyId', 'key', 'passphrase'],
  photo_store: ['secret'],
};

/** A control-room setting as it is kept: its secret fields sealed. */
export function sealPlatformSetting<T>(key: string, value: T): T {
  const f = PLATFORM_SECRETS[key];
  return !f ? value : f === 'all' ? sealDeep(value) : sealFields(value, f);
}
