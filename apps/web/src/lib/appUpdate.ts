// The Pilotix phone app (mobile/) updating itself. When GitHub has made a newer app than the one on this phone, signed
// with Pilotix's fixed key so it can replace it, the page offers « Nouvelle version de l'app »; from the build the
// control room made « obligatoire » it asks for it before anything else. The app downloads it and Android asks
// « Mettre à jour cette application ? » (one tap): mobile/android/…/AppUpdatePlugin.java. An app made before the
// updater existed can't replace itself: it shows how to install the new app once, by hand.
// (The website itself needs none of this: it moves to each new version by itself, lib/freshness.)
import { AppInfo, appUpdateNeed, LatestApp } from '@pilotix/shared';
import { atLocalMidnight } from './midnight';
import i18n from './i18n';
import { appInfo } from './backend';
import { store } from './store';
import { toast } from '../ui/toast';

type Cap = { PluginHeaders?: { name: string }[]; nativePromise?: (plugin: string, method: string, options?: object) => Promise<unknown> };
const cap = () => (window as unknown as { Capacitor?: Cap }).Capacitor;
/** Inside the Pilotix phone app: its pages carry « PilotixApp » in their user agent (mobile/capacitor.config.json). */
export const inApp = () => /\bPilotixApp\b/.test(navigator.userAgent);
/** The app on this phone has the updater (apps made from now on). */
const hasUpdater = () => !!cap()?.PluginHeaders?.some((h) => h.name === 'AppUpdate') && !!cap()?.nativePromise;
const native = <T>(method: string, options: object = {}) => cap()!.nativePromise!('AppUpdate', method, options) as Promise<T>;

export type Phase = 'ask' | 'allow' | 'download' | 'failed';
export interface AppUpdateState {
  need: 'offer' | 'required';
  /** an app without the updater: the new one is installed by hand, once */
  old: boolean;
  latest: LatestApp;
  phase: Phase;
  loaded: number;
  total: number;
}

let state: AppUpdateState | null = null;
const subs = new Set<(s: AppUpdateState | null) => void>();
const show = (s: AppUpdateState | null) => {
  state = s;
  subs.forEach((f) => f(s));
};
export function subscribeAppUpdate(f: (s: AppUpdateState | null) => void) {
  subs.add(f);
  f(state);
  return () => void subs.delete(f);
}

/** « Plus tard »: the same version is offered again 6 hours later (a required one never waits). */
const LATER = 'appLater';
const postponed = (build: number) => {
  try {
    const v = JSON.parse(store.get(LATER) || 'null') as { build: number; until: number } | null;
    return !!v && v.build === build && v.until > Date.now();
  } catch {
    return false;
  }
};
export function postpone() {
  if (!state || state.need === 'required' || state.phase === 'download') return;
  store.set(LATER, JSON.stringify({ build: state.latest.build, until: Date.now() + 6 * 3600_000 }));
  show(null);
}

let lastCheck = 0;
let checking = false;
async function check() {
  if (checking || (state && state.phase !== 'ask')) return;
  checking = true;
  lastCheck = Date.now();
  try {
    let info: AppInfo;
    try {
      info = await appInfo();
    } catch {
      return; // the server out of reach: asked again later
    }
    const updater = hasUpdater();
    const installed = updater ? Number((await native<{ build: number }>('info')).build) || 0 : 0;
    if (updater) {
      // just updated by Android: say so once (the app restarted in its new version)
      const seen = Number(store.get('appBuild')) || 0;
      if (seen && installed > seen) setTimeout(() => toast(i18n.t('common.appUpdate.done', { build: installed }), 'ok', 4000), 1500);
      store.set('appBuild', String(installed));
    }
    const need = appUpdateNeed(installed, info);
    if (need === 'none' || (need === 'offer' && postponed(info.latest!.build))) {
      if (state?.phase === 'ask') show(null);
      return;
    }
    show({ need, old: !updater || installed < 24, latest: info.latest!, phase: 'ask', loaded: 0, total: info.latest!.size });
  } catch {
    /* the app did not answer: nothing offered */
  } finally {
    checking = false;
  }
}

/** « Mettre à jour »: download it in the app, then Android asks (an old app: the phone's browser downloads it). */
export async function runAppUpdate() {
  const s = state;
  if (!s || s.phase === 'download') return;
  if (s.old) {
    window.open(s.latest.url, '_blank');
    return;
  }
  try {
    const { allowed } = await native<{ allowed: boolean }>('canInstall');
    if (!allowed) {
      show({ ...s, phase: 'allow' });
      return;
    }
    show({ ...s, phase: 'download', loaded: 0 });
    const poll = setInterval(() => {
      void native<{ loaded: number; total: number }>('progress')
        .then((p) => state && state.phase === 'download' && show({ ...state, loaded: p.loaded, total: p.total > 0 ? p.total : state.total }))
        .catch(() => undefined);
    }, 400);
    try {
      await native('install', { url: s.latest.url });
    } finally {
      clearInterval(poll);
    }
    // Android's « Mettre à jour ? » is on screen: confirmed, the app restarts in its new version; cancelled, the offer stays
    show({ ...s, phase: 'ask' });
  } catch {
    show({ ...s, phase: 'failed' });
  }
}

/** Android asks once to let Pilotix install its updates: its settings screen, then back here, and on. */
export async function allowAppInstalls() {
  const back = () => {
    if (document.visibilityState !== 'visible') return;
    document.removeEventListener('visibilitychange', back);
    void runAppUpdate();
  };
  document.addEventListener('visibilitychange', back);
  await native('openInstallSettings').catch(() => undefined);
}

export function startAppUpdates() {
  if (!inApp()) return;
  atLocalMidnight(() => void check());
  setTimeout(() => void check(), 8000);
  // back on screen after a while, and every few hours: a newer app, or one made obligatoire meanwhile
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastCheck > 30 * 60_000) void check();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible' && Date.now() - lastCheck >= 5 * 60_000) void check();
  }, 5 * 60_000);
}
