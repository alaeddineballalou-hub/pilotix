// The address of a boutique's landing pages in every link Pilotix shows or sends: the pages' list and its « Copier », the
// editors, the ads launched from Pilotix, the Meta catalogue and the WhatsApp campaigns (Landing pages › Réglages ›
// « Liens des pages », decided 20 Nov 2026).
//
// - Its own domain (https://<domain>/<page>) by default, once it is ready (its DNS points to the server, with its proof:
//   platform/domains.ts) and still reaches the server (the server checks it every 10 minutes: CoreService.shopDomainLive).
// - Else, or when the boutique chooses it, the platform's pages address (https://go.<domain>/<store>/<page>).
// - One page or group can choose the other one (its editor › « Où vit cette page », 21 Nov 2026); « default » follows
//   the boutique's choice, also when it changes. Its own domain still only while it works.
// Both addresses always serve every page, whatever is chosen: links already out (ads, messages) keep working.
//
// Imports no other module of ./modules but landingquery: no import cycle.
import { z } from 'zod';
import { Ctx, forbidden, proc } from '../rpc';
import { getSetting, setSetting } from '../settings';
import { landingStore } from './landingquery';

export type LinkChoice = 'own' | 'pilotix';
/** a page's (or a group's) own choice: 'default' = as the boutique chose (its column link_use: NULL) */
export const LINK_USE = ['default', 'own', 'pilotix'] as const;
export type LinkUse = (typeof LINK_USE)[number];
export const readLinkUse = (v: unknown): LinkUse => (v === 'own' || v === 'pilotix' ? v : 'default');
/** what the column link_use holds for a choice */
export const linkUseDb = (u: LinkUse): LinkChoice | null => (u === 'default' ? null : u);

export interface OwnDomain {
  domain: string;
  /** its DNS: 'ok' = ready (its pages are served there), 'pending' = waiting for its DNS or its proof */
  status: 'none' | 'pending' | 'ok';
  /** it still reaches the server (false after 2 failed checks in a row; true when nothing was checked yet) */
  live: boolean;
}

export interface PageLinks {
  /** the store's part of the platform's addresses (site/<store>/<page>) */
  store: string;
  /** the platform's pages address (https://go.<domain> once it answers, else the site's), no trailing slash; '' in the preview */
  base: string;
  /** what the boutique chose (Réglages › « Liens des pages »): 'own' unless it chose the platform's address */
  choice: LinkChoice;
  /** its own domain, when it has one (a shop of the platform; never the demo shop nor the preview) */
  own: OwnDomain | null;
  /** the links use its own domain now: chosen, ready and reaching the server */
  usesOwn: boolean;
  /** what a page's (or a group's) link starts with, ending with « / »: https://<domain>/ or <base>/<store>/; '' with no address */
  prefix: string;
  /** https://<domain>/ while its own domain is ready and reaches the server, else '' (whatever is chosen) */
  ownPrefix: string;
  /** <base>/<store>/ ('' with no address) */
  pilotixPrefix: string;
}

/** The boutique's own domain on the platform, as Pilotix knows it now. */
async function ownDomainOf(ctx: Ctx): Promise<OwnDomain | null> {
  if (!ctx.server || !ctx.t || !ctx.shop || ctx.shop.demo) return null;
  const r = (await ctx.t.platform.query(`SELECT domain, domain_status FROM platform.shops WHERE id = $1`, [ctx.shop.id]).catch(() => [] as any[]))[0];
  if (!r?.domain) return null;
  const status: OwnDomain['status'] = r.domain_status === 'ok' ? 'ok' : r.domain_status === 'pending' ? 'pending' : 'none';
  return { domain: String(r.domain).toLowerCase(), status, live: ctx.server.shopDomainLive?.(ctx.shop.id) ?? true };
}

/**
 * Where the boutique's page links point now. `fallbackBase`: the platform's address to use when there is no server (the
 * ads launcher's preview), so a link still shows.
 */
export async function pageLinks(ctx: Ctx, fallbackBase = ''): Promise<PageLinks> {
  const store = await landingStore(ctx.db);
  const choice: LinkChoice = (await getSetting(ctx.db, 'pagelinks')).use === 'pilotix' ? 'pilotix' : 'own';
  const own = await ownDomainOf(ctx);
  const base = String(ctx.server?.pagesUrl?.() || ctx.server?.publicUrl || fallbackBase).replace(/\/+$/, '');
  const ownPrefix = own && own.status === 'ok' && own.live ? `https://${own.domain}/` : '';
  const pilotixPrefix = base ? `${base}/${store ? `${store}/` : ''}` : '';
  const usesOwn = !!ownPrefix && choice === 'own';
  return { store, base, choice, own, usesOwn, prefix: usesOwn ? ownPrefix : pilotixPrefix, ownPrefix, pilotixPrefix };
}

/**
 * What one page's (or group's) link starts with: its own choice (`use`: its link_use), else the boutique's; its own domain
 * only while it is ready and reaches the server, else the platform's address.
 */
export function prefixFor(l: PageLinks, use?: unknown): string {
  const u = readLinkUse(use);
  const want: LinkChoice = u === 'default' ? l.choice : u;
  return want === 'own' && l.ownPrefix ? l.ownPrefix : l.pilotixPrefix;
}

export const pageLinksProcs = {
  /** Réglages › « Liens des pages »: the boutique's own domain in its links (the default) or the platform's address. */
  'landing.links.set': proc([], z.object({ use: z.enum(['own', 'pilotix']) }), async (ctx, i) => {
    if (!ctx.session.isAdmin) throw forbidden('Seul l’administrateur choisit l’adresse des liens');
    await setSetting(ctx.db, 'pagelinks', { use: i.use }, ctx.session.profile.id);
    ctx.emit({ type: 'settings' });
    const l = await pageLinks(ctx);
    return { choice: l.choice, usesOwn: l.usesOwn, prefix: l.prefix };
  }),
};
