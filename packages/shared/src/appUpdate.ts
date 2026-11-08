// The Pilotix phone app (mobile/) updating itself. GitHub builds a new app each time the app's own code changes
// (.github/workflows/mobile.yml) and puts it on one download page with its version card, app-version.json. The server
// reads that card (core platform/appUpdate) and tells the app's pages; the page offers « Nouvelle version de l'app »,
// and from the build the control room made « obligatoire » it asks for it before anything else.

/** The app's download page on GitHub: the app (pilotix-test.apk) and its version card (app-version.json). */
export const APP_RELEASE_URL = 'https://github.com/alaeddineballalou-hub/pilotix/releases/download/app-test';

/**
 * The latest app, as its version card says: GitHub's build number (the app's version code on Android), the commit, when
 * it was made, its size in bytes, and whether it is signed with Pilotix's fixed key (only then can it install over the
 * app already on a phone; before, Android refuses and the old app must be removed first).
 */
export interface LatestApp {
  build: number;
  sha: string;
  date: string;
  size: number;
  fixedKey: boolean;
  url: string;
}

/** What the server tells the app's pages: the latest app (null: not known right now) and the oldest build still allowed (0: none required). */
export interface AppInfo {
  latest: LatestApp | null;
  minBuild: number;
}

/** The version card read safely (anything else: null). */
export function parseAppCard(card: unknown): LatestApp | null {
  const c = card as Partial<Record<keyof LatestApp, unknown>> | null;
  const build = Number(c?.build);
  if (!c || !Number.isInteger(build) || build < 1) return null;
  return {
    build,
    sha: typeof c.sha === 'string' ? c.sha.slice(0, 12) : '',
    date: typeof c.date === 'string' ? c.date.slice(0, 40) : '',
    size: Math.max(0, Math.round(Number(c.size) || 0)),
    fixedKey: c.fixedKey === true,
    url: `${APP_RELEASE_URL}/pilotix-test.apk`,
  };
}

/** What a phone's app should show: nothing, an offer (« Plus tard » allowed), or a required update. */
export function appUpdateNeed(installed: number, info: AppInfo | null): 'none' | 'offer' | 'required' {
  const latest = info?.latest;
  // only an app with the fixed key can replace the one on the phone
  if (!latest || !latest.fixedKey || latest.build <= installed) return 'none';
  const min = info?.minBuild ?? 0;
  return min > installed && latest.build >= min ? 'required' : 'offer';
}
