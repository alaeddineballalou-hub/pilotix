// What the Pilotix Chrome extension (apps/extension) asks this page. The extension has no Pilotix session of its own:
// this page has one, so the extension's script here (bridge.js) hands it what needs Pilotix and waits for the answer.
//   extension → page  { source: 'pilotix-ext', id, type: 'site-price', url, price, oldPrice, title, page: { text } }
//                         what the user's Chrome read on a competitor's page (the popup's « Lire la page »)
//                     { source: 'pilotix-ext', id, type: 'rpc', name, input }
//                         an action for the extension's pieces on other sites (the customer card on WhatsApp Web,
//                         buttons on Facebook's ad library, numbers in Ads Manager)
//   page → extension  { source: 'pilotix-page', id, type: 'site-price-done' | 'rpc-done', ok, … }
// The extension checks the action and the site it comes from first (apps/extension/actions.js); this page checks the
// action against its own list (EXT_ACTIONS), and the server the rights of whoever is logged in here.
// <html data-pilotix-answers> tells the extension this page can answer (an older Pilotix page cannot: it is skipped).

const PAGE = 'pilotix-page';
const EXT = 'pilotix-ext';

/** What the user's Chrome read on a competitor's page. */
export interface ExtPageRead {
  url: string;
  price: number | null;
  oldPrice: number | null;
  title: string | null;
  /** the text the page shows (its offers, delivery and promises are read from it) */
  text: string | null;
}

export interface ExtHandlers {
  sitePrice(p: ExtPageRead): Promise<{ saved: number; read: unknown }>;
  rpc(name: string, input: unknown): Promise<unknown>;
}

/** The ad on screen in AI Spy (set by the page): used when the page read by Chrome matches no ad's address. */
let spyScreen: { productId: number; gkey: string } | null = null;
export const setSpyScreen = (s: { productId: number; gkey: string } | null) => {
  spyScreen = s;
};
export const getSpyScreen = () => spyScreen;

/** The actions the extension's pieces on other sites may ask for (apps/extension/actions.js lists the same). */
export const EXT_ACTIONS: ReadonlySet<string> = new Set<string>([
  // the customer card on WhatsApp Web
  'customers.waCard',
  // the buttons on Facebook's ad library: what AI Spy has of the ads there, and one ad kept with its tag
  'spy.libraryInfo',
  'spy.libraryAd',
  // Pilotix's numbers next to each ad in Meta's Ads Manager
  'ads.extNumbers',
]);

const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** Listens to the extension while the app is open; returns the function that stops. */
export function startExtBridge(h: ExtHandlers): () => void {
  if (typeof window === 'undefined') return () => {};
  const html = document.documentElement;
  html.setAttribute('data-pilotix-answers', '1');
  const reply = (id: string, type: string, r: Record<string, unknown>) => window.postMessage({ source: PAGE, id, type: `${type}-done`, ...r }, window.location.origin);
  const on = async (e: MessageEvent) => {
    const d = e.data;
    if (e.source !== window || e.origin !== window.location.origin || !d || typeof d !== 'object' || d.source !== EXT) return;
    if (typeof d.id !== 'string' || !d.id || d.id.length > 100) return;
    if (d.type === 'site-price') {
      const price = num(d.price);
      const old = num(d.oldPrice);
      const text = d.page && typeof d.page === 'object' && typeof d.page.text === 'string' ? d.page.text.slice(0, 8000) : null;
      if (typeof d.url !== 'string' || (price !== null && price < 100) || (price === null && !text)) return reply(d.id, d.type, { ok: false, message: 'Page illisible' });
      try {
        const r = await h.sitePrice({ url: d.url.slice(0, 2000), price, oldPrice: price !== null && old !== null && old > price ? old : null, title: typeof d.title === 'string' ? d.title.slice(0, 200) : null, text });
        reply(d.id, d.type, { ok: true, saved: r.saved, read: r.read ?? null });
      } catch (err) {
        reply(d.id, d.type, { ok: false, message: errText(err) });
      }
    } else if (d.type === 'rpc') {
      if (typeof d.name !== 'string' || !EXT_ACTIONS.has(d.name)) return reply(d.id, d.type, { ok: false, message: 'Action refusée' });
      try {
        reply(d.id, d.type, { ok: true, out: (await h.rpc(d.name, d.input ?? {})) ?? null });
      } catch (err) {
        reply(d.id, d.type, { ok: false, message: errText(err) });
      }
    }
  };
  window.addEventListener('message', on);
  return () => {
    window.removeEventListener('message', on);
    html.removeAttribute('data-pilotix-answers');
  };
}
