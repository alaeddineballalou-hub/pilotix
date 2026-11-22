// The Pilotix Spy Chrome extension (apps/extension), seen from the app. The extension's small script on this page
// (bridge.js, registered for the Pilotix address the user typed in the extension) answers window messages:
//   page → extension  { source: 'pilotix-spy-page', id, type: 'ping' }
//                     { source: 'pilotix-spy-page', id, type: 'search', query, country, max }
//   extension → page  { source: 'pilotix-spy-ext', type: 'ready', version }            (when the page loads)
//                     { source: 'pilotix-spy-ext', id, type: 'pong', version }
//                     { source: 'pilotix-spy-ext', id, type: 'progress', step }        (step: 'open' | 'read' | 'pictures')
//                     { source: 'pilotix-spy-ext', id, type: 'result', count, ads }    (ads: RawAd[], pictures included)
//                     { source: 'pilotix-spy-ext', id, type: 'error', message }
//                     { source: 'pilotix-spy-ext', id, type: 'site-price', url, price, oldPrice, title }
//                         a competitor's price the user's Chrome read on the page they had open (the popup's « Lire le prix
//                         de cette page »); this page saves it and answers
//   page → extension  { source: 'pilotix-spy-page', id, type: 'site-price-done', ok, saved, message }
// The search runs in the user's own Chrome: it opens Facebook's public Ad Library in a background tab, reads the ads and
// closes it (Facebook refuses these pages to a server, never to a browser).
import type { RawAd } from '@pilotix/core';

const PAGE = 'pilotix-spy-page';
const EXT = 'pilotix-spy-ext';

export interface ExtStatus {
  installed: boolean;
  version: string | null;
}
export interface ExtResult {
  count: number | null;
  ads: RawAd[];
}
export type ExtStep = 'open' | 'read' | 'pictures';

let seq = 0;
const nextId = () => `s${Date.now().toString(36)}${(seq++).toString(36)}`;
let announced: string | null = null;
if (typeof window !== 'undefined')
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data?.source === EXT && e.data.type === 'ready') announced = String(e.data.version ?? '1');
  });

/** Is the extension on this page? (it answers a ping within the timeout) */
export function detectExtension(timeoutMs = 700): Promise<ExtStatus> {
  if (typeof window === 'undefined') return Promise.resolve({ installed: false, version: null });
  if (announced) return Promise.resolve({ installed: true, version: announced });
  return new Promise((resolve) => {
    const id = nextId();
    const done = (s: ExtStatus) => {
      window.removeEventListener('message', on);
      clearTimeout(timer);
      resolve(s);
    };
    const on = (e: MessageEvent) => {
      if (e.source !== window || e.data?.source !== EXT) return;
      if (e.data.type === 'ready' || (e.data.type === 'pong' && e.data.id === id)) done({ installed: true, version: String(e.data.version ?? '1') });
    };
    const timer = setTimeout(() => done({ installed: false, version: null }), timeoutMs);
    window.addEventListener('message', on);
    window.postMessage({ source: PAGE, id, type: 'ping' }, window.location.origin);
  });
}

/** One keyword searched in Facebook's Ad Library by the user's Chrome (≈ 5–15 s with the pictures). */
export function extensionSearch(query: string, opts: { country?: string; max?: number; onProgress?: (step: ExtStep) => void; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ExtResult> {
  return new Promise((resolve, reject) => {
    const id = nextId();
    const finish = () => {
      window.removeEventListener('message', on);
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
    };
    const on = (e: MessageEvent) => {
      const d = e.data;
      if (e.source !== window || d?.source !== EXT || d.id !== id) return;
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
    window.postMessage({ source: PAGE, id, type: 'search', query, country: opts.country ?? 'DZ', max: opts.max ?? 30 }, window.location.origin);
  });
}

/** The extension's newest version (apps/extension/manifest.json): « Lire le prix de cette page » came with 1.1.0. */
export const SPY_EXT_VERSION = '1.1.0';

/** A competitor's price read by the user's own Chrome on the page they had open (the extension's popup). */
export interface ExtSitePrice {
  url: string;
  price: number;
  oldPrice: number | null;
  title: string | null;
}

/**
 * Takes the prices the extension's popup reads (« Lire le prix de cette page ») while this page is open: `save` keeps
 * one and says on how many ads; the answer goes back to the popup. Returns the function that stops listening.
 */
export function onSitePrice(save: (p: ExtSitePrice) => Promise<{ saved: number }>): () => void {
  if (typeof window === 'undefined') return () => {};
  const on = async (e: MessageEvent) => {
    const d = e.data;
    if (e.source !== window || d?.source !== EXT || d.type !== 'site-price' || typeof d.id !== 'string') return;
    const price = Math.round(Number(d.price));
    const old = d.oldPrice === null || d.oldPrice === undefined ? null : Math.round(Number(d.oldPrice));
    const reply = (r: { ok: boolean; saved?: number; message?: string }) => window.postMessage({ source: PAGE, id: d.id, type: 'site-price-done', ...r }, window.location.origin);
    if (!Number.isFinite(price) || price < 100 || typeof d.url !== 'string') return reply({ ok: false, message: 'Prix illisible' });
    try {
      const r = await save({ url: d.url.slice(0, 2000), price, oldPrice: old !== null && Number.isFinite(old) && old > price ? old : null, title: typeof d.title === 'string' ? d.title.slice(0, 200) : null });
      reply({ ok: true, saved: r.saved });
    } catch (err) {
      reply({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  };
  window.addEventListener('message', on);
  return () => window.removeEventListener('message', on);
}

/** Facebook's own Ad Library search for a keyword (Algeria, active ads), to open in a new tab. */
export const adLibraryUrl = (q: string, country = 'DZ') =>
  `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${country}&q=${encodeURIComponent(q)}&search_type=keyword_unordered&media_type=all`;
/** One ad in Facebook's Ad Library. */
export const adUrl = (adId: string) => `https://www.facebook.com/ads/library/?id=${encodeURIComponent(adId)}`;
