import { HttpException } from '@nestjs/common';

/**
 * Failed logins: 10 per 15 minutes per address, and 5 per account from one address. Never per account alone: a stranger
 * sending wrong passwords from a few addresses would keep the owner out of the shop. Only failures count, and a
 * good password clears the counter. Also used by "mot de passe oublié" and the control room's login.
 */
const attempts = new Map<string, { n: number; until: number }>();

export function checkLogin(key: string, max: number) {
  const a = attempts.get(key);
  if (a && a.until >= Date.now() && a.n >= max) throw new HttpException({ message: 'Trop de tentatives, réessayez dans quelques minutes' }, 429);
}

export function failedLogin(key: string) {
  const now = Date.now();
  if (attempts.size > 10_000) for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
  const a = attempts.get(key);
  if (!a || a.until < now) attempts.set(key, { n: 1, until: now + 15 * 60_000 });
  else a.n++;
}

export function clearLogin(key: string) {
  attempts.delete(key);
}
