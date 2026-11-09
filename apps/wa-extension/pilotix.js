// Pilotix WhatsApp — on the Pilotix page: the bridge between the page and the add-on (a page cannot talk to an add-on
// itself). The page sees the add-on by the « data-pilotix-wa » mark on <html> (its version), asks with
// window.postMessage({ type: 'pilotix-wa:send', id, phone, text, photos }) and gets { type: 'pilotix-wa:result', id, ok,
// error } back (website: apps/web/src/lib/waShare.ts). Nothing else is read from the page.
(() => {
  const VERSION = chrome.runtime.getManifest().version;
  document.documentElement.setAttribute('data-pilotix-wa', VERSION);
  let pending = 0;
  // the add-on's worker stays awake while a send is under way (WhatsApp Web can take a while to open)
  setInterval(() => {
    if (pending > 0) chrome.runtime.sendMessage({ action: 'ping' }, () => void chrome.runtime.lastError);
  }, 10_000);

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'pilotix-wa:ping') {
      window.postMessage({ type: 'pilotix-wa:pong', version: VERSION }, location.origin);
      return;
    }
    if (m.type !== 'pilotix-wa:send' || typeof m.id !== 'string') return;
    pending++;
    chrome.runtime.sendMessage({ action: 'send', phone: m.phone, text: m.text, photos: m.photos }, (r) => {
      pending--;
      const err = chrome.runtime.lastError;
      const out = err || !r ? { ok: false, error: 'extension', detail: err ? err.message : 'no answer' } : r;
      window.postMessage({ type: 'pilotix-wa:result', id: m.id, ...out }, location.origin);
    });
  });
})();
