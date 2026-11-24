// Pilotix extension — buttons on Facebook's ad library (facebook.com/ads/library), for the person browsing it: on each
// ad, the product it competes with, its tag (Identique, Ressemble, Pas le même, or one of the shop's own tags) and
// « Suivre la boutique ». A tag or a follow keeps the ad in AI Spy (the worker reads the ad from the page's own data,
// then the open Pilotix tab saves it with the person's rights). Nothing is clicked, liked or sent on Facebook.
// The bar is drawn in a closed shadow root: Facebook's page sees an empty element.
(() => {
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };
  if (globalThis.__pilotixLibrary?.alive?.()) return;
  globalThis.__pilotixLibrary?.remove?.();

  const ID_RE = /(?:Library ID|ID dans la biblioth[eè]que|ID de la biblioth[eè]que|ID de la biblioteca|معرف المكتبة|معرّف المكتبة|المعرّف في المكتبة)\s*[:：]?\s*(\d{8,20})/i;
  const TAGS = [
    ['same', 'Identique'],
    ['like', 'Ressemble'],
    ['other', 'Pas le même'],
  ];
  /** card element → { id, host, ui } */
  const cards = new Map();
  /** what Pilotix said: products, own tags, the ads kept in AI Spy (by id), the pages followed ({ key, name }) */
  let info = { products: [], tags: [], ads: new Map(), followed: [], error: '' };
  let productId = null;
  let asked = new Set();

  const send = (msg) =>
    new Promise((ok) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => ok(chrome.runtime.lastError ? { ok: false, message: 'L’extension a été mise à jour : rechargez cette page.' } : r));
      } catch {
        ok({ ok: false, message: 'L’extension a été mise à jour : rechargez cette page.' });
      }
    });

  // ---------------------------------------------------------------- the ads on the page
  /** the elements that say « Library ID: 123… » */
  function idNodes() {
    const out = [];
    const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'INPUT']);
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (/\d{8,20}/.test(n.data) && !skip.has(n.parentElement?.tagName ?? '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement;
      const m = el && ID_RE.exec(el.textContent || '');
      if (m) out.push([el, m[1]]);
    }
    return out;
  }
  const idsIn = (el) => {
    const t = el.textContent || '';
    const re = new RegExp(ID_RE.source, 'gi');
    const s = new Set();
    for (const m of t.matchAll(re)) s.add(m[1]);
    return s.size;
  };
  /** the ad's card: the biggest box around its id that holds no other ad */
  function cardOf(el) {
    let card = el;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (idsIn(p) > 1) break;
      card = p;
    }
    return card;
  }
  /** the link to the ad's Facebook page (its name is the link's text) */
  const pageLink = (card) => [...card.querySelectorAll('a[href]')].find((a) => /^https:\/\/(www\.|web\.)?facebook\.com\/(?!ads\/|l\.php)[^?#]+/.test(a.href) && (a.textContent || '').trim());
  /** what the card shows (used when the page's data no longer has the ad: it came later, as the person scrolled) */
  function domData(card) {
    const links = [...card.querySelectorAll('a[href]')];
    const page = pageLink(card);
    const out = links.map((a) => a.href).find((h) => /l\.facebook\.com\/l\.php\?u=/.test(h));
    let link = null;
    try {
      link = out ? new URL(out).searchParams.get('u') : null;
    } catch {
      link = null;
    }
    let body = '';
    for (const d of card.querySelectorAll('div, span')) {
      const t = (d.innerText || '').trim();
      if (t.length > body.length && getComputedStyle(d).whiteSpace.startsWith('pre') && !ID_RE.test(t)) body = t;
    }
    const img = [...card.querySelectorAll('img')].filter((i) => i.naturalWidth >= 120).sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight)[0];
    const video = card.querySelector('video');
    return {
      pageName: (page?.textContent || '').trim().slice(0, 200),
      pageUrl: page?.href ?? null,
      body: body.slice(0, 6000),
      linkUrl: link,
      mediaUrl: video?.poster || img?.src || null,
      isVideo: !!video,
      // the video's own file on Facebook's servers (a blob: player stream is no file: left out)
      videoUrl: /^https:\/\//.test(video?.currentSrc || video?.src || '') ? video.currentSrc || video.src : null,
    };
  }

  // ---------------------------------------------------------------- the bar on each ad
  const CSS = `
:host { all: initial; display: block; margin: 0 0 8px; }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 7px 8px; border: 1px solid #dde2ec; border-radius: 10px; background: #f7f9fc;
  font: 600 12.5px/1.3 system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; color: #1b2a47; }
img { width: 18px; height: 18px; border-radius: 4px; }
select { height: 28px; max-width: 170px; border: 1px solid #dde2ec; border-radius: 7px; background: #fff; color: #1b2a47; font: inherit; font-weight: 600; }
button { height: 28px; padding: 0 9px; border: 1px solid #dde2ec; border-radius: 999px; background: #fff; color: #1b2a47; font: inherit; cursor: pointer; }
button:hover:not(:disabled) { border-color: #f28b1e; }
button:disabled { opacity: .6; cursor: default; }
button.on.same { background: #e3f5ea; border-color: #1f9d57; color: #137a3b; }
button.on.like { background: #fff2da; border-color: #f2b544; color: #8a5a00; }
button.on.other { background: #fce7e5; border-color: #d6453d; color: #b42318; }
button.on.own { background: #e8eef8; border-color: #2459d6; color: #2459d6; }
button.follow.on { background: #1b2a47; border-color: #1b2a47; color: #fff; }
.tags { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.msg { flex-basis: 100%; font-weight: 500; color: #5d6b85; }
.msg.ok { color: #137a3b; font-weight: 700; }
.msg.bad { color: #b42318; }
.msg:empty { display: none; }
@media (prefers-color-scheme: dark) {
  .bar { background: #1b2538; border-color: #34415c; color: #e8ecf4; }
  select, button { background: #232f46; border-color: #34415c; color: #e8ecf4; }
  .msg { color: #9aa6bd; }
}`;

  function bar(card, id) {
    const host = document.createElement('div');
    host.className = 'pilotix-library-bar';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS}</style><div class="bar" role="group" aria-label="Pilotix"><img alt="Pilotix" src="${chrome.runtime.getURL('icons/icon32.png')}"><select aria-label="Produit"></select><span class="tags"></span><button class="follow" type="button">☆ Suivre la boutique</button><span class="msg" role="status"></span></div>`;
    const ui = { root, select: root.querySelector('select'), tags: root.querySelector('.tags'), follow: root.querySelector('.follow'), msg: root.querySelector('.msg') };
    ui.select.addEventListener('change', () => {
      productId = Number(ui.select.value) || null;
      chrome.storage.local.set({ libraryProduct: productId }).catch(() => {});
      for (const c of cards.values()) paint(c);
    });
    ui.follow.addEventListener('click', () => {
      const c = cards.get(card);
      if (c) save(card, id, { follow: !followedOf(c) });
    });
    card.prepend(host);
    return { id, host, ui, card, busy: false, pageKey: null, pageName: (pageLink(card)?.textContent || '').trim() };
  }

  /** its page is followed in AI Spy: by its key once the ad is kept, else by the page's name */
  function followedOf(c) {
    const key = c.pageKey ?? info.ads.get(c.id)?.pageKey ?? null;
    if (key) return info.followed.some((f) => f.key === key);
    const name = (c.pageName || '').toLowerCase();
    return !!name && info.followed.some((f) => f.name.toLowerCase() === name);
  }

  function paint(c) {
    const { ui } = c;
    const saved = info.ads.get(c.id);
    // the products to choose from (the ad's own when it is in AI Spy already)
    if (ui.select.options.length !== info.products.length) {
      ui.select.replaceChildren(...info.products.map((p) => new Option(p.name, String(p.id))));
    }
    const pid = saved?.productId ?? productId;
    if (pid) ui.select.value = String(pid);
    ui.select.disabled = !!saved || c.busy;
    const tags = [...TAGS, ...info.tags.map((t) => [t.id, t.label])];
    ui.tags.replaceChildren(
      ...tags.map(([k, label]) => {
        const b = document.createElement('button');
        b.type = 'button';
        const on = saved?.tag === k;
        b.className = `${['same', 'like', 'other'].includes(k) ? k : 'own'}${on ? ' on' : ''}`;
        b.textContent = `${on && saved.tagBy === 'ai' ? '✦ ' : ''}${label}`;
        b.title = on ? (saved.tagBy === 'ai' ? 'Mis par l’IA' : 'Mis par vous') : 'Mettre ce tag (la pub va dans AI Spy)';
        b.setAttribute('aria-pressed', String(on));
        b.disabled = c.busy || !(saved?.productId ?? productId);
        b.addEventListener('click', () => !on && save(c.card, c.id, { tag: k }));
        return b;
      }),
    );
    const f = followedOf(c);
    ui.follow.className = `follow${f ? ' on' : ''}`;
    ui.follow.textContent = f ? '★ Suivie' : '☆ Suivre la boutique';
    ui.follow.disabled = c.busy || !(saved?.productId ?? productId);
    if (!c.busy && !ui.msg.className.includes('bad') && !ui.msg.className.includes('ok')) ui.msg.textContent = info.error || (saved ? `Dans AI Spy · ${saved.product}` : '');
  }

  async function save(card, id, what) {
    const c = cards.get(card);
    if (!c || c.busy) return;
    const saved = info.ads.get(id);
    const pid = saved?.productId ?? productId;
    if (!pid) return;
    c.busy = true;
    c.ui.msg.className = 'msg';
    c.ui.msg.textContent = 'Enregistrement dans AI Spy…';
    paint(c);
    const r = await send({ kind: 'library-save', adId: id, productId: pid, tag: what.tag ?? null, follow: what.follow, dom: domData(card) });
    c.busy = false;
    if (!r?.ok) {
      c.ui.msg.className = 'msg bad';
      c.ui.msg.textContent = r?.message || 'Pilotix ne répond pas.';
    } else {
      const o = r.out;
      info.ads.set(id, { adId: id, productId: pid, product: info.products.find((p) => p.id === pid)?.name ?? '', gkey: o.gkey, tag: o.tag, tagBy: o.tagBy });
      c.pageKey = o.pageKey;
      info.followed = info.followed.filter((f) => f.key !== o.pageKey);
      if (o.followed) info.followed.push({ key: o.pageKey, name: c.pageName });
      c.ui.msg.className = 'msg ok';
      c.ui.msg.textContent = what.follow === true ? 'Boutique suivie dans AI Spy.' : what.follow === false ? 'Boutique plus suivie.' : 'Enregistrée dans AI Spy.';
      setTimeout(() => {
        c.ui.msg.className = 'msg';
        paint(c);
      }, 4000);
    }
    paint(c);
  }

  // ---------------------------------------------------------------- what Pilotix knows of the ads on screen
  async function load(ids) {
    const r = await send({ kind: 'pilotix', name: 'spy.libraryInfo', input: { adIds: ids.slice(0, 120) } });
    if (!r?.ok) {
      info.error = r?.message || 'Pilotix ne répond pas.';
      for (const c of cards.values()) paint(c);
      return;
    }
    info.error = '';
    const o = r.out;
    info.products = o.products;
    info.tags = o.tags;
    info.followed = o.followed;
    for (const a of o.ads) info.ads.set(a.adId, a);
    if (!productId || !info.products.some((p) => p.id === productId)) productId = info.products[0]?.id ?? null;
    for (const c of cards.values()) paint(c);
  }

  let timer = null;
  function scan() {
    timer = null;
    if (!alive()) return stop();
    if (document.visibilityState !== 'visible') return; // AI Spy's own searches open the library in a hidden tab
    const fresh = [];
    for (const [el, id] of idNodes()) {
      const card = cardOf(el);
      let c = cards.get(card);
      if (c && c.id !== id) {
        c.host.remove();
        cards.delete(card);
        c = null;
      }
      if (!c) {
        c = bar(card, id);
        cards.set(card, c);
        if (!asked.has(id)) fresh.push(id);
        paint(c);
      } else if (!c.host.isConnected) card.prepend(c.host);
    }
    for (const [card, c] of cards) if (!card.isConnected) cards.delete(card);
    if (fresh.length) {
      for (const id of fresh) asked.add(id);
      load(fresh);
    }
  }
  const later = () => {
    if (!timer) timer = setTimeout(scan, 700);
  };
  const obs = new MutationObserver(later);
  function stop() {
    obs.disconnect();
    document.removeEventListener('visibilitychange', later);
  }
  chrome.storage.local
    .get('libraryProduct')
    .then((v) => {
      productId = Number(v.libraryProduct) || null;
    })
    .catch(() => {})
    .finally(() => {
      obs.observe(document.body, { childList: true, subtree: true });
      document.addEventListener('visibilitychange', later);
      later();
    });

  globalThis.__pilotixLibrary = {
    alive,
    remove: () => {
      stop();
      for (const c of cards.values()) c.host.remove();
    },
  };
})();
