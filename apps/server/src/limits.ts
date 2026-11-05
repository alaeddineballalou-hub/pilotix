import { HttpException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import IORedis from 'ioredis';

/**
 * Failed logins: 10 per 15 minutes per address, and 5 per account from one address. Never per account alone: a stranger
 * sending wrong passwords from a few addresses would keep the owner out of the shop. Only failures count, and a
 * good password clears the counter. Also used by "mot de passe oublié" and the control room's login.
 */
const attempts = new Map<string, { n: number; until: number; pending: number[] }>();
/** the counters are kept under a fingerprint of their key (an address, an e-mail): never the key itself */
const fp = (key: string) => createHash('sha256').update(key).digest('base64url').slice(0, 24);
/** a try still being checked (its password): counted until its answer is known, 15 s at most */
const PENDING_MS = 15_000;

/**
 * Refuses when the limit is reached. `held` (one account's password): the tries still being checked count too, so many
 * sent at the same moment never pass together — each one is counted the moment it arrives; a failure keeps it, a good
 * password clears the counter (clearLogin). The other limits count failures only.
 */
export function checkLogin(raw: string, max: number, held = false) {
  const key = fp(raw);
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

export function failedLogin(raw: string) {
  const key = fp(raw);
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

export function clearLogin(raw: string) {
  attempts.delete(fp(raw));
}

// ---------------------------------------------------------------- kept across restarts
// An update restarts the server: without this, every counter would start again from zero after each update. The
// failures counted (their fingerprints, their end) are written to Redis every 30 seconds and when the server stops,
// and read back when it starts. Redis away: the counters simply live in memory, as before.
const KEEP_KEY = 'pilotix:login-limits';
let keeper: IORedis | null = null;
let keepTimer: NodeJS.Timeout | null = null;

export async function keepLimits(redisUrl: string): Promise<void> {
  if (!redisUrl || keeper) return;
  keeper = new IORedis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2500, enableOfflineQueue: false });
  keeper.on('error', () => null);
  try {
    await keeper.connect();
    const saved = JSON.parse((await keeper.get(KEEP_KEY)) ?? '[]') as [string, number, number][];
    const now = Date.now();
    for (const [k, n, until] of Array.isArray(saved) ? saved : [])
      if (typeof k === 'string' && Number.isFinite(n) && n > 0 && until > now && !attempts.has(k)) attempts.set(k, { n, until, pending: [] });
  } catch {
    /* Redis away: in memory only */
  }
  keepTimer = setInterval(() => void saveLimits(), 30_000);
  keepTimer.unref?.();
}

export async function saveLimits(): Promise<void> {
  if (!keeper || keeper.status !== 'ready') return;
  const now = Date.now();
  const live = [...attempts].filter(([, v]) => v.until > now && v.n > 0).map(([k, v]) => [k, v.n, v.until]);
  await keeper.set(KEEP_KEY, JSON.stringify(live), 'PX', 15 * 60_000).catch(() => null);
}

export async function stopKeepingLimits(): Promise<void> {
  if (keepTimer) clearInterval(keepTimer);
  keepTimer = null;
  await saveLimits();
  keeper?.disconnect();
  keeper = null;
}
