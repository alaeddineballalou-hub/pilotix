// The control room's authenticator app (TOTP, RFC 6238: Google Authenticator, Microsoft Authenticator, 2FAS…): a
// 6-digit code that changes every 30 seconds, made on the staff member's phone from a secret shown once as a QR code.
// Once it is on, it replaces the e-mailed code at login: an e-mail account taken over no longer opens the control room.
// The secret is kept sealed (secretbox); a code serves once (the step it was made for is kept).
import { bad } from '../rpc';
import { sealString } from '../secretbox';
import type { Tenancy } from './tenancy';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_MS = 30_000;

export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function unbase32(s: string): Uint8Array {
  const clean = String(s ?? '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** The 6-digit code of one step (RFC 4226, HMAC-SHA1). */
export async function hotp(secret: Uint8Array, counter: number): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey('raw', new Uint8Array(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new ArrayBuffer(8);
  const v = new DataView(msg);
  v.setUint32(0, Math.floor(counter / 2 ** 32));
  v.setUint32(4, counter >>> 0);
  const h = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, msg));
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

/** The step a code was made for: now, 30 seconds before or after (a phone's clock a little off); null: none. */
export async function totpStep(secretB32: string, code: string, now = Date.now()): Promise<number | null> {
  const typed = String(code ?? '').replace(/\D/g, '');
  if (typed.length !== 6) return null;
  const key = unbase32(secretB32);
  if (key.length < 10) return null;
  const step = Math.floor(now / STEP_MS);
  let found: number | null = null;
  // every step is computed (the same time whichever matches)
  for (const s of [step - 1, step, step + 1]) {
    const c = await hotp(key, s);
    let diff = 0;
    for (let i = 0; i < 6; i++) diff |= c.charCodeAt(i) ^ typed.charCodeAt(i);
    if (diff === 0 && found === null) found = s;
  }
  return found;
}

async function row(t: Tenancy, staffId: number): Promise<{ email: string; secret: string | null; on: boolean; step: number | null } | null> {
  const r = (await t.platform.query('SELECT email, totp_secret, totp_on, totp_step FROM platform.staff WHERE id = $1 AND active', [staffId]))[0];
  return r ? { email: String(r.email), secret: r.totp_secret ? String(r.totp_secret) : null, on: !!r.totp_on, step: r.totp_step === null || r.totp_step === undefined ? null : Number(r.totp_step) } : null;
}

export async function staffTotpOn(t: Tenancy, staffId: number): Promise<boolean> {
  return !!(await row(t, staffId))?.on;
}

/** A new secret, shown once (its QR code): it counts only once a code made from it is typed (totpConfirm). */
export async function totpStart(t: Tenancy, staffId: number): Promise<{ secret: string; uri: string }> {
  const r = await row(t, staffId);
  if (!r) throw bad('Compte introuvable');
  if (r.on) throw bad('L’application d’authentification est déjà active : retirez-la d’abord pour en mettre une autre.');
  const secret = base32(globalThis.crypto.getRandomValues(new Uint8Array(20)));
  await t.platform.query('UPDATE platform.staff SET totp_secret = $2, totp_on = false, totp_step = NULL WHERE id = $1', [staffId, sealString(secret)]);
  const label = encodeURIComponent(`Pilotix:${r.email}`);
  return { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=Pilotix&algorithm=SHA1&digits=6&period=30` };
}

/** The first code made by the phone: the app is on from now (the e-mailed code is no longer asked). */
export async function totpConfirm(t: Tenancy, staffId: number, code: string, now = Date.now()): Promise<void> {
  const r = await row(t, staffId);
  if (!r?.secret || r.on) throw bad('Recommencez : « Ajouter l’application »');
  const step = await totpStep(r.secret, code, now);
  if (step === null) throw bad('Code incorrect : tapez le code à 6 chiffres que montre l’application maintenant');
  await t.platform.query('UPDATE platform.staff SET totp_on = true, totp_step = $2 WHERE id = $1', [staffId, step]);
}

/** Turned off with a code of the app (a stolen session alone cannot remove it). */
export async function totpOff(t: Tenancy, staffId: number, code: string, now = Date.now()): Promise<void> {
  if (!(await totpCheck(t, staffId, code, now))) throw bad('Code incorrect : tapez le code à 6 chiffres que montre l’application maintenant');
  await t.platform.query('UPDATE platform.staff SET totp_secret = NULL, totp_on = false, totp_step = NULL WHERE id = $1', [staffId]);
}

/** A login's code: right, and never used before (each code serves once). */
export async function totpCheck(t: Tenancy, staffId: number, code: string, now = Date.now()): Promise<boolean> {
  const r = await row(t, staffId);
  if (!r?.on || !r.secret) return false;
  const step = await totpStep(r.secret, code, now);
  if (step === null || (r.step !== null && step <= r.step)) return false;
  // kept only if no other login used this step meanwhile
  return (await t.platform.query('UPDATE platform.staff SET totp_step = $2 WHERE id = $1 AND (totp_step IS NULL OR totp_step < $2) RETURNING id', [staffId, step])).length > 0;
}
