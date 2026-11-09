// Pilotix WhatsApp — the add-on's worker. Asked by a Pilotix page (pilotix.js): download the products' photos from
// Pilotix (its public photo copies only), open WhatsApp Web on the customer's chat (the tab already open, or a new
// one), then have whatsapp.js paste the photos and the message there. The agent presses Enter: nothing is sent by
// the add-on itself. It never reads WhatsApp's chats and talks to no other server.
const HOSTS = ['pilotix.online', 'direct.pilotix.online'];
/** WhatsApp takes 30 photos at once */
const MAX_PHOTOS = 30;
const MAX_BYTES = 12 * 1024 * 1024;
/** how long WhatsApp Web may take to open the chat */
const OPEN_MS = 90_000;

/** only Pilotix's own photo copies: https, its address, /api/…/lp/dp/… */
function okPhoto(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && HOSTS.includes(x.hostname) && x.pathname.startsWith('/api/') && x.pathname.includes('/lp/dp/');
  } catch {
    return false;
  }
}
/** an international number, digits only (213…): 8 to 15 digits */
function digits(s) {
  const d = String(s ?? '').replace(/\D/g, '');
  return d.length >= 8 && d.length <= 15 ? d : null;
}
function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.action === 'ping') {
    reply({ ok: true });
    return false;
  }
  if (msg?.action !== 'send') return false;
  // only a Pilotix page may ask
  let from = null;
  try {
    from = sender.url ? new URL(sender.url).hostname : null;
  } catch {
    from = null;
  }
  if (!from || !HOSTS.includes(from) || sender.id !== chrome.runtime.id) {
    reply({ ok: false, error: 'not-pilotix' });
    return false;
  }
  send(msg).then(reply, (e) => reply({ ok: false, error: 'failed', detail: String(e?.message || e) }));
  return true;
});

async function send({ phone, text, photos }) {
  const p = digits(phone);
  if (!p) return { ok: false, error: 'bad-phone' };
  if (!Array.isArray(photos) || !photos.length || photos.length > MAX_PHOTOS || !photos.every(okPhoto)) return { ok: false, error: 'bad-photos' };
  const caption = typeof text === 'string' ? text.slice(0, 4000) : '';
  // 1 the photos, from Pilotix
  const files = [];
  for (const [k, u] of photos.entries()) {
    let r;
    try {
      r = await fetch(u, { credentials: 'omit', cache: 'no-store', redirect: 'error' });
    } catch (e) {
      return { ok: false, error: 'photo', detail: String(e?.message || e) };
    }
    if (!r.ok) return { ok: false, error: 'photo', detail: `HTTP ${r.status}` };
    const type = (r.headers.get('content-type') || 'image/jpeg').split(';')[0].trim().toLowerCase();
    if (!type.startsWith('image/')) return { ok: false, error: 'photo', detail: type };
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length > MAX_BYTES) return { ok: false, error: 'photo', detail: 'too big' };
    const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
    files.push({ name: `photo-${k + 1}.${ext}`, type, b64: b64(bytes) });
  }
  // 2 WhatsApp Web on the customer's chat: the tab already open (or a new one), in front
  const startedAt = Date.now();
  const url = `https://web.whatsapp.com/send?phone=${p}`;
  const [open] = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  const tab = open ? await chrome.tabs.update(open.id, { url, active: true }) : await chrome.tabs.create({ url, active: true });
  if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  // 3 the photos and the message pasted there, once WhatsApp Web has opened the chat
  const until = Date.now() + OPEN_MS + 20_000;
  while (Date.now() < until) {
    let r = null;
    try {
      r = await chrome.tabs.sendMessage(tab.id, { action: 'attach', startedAt, phone: p, text: caption, files });
    } catch {
      r = null; // the page is still loading (its script not there yet)
    }
    // (already pasting for an earlier click: not twice)
    if (r?.busy) return { ok: false, error: 'busy' };
    if (r && !r.stale) return r;
    await sleep(700);
  }
  return { ok: false, error: 'timeout' };
}
