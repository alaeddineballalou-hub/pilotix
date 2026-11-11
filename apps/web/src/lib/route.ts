// Pilotix's addresses. On the real site they are real addresses, without « # »: pilotix.online/<boutique>/<page>/<sub>…
// — the open boutique's link name first (chosen once, when the boutique, the agency or the marketer's space was made: it
// never changes), then the page. Pages open to everyone have no boutique: pilotix.online/conditions, /inscription,
// /reset/<secret>… (PUBLIC_ROOTS in @pilotix/shared). The preview (the files published in Claude, GitHub Pages, a file
// opened from disk) keeps « #/<page>/… »: a set of plain files answers no other address.
//
// The code keeps writing every link of the app « #/<page>/<sub> » (href, location.hash = …, location.replace(…), the
// server's notifications and Doctor links). This file turns them into real addresses:
// - a link's href when it is drawn (lib/jsx: <a href="#/x"> shows and copies the real address),
// - a click on a link of the app changes the page without loading the site again (history.pushState),
// - « #/… » put in the address (location.hash = …, an old bookmark, an e-mail sent before) is replaced at once by the
//   real address (the bridge): old links keep working.
// The address names the boutique: opened from a bookmark or a link, another of the person's boutiques opens by itself
// (main.tsx); after that, the address always follows the boutique open now.
import { isAppPage, isPublicRoot } from '@pilotix/shared';
import { startTransition, useEffect, useState } from 'react';

/** Real addresses (the site on its own server); false: « #/… » (the preview, GitHub Pages, a file opened from disk). */
export const PATHS = import.meta.env.VITE_DEMO_ONLY !== '1' && import.meta.env.BASE_URL === '/' && /^https?:$/.test(location.protocol);

/** The open boutique's link name (null: nobody logged in yet, or a server with a single shop). */
let shop: string | null = null;

/** Fired on window when the page changes (lib/freshness: a good moment to load a new version). */
export const ROUTE_EVENT = 'px:route';
const EVENT = ROUTE_EVENT;
/** The page changed: every useRoute() reads the address again (after the current work, never inside a render). */
let motion: (apply: () => void) => void = (apply) => apply();
/** ui/motion: how a page change is shown (the old page melting into the new one). It must call « apply » once. */
export const setRouteMotion = (m: (apply: () => void) => void) => {
  motion = m;
};
const changed = () => queueMicrotask(() => motion(() => window.dispatchEvent(new Event(EVENT))));

const decode = (p: string) => {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
};
const words = (s: string) => s.split('/').filter(Boolean).map(decode);
const isAppHash = (h: string) => h.startsWith('#/');
/** « #/a/b » → ['a', 'b'] */
const hashWords = (h: string) => words(h.replace(/^#\/?/, ''));

/** What an address names: the boutique (its link name; null: none) and the page after it. */
export function readAddress(path: string): { shop: string | null; route: string[] } {
  const p = words(path);
  if (!p.length || isPublicRoot(p[0])) return { shop: null, route: p };
  // the open boutique's name, then its page; a page's word alone (/commandes/tout): the page in the open boutique;
  // any other first word is a boutique's name
  if (p[0] === shop) return { shop: p[0], route: p.slice(1) };
  if (isAppPage(p[0])) return { shop: null, route: p };
  return { shop: p[0], route: p.slice(1) };
}

/** The address of a page: 'commandes/tout' (as written after « #/ », encoded) → '/maison-fatima/commandes/tout'. */
function pathOf(raw: string): string {
  const first = decode(raw.split(/[/?]/, 1)[0] ?? '');
  if (!first) return shop ? `/${shop}` : '/';
  if (isPublicRoot(first) || !shop) return `/${raw}`;
  return `/${shop}/${raw}`;
}

/** A link's real address: '#/commandes/tout' → '/maison-fatima/commandes/tout' (anything else, and the preview: as is). */
export function linkHref(link: string): string {
  return PATHS && isAppHash(link) ? pathOf(link.slice(2)) : link;
}

/**
 * The props of an element as lib/jsx draws it: a link of the app written « #/… » gets its real address, and data-route
 * keeps the page it opens (a click opens it in the boutique open now, even on a link drawn before a change of boutique).
 */
export function linkProps<P>(type: unknown, props: P): P {
  if (!PATHS || type !== 'a' || !props) return props;
  const href = (props as { href?: unknown }).href;
  if (typeof href !== 'string' || !isAppHash(href)) return props;
  return { ...props, href: pathOf(href.slice(2)), 'data-route': href };
}

/** The page the address shows: ['commandes', 'tout']. */
export function currentRoute(): string[] {
  if (!PATHS || isAppHash(location.hash)) return hashWords(location.hash);
  return readAddress(location.pathname).route;
}

/** The boutique the address names (null: none, or the preview). */
export const addressShop = (): string | null => (PATHS ? readAddress(location.pathname).shop : null);

/** « #/… » in the address → its real address, in the same history entry. True when it did. */
function bridge(): boolean {
  if (!PATHS || !isAppHash(location.hash)) return false;
  history.replaceState(history.state, '', pathOf(location.hash.slice(2)) + location.search);
  return true;
}

/**
 * Opens a page of the app: go('#/commandes/tout'); replace: in the same history entry (a page that leads to another).
 * The page already shown adds nothing.
 */
export function go(link: string, opts: { replace?: boolean } = {}) {
  const l = isAppHash(link) ? link : `#/${link.replace(/^[#/]+/, '')}`;
  if (!PATHS) {
    if (location.hash === l) return;
    if (opts.replace) location.replace(l);
    else location.hash = l;
    return;
  }
  const to = pathOf(l.slice(2)) + location.search;
  if (to === location.pathname + location.search && !location.hash) return;
  if (opts.replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  changed();
}

/** Leaves a page opened from an e-mail: its secret leaves the address bar and the history (to: the page to show). */
export function leaveAddress(to = '') {
  if (PATHS) history.replaceState(null, '', linkHref(to || '#/') + location.search);
  else history.replaceState(null, '', `${location.pathname}${location.search}${to}`);
  changed();
}

/** The open boutique changed (login, another boutique, logout): the app's links and the address follow it. */
export function setRouteShop(slug: string | null | undefined) {
  const next = slug || null;
  if (next === shop) return;
  shop = next;
  changed();
}

/** The address names the open boutique and the page shown (same history entry). */
export function fixAddress() {
  if (!PATHS) return;
  const want = pathOf(currentRoute().map(encodeURIComponent).join('/'));
  if (location.pathname !== want || location.hash) history.replaceState(history.state, '', want + location.search);
}

/** The page the address shows, read again each time it changes (a link, back / forward, « #/… » set). */
export function useRoute(): string[] {
  const [parts, setParts] = useState(currentRoute);
  useEffect(() => {
    const on = () => {
      // the new page is rendered as a transition: the click shows at once and a big page no longer freezes the screen
      startTransition(() => setParts(currentRoute()));
      window.scrollTo(0, 0);
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return parts;
}

/** An address of the app on this site: not the server (/api, /live), a file (/assets, x.png) or a landing page. */
function isAppPath(path: string): boolean {
  if (/^\/(api|live|assets)(\/|$)/.test(path) || /\.[a-z0-9]+$/i.test(path)) return false;
  const p = words(path);
  // two words that are not a boutique's page: a landing page (pilotix.online/<boutique>/<page>), served by the server
  return !(p.length === 2 && !isPublicRoot(p[0]) && !isAppPage(p[1]));
}

/** A click on a link of the app: the page changes without loading the site again. */
function onClick(e: MouseEvent) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = (e.target as Element | null)?.closest?.('a');
  if (!a || !a.hasAttribute('href') || a.hasAttribute('download')) return;
  if ((a.getAttribute('target') || '_self') !== '_self') return;
  const link = a.getAttribute('data-route') ?? a.getAttribute('href')!;
  if (isAppHash(link)) {
    e.preventDefault();
    go(link);
    return;
  }
  let url: URL;
  try {
    url = new URL(link, location.href);
  } catch {
    return;
  }
  if (url.origin !== location.origin || !isAppPath(url.pathname)) return;
  e.preventDefault();
  if (url.pathname + url.search === location.pathname + location.search) return;
  history.pushState(null, '', url.pathname + url.search);
  changed();
}

if (PATHS) {
  bridge();
  // « #/… » set (location.hash = …, an old link): its real address; back / forward: the page of that address
  window.addEventListener('popstate', () => {
    bridge();
    changed();
  });
  window.addEventListener('hashchange', () => {
    if (bridge()) changed();
  });
  document.addEventListener('click', onClick);
} else {
  window.addEventListener('hashchange', changed);
}
