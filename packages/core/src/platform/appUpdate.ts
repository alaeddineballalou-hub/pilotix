// The Pilotix phone app's latest version, read from its version card on GitHub (mobile.yml writes app-version.json
// next to the app on its download page). Kept 5 minutes: a whole team of phones asking costs GitHub one read. A failure
// is kept 1 minute (GitHub out of reach: no new app offered meanwhile, nothing breaks).
import { APP_RELEASE_URL, LatestApp, parseAppCard } from '@pilotix/shared';

let kept: { at: number; ttl: number; v: LatestApp | null } | null = null;

export async function latestApp(now = Date.now(), read: typeof fetch = fetch): Promise<LatestApp | null> {
  if (kept && now - kept.at < kept.ttl) return kept.v;
  let v: LatestApp | null = null;
  try {
    const r = await read(`${APP_RELEASE_URL}/app-version.json`, { signal: AbortSignal.timeout(8000), redirect: 'follow' });
    if (r.ok) v = parseAppCard(await r.json());
  } catch {
    /* GitHub out of reach (or a browser preview without the right to read it) */
  }
  kept = { at: now, ttl: v ? 5 * 60_000 : 60_000, v };
  return v;
}

/** Tests: forget the kept card. */
export function forgetLatestApp() {
  kept = null;
}

/** Tests: a card as if just read from GitHub. */
export function keepLatestApp(v: LatestApp | null, at = Date.now()) {
  kept = { at, ttl: 5 * 60_000, v };
}
