// A shop's own domain name for its landing pages (myshop.com instead of pilotix.online/<store>): set by the shop's
// administrator, ready once its TXT record proves it is the shop's and the site answers through it in HTTPS — straight
// to this server or through Cloudflare's orange cloud (20 Nov 2026): the domain's addresses are not checked any more,
// behind Cloudflare they are Cloudflare's. Caddy gets its HTTPS certificate on demand once the TXT proof is there.
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
 * it: anyone could type a name first. It is pending until it carries this shop's proof and answers in HTTPS
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

/** Why a domain did not answer in HTTPS (the owner is told what to fix). */
export type DomainReachWhy = 'timeout' | 'tls' | 'redirect' | 'cloudflare' | 'other-site' | 'error';

/** What the domain check asks the outside world. */
export interface DomainLookups {
  /** a name's TXT texts (the shop's proof: domainProof) */
  resolveTxt: (host: string) => Promise<string[]>;
  /**
   * Opens https://<domain>/… through the domain, as a customer would (Cloudflare or not), and tells whether THIS server
   * answered: only it can give the answer it expects (apps/server domainEcho.ts).
   */
  reaches: (domain: string) => Promise<{ ok: boolean; why?: DomainReachWhy }>;
  /** a name's IPv4 addresses: only shown to the owner (where the domain points today), never needed any more */
  resolve?: (host: string) => Promise<string[]>;
}

/**
 * Is the shop's domain ready? Its `_pilotix.` TXT record carries this shop's proof AND the site answers through the
 * domain in HTTPS from this server (look.reaches). Where it points does not matter: straight here, or through
 * Cloudflare's orange cloud. The HTTPS test runs only for a domain proved to be the shop's: it makes Caddy ask for a
 * certificate. A domain ready before the proof existed stays ready while it answers (it was proved by being in use).
 * A ready domain that still carries its proof stays ready when the HTTPS test fails once (Cloudflare or the network
 * can fail for a minute): the 10-minute check moves its links to the platform's address while it does not answer,
 * nothing else changes.
 */
export async function checkShopDomain(
  t: Tenancy,
  shopId: number,
  look: DomainLookups,
): Promise<{ ok: boolean; proof: boolean; https: boolean; why?: DomainReachWhy; found: string[] }> {
  const s = await loadShop(t, { id: shopId });
  if (!s?.domain) return { ok: false, proof: false, https: false, found: [] };
  const was = s.domainStatus === 'ok';
  const [txt, found] = await Promise.all([
    look.resolveTxt(proofName(s.domain)).catch(() => [] as string[]),
    look.resolve ? look.resolve(s.domain).catch(() => [] as string[]) : Promise.resolve([] as string[]),
  ]);
  const proof = txt.map((x) => x.trim()).includes(domainProof(shopId, s.domain));
  const reach: { ok: boolean; why?: DomainReachWhy } = proof || was ? await look.reaches(s.domain).catch(() => ({ ok: false, why: 'error' as const })) : { ok: false };
  const ok = (reach.ok && (proof || was)) || (was && proof);
  await t.platform.query(`UPDATE platform.shops SET domain_status = $2, domain_checked_at = now() WHERE id = $1`, [shopId, ok ? 'ok' : 'pending']);
  return { ok, proof, https: reach.ok, why: reach.ok ? undefined : reach.why, found };
}

/**
 * May Caddy get an HTTPS certificate for this name? Yes for a ready domain of an active shop, and for an active shop's
 * domain still pending whose TXT record already carries its proof: the HTTPS test of checkShopDomain needs that
 * certificate first. A name nobody proved gets nothing (no certificate for any name someone points here).
 */
export async function shopIdForCertificate(t: Tenancy, host: string, resolveTxt: (host: string) => Promise<string[]>): Promise<number | null> {
  const ready = await shopIdByDomain(t, host);
  if (ready) return ready;
  const d = cleanDomain(host.replace(/:\d+$/, ''));
  if (!d) return null;
  const r = (await t.platform.query(`SELECT id FROM platform.shops WHERE domain = $1 AND status = 'active'`, [d]))[0];
  if (!r) return null;
  const txt = await resolveTxt(proofName(d)).catch(() => [] as string[]);
  return txt.map((x) => x.trim()).includes(domainProof(num(r.id), d)) ? num(r.id) : null;
}

/** The active shop that uses this domain (ready), or null. */
export async function shopIdByDomain(t: Tenancy, host: string): Promise<number | null> {
  const d = cleanDomain(host.replace(/:\d+$/, ''));
  if (!d) return null;
  const r = (await t.platform.query(`SELECT id FROM platform.shops WHERE domain = $1 AND domain_status = 'ok' AND status = 'active'`, [d]))[0];
  return r ? num(r.id) : null;
}

/**
 * Where a shop's own domain sends an address that is none of its pages: an old link from the site the domain came from
 * (babyjoydz.net/product/28026, moved from JustSell on 20 Nov 2026), a page taken offline, a typo. The customer lands on
 * the shop's home (« / », its pages), never on an error. A page's address with a « / » at its end goes to that page.
 * A file (a dot in its last part: /favicon.ico, /sitemap.xml; an old site's /x.html is a page) and the hidden
 * addresses (/.well-known/…, /.env) stay « not found »: a browser or a robot asked for a file, not a customer for a
 * page. null = not found (the home itself too, so it never sends anyone in a circle).
 */
export function domainFallback(path: string): string | null {
  const p = String(path ?? '').replace(/[?#].*$/, '');
  const parts = p.split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last || parts[0].startsWith('.') || (last.includes('.') && !/\.(?:html?|php)$/i.test(last))) return null;
  const page = /^\/([a-z0-9-]{2,60})\/+$/.exec(p);
  return page ? `/${page[1]}` : '/';
}
