// After a few failed passwords, a login also asks Cloudflare's robot check (Turnstile, invisible: a person sees nothing;
// a script trying passwords is stopped even from many addresses). Not at the backup door (direct.<domain>, for when
// Cloudflare's road is cut) and not when Turnstile is not set up (control room › Doctor): the limits alone, as before.
import { HttpException } from '@nestjs/common';
import type { CoreService } from './core.service';
import { failuresOf } from './limits';
import { turnstileCheck, turnstileSiteKey } from './turnstile';

/** After this many failed tries (from the address, or for the account from it), the robot check is asked too. */
export const ROBOT_AFTER = 3;

const hostOf = (req: { headers?: Record<string, unknown> }) =>
  String(req.headers?.['x-forwarded-host'] || req.headers?.host || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '');

export async function robotGate(core: CoreService, req: { ip?: string; headers?: Record<string, unknown> }, keys: string[], token: unknown): Promise<void> {
  if (!keys.some((k) => failuresOf(k) >= ROBOT_AFTER)) return;
  const host = hostOf(req);
  if (!host || host.startsWith('direct.')) return;
  const site = await turnstileSiteKey(core, host).catch(() => null);
  if (!site) return;
  const t = typeof token === 'string' ? token.trim().slice(0, 4000) : '';
  if (!t) throw new HttpException({ message: 'Une vérification anti-robot est demandée après plusieurs essais.', challenge: site }, 403);
  // Cloudflare unreachable (null): let in, the limits still count; a token Cloudflare refuses: asked again
  if ((await turnstileCheck(core, site, t, req.ip || '')) === false)
    throw new HttpException({ message: 'La vérification anti-robot a échoué : réessayez.', challenge: site }, 403);
}
