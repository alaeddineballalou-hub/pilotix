// Pilotix service worker:
// 1. shows the notifications the server pushes (dépôt alerts ring until the app is opened);
// 2. the door keeper (« porte de secours », owner's ask, 21 Nov 2026): when the site's main address gives no answer
//    (Cloudflare's road from the person's internet is cut), it shows a small door page that opens the same page on the
//    backup door (direct.<site>: the same server without Cloudflare), still logged in (apps/web lib/door.ts, the
//    server's /api/auth/door). It never keeps a copy of Pilotix: the app always comes from the server, as before.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch (_) {
    d = { title: 'Pilotix', body: e.data ? e.data.text() : '' };
  }
  const alarm = !!d.alarm;
  e.waitUntil(
    self.registration.showNotification(d.title || 'Pilotix', {
      body: d.body || '',
      tag: d.tag || 'pilotix',
      // same tag again: it rings and vibrates again instead of staying silent
      renotify: true,
      requireInteraction: alarm,
      silent: false,
      vibrate: alarm ? [800, 200, 800, 200, 800, 200, 1200] : [200],
      icon: 'icon.svg',
      badge: 'icon.svg',
      data: { url: d.url || '' },
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data && e.notification.data.url ? e.notification.data.url : '', self.registration.scope).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) return c.focus();
      return self.clients.openWindow(url);
    }),
  );
});

// ---------------------------------------------------------------- the door keeper
// On only when the site registered this worker as « sw.js?door=1 » (lib/door.ts, the control room's switch on), and
// only at the site's main address: otherwise this worker never touches a page, exactly as before.
const DOOR = new URL(self.location.href).searchParams.get('door') === '1' && !self.location.hostname.startsWith('direct.');
const MAIN = self.location.hostname;
const DIRECT = 'direct.' + MAIN.replace(/^www\./, '');
/** The main address's silence after which the door page is shown (the page then checks both roads itself). */
const DOOR_WAIT_MS = 5000;
/** « The main road answers again »: the door page asks the next page loads to wait for it as long as it takes. */
let bypassUntil = 0;

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'px-door-bypass') bypassUntil = Date.now() + 60_000;
});

/** Addresses that are not pages of the app (the server's own: logins with Google or Meta come back there): never touched. */
const NOT_A_PAGE = /^\/(api|live|mcp|\.well-known)(\/|$)|^\/llms\.txt$/;

self.addEventListener('fetch', (e) => {
  if (!DOOR) return;
  const req = e.request;
  if (req.mode !== 'navigate' || req.method !== 'GET' || Date.now() < bypassUntil) return;
  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return;
  }
  if (url.origin !== self.location.origin || NOT_A_PAGE.test(url.pathname)) return;
  e.respondWith(openPage(req));
});

/** The main road: its answer, or the door page after 5 s of silence, a failure, or Cloudflare not reaching the server. */
async function openPage(req) {
  const net = fetch(req);
  let timer = null;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), DOOR_WAIT_MS);
  });
  try {
    const r = await Promise.race([net, late]);
    if (timer) clearTimeout(timer);
    if (!r) {
      net.catch(() => {});
      return doorPage('sw');
    }
    if (r.status >= 520 && r.status <= 526) return doorPage('sw');
    return r;
  } catch (_) {
    if (timer) clearTimeout(timer);
    return doorPage('sw');
  }
}

/** The door page: drawn here (no file to load: the road may be cut), its script runs once, with its own strict rules. */
function doorPage(why) {
  const nonce = Array.from(self.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  const json = JSON.stringify({ main: MAIN, direct: DIRECT, why }).replace(/</g, '\\u003c');
  const html = DOOR_HTML.replace(/__NONCE__/g, () => nonce).replace('__CONF__', () => json);
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

const DOOR_HTML = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Pilotix</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#FBF8F3;color:#1B2A47;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Arabic",Tahoma,sans-serif}
.card{width:100%;max-width:420px;background:#fff;border-radius:20px;padding:28px 24px;box-shadow:0 10px 40px rgba(27,42,71,.12);text-align:center}
.logo{font-weight:800;font-size:26px;letter-spacing:-.5px;margin-bottom:18px}
.logo i{font-style:normal;color:#F28B1E}
.door{width:56px;height:56px;margin:0 auto 14px;border-radius:16px;display:grid;place-items:center;background:#FFF3E6;color:#A4480A}
h1{font-size:19px;margin:0 0 6px}
p{margin:0;color:#5F6673}
.spin{width:22px;height:22px;margin:18px auto 0;border-radius:50%;border:3px solid #FFE2BF;border-top-color:#F28B1E;animation:s 1s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}
button{margin-top:18px;border:0;border-radius:12px;padding:12px 20px;font:inherit;font-weight:700;background:linear-gradient(135deg,#F7A823,#F28B1E);color:#1B2A47;cursor:pointer}
.note{margin-top:16px;font-size:13px}
[hidden]{display:none!important}
@media (prefers-color-scheme:dark){body{background:#181B21;color:#EEF1F6}.card{background:#22262E;box-shadow:none}p{color:#AEB5C2}.door{background:#3A2E14;color:#F7B955}}
@media (prefers-reduced-motion:reduce){.spin{animation-duration:3s}}
</style></head>
<body><main class="card" role="status" aria-live="polite">
<div class="logo">p<i>i</i>lot<i>i</i>x</div>
<div class="door" aria-hidden="true"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 4h3a2 2 0 0 1 2 2v14"/><path d="M2 20h3"/><path d="M13 20h9"/><path d="M10 12v.01"/><path d="M13 4.562v16.157a1 1 0 0 1-1.242.97L5 20V5.562a2 2 0 0 1 1.515-1.94l4-1A2 2 0 0 1 13 4.561Z"/></svg></div>
<h1 id="t"></h1><p id="s"></p><div class="spin" id="w"></div>
<button type="button" id="r" hidden></button>
<p class="note" id="n"></p>
</main>
<script nonce="__NONCE__">
(function () {
  var C = __CONF__;
  var TX = {
    fr: { t: 'Porte de secours', checking: 'La route vers Pilotix ne répond pas. On essaie la porte de secours…', opening: 'Porte de secours trouvée. Ouverture de Pilotix…', none: 'Pilotix ne répond pas pour le moment', noneSub: 'Vérifiez votre internet. Nouvel essai tout seul dans quelques secondes.', retry: 'Réessayer', note: 'Même Pilotix, mêmes données : rien n’est perdu.' },
    en: { t: 'Backup door', checking: 'The road to Pilotix is not answering. Trying the backup door…', opening: 'Backup door found. Opening Pilotix…', none: 'Pilotix is not answering right now', noneSub: 'Check your internet. Trying again by itself in a few seconds.', retry: 'Try again', note: 'Same Pilotix, same data: nothing is lost.' },
    ar: { t: 'الباب الاحتياطي', checking: 'الطريق إلى Pilotix لا يستجيب. نجرّب الباب الاحتياطي…', opening: 'وجدنا الباب الاحتياطي. جارٍ فتح Pilotix…', none: 'Pilotix لا يستجيب حاليًا', noneSub: 'تحقّق من الإنترنت. محاولة جديدة تلقائيًا بعد ثوانٍ.', retry: 'أعد المحاولة', note: 'نفس Pilotix ونفس البيانات: لا شيء يضيع.' }
  };
  var get = function (k) { try { return localStorage.getItem('px.' + k); } catch (_) { return null; } };
  // the app's own language (French unless the person chose English or Arabic, as lib/i18n)
  var lang = get('lang');
  if (lang !== 'en' && lang !== 'ar') lang = 'fr';
  var T = TX[lang];
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  var $ = function (id) { return document.getElementById(id); };
  $('t').textContent = T.t; $('r').textContent = T.retry; $('n').textContent = T.note;
  var show = function (msg, wait, retry) { $('s').textContent = msg; $('w').hidden = !wait; $('r').hidden = !retry; };

  // a road answers when the server itself says it is well within the time (Cloudflare's own error pages do not count)
  var answers = function (origin, ms) {
    return new Promise(function (done) {
      var ac = typeof AbortController === 'function' ? new AbortController() : null;
      var t = setTimeout(function () { if (ac) ac.abort(); done(false); }, ms);
      fetch(origin + '/api/health?door=' + Date.now(), { cache: 'no-store', credentials: 'omit', signal: ac ? ac.signal : undefined })
        .then(function (res) { clearTimeout(t); done(res.ok); }, function () { clearTimeout(t); done(false); });
    });
  };
  // the main road was only slow: this page again, waited for as long as it takes (twice at most a minute)
  var reloadMain = function () {
    var n = 0;
    try { n = Number(sessionStorage.getItem('px.door.reload') || 0); if (Date.now() - n < 60000) return false; sessionStorage.setItem('px.door.reload', String(Date.now())); } catch (_) {}
    try { if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: 'px-door-bypass' }); } catch (_) {}
    setTimeout(function () { location.reload(); }, 150);
    return true;
  };
  var main = 'https://' + C.main, direct = 'https://' + C.direct;
  var busy = false, again = null;
  var attempt = function () {
    if (busy) return;
    busy = true; clearTimeout(again);
    show(T.checking, true, false);
    Promise.all([answers(main, 4000), answers(direct, 8000)]).then(function (r) {
      if (r[0] && reloadMain()) return;
      if (!r[1]) { busy = false; show(T.none + '. ' + T.noneSub, false, true); again = setTimeout(attempt, 15000); return; }
      show(T.opening, true, false);
      var go = function (ticket) {
        location.replace(direct + location.pathname + location.search + '#porte=' + encodeURIComponent(ticket || '') + '&par=' + C.why);
      };
      var token = get('token');
      if (!token) return go('');
      // this browser's session, carried to the backup door by a ticket (2 minutes, once): never the session itself
      fetch(direct + '/api/auth/door/ticket', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: '{}', cache: 'no-store', credentials: 'omit' })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (j) { go(j && typeof j.ticket === 'string' ? j.ticket : ''); }, function () { go(''); });
    });
  };
  $('r').addEventListener('click', attempt);
  window.addEventListener('online', attempt);
  attempt();
})();
</script></body></html>`;
