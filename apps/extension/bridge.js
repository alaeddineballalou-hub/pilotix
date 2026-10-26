// Pilotix Spy bridge: a content script on the Pilotix addresses the user added in the popup (isolated world).
// It connects the Pilotix page (apps/web/src/lib/spyExtension.ts) and the service worker:
//   page → bridge   window message { source: 'pilotix-spy-page', id, type: 'ping' | 'search', query, country, max }
//   bridge → page   window message { source: 'pilotix-spy-ext', type: 'ready' | 'pong' | 'progress' | 'result' | 'error', id… }
//   bridge ↔ worker one port named 'pilotix-search' per search.
// Only messages the page posts to itself are read (event.source === window, same origin, source 'pilotix-spy-page').
(() => {
  const PAGE = 'pilotix-spy-page';
  const EXT = 'pilotix-spy-ext';
  const STEPS = ['open', 'read', 'pictures'];

  // An extension that was reloaded or updated leaves its old copy here, cut off from the worker ("context
  // invalidated"): a new copy takes over then. While the current copy is alive, a second injection does nothing.
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };
  if (globalThis.__pilotixSpyBridge?.alive?.()) return;
  globalThis.__pilotixSpyBridge = { alive };

  const version = chrome.runtime.getManifest().version;
  const post = (msg) => window.postMessage({ source: EXT, ...msg }, window.location.origin);

  // "I am here": now, and once the page's own scripts are running.
  const announce = () => alive() && post({ type: 'ready', version });
  announce();
  if (document.readyState !== 'complete') {
    document.addEventListener('DOMContentLoaded', announce, { once: true });
    window.addEventListener('load', announce, { once: true });
  }

  function search(id, d) {
    let port;
    try {
      port = chrome.runtime.connect({ name: 'pilotix-search' });
    } catch {
      post({ id, type: 'error', message: 'L’extension Pilotix Spy a été mise à jour : rechargez cette page.' });
      return;
    }
    let done = false;
    port.onMessage.addListener((m) => {
      if (done || !m || typeof m !== 'object') return;
      if (m.type === 'progress') {
        if (STEPS.includes(m.step)) post({ id, type: 'progress', step: m.step });
      } else if (m.type === 'result' || m.type === 'error') {
        done = true;
        if (m.type === 'result') post({ id, type: 'result', count: typeof m.count === 'number' ? m.count : null, ads: Array.isArray(m.ads) ? m.ads : [] });
        else post({ id, type: 'error', message: String(m.message || 'Erreur de l’extension') });
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      if (done) return;
      done = true;
      post({ id, type: 'error', message: 'L’extension s’est arrêtée pendant la recherche. Réessayez.' });
    });
    port.postMessage({ type: 'search', query: d.query, country: d.country, max: d.max });
  }

  function onMessage(e) {
    if (!alive()) {
      window.removeEventListener('message', onMessage); // a newer copy answers now
      return;
    }
    if (e.source !== window || e.origin !== window.location.origin) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || d.source !== PAGE) return;
    const id = typeof d.id === 'string' && d.id.length > 0 && d.id.length <= 100 ? d.id : null;
    if (!id) return;
    if (d.type === 'ping') post({ id, type: 'pong', version });
    else if (d.type === 'search') search(id, d);
  }
  window.addEventListener('message', onMessage);
})();
