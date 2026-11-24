// Pilotix extension — the customer card on WhatsApp Web. This script finds the number of the chat open there and shows
// the card beside it; the card itself is the extension's own page (card.html) in a frame, so what Pilotix knows about
// the customer never enters WhatsApp's page (WhatsApp cannot read another site's frame). The card asks Pilotix through
// the worker (background.js › askPilotix: the open Pilotix tab answers with the agent's rights).
// The number goes to the card in its address (#p=213…), the card says its size back (window message: numbers only).
// A quick reply clicked in the card is put in the chat's message box (asked by the worker: { action: 'insert' }); the
// agent sends it. Nothing is ever sent by the extension.
(() => {
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };
  // after an update the old copy is cut off from the worker: the new one takes over (one card on the page)
  if (globalThis.__pilotixCard?.alive?.()) return;
  globalThis.__pilotixCard?.remove?.();
  const CARD = chrome.runtime.getURL('card.html');
  const ORIGIN = new URL(CARD).origin;
  const visible = (el) => !!el && el.isConnected && el.getClientRects().length > 0;

  /** 8 to 15 digits of a phone number written in a text (« +213 555 12 34 56 »), or null */
  function digitsOf(text) {
    const m = /\+?\d[\d\s\-().]{6,20}\d/.exec(String(text || ''));
    if (!m) return null;
    const d = m[0].replace(/\D/g, '');
    return d.length >= 8 && d.length <= 15 ? d : null;
  }
  /** the number Pilotix opened this tab on (Envoyer photos: /send?phone=…), until another chat is opened */
  let opened = new URLSearchParams(location.search).get('phone');
  let openedTitle = null;

  /** The number of the chat open now (null: no chat open, or WhatsApp does not show it). */
  function chatPhone() {
    const main = document.getElementById('main');
    if (!main || !visible(main)) return null;
    const header = main.querySelector('header');
    const title = header?.querySelector('span[title]')?.getAttribute('title') || header?.querySelector('span[dir="auto"]')?.textContent || '';
    // a contact not saved: its number is the chat's title
    const fromTitle = digitsOf(title);
    if (fromTitle) return fromTitle;
    // the messages carry the chat's id: false_213555123456@c.us_…
    for (const el of main.querySelectorAll('[data-id]')) {
      const m = /(?:true|false)_(\d{8,15})@c\.us/.exec(el.getAttribute('data-id') || '');
      if (m) return m[1];
    }
    // the chat Pilotix opened (a saved contact shows its name): while its title stays the same
    if (opened) {
      if (openedTitle === null) openedTitle = title;
      if (title === openedTitle) return opened;
      opened = null;
    }
    return null;
  }

  // ---------------------------------------------------------------- the frame
  const host = document.createElement('div');
  host.id = 'pilotix-card';
  const shadow = host.attachShadow({ mode: 'closed' });
  const frame = document.createElement('iframe');
  frame.title = 'Pilotix';
  frame.setAttribute('allow', 'clipboard-write');
  Object.assign(frame.style, { border: '0', width: '100%', height: '100%', display: 'block', background: 'transparent', colorScheme: 'normal' });
  shadow.append(frame);
  Object.assign(host.style, { position: 'fixed', top: '68px', right: '8px', width: '210px', height: '52px', zIndex: '2147483000', display: 'none' });
  let shown = null;
  function show(phone) {
    if (phone === shown) return;
    shown = phone;
    if (!phone) {
      host.style.display = 'none';
      return;
    }
    if (!host.isConnected) document.documentElement.append(host);
    const url = `${CARD}#p=${phone}`;
    if (!frame.src) frame.src = url;
    else frame.contentWindow?.postMessage({ pilotixCard: 'phone', phone }, ORIGIN);
    host.style.display = 'block';
  }
  // the card's size (collapsed: its pill; open: the card), said by the card itself
  function onCardMessage(e) {
    if (e.source !== frame.contentWindow || e.origin !== ORIGIN) return;
    const d = e.data;
    if (!d || d.pilotixCard !== 'size') return;
    const w = Math.max(60, Math.min(440, Number(d.w) || 210));
    const h = Math.max(40, Math.min(window.innerHeight - 80, Number(d.h) || 52));
    host.style.width = `${w}px`;
    host.style.height = `${h}px`;
  }
  window.addEventListener('message', onCardMessage);

  const timer = setInterval(() => {
    if (!alive()) return stop();
    show(chatPhone());
  }, 900);
  function stop() {
    clearInterval(timer);
    window.removeEventListener('message', onCardMessage);
  }

  // ---------------------------------------------------------------- a quick reply into the chat's message box
  function composer() {
    for (const s of ['#main footer [contenteditable="true"]', 'footer [contenteditable="true"][role="textbox"]', 'footer div[contenteditable="true"]'])
      for (const el of document.querySelectorAll(s)) if (visible(el)) return el;
    return null;
  }
  function insert(text) {
    const box = composer();
    if (!box) return false;
    box.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const before = box.textContent || '';
    box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    // an editor that ignored the pasted text: typed instead
    if ((box.textContent || '') === before) document.execCommand('insertText', false, text);
    return true;
  }
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!alive() || sender.id !== chrome.runtime.id || msg?.action !== 'insert' || typeof msg.text !== 'string') return false;
    reply({ ok: insert(msg.text.slice(0, 4000)) });
    return false;
  });

  globalThis.__pilotixCard = {
    alive,
    remove: () => {
      stop();
      host.remove();
    },
  };
})();
