// The Pilotix Chrome extension (apps/extension), seen from AI Spy. The extension's small script on this page
// (bridge.js: always on pilotix.online and direct.pilotix.online, and on any other Pilotix address added in its popup)
// answers window messages:
//   page → extension  { source: 'pilotix-page', id, type: 'ping' }
//                     { source: 'pilotix-page', id, type: 'search', query, country, max }
//   extension → page  { source: 'pilotix-ext', type: 'ready', version }            (when the page loads)
//                     { source: 'pilotix-ext', id, type: 'pong', version }
//                     { source: 'pilotix-ext', id, type: 'progress', step }        (step: 'open' | 'read' | 'pictures')
//                     { source: 'pilotix-ext', id, type: 'result', count, ads }    (ads: RawAd[], pictures included)
//                     { source: 'pilotix-ext', id, type: 'error', message }
// What the extension asks this page (a page read on a competitor's site, actions for its pieces on other sites):
// lib/extBridge.ts. Since 2.0.0 the extension is « Pilotix » (AI Spy and Envoyer photos together) and marks the page
// <html data-pilotix-ext="2.0.0">. The older « Pilotix Spy » (1.x) used the names 'pilotix-spy-page' / 'pilotix-spy-ext':
// it is still answered, by those names, when it is the only one here.
// The search runs in the user's own Chrome: it opens Facebook's public Ad Library in a background tab, reads the ads and
// closes it (Facebook refuses these pages to a server, never to a browser).
import type { RawAd } from '@pilotix/core';

const NEW = { page: 'pilotix-page', ext: 'pilotix-ext' } as const;
const OLD = { page: 'pilotix-spy-page', ext: 'pilotix-spy-ext' } as const;
type Proto = typeof NEW | typeof OLD;

/** The extension's newest version (apps/extension/manifest.json). */
export const EXT_VERSION = '2.0.0';
/** Its download, made by the website's build (scripts/extension-zips.mjs). */
export const EXT_ZIP = '/pilotix.zip';

export interface ExtStatus {
  installed: boolean;
  version: string | null;
  /** an older extension of Pilotix is still on this Chrome next to it (« Pilotix Spy » 1.x, « Pilotix WhatsApp » 1.0) */
  older?: boolean;
  /** « Pilotix » loaded twice (from two folders): only the first acts */
  twice?: boolean;
}
export interface ExtResult {
  count: number | null;
  ads: RawAd[];
}
export type ExtStep = 'open' | 'read' | 'pictures';

/** The merged extension marks the page from its first moment (document_start), or says « ready » when added later. */
let announcedNew: string | null = null;
let announcedOld: string | null = null;
const marked = () => (typeof document !== 'undefined' ? document.documentElement.getAttribute('data-pilotix-ext') : null);
const proto = (): Proto => (marked() || announcedNew ? NEW : OLD);
/** « Pilotix Spy » 1.x or « Pilotix WhatsApp » 1.0 still installed */
const olderHere = () => !!announcedOld || !!document.documentElement.getAttribute('data-pilotix-wa');
let seq = 0;
const nextId = () => `s${Date.now().toString(36)}${(seq++).toString(36)}`;
if (typeof window !== 'undefined')
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.type !== 'ready') return;
    if (e.data.source === NEW.ext) announcedNew = String(e.data.version ?? '2');
    else if (e.data.source === OLD.ext) announcedOld = String(e.data.version ?? '1');
  });

/** Is the extension on this page? (it answers a ping within the timeout) */
export function detectExtension(timeoutMs = 700): Promise<ExtStatus> {
  if (typeof window === 'undefined') return Promise.resolve({ installed: false, version: null });
  return new Promise((resolve) => {
    const ids = new Set<string>();
    const done = (s: ExtStatus) => {
      window.removeEventListener('message', on);
      clearTimeout(timer);
      resolve(s);
    };
    const seen = { new: null as string | null, old: null as string | null, exts: new Set<string>() };
    const on = (e: MessageEvent) => {
      const d = e.data;
      if (e.source !== window || (d?.source !== NEW.ext && d?.source !== OLD.ext)) return;
      if (d.type !== 'ready' && !(d.type === 'pong' && ids.has(d.id))) return;
      if (d.source === NEW.ext) {
        seen.new = String(d.version ?? '2');
        if (typeof d.ext === 'string') seen.exts.add(d.ext);
      } else seen.old = String(d.version ?? '1');
    };
    // every copy answers within a moment: the merged one, a second copy of it, an older one
    const timer = setTimeout(
      () =>
        done(
          seen.new
            ? { installed: true, version: seen.new, older: !!seen.old || olderHere(), twice: seen.exts.size > 1 }
            : seen.old
              ? { installed: true, version: seen.old }
              : marked()
                ? { installed: true, version: marked() }
                : { installed: false, version: null },
        ),
      marked() || announcedNew ? Math.min(timeoutMs, 250) : timeoutMs,
    );
    window.addEventListener('message', on);
    for (const p of [NEW, OLD]) {
      const id = nextId();
      ids.add(id);
      window.postMessage({ source: p.page, id, type: 'ping' }, window.location.origin);
    }
  });
}

/** One keyword searched in Facebook's Ad Library by the user's Chrome (≈ 5–15 s with the pictures). */
export function extensionSearch(query: string, opts: { country?: string; max?: number; onProgress?: (step: ExtStep) => void; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ExtResult> {
  const p = proto();
  return new Promise((resolve, reject) => {
    const id = nextId();
    const finish = () => {
      window.removeEventListener('message', on);
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
    };
    const on = (e: MessageEvent) => {
      const d = e.data;
      if (e.source !== window || d?.source !== p.ext || d.id !== id) return;
      if (d.type === 'progress') opts.onProgress?.(d.step as ExtStep);
      else if (d.type === 'result') {
        finish();
        resolve({ count: typeof d.count === 'number' ? d.count : null, ads: Array.isArray(d.ads) ? (d.ads as RawAd[]) : [] });
      } else if (d.type === 'error') {
        finish();
        reject(new Error(String(d.message ?? 'Erreur de l’extension')));
      }
    };
    const abort = () => {
      finish();
      reject(new DOMException('Recherche annulée', 'AbortError'));
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error('L’extension ne répond pas. Rechargez la page et réessayez.'));
    }, opts.timeoutMs ?? 90_000);
    window.addEventListener('message', on);
    opts.signal?.addEventListener('abort', abort);
    window.postMessage({ source: p.page, id, type: 'search', query, country: opts.country ?? 'DZ', max: opts.max ?? 30 }, window.location.origin);
  });
}

/** Facebook's own Ad Library search for a keyword (Algeria, active ads), to open in a new tab. */
export const adLibraryUrl = (q: string, country = 'DZ') =>
  `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${country}&q=${encodeURIComponent(q)}&search_type=keyword_unordered&media_type=all`;
/** One ad in Facebook's Ad Library. */
export const adUrl = (adId: string) => `https://www.facebook.com/ads/library/?id=${encodeURIComponent(adId)}`;
