/*
 * Pilotix app: which door to open.
 * Used by index.html (the app's start page) and offline.html (shown when a page can't load).
 *
 * 1. It asks both doors at the same time, with a short wait:
 *      main   https://pilotix.online         (through Cloudflare)
 *      backup https://direct.pilotix.online  (straight to the server, for when Cloudflare's road is cut)
 *    The main door wins when it answers; the backup door is used only when the main one doesn't.
 * 2. When neither answers, it checks if the phone's internet works at all, and says the right thing:
 *      « No internet »  or  « Your internet works, but the road to Pilotix is cut ».
 * 3. It keeps trying by itself and opens Pilotix as soon as a door answers.
 *
 * It must work with no internet: no outside files. On Android the error page can't use Capacitor plugins.
 */
(function () {
  'use strict';

  var PAGE = window.PILOTIX_PAGE === 'error' ? 'error' : 'start';
  var MAIN = { id: 'main', url: 'https://pilotix.online/' };
  var BACKUP = { id: 'backup', url: 'https://direct.pilotix.online/' };
  var INTERNET = ['https://connectivitycheck.gstatic.com/generate_204', 'https://www.google.com/generate_204'];
  var PROBE_MS = 5000; // how long a door has to answer
  var PREFER_MAIN_MS = 1500; // when the backup answers first, how long the main door still gets
  var POLL_MS = 6000; // pause between two tries when nothing answers
  var CALM_S = 15; // the server itself fails again and again: wait this long between tries

  var WORDS = {
    fr: {
      connecting: 'Connexion à Pilotix…',
      netTitle: 'Pas de connexion internet',
      netText: 'Vérifiez le Wi‑Fi ou la 4G. Pilotix se rouvre tout seul dès que la connexion revient.',
      cutTitle: 'Pilotix ne répond pas sur cette connexion',
      cutText: 'Votre internet marche, mais la route vers Pilotix est coupée en ce moment. Essayez la 4G (coupez le Wi‑Fi) ou attendez un peu : on réessaie tout seul.',
      srvTitle: 'Pilotix revient dans un instant',
      srvText: 'Le serveur est en mise à jour ou ne répond pas. On réessaie tout seul.',
      retry: 'Réessayer',
      trying: 'Connexion…',
      backup: 'Ouverture par la porte de secours…',
      waiting: 'On réessaie toutes les quelques secondes…',
      next: function (s) { return 'Nouvel essai dans ' + s + ' s'; }
    },
    ar: {
      connecting: 'جارٍ الاتصال بـ Pilotix…',
      netTitle: 'لا يوجد اتصال بالإنترنت',
      netText: 'تحقق من الواي فاي أو 4G. سيفتح Pilotix تلقائياً عند عودة الاتصال.',
      cutTitle: 'Pilotix لا يستجيب على هذا الاتصال',
      cutText: 'الإنترنت يعمل، لكن الطريق إلى Pilotix مقطوع الآن. جرّب 4G (أوقف الواي فاي) أو انتظر قليلاً: سنعيد المحاولة تلقائياً.',
      srvTitle: 'Pilotix سيعود بعد لحظات',
      srvText: 'الخادم قيد التحديث أو لا يستجيب. سنعيد المحاولة تلقائياً.',
      retry: 'إعادة المحاولة',
      trying: 'جارٍ الاتصال…',
      backup: 'الفتح عبر الباب الاحتياطي…',
      waiting: 'نعيد المحاولة كل بضع ثوانٍ…',
      next: function (s) { return 'محاولة جديدة بعد ' + s + ' ثانية'; }
    },
    en: {
      connecting: 'Connecting to Pilotix…',
      netTitle: 'No internet connection',
      netText: 'Check your Wi‑Fi or mobile data. Pilotix opens again by itself when you are back online.',
      cutTitle: "Pilotix can't be reached on this connection",
      cutText: 'Your internet works, but the road to Pilotix is cut right now. Try mobile data (turn Wi‑Fi off) or wait a little: we keep trying by ourselves.',
      srvTitle: 'Pilotix will be back in a moment',
      srvText: 'The server is updating or not answering. We will keep trying.',
      retry: 'Try again',
      trying: 'Connecting…',
      backup: 'Opening through the backup door…',
      waiting: 'Trying again every few seconds…',
      next: function (s) { return 'Next try in ' + s + ' s'; }
    }
  };

  var langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'fr'];
  var lang = 'fr';
  for (var i = 0; i < langs.length; i++) {
    var l = String(langs[i] || '').slice(0, 2).toLowerCase();
    if (WORDS[l]) { lang = l; break; }
  }
  var w = WORDS[lang];
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';

  var $ = function (id) { return document.getElementById(id); };
  // works for svg too (svg elements have no .hidden switch)
  function setHidden(el, yes) { if (yes) el.setAttribute('hidden', ''); else el.removeAttribute('hidden'); }
  var btn = $('retry'), status = $('status');
  btn.textContent = w.retry;
  if (window.PILOTIX_BUILD) { $('build').textContent = 'Pilotix app · ' + window.PILOTIX_BUILD; setHidden($('build'), false); }

  var store = {
    get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
  };

  var timers = [], leaving = false;
  function later(fn, ms) { timers.push(setTimeout(fn, ms)); }
  function every(fn, ms) { timers.push(setInterval(fn, ms)); }
  function stopTimers() { while (timers.length) { var t = timers.pop(); clearTimeout(t); clearInterval(t); } }

  // ---- what the screen shows ----
  var ICONS = { connecting: 'ico-spin', net: 'ico-net', cut: 'ico-cut', server: 'ico-srv' };
  function show(kind) {
    for (var k in ICONS) setHidden($(ICONS[k]), k !== kind);
    var titles = { connecting: w.connecting, net: w.netTitle, cut: w.cutTitle, server: w.srvTitle };
    var texts = { connecting: '', net: w.netText, cut: w.cutText, server: w.srvText };
    $('title').textContent = titles[kind];
    $('text').textContent = texts[kind];
    setHidden(btn, kind === 'connecting');
    btn.disabled = false;
    status.textContent = '';
  }

  // ---- asking the doors ----
  // true when the address answers at all (any answer, even an error page), false after PROBE_MS or a network error
  function probe(url, ms) {
    return new Promise(function (resolve) {
      var done = false;
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var t = setTimeout(function () { finish(false); if (ctrl) ctrl.abort(); }, ms);
      function finish(ok) { if (!done) { done = true; clearTimeout(t); resolve(ok); } }
      try {
        fetch(url + (url.indexOf('?') < 0 ? '?' : '&') + 'app=' + Date.now(), {
          mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: ctrl ? ctrl.signal : undefined
        }).then(function () { finish(true); }, function () { finish(false); });
      } catch (e) { finish(false); }
    });
  }

  // the door to open, or null when none answers
  function pickDoor(preferBackup) {
    var order = preferBackup ? [BACKUP, MAIN] : [MAIN, BACKUP];
    return new Promise(function (resolve) {
      var res = {}, done = false, grace = null;
      function end(d) { if (!done) { done = true; clearTimeout(grace); resolve(d); } }
      function settle() {
        var a = order[0], b = order[1];
        if (res[a.id] === true) return end(a);
        if (res[a.id] === false) {
          if (res[b.id] === true) return end(b);
          if (res[b.id] === false) return end(null);
          return;
        }
        if (res[b.id] === true && !grace) grace = setTimeout(function () { end(res[a.id] === true ? a : b); }, PREFER_MAIN_MS);
      }
      order.forEach(function (d) { probe(d.url + 'robots.txt', PROBE_MS).then(function (ok) { res[d.id] = ok; settle(); }); });
    });
  }

  function internetWorks() {
    return Promise.all(INTERNET.map(function (u) { return probe(u, PROBE_MS); }))
      .then(function (r) { return r.indexOf(true) >= 0; });
  }

  // ---- pages that failed recently (to not loop when the server itself is down) ----
  function recentErrors() {
    var list = [];
    try { list = JSON.parse(store.get('pxErrors') || '[]'); } catch (e) {}
    var now = Date.now();
    return list.filter(function (t) { return now - t < 60000; });
  }

  // ---- opening a door ----
  function go(door) {
    if (leaving) return;
    leaving = true;
    stopTimers();
    store.set('pxDoor', door.id);
    btn.disabled = true;
    status.textContent = door.id === 'backup' ? w.backup : w.trying;
    // the start animation (splash.js) finishes first
    var leave = function () { location.replace(door.url); };
    if (window.PILOTIX_SPLASH) window.PILOTIX_SPLASH.then(leave); else leave();
  }

  function countdown(seconds, then) {
    var left = seconds;
    status.textContent = w.next(left);
    every(function () {
      left -= 1;
      if (left <= 0) { stopTimers(); then(); return; }
      status.textContent = w.next(left);
    }, 1000);
  }

  function nothingAnswers() {
    if (navigator.onLine === false) { show('net'); return waitAndRetry(); }
    internetWorks().then(function (ok) { if (!leaving) { show(ok ? 'cut' : 'net'); waitAndRetry(); } });
  }

  function waitAndRetry() {
    status.textContent = w.waiting;
    later(function () { attempt(false, true); }, POLL_MS);
  }

  // fromPerson: the person tapped « Try again » (or the phone just came back online)
  // quiet: a background retry that keeps the current message on screen
  function attempt(fromPerson, quiet) {
    if (leaving) return;
    stopTimers();
    if (navigator.onLine === false) { show('net'); return waitAndRetry(); }
    if (!quiet) {
      if (PAGE === 'start' || fromPerson) show('connecting');
      else status.textContent = w.trying;
    }
    // the main door just failed: ask the backup door first this time
    var preferBackup = PAGE === 'error' && store.get('pxDoor') === 'main';
    pickDoor(preferBackup).then(function (door) {
      if (leaving) return;
      if (!door) return nothingAnswers();
      // a door answers but its pages keep failing: the server itself has a problem, so wait calmly
      if (PAGE === 'error' && !fromPerson && recentErrors().length >= 2) {
        show('server');
        return countdown(CALM_S, function () { go(door); });
      }
      go(door);
    });
  }

  btn.addEventListener('click', function () { attempt(true, false); });
  window.addEventListener('online', function () { later(function () { attempt(true, false); }, 800); });

  if (PAGE === 'error') {
    var errs = recentErrors();
    errs.push(Date.now());
    store.set('pxErrors', JSON.stringify(errs));
    show(navigator.onLine === false ? 'net' : 'connecting');
  } else {
    store.set('pxErrors', '[]');
    show('connecting');
  }
  attempt(false, false);
})();
