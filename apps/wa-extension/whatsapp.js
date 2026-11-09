// Pilotix WhatsApp — on WhatsApp Web. Asked by the add-on's worker (background.js): wait until WhatsApp Web has opened
// the customer's chat, paste the photos into it (WhatsApp shows them, ready to send), then put the message under them.
// The agent presses Enter: nothing is sent by the add-on, and nothing of WhatsApp is read or sent anywhere.
(() => {
  /** how long WhatsApp Web may take to load and open the chat */
  const OPEN_MS = 90_000;
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const visible = (el) => !!el && el.isConnected && el.getClientRects().length > 0;
  let busy = false;

  /** the chat's message box (the conversation's footer) */
  function composer() {
    const sel = ['#main footer [contenteditable="true"]', 'footer [contenteditable="true"][role="textbox"]', 'footer div[contenteditable="true"]'];
    for (const s of sel) for (const el of document.querySelectorAll(s)) if (visible(el)) return el;
    return null;
  }
  /** WhatsApp Web is not linked: it shows its QR code */
  function notLinked() {
    return !!document.querySelector('[data-ref] canvas, canvas[aria-label*="QR" i], canvas[aria-label*="scan" i], canvas[aria-label*="Scan" i]');
  }
  /** WhatsApp says the number is not on WhatsApp (its little window) */
  function invalidNumber() {
    for (const d of document.querySelectorAll('[role="dialog"], [data-animate-modal-popup="true"]')) {
      if (visible(d) && /invalid|invalide|n.?est pas sur whatsapp|isn.?t on whatsapp|not on whatsapp|غير صالح|ليس على واتساب|no es válido|ungültig|non valido|inválido/i.test(d.textContent || '')) return true;
    }
    return false;
  }
  const boxes = () => [...document.querySelectorAll('[contenteditable="true"]')];
  /** the caption box of WhatsApp's photo preview: a new box, not the chat's own */
  function captionBox(before, chat) {
    for (const el of boxes()) if (!before.has(el) && el !== chat && visible(el)) return el;
    return null;
  }
  async function waitFor(f, ms, every = 150) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = f();
      if (v) return v;
      await sleep(every);
    }
    return null;
  }
  function fromB64(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function pasteFiles(target, files) {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    target.focus();
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }
  /** the other way WhatsApp Web takes photos: dropped on the chat */
  function dropFiles(files) {
    const zone = document.querySelector('#main') || composer()?.closest('footer')?.parentElement;
    if (!zone) return;
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    for (const type of ['dragenter', 'dragover', 'drop']) zone.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }
  function pasteText(target, text) {
    if (!text) return;
    target.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    // an editor that ignored the pasted text: typed instead
    if (!(target.textContent || '').trim()) document.execCommand('insertText', false, text);
  }
  function banner(text) {
    const old = document.getElementById('pilotix-wa-banner');
    if (old) old.remove();
    const b = document.createElement('div');
    b.id = 'pilotix-wa-banner';
    b.textContent = text;
    b.setAttribute('role', 'status');
    Object.assign(b.style, {
      position: 'fixed', left: '50%', top: '14px', transform: 'translateX(-50%)', zIndex: '2147483647', background: '#1B2A47', color: '#fff',
      font: '600 15px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', padding: '10px 18px', borderRadius: '999px',
      boxShadow: '0 8px 24px rgba(0,0,0,.25)', pointerEvents: 'none',
    });
    document.body.appendChild(b);
    setTimeout(() => b.remove(), 9000);
  }

  async function attach({ text, files }) {
    // 1 the chat open (WhatsApp Web loads, then opens the number's chat)
    const t0 = Date.now();
    let chat = null;
    while (Date.now() - t0 < OPEN_MS) {
      if (notLinked()) return { ok: false, error: 'not-logged-in' };
      if (invalidNumber()) return { ok: false, error: 'invalid-number' };
      chat = composer();
      if (chat) break;
      await sleep(300);
    }
    if (!chat) return { ok: false, error: 'timeout' };
    await sleep(600); // WhatsApp finishes opening the chat
    if (invalidNumber()) return { ok: false, error: 'invalid-number' };
    chat = composer() || chat;
    // 2 the photos: pasted into the chat — WhatsApp shows them, ready to send
    const list = files.map((f) => new File([fromB64(f.b64)], f.name, { type: f.type }));
    const before = new Set(boxes());
    pasteFiles(chat, list);
    let cap = await waitFor(() => captionBox(before, chat), 5000);
    if (!cap) {
      dropFiles(list);
      cap = await waitFor(() => captionBox(before, chat), 5000);
    }
    if (!cap) {
      // the message at least, in the chat's box
      pasteText(chat, text);
      return { ok: false, error: 'paste' };
    }
    // 3 the message under the photos
    await sleep(250);
    pasteText(cap, text);
    banner('Pilotix · Photos et message prêts : appuyez sur Entrée pour envoyer.');
    return { ok: true, photos: list.length };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.action !== 'attach') return false;
    // a page from before the add-on opened this chat: the new one will answer
    if (performance.timeOrigin < msg.startedAt - 50) {
      reply({ stale: true });
      return false;
    }
    if (busy) {
      reply({ busy: true });
      return false;
    }
    busy = true;
    attach(msg)
      .then(reply, (e) => reply({ ok: false, error: 'failed', detail: String(e?.message || e) }))
      .finally(() => {
        busy = false;
      });
    return true;
  });
})();
