// The backup door (« porte de secours », owner's ask, 21 Nov 2026). Cloudflare's road from a country, or from one
// internet company, is sometimes cut while the server is fine (the cuts of Nov. 2026 in Algeria). The same app and
// server also answer at direct.<site>, without Cloudflare (README › Backup door). Pilotix uses it by itself:
// - on the main address: the browser's door keeper (public/sw.js) is installed while it is on (Control room › Réglages ›
//   « Porte de secours automatique »). When a page of Pilotix gives no answer for 5 s, the keeper shows a door page that
//   opens the same page at the backup door. And when Pilotix is already open and the road gets cut while the backup door
//   answers, the person is moved there: by itself after 5 s (ui/DoorChip), or with a button when something is being typed;
// - on both addresses: a ticket in the address (#porte=…, 2 minutes, once: /api/auth/door) opens the same person's
//   session there before the app starts, so nobody logs in again;
// - on the backup door: the chip in the top bar (ui/DoorChip), and the way back. Once the main address answers again
//   (twice in a row, 30 s apart), the person goes back at the next good moment: a change of page, back to Pilotix after
//   a while, or 2 minutes untouched — never with something typed or a window open.
// Every move is told to Control room › Doctor (lib/watch « door »). Not in the phone app (mobile/www/door.js does the
// same there), not in the preview (its look-alike only: demoDoor), not in development.
import i18n from './i18n';
import { BACKUP_DOOR, DEMO_ONLY, FIXED_SERVER, server, serverUrl } from './backend';
import { PATHS, ROUTE_EVENT } from './route';
import { store } from './store';
import { NET_FAIL, report } from './watch';
import { toast } from '../ui/toast';

export interface DoorView {
  /** this page is on the backup door */
  here: boolean;
  /** on the backup door: the main address answers again */
  mainBack: boolean;
  /** just arrived through the door: the 5-second message (« sw »: while opening Pilotix, « app »: while working) */
  arrived: 'sw' | 'app' | null;
  /** on the main address: its road is cut and the backup door answers. « auto »: moving in 5 s; « ask »: a button */
  offer: 'auto' | 'ask' | null;
  /** the preview's look-alike (an « Essayer » link): drawn, nothing moves */
  demo: boolean;
}

let view: DoorView = { here: BACKUP_DOOR, mainBack: false, arrived: null, offer: null, demo: false };
const subs = new Set<() => void>();
const set = (p: Partial<DoorView>) => {
  view = { ...view, ...p };
  subs.forEach((f) => f());
};
export const doorView = () => view;
export const onDoorView = (f: () => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};

/** The site on its own server (not the phone app, the preview or development). */
const LIVE = FIXED_SERVER && PATHS && import.meta.env.PROD && !/\bPilotixApp\b/.test(navigator.userAgent);

function mainHost(): string {
  try {
    return new URL(serverUrl()).hostname;
  } catch {
    return '';
  }
}
/** https://pilotix.online */
export const mainOrigin = () => (mainHost() ? `https://${mainHost()}` : '');
/** https://direct.pilotix.online */
export const directOrigin = () => (mainHost() ? `https://direct.${mainHost()}` : '');

/** Does this address's server say it is well, within `ms`? (Cloudflare's own error pages do not count.) */
async function answers(origin: string, ms: number): Promise<boolean> {
  if (!origin) return false;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(`${origin}/api/health?door=${Date.now()}`, { cache: 'no-store', credentials: 'omit', signal: ac.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return '';
  }
};
/** On the backup door: when this tab arrived (sessionStorage: this tab only). */
const SINCE = 'px:door-since';

/**
 * A ticket in the address (#porte=<ticket>&par=sw|app|retour[&min=n]): this address's own session for the same person,
 * opened before the app starts (main.tsx waits for it). The ticket leaves the address at once.
 */
export async function arriveThroughDoor(): Promise<void> {
  const m = /^#porte=([^&]*)((?:&[a-z]+=[a-z0-9]*)*)$/i.exec(location.hash);
  if (!m) return;
  history.replaceState(history.state, '', location.pathname + location.search);
  if (!FIXED_SERVER || DEMO_ONLY) return;
  const args = new URLSearchParams(m[2].replace(/^&/, ''));
  const par = args.get('par');
  const ticket = decode(m[1] ?? '');
  const entered = ticket ? await server.enterThroughDoor(ticket) : false;
  if (BACKUP_DOOR) {
    try {
      sessionStorage.setItem(SINCE, String(Date.now()));
    } catch {
      /* private mode: no time on the way back */
    }
    set({ arrived: par === 'app' ? 'app' : 'sw' });
    report(
      'door',
      `Porte de secours ouverte ${par === 'app' ? 'pendant le travail' : "à l'ouverture de Pilotix"} (${mainHost()} ne répondait pas) · ${entered ? 'toujours connecté' : ticket ? 'connexion à refaire (ticket refusé)' : 'pas connecté'}`,
    );
  } else if (par === 'retour') {
    const min = Number(args.get('min') || 0);
    report('door', `Retour sur ${mainHost()}${min > 0 ? ` après ${min} min sur la porte de secours` : ''}${entered ? '' : ' · connexion à refaire'}`);
    setTimeout(() => toast(i18n.t('shell.door.backToast', { site: mainHost() }), 'ok', 3500), 900);
  }
}

/** Starts the backup door's work for this page (once, after the app is drawn). */
export function startDoor() {
  if (!LIVE) return;
  watchTyping();
  if (BACKUP_DOOR) wayBack();
  else void keepDoor();
}

// ---------------------------------------------------------------- a good moment to move (as lib/freshness)
let typed = false;
const isField = (t: EventTarget | null) => t instanceof HTMLElement && t.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
/** Something would be lost by leaving this page: a window open, a field in use, something typed on this page. */
export function busy(): boolean {
  if (typed) return true;
  if (document.querySelector('[aria-modal="true"], dialog[open]')) return true;
  return isField(document.activeElement);
}
function watchTyping() {
  document.addEventListener('input', (e) => isField(e.target) && (typed = true), true);
  document.addEventListener('change', (e) => isField(e.target) && (typed = true), true);
  window.addEventListener(ROUTE_EVENT, () => (typed = false));
}

// ---------------------------------------------------------------- the main address
const DOOR_OFF = 'door-off';

async function keepDoor() {
  let on = store.get(DOOR_OFF) !== '1';
  try {
    const r = await fetch(`${serverUrl()}/api/door`, { cache: 'no-store', credentials: 'omit' });
    const j = r.ok ? ((await r.json().catch(() => null)) as { on?: unknown } | null) : null;
    if (typeof j?.on === 'boolean') {
      on = j.on;
      store.set(DOOR_OFF, on ? null : '1');
    }
  } catch {
    /* no answer: the last choice known on this device */
  }
  void tellKeeper(on);
  if (on) window.addEventListener(NET_FAIL, () => void roadFailed());
}

/**
 * The door keeper (public/sw.js) is the browser's worker of the site, installed as « sw.js?door=1 » while the switch is
 * on; off, the plain « sw.js » (kept only where it already was, for the notifications) never touches a page.
 */
async function tellKeeper(on: boolean) {
  if (!('serviceWorker' in navigator)) return;
  try {
    if (on) await navigator.serviceWorker.register('/sw.js?door=1');
    else if (await navigator.serviceWorker.getRegistration('/')) await navigator.serviceWorker.register('/sw.js');
  } catch {
    /* no worker here (private mode, an old browser): the move inside the app still works */
  }
}

let checking = false;
let lastCheck = 0;
let stayUntil = 0;
/** A request got no answer: is the main road cut while the backup door answers? Then the move is offered (checked at most every 20 s). */
async function roadFailed() {
  const now = Date.now();
  if (checking || view.offer || now < stayUntil || now - lastCheck < 20_000) return;
  checking = true;
  lastCheck = now;
  try {
    const [main, direct] = await Promise.all([answers(mainOrigin(), 4000), answers(directOrigin(), 8000)]);
    if (!main && direct) set({ offer: busy() ? 'ask' : 'auto' });
  } finally {
    checking = false;
  }
}

/** « Rester ici »: not offered again for 10 minutes. */
export function stayHere() {
  stayUntil = Date.now() + 10 * 60_000;
  set({ offer: null });
}

let leaving = false;
/** To the backup door now, still logged in: the same page there. */
export async function moveToBackupDoor() {
  if (view.demo || leaving) return;
  leaving = true;
  const to = directOrigin();
  const ticket = await server.doorTicket(to);
  location.replace(`${to}${location.pathname}${location.search}#porte=${encodeURIComponent(ticket ?? '')}&par=app`);
}

// ---------------------------------------------------------------- the backup door: the way back
function wayBack() {
  let ok = 0;
  let lastTouch = Date.now();
  let hiddenAt = 0;
  const check = async () => {
    if (document.visibilityState !== 'visible' || leaving) return;
    const up = await answers(mainOrigin(), 6000);
    ok = up ? ok + 1 : 0;
    if (ok >= 2 !== view.mainBack) set({ mainBack: ok >= 2 });
  };
  setTimeout(() => void check(), 5_000);
  setInterval(() => void check(), 30_000);
  window.addEventListener('online', () => void check());
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) document.addEventListener(ev, () => (lastTouch = Date.now()), { capture: true, passive: true });
  // the page changed: nothing typed on the new one yet, the best moment
  window.addEventListener(ROUTE_EVENT, () => {
    if (view.mainBack && !document.querySelector('[aria-modal="true"], dialog[open]')) void goBack();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    if (view.mainBack && hiddenAt && Date.now() - hiddenAt >= 60_000 && !busy()) void goBack();
    else void check();
  });
  setInterval(() => {
    if (view.mainBack && document.visibilityState === 'visible' && Date.now() - lastTouch >= 2 * 60_000 && !busy()) void goBack();
  }, 30_000);
}

/** Back to the main address, still logged in: the same page there. */
export async function goBack() {
  if (view.demo || leaving) return;
  leaving = true;
  let min = 0;
  try {
    const since = Number(sessionStorage.getItem(SINCE) || 0);
    if (since) min = Math.max(1, Math.round((Date.now() - since) / 60_000));
  } catch {
    /* private mode */
  }
  const ticket = await server.doorTicket(location.origin);
  location.replace(`${mainOrigin()}${location.pathname}${location.search}#porte=${encodeURIComponent(ticket ?? '')}&par=retour${min ? `&min=${min}` : ''}`);
}

/** The preview (an « Essayer » link ending in « -porte »): the backup door's chip and message drawn, nothing moves. */
export function demoDoor() {
  set({ here: true, arrived: 'sw', mainBack: false, offer: null, demo: true });
}

// the preview only, from the console (pictures of each state): pxDoor('here' | 'back' | 'offer' | 'ask')
if (DEMO_ONLY && typeof window !== 'undefined')
  (window as unknown as { pxDoor?: (k: string) => void }).pxDoor = (k) => {
    if (k === 'offer' || k === 'ask') set({ here: false, arrived: null, mainBack: false, offer: k === 'offer' ? 'auto' : 'ask', demo: true });
    else set({ here: true, arrived: k === 'back' ? null : 'sw', mainBack: k === 'back', offer: null, demo: true });
  };
