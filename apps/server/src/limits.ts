import { HttpException } from '@nestjs/common';

/**
 * Failed logins: 10 per 15 minutes per address, and 5 per account from one address. Never per account alone: a stranger
 * sending wrong passwords from a few addresses would keep the owner out of the shop. Only failures count, and a
 * good password clears the counter. Also used by "mot de passe oublié" and the control room's login.
 */
const attempts = new Map<string, { n: number; until: number; pending: number[] }>();
/** a try still being checked (its password): counted until its answer is known, 15 s at most */
const PENDING_MS = 15_000;

/**
 * Refuses when the limit is reached. `held` (one account's password): the tries still being checked count too, so many
 * sent at the same moment never pass together — each one is counted the moment it arrives; a failure keeps it, a good
 * password clears the counter (clearLogin). The other limits count failures only.
 */
export function checkLogin(key: string, max: number, held = false) {
  const now = Date.now();
  let a = attempts.get(key);
  if (a && a.until < now) {
    attempts.delete(key);
    a = undefined;
  }
  const live = a ? a.pending.filter((t) => now - t < PENDING_MS) : [];
  if ((a?.n ?? 0) + live.length >= max) throw new HttpException({ message: 'Trop de tentatives, réessayez dans quelques minutes' }, 429);
  if (!held) return;
  if (attempts.size > 10_000) for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
  if (!a) {
    a = { n: 0, until: now + 15 * 60_000, pending: [] };
    attempts.set(key, a);
  }
  a.pending = [...live, now];
}

export function failedLogin(key: string) {
  const now = Date.now();
  if (attempts.size > 10_000) for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
  const a = attempts.get(key);
  if (!a || a.until < now) attempts.set(key, { n: 1, until: now + 15 * 60_000, pending: [] });
  else {
    a.n++;
    // its try is known now: no longer « being checked »
    a.pending.shift();
  }
}

export function clearLogin(key: string) {
  attempts.delete(key);
}
