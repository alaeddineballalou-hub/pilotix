// Pilotix extension — the bridge on a Pilotix page (pilotix.online, direct.pilotix.online, and any other Pilotix address
// the user added in the popup), in the content script's own world. A page cannot talk to an extension itself: this
// script carries the messages between the Pilotix page and the service worker.
//   page → bridge   window message { source: 'pilotix-page', id, type: 'ping' | 'search' | 'wa-send', … }
//                     search  { query, country, max }: one keyword in Facebook's Ad Library (AI Spy)
//                     wa-send { phone, text, photos }: Envoyer photos on WhatsApp Web
//   bridge → page   window message { source: 'pilotix-ext', type: 'ready' | 'pong' | 'progress' | 'result' | 'error' |
//                   'wa-result', id… }
//   worker → bridge chrome message { type: 'site-price' | 'rpc', … }: something an extension page or another site's
//                   script (WhatsApp Web, Facebook's ad library, Ads Manager) needs from Pilotix; the bridge posts
//                   { source: 'pilotix-ext', id, type, … } to the page, which answers { source: 'pilotix-page', id,
//                   type: '<type>-done', ok, … } (apps/web/src/lib/spyExtension.ts and extBridge.ts), or nothing after a
//                   while (no Pilotix page able to answer here).
// <html data-pilotix-ext="2.0.0"> tells the page this extension is here and which protocol to use. An older « Pilotix
// Spy » (1.x) or « Pilotix WhatsApp » (1.0) on the same Chrome uses other message names, so the two never both act.
// The extension loaded twice (from two folders: two extensions for Chrome): the first copy on the page writes its id in
// <html data-pilotix-ext-id> and is the only one that acts; the other answers pings only, so the page can say so.
// Only messages the page posts to itself are read (event.source === window, same origin, source 'pilotix-page').
(() => {
  const PAGE = 'pilotix-page';
  const EXT = 'pilotix-ext';
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
  if (globalThis.__pilotixBridge?.alive?.()) return;
  globalThis.__pilotixBridge = { alive };

  const version = chrome.runtime.getManifest().version;
  const me = chrome.runtime.id;
  const root = document.documentElement;
  root.setAttribute('data-pilotix-ext', version);
  if (!root.getAttribute('data-pilotix-ext-id')) root.setAttribute('data-pilotix-ext-id', me);
  /** this copy acts on this page (not a second copy of the extension loaded from another folder) */
  const mine = () => root.getAttribute('data-pilotix-ext-id') === me;
  const post = (msg) => window.postMessage({ source: EXT, ...msg }, window.location.origin);

  // "I am here": now, and once the page's own scripts are running.
  const announce = () => alive() && post({ type: 'ready', version, ext: me, active: mine() });
  announce();
  if (document.readyState !== 'complete') {
    document.addEventListener('DOMContentLoaded', announce, { once: true });
    window.addEventListener('load', announce, { once: true });
  }

  // ---------------------------------------------------------------- AI Spy: one keyword in Facebook's Ad Library
  function search(id, d) {
    let port;
    try {
      port = chrome.runtime.connect({ name: 'pilotix-search' });
    } catch {
      post({ id, type: 'error', message: 'L’extension Pilotix a été mise à jour : rechargez cette page.' });
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

  // ---------------------------------------------------------------- Envoyer photos on WhatsApp Web
  let sending = 0;
  // the worker stays awake while a send is under way (WhatsApp Web can take a while to open)
  setInterval(() => {
    if (sending > 0 && alive()) chrome.runtime.sendMessage({ action: 'ping' }, () => void chrome.runtime.lastError);
  }, 10_000);
  function waSend(id, d) {
    sending++;
    chrome.runtime.sendMessage({ action: 'send', phone: d.phone, text: d.text, photos: d.photos }, (r) => {
      sending--;
      const err = chrome.runtime.lastError;
      const out = err || !r ? { ok: false, error: 'extension', detail: err ? err.message : 'no answer' } : r;
      post({ id, type: 'wa-result', ...out });
    });
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
    if (d.type === 'ping') post({ id, type: 'pong', version, ext: me, active: mine() });
    else if (!mine()) return;
    else if (d.type === 'search') search(id, d);
    else if (d.type === 'wa-send') waSend(id, d);
  }
  window.addEventListener('message', onMessage);

  // ---------------------------------------------------------------- the worker asks this Pilotix page something
  /** Posts { type, …payload } to the page and waits for its « <type>-done » answer (null after `ms`: nobody answered). */
  function askPage(type, payload, ms) {
    return new Promise((resolve) => {
      const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        window.removeEventListener('message', onDone);
        clearTimeout(timer);
        resolve(r);
      };
      function onDone(e) {
        if (e.source !== window || e.origin !== window.location.origin) return;
        const d = e.data;
        if (!d || typeof d !== 'object' || d.source !== PAGE || d.type !== `${type}-done` || d.id !== id) return;
        const { source: _s, id: _i, type: _t, ...rest } = d;
        finish(rest);
      }
      const timer = setTimeout(() => finish(null), ms);
      window.addEventListener('message', onDone);
      post({ id, type, ...payload });
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, answer) => {
    if (!alive() || sender.id !== chrome.runtime.id || !msg || typeof msg !== 'object') return false;
    if ((msg.type === 'site-price' || msg.type === 'rpc') && !root.hasAttribute('data-pilotix-answers')) {
      // an older Pilotix page (before 2.0), or one still loading: it cannot answer
      answer({ ok: false, message: 'Rechargez l’onglet Pilotix, puis réessayez.' });
      return false;
    }
    if (msg.type === 'site-price') {
      // a price the popup read on the user's open page: AI Spy saves it on the ads of that page
      const payload = {
        url: String(msg.url ?? ''),
        price: msg.price === null || msg.price === undefined ? null : Number(msg.price),
        oldPrice: msg.oldPrice === null || msg.oldPrice === undefined ? null : Number(msg.oldPrice),
        title: msg.title ? String(msg.title) : null,
        page: msg.page && typeof msg.page === 'object' ? { text: String(msg.page.text ?? '') } : null,
      };
      askPage('site-price', payload, 45_000).then((r) =>
        answer(
          r
            ? { ok: !!r.ok, saved: Number(r.saved) || 0, read: r.read && typeof r.read === 'object' ? r.read : null, message: r.message ? String(r.message).slice(0, 200) : '' }
            : { ok: false, message: '' },
        ),
      );
      return true;
    }
    if (msg.type === 'rpc' && typeof msg.name === 'string') {
      // a Pilotix action another site's script needs (the customer card, an ad's numbers…): this page runs it
      askPage('rpc', { name: msg.name, input: msg.input ?? {} }, 20_000).then((r) => answer(r ?? { ok: false, message: '' }));
      return true;
    }
    return false;
  });
})();
