// A new version of Pilotix goes live several times a day. A page left open (a tab, the phone app kept in the background)
// would keep the old one, and after an update the old files are gone from the server: opening a page it had not loaded
// yet would fail. So the site checks now and then whether a new version is live, and moves to it at a moment that loses
// nothing: when the person changes page, comes back to Pilotix after a while, or leaves it untouched a few minutes —
// never with a window open, a field in use or something typed on this page. A page whose files are gone loads the new
// version at once. The person sees « Mise à jour de Pilotix… » for a moment, then « Pilotix est à jour ».
// Only on the real site (lib/route PATHS): the preview in Claude has no new versions to fetch.
import { atLocalMidnight } from './midnight';
import i18n from './i18n';
import { ROUTE_EVENT } from './route';
import { toast } from '../ui/toast';

/** The main file of a version: its name changes with every build (« /assets/index-<hash>.js »). */
const MAIN = /\/assets\/index-[A-Za-z0-9_-]+\.js/;
const CHECK_EVERY = 5 * 60_000;
/** Away from Pilotix at least this long (the phone locked, another app): coming back is a good moment. */
const AWAY = 60_000;
/** Untouched this long, with a new version waiting at least this long: a good moment too. */
const IDLE = 2 * 60_000;
const WAITED = 3 * 60_000;
/** Shown once after the move (the next start of the site in this tab). */
const DONE = 'px:updated';
/** A page whose files were gone already reloaded at this time: a second failure within 30 s is not a new version. */
const STALE = 'px:stale-reload';

/** This page's version, from its main file. */
export function mainFile(src: string | null | undefined): string | null {
  return src?.match(MAIN)?.[0] ?? null;
}

/** Is a new version live? The site's own page names its main file (null: no answer, or not a Pilotix page). */
async function liveMain(): Promise<string | null> {
  try {
    const r = await fetch(`/?v=${Date.now()}`, { cache: 'no-store', credentials: 'same-origin' });
    return r.ok ? mainFile(await r.text()) : null;
  } catch {
    return null;
  }
}

/** Something on this page would be lost by loading it again: a window open, a field in use, something typed here. */
function busy(typed: boolean): boolean {
  if (typed) return true;
  if (document.querySelector('[aria-modal="true"], dialog[open]')) return true;
  const a = document.activeElement;
  return a instanceof HTMLElement && a.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
}

/** « Mise à jour de Pilotix… » over the page, then the new version. */
function moveOn() {
  if (document.querySelector('.px-update')) return;
  try {
    sessionStorage.setItem(DONE, '1');
  } catch {
    /* private mode: no message after */
  }
  const el = document.createElement('div');
  el.className = 'px-update';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  const card = document.createElement('div');
  card.className = 'px-update-card';
  const spin = document.createElement('span');
  spin.className = 'px-update-spin';
  spin.setAttribute('aria-hidden', 'true');
  const title = document.createElement('b');
  title.textContent = i18n.t('common.update.moving');
  const sub = document.createElement('small');
  sub.textContent = i18n.t('common.update.movingSub');
  card.append(spin, title, sub);
  el.append(card);
  document.body.append(el);
  setTimeout(() => location.reload(), 900);
}

export function startFreshness() {
  const mine = mainFile(document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')?.src);
  if (!mine) return;

  // just moved to a new version: say so once
  try {
    if (sessionStorage.getItem(DONE)) {
      sessionStorage.removeItem(DONE);
      setTimeout(() => toast(i18n.t('common.update.done'), 'ok', 3000), 1200);
    }
  } catch {
    /* private mode */
  }

  // a page whose files are gone (Vite could not load it): the new version, at once
  window.addEventListener('vite:preloadError', (e) => {
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(STALE) || 0);
      if (Date.now() - last < 30_000) return; // just tried: no internet, or the server is down (the page says so)
      sessionStorage.setItem(STALE, String(Date.now()));
    } catch {
      /* private mode: one try per page */
    }
    e.preventDefault();
    moveOn();
  });

  let waiting: number | null = null; // when a new version was first seen live
  let typed = false; // something typed or changed on this page
  let lastTouch = Date.now();
  let hiddenAt = 0;
  let lastCheck = 0;

  const check = async () => {
    if (document.visibilityState !== 'visible' || waiting) return;
    lastCheck = Date.now();
    const live = await liveMain();
    if (live && live !== mine) waiting = Date.now();
  };

  atLocalMidnight(async () => {
    await check();
    if (waiting && document.visibilityState === 'visible' && !busy(typed) && Date.now() - lastTouch >= IDLE) moveOn();
  });

  // the page changed: nothing typed on the new one yet, and the best moment to move on
  window.addEventListener(ROUTE_EVENT, () => {
    typed = false;
    if (waiting && !document.querySelector('[aria-modal="true"], dialog[open]')) moveOn();
  });
  const isField = (t: EventTarget | null) =>
    t instanceof HTMLElement && t.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
  document.addEventListener('input', (e) => isField(e.target) && (typed = true), true);
  document.addEventListener('change', (e) => isField(e.target) && (typed = true), true);
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
    document.addEventListener(ev, () => (lastTouch = Date.now()), { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    const away = hiddenAt ? Date.now() - hiddenAt : 0;
    if (Date.now() - lastCheck > AWAY) await check();
    if (waiting && away >= AWAY && !busy(typed)) moveOn();
  });
  window.addEventListener('online', () => void check());
  setTimeout(() => void check(), 20_000);
  setInterval(() => {
    const now = Date.now();
    if (now - lastCheck >= CHECK_EVERY) void check();
    if (waiting && document.visibilityState === 'visible' && now - waiting >= WAITED && now - lastTouch >= IDLE && !busy(typed)) moveOn();
  }, 30_000);
}
