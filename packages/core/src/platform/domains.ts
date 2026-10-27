// A shop's own domain name for its landing pages (myshop.com instead of pilotix.online/<store>): set by the shop's
// administrator, ready once its DNS points to this server (Caddy then gets its HTTPS certificate on demand).
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
 * Sets (or removes: null) the shop's own domain for its landing pages. Never the platform's own address nor one of its
 * sub-domains, never another shop's. It is pending until its DNS points to this server (checkShopDomain).
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
  if ((await t.platform.query('SELECT 1 FROM platform.shops WHERE domain = $1 AND id <> $2', [d, shopId])).length) throw new DomainError('Ce domaine est déjà utilisé par une autre boutique');
  await t.platform.query(`UPDATE platform.shops SET domain = $2, domain_status = CASE WHEN domain = $2 THEN domain_status ELSE 'pending' END, domain_checked_at = NULL WHERE id = $1`, [shopId, d]);
  return (await loadShop(t, { id: shopId }))!;
}

/**
 * Does the shop's domain point to this server? `resolve` gives a name's IPv4 addresses (the server's DNS). The domain
 * is ready when every address of it is one of the platform's addresses.
 */
export async function checkShopDomain(t: Tenancy, shopId: number, platformHost: string, resolve: (host: string) => Promise<string[]>): Promise<{ ok: boolean; found: string[]; expected: string[] }> {
  const s = await loadShop(t, { id: shopId });
  if (!s?.domain) return { ok: false, found: [], expected: [] };
  const [found, expected] = await Promise.all([resolve(s.domain).catch(() => [] as string[]), resolve(platformHost).catch(() => [] as string[])]);
  const ok = found.length > 0 && expected.length > 0 && found.every((a) => expected.includes(a));
  await t.platform.query(`UPDATE platform.shops SET domain_status = $2, domain_checked_at = now() WHERE id = $1`, [shopId, ok ? 'ok' : 'pending']);
  return { ok, found, expected };
}

/** The active shop that uses this domain (ready), or null. */
export async function shopIdByDomain(t: Tenancy, host: string): Promise<number | null> {
  const d = cleanDomain(host.replace(/:\d+$/, ''));
  if (!d) return null;
  const r = (await t.platform.query(`SELECT id FROM platform.shops WHERE domain = $1 AND domain_status = 'ok' AND status = 'active'`, [d]))[0];
  return r ? num(r.id) : null;
}
