// The HTTPS test of a shop's own domain (Landing pages › Réglages › « Votre propre domaine »).
//
// Since 20 Nov 2026 a shop's domain may sit behind Cloudflare's orange cloud (babyjoydz.net first): its addresses are
// then Cloudflare's, so « the domain points to the server's address » proves nothing any more. Instead the server opens
// https://<domain>/api/domain-echo?n=<random word> through the domain, as a customer would, and checks the answer. Only
// this server can compute it (a keyed hash of the name and the random word, with the server's secret), so the right
// answer proves the domain's road ends here — straight, or through Cloudflare. Nothing secret travels: the answer is a
// hash, new for every random word.
import { createHmac, randomBytes } from 'node:crypto';
import type { DomainReachWhy } from '@pilotix/core';
import { config } from './config';

/** The answer this server gives for a name and a random word (the echo route, api.ts). */
export function domainEcho(host: string, nonce: string): string {
  const name = host.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  return createHmac('sha256', `${config.jwtSecret}:domain-echo`).update(`${name}|${nonce}`).digest('hex').slice(0, 40);
}

/** The random word: 32 hexadecimal letters (anything else is refused before any hashing). */
export const echoNonceOk = (n: unknown): n is string => typeof n === 'string' && /^[a-f0-9]{32}$/.test(n);

/** Cloudflare's own error pages: its road to the server failed (521 down, 522/524 too slow, 525/526 certificate). */
const CLOUDFLARE = new Set([520, 521, 522, 523, 524, 525, 526, 530]);
/** A certificate refused: missing, expired, for another name, not trusted. */
const TLS = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|EPROTO/i;

/**
 * Opens https://<domain>/api/domain-echo through the domain: did THIS server answer? A redirect is not followed (with
 * Cloudflare's « Flexible » SSL mode the site sends the visitor round in circles), a certificate must be valid (the
 * customers' browsers would refuse it too). `get` is the fetch to use (tests).
 */
export async function reachDomain(domain: string, timeoutMs: number, get: typeof fetch = fetch): Promise<{ ok: boolean; why?: DomainReachWhy }> {
  const nonce = randomBytes(16).toString('hex');
  try {
    const r = await get(`https://${domain}/api/domain-echo?n=${nonce}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'Pilotix-domain-check' },
    });
    if (r.status >= 300 && r.status < 400) return { ok: false, why: 'redirect' };
    if (CLOUDFLARE.has(r.status)) return { ok: false, why: 'cloudflare' };
    const body = (await r.text()).trim();
    return r.ok && body === domainEcho(domain, nonce) ? { ok: true } : { ok: false, why: 'other-site' };
  } catch (e: any) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { ok: false, why: 'timeout' };
    const said = `${e?.cause?.code ?? e?.code ?? ''} ${e?.cause?.message ?? ''}`;
    return { ok: false, why: TLS.test(said) ? 'tls' : 'error' };
  }
}
