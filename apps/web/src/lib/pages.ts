// The address the landing pages live at, for the links the app shows and copies.
import { useEffect, useState } from 'react';
import { backend, domainGet, serverUrl, shopApi } from './backend';
import { useRpc } from './query';

/** a page's (or a group's) own choice of address (« Où vit cette page »): 'default' = as the boutique chose */
export type LinkUse = 'default' | 'own' | 'pilotix';

const useLinks = () => useRpc('landing.store', {}, { staleTime: 60_000 }).data;

/** their own address (https://go.<domain>) once the server reaches it there, else the app's (as before; the demo too) */
export const usePagesBase = () => useLinks()?.pagesUrl || serverUrl();

/**
 * What a page's (or a group's) public link starts with, ending with « / », for its own choice (`use`; missing or
 * 'default': the boutique's, Landing pages › Réglages › « Liens des pages »), as the server's prefixFor: the boutique's
 * own domain (https://babyjoydz.net/) while it is ready and reaches the server, else <pages' address>/<store>/. '' while
 * it loads or in the demo (its links open inside the app).
 */
export function usePrefixOf(): (use?: LinkUse | null) => string {
  const d = useLinks();
  return (use) => {
    if (!d) return '';
    const p = use === 'own' || use === 'pilotix' ? (use === 'own' && d.ownPrefix ? d.ownPrefix : d.pilotixPrefix) : d.prefix;
    if (p) return p;
    const base = (d.pagesUrl || serverUrl()).replace(/\/+$/, '');
    return base && d.store ? `${base}/${d.store}/` : '';
  };
}

/** The boutique's link start: a page or a group that did not choose its own address. */
export const usePagesPrefix = (): string => usePrefixOf()();

/**
 * The boutique's own domain once it is ready (its DNS points to the server), when a page may choose it: the server's,
 * the demo's sample (Réglages › « Liens des pages », kept in this browser). live: it still reaches the server.
 */
export function useOwnDomain(): { domain: string; live: boolean } | null {
  const own = useLinks()?.own;
  const [demo, setDemo] = useState<{ domain: string; live: boolean } | null>(null);
  useEffect(() => {
    if (backend.kind !== 'demo') return;
    let on = true;
    domainGet()
      .then((r) => on && setDemo(r.domain && r.status === 'ok' ? { domain: r.domain, live: true } : null))
      .catch(() => null);
    return () => {
      on = false;
    };
  }, []);
  if (backend.kind === 'demo') return demo;
  return own && own.status === 'ok' ? { domain: own.domain, live: own.live } : null;
}

/** Pilotix's pages address as the screens show it (no https://); the demo shows the real one. */
export function usePilotixHost(): string {
  const d = useLinks();
  return (d?.pagesUrl || serverUrl() || (backend.kind === 'demo' ? 'https://go.pilotix.online' : location.origin)).replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/**
 * What the editors show before a page's (or a group's) address, no https://: the start of its link for this choice. The
 * demo shows its sample addresses (its own links open inside the app).
 */
export function useShownPrefix(use: LinkUse): string {
  const d = useLinks();
  const own = useOwnDomain();
  const host = usePilotixHost();
  const prefixOf = usePrefixOf();
  if (backend.kind !== 'demo') return (prefixOf(use) || `${shopApi(serverUrl() || '')}/lp/`).replace(/^https?:\/\//, '');
  const eff = use === 'default' ? d?.choice ?? 'own' : use;
  return own && eff === 'own' ? `${own.domain}/` : `${host}/${d?.store ?? '…'}/`;
}
