// After a few failed passwords, a login also asks Cloudflare's robot check (Turnstile, invisible: a person sees nothing;
// a script trying passwords is stopped even from many addresses). Not at the backup door (direct.<domain>, for when
// Cloudflare's road is cut) and not when Turnstile is not set up (control room › Doctor): the limits alone, as before.
import { HttpException } from '@nestjs/common';
import type { CoreService } from './core.service';
import { failuresOf } from './limits';
import { turnstileCheck, turnstileSiteKey } from './turnstile';

/** After this many failed tries (from the address, or for the account from it), the robot check is asked too. */
export const ROBOT_AFTER = 3;
/**
 * One account's failed tries from ALL addresses together (someone changing address every two tries): after this many
 * the robot check is asked for that account, whatever the address — a person sees nothing, a script is stopped.
 */
export const ACCOUNT_ROBOT_AFTER = 5;
/**
 * Where no robot check can be asked (the backup door direct.<domain>, or Turnstile not set up): after this many failed
 * tries for one account from all addresses, that account is refused there for the rest of the 15 minutes. Its owner
 * still gets in by the normal address (pilotix.online), where the robot check lets people through.
 */
export const ACCOUNT_CAP_NO_ROBOT = 20;

const hostOf = (req: { headers?: Record<string, unknown> }) =>
  String(req.headers?.['x-forwarded-host'] || req.headers?.host || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '');

/**
 * `account`: the counter of this account's failures from every address (« acct:<e-mail> »): someone guessing a password
 * from many addresses is asked the robot check too, and refused where no robot check exists.
 */
export async function robotGate(core: CoreService, req: { ip?: string; headers?: Record<string, unknown> }, keys: string[], token: unknown, account?: string): Promise<void> {
  const acct = account ? failuresOf(account) : 0;
  if (!keys.some((k) => failuresOf(k) >= ROBOT_AFTER) && acct < ACCOUNT_ROBOT_AFTER) return;
  const host = hostOf(req);
  const site = !host || host.startsWith('direct.') ? null : await turnstileSiteKey(core, host).catch(() => null);
  if (!site) {
    // no robot check here: one account's tries from every address are capped instead
    if (acct >= ACCOUNT_CAP_NO_ROBOT)
      throw new HttpException({ message: 'Trop de tentatives sur ce compte : connectez-vous depuis l’adresse habituelle de Pilotix, ou réessayez dans 15 minutes' }, 429);
    return;
  }
  const t = typeof token === 'string' ? token.trim().slice(0, 4000) : '';
  if (!t) throw new HttpException({ message: 'Une vérification anti-robot est demandée après plusieurs essais.', challenge: site }, 403);
  // Cloudflare unreachable (null): let in, the limits still count; a token Cloudflare refuses: asked again
  if ((await turnstileCheck(core, site, t, req.ip || '')) === false)
    throw new HttpException({ message: 'La vérification anti-robot a échoué : réessayez.', challenge: site }, 403);
}
