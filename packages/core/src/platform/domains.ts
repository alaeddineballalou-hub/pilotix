// A shop's own domain name for its landing pages (myshop.com instead of pilotix.online/<store>): set by the shop's
// administrator, ready once its DNS points to this server (Caddy then gets its HTTPS certificate on demand).
// sha256 in plain code: this file is in the browser build too (the demo)
import { sha256Hex } from '@pilotix/shared';
import { num } from '../db';
import { loadShop, Shop } from './shops';
import type { Tenancy } from './tenancy';

/** A domain name refused (its message is shown to the person). */
export class DomainError extends Error {}

const HOST_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** "https://www.MyShop.com/" → "www.myshop.com" (null = not a domain name). */
export function cleanDomain(input: string): string | null {
  const d = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '');
  return HOST_RE.test(d) ? d : null;
}

/**
 * The proof that a domain is this shop's: every shop's domain points to the same server, so pointing it here proves
 * nothing about WHICH shop owns it. The owner also writes this text in a TXT record named `_pilotix.<domain>` at the
 * domain's registrar — only the domain's owner can. One text per shop and domain (nothing to keep: it is computed).
 */
export function domainProof(shopId: number, domain: string): string {
  return 'pilotix-verify=' + sha256Hex(`pilotix-domain|${shopId}|${domain}`).slice(0, 32);
}
/** Where that TXT record lives. */
export const proofName = (domain: string) => `_pilotix.${domain}`;

/**
 * Sets (or removes: null) the shop's own domain for its landing pages. Never the platform's own address nor one of its
 * sub-domains, never another shop's ready one. Another shop that only TYPED it (pending, never proved) does not keep
 * it: anyone could type a name first. It is pending until its DNS points to this server and carries this shop's proof
 * (checkShopDomain).
 */
export async function setShopDomain(t: Tenancy, shopId: number, input: string | null, platformHost: string): Promise<Shop> {
  if (input === null || !input.trim()) {
    await t.platform.query(`UPDATE platform.shops SET domain = NULL, domain_status = 'none', domain_checked_at = NULL WHERE id = $1`, [shopId]);
    return (await loadShop(t, { id: shopId }))!;
  }
  const d = cleanDomain(input);
  if (!d) throw new DomainError('Nom de domaine invalide (ex. www.ma-boutique.com)');
  const host = platformHost.toLowerCase().replace(/^www\./, '');
  if (host && (d === host || d.endsWith(`.${host}`))) throw new DomainError('Ce domaine appartient à Pilotix : choisissez le vôtre');
  if ((await t.platform.query(`SELECT 1 FROM platform.shops WHERE domain = $1 AND id <> $2 AND domain_status = 'ok'`, [d, shopId])).length) throw new DomainError('Ce domaine est déjà utilisé par une autre boutique');
  // another shop that typed it without proving it: it loses it (its owner sees « no domain » and can type it again)
  await t.platform.query(`UPDATE platform.shops SET domain = NULL, domain_status = 'none', domain_checked_at = NULL WHERE domain = $1 AND id <> $2 AND domain_status <> 'ok'`, [d, shopId]);
  await t.platform.query(`UPDATE platform.shops SET domain = $2, domain_status = CASE WHEN domain = $2 THEN domain_status ELSE 'pending' END, domain_checked_at = NULL WHERE id = $1`, [shopId, d]);
  return (await loadShop(t, { id: shopId }))!;
}

/**
 * Does the shop's domain point to this server, and does it carry this shop's proof? `resolve` gives a name's IPv4
 * addresses, `resolveTxt` its TXT texts (the server's DNS). The domain is ready when every address of it is one of the
 * platform's addresses AND its `_pilotix.` TXT record has this shop's proof. A domain already ready before the proof
 * existed stays ready while it points here (it was proved by being in use).
 */
export async function checkShopDomain(
  t: Tenancy,
  shopId: number,
  platformHost: string,
  resolve: (host: string) => Promise<string[]>,
  resolveTxt: (host: string) => Promise<string[]> = async () => [],
): Promise<{ ok: boolean; found: string[]; expected: string[]; proof: boolean }> {
  const s = await loadShop(t, { id: shopId });
  if (!s?.domain) return { ok: false, found: [], expected: [], proof: false };
  const [found, expected, txt] = await Promise.all([
    resolve(s.domain).catch(() => [] as string[]),
    resolve(platformHost).catch(() => [] as string[]),
    resolveTxt(proofName(s.domain)).catch(() => [] as string[]),
  ]);
  const points = found.length > 0 && expected.length > 0 && found.every((a) => expected.includes(a));
  const proof = txt.map((x) => x.trim()).includes(domainProof(shopId, s.domain));
  const ok = points && (proof || s.domainStatus === 'ok');
  await t.platform.query(`UPDATE platform.shops SET domain_status = $2, domain_checked_at = now() WHERE id = $1`, [shopId, ok ? 'ok' : 'pending']);
  return { ok, found, expected, proof };
}

/** The active shop that uses this domain (ready), or null. */
export async function shopIdByDomain(t: Tenancy, host: string): Promise<number | null> {
  const d = cleanDomain(host.replace(/:\d+$/, ''));
  if (!d) return null;
  const r = (await t.platform.query(`SELECT id FROM platform.shops WHERE domain = $1 AND domain_status = 'ok' AND status = 'active'`, [d]))[0];
  return r ? num(r.id) : null;
}
