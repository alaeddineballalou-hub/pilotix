// The WhatsApp code that proves a person's phone (one number = one account). Pilotix's own WhatsApp Business number
// sends it with an approved « Authentication » template (Meta: « {{1}} est votre code de vérification », with the
// « Copier le code » button). The owner of the platform sets it once in the control room › Réglages: the number's ID,
// a permanent token, the template's name and language, and turns the code on. The token never comes back to a screen.
// Off (the default) or not set up: every account still needs its own number, but no code is asked.
// Without a server able to reach Meta (development), the code is written in the server's log instead.
import { Logger } from '@nestjs/common';
import { phoneWa } from '@pilotix/shared';
import type { CoreService } from './core.service';

const log = new Logger('OTP');
const SETTING = 'whatsapp_otp';
const GRAPH = 'https://graph.facebook.com/v21.0';

export interface OtpConfig {
  /** the code is asked to prove every account's number */
  on: boolean;
  /** Meta: the WhatsApp number's ID (Phone number ID) */
  phoneId: string;
  /** Meta: a permanent token (system user) allowed to send from that number */
  token: string;
  /** the approved Authentication template */
  template: string;
  /** its language code (fr, en, ar…) */
  lang: string;
  /** the template has the « Copier le code » button (Meta's default for Authentication templates) */
  button: boolean;
  lastError?: string | null;
  lastSentAt?: string | null;
}

const EMPTY: OtpConfig = { on: false, phoneId: '', token: '', template: '', lang: 'fr', button: true };

export async function readOtp(core: CoreService): Promise<OtpConfig> {
  const r = (await core.t.platform.query(`SELECT value FROM platform.settings WHERE key = $1`, [SETTING]))[0];
  return { ...EMPTY, ...((r?.value as Partial<OtpConfig> | undefined) ?? {}) };
}

async function writeOtp(core: CoreService, v: OtpConfig) {
  await core.t.platform.query(
    `INSERT INTO platform.settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [SETTING, JSON.stringify(v)],
  );
}

const ready = (c: OtpConfig) => !!(c.phoneId && c.token && c.template);
/** Is the WhatsApp code asked now? (turned on and set up) */
export const otpOn = async (core: CoreService) => {
  const c = await readOtp(core);
  return c.on && ready(c);
};

/** What the control room shows (never the token). */
export async function otpStatus(core: CoreService) {
  const c = await readOtp(core);
  const counts = (
    await core.t.platform.query(
      `SELECT count(*)::int AS accounts, count(phone)::int AS with_phone, count(phone_verified_at)::int AS verified FROM platform.accounts WHERE email NOT LIKE '%@pilotix.invalid'`,
    )
  )[0];
  return {
    on: c.on && ready(c),
    wanted: c.on,
    ready: ready(c),
    phoneId: c.phoneId,
    tokenSet: !!c.token,
    template: c.template,
    lang: c.lang,
    button: c.button,
    lastError: c.lastError ?? null,
    lastSentAt: c.lastSentAt ?? null,
    accounts: Number(counts?.accounts ?? 0),
    withPhone: Number(counts?.with_phone ?? 0),
    verified: Number(counts?.verified ?? 0),
  };
}

/** Sends the code by WhatsApp; the error to show when Meta refuses. */
async function sendWith(c: OtpConfig, phone: string, code: string): Promise<void> {
  const components: unknown[] = [{ type: 'body', parameters: [{ type: 'text', text: code }] }];
  if (c.button) components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] });
  let res: Response;
  try {
    res = await fetch(`${GRAPH}/${encodeURIComponent(c.phoneId)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: phoneWa(phone), type: 'template', template: { name: c.template, language: { code: c.lang || 'fr' }, components } }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('WhatsApp injoignable pour le moment. Réessayez dans une minute.');
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    const e = data?.error;
    if (e?.code === 190) throw new Error('Le jeton WhatsApp de Pilotix a expiré (salle de contrôle › Réglages).');
    if (e?.code === 131026 || e?.code === 131030) throw new Error('Ce numéro n’a pas WhatsApp (ou ne peut pas recevoir de message). Vérifiez le numéro.');
    if (e?.code === 132001) throw new Error('Le modèle WhatsApp du code n’existe pas ou n’est pas approuvé (salle de contrôle › Réglages).');
    throw new Error(`WhatsApp : ${e?.error_user_msg ?? e?.message ?? res.statusText}`);
  }
}

/** Sends one code to a person. Throws the message to show when it could not be sent. */
export async function sendOtp(core: CoreService, phone: string, code: string): Promise<void> {
  const c = await readOtp(core);
  if (!ready(c)) {
    // never in production without a sender: the code would only be in the log
    if (process.env.NODE_ENV === 'production') throw new Error('Le code WhatsApp n’est pas configuré. Écrivez à Pilotix.');
    log.warn(`(development) code for ${phone}: ${code}`);
    return;
  }
  try {
    await sendWith(c, phone, code);
    await writeOtp(core, { ...c, lastError: null, lastSentAt: new Date().toISOString() });
  } catch (e) {
    const msg = (e as Error).message;
    // the person's own number: not a problem of the setup
    if (!/n’a pas WhatsApp/.test(msg)) await writeOtp(core, { ...c, lastError: msg });
    throw e;
  }
}

/** The owner saves the settings (an empty token keeps the one already saved). Turning it on needs everything set. */
export async function saveOtp(core: CoreService, b: Partial<OtpConfig>) {
  const c = await readOtp(core);
  const next: OtpConfig = {
    ...c,
    on: !!b.on,
    phoneId: String(b.phoneId ?? c.phoneId).trim().slice(0, 40),
    token: String(b.token ?? '').trim() ? String(b.token).trim().slice(0, 600) : c.token,
    template: String(b.template ?? c.template).trim().slice(0, 120),
    lang: String(b.lang ?? c.lang).trim().slice(0, 12) || 'fr',
    button: b.button === undefined ? c.button : !!b.button,
  };
  if (next.phoneId && !/^\d{5,25}$/.test(next.phoneId)) throw new Error('ID du numéro WhatsApp : des chiffres seulement (Meta › WhatsApp › Configuration de l’API)');
  if (next.template && !/^[a-z0-9_]{1,120}$/.test(next.template)) throw new Error('Nom du modèle : lettres minuscules, chiffres et _ (comme dans Meta)');
  if (next.on && !ready(next)) throw new Error('Remplissez l’ID du numéro, le jeton et le modèle avant d’activer le code');
  await writeOtp(core, next);
  return otpStatus(core);
}

/** « Envoyer un test »: a code to a number (not kept, proves nothing). */
export async function testOtp(core: CoreService, phone: string) {
  const c = await readOtp(core);
  if (!ready(c)) throw new Error('Remplissez l’ID du numéro, le jeton et le modèle d’abord');
  await sendWith(c, phone, String(Math.floor(100000 + Math.random() * 900000)));
  await writeOtp(core, { ...c, lastError: null, lastSentAt: new Date().toISOString() });
  return otpStatus(core);
}
