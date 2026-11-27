// The road test (owner's ask, 27 Nov 2026; shared/roads): when Pilotix stops answering on this screen, which roads
// still answer from here, at that moment — Pilotix's own Cloudflare addresses, Cloudflare in general, the backup door
// (the server without Cloudflare), plain internet, and Pilotix through Cloudflare up to the server. It goes with the cut
// to Control room › Doctor (lib/watch), where the server adds the internet company. Only on the live site (lib/door
// starts it); one test at a time, a result reused for 30 s (every failed request asks for it).
import type { RoadTest } from '@pilotix/shared';

const WAIT_MS = 6_000;
const REUSE_MS = 30_000;
/** Cloudflare's own site: Cloudflare in general */
const CLOUDFLARE = 'https://www.cloudflare.com/cdn-cgi/trace';
/** plain internet: Google's « no content » page, the one phones use to check they are online (not on Cloudflare) */
const INTERNET = 'https://www.google.com/generate_204';

const fresh = (url: string) => `${url}${url.includes('?') ? '&' : '?'}road=${Date.now()}`;

/** Did anything answer at this address in time? Another site's answer cannot be read here: arriving is enough. */
async function arrives(url: string, ms = WAIT_MS): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    await fetch(fresh(url), { cache: 'no-store', credentials: 'omit', mode: 'no-cors', signal: ac.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Does this address's server say it is well in time? (its own answer: Cloudflare's error pages do not count) */
export async function serverAnswers(origin: string, ms: number): Promise<boolean> {
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

let last: { at: number; roads: RoadTest } | null = null;
let running: Promise<RoadTest> | null = null;

/**
 * Every road from this screen, tested together (about 8 s at most). `main`: https://pilotix.online, `direct`: its
 * backup door. The main address gets 4 s and the backup door 8 s, as the backup door's own check always had.
 * `fresh`: a new test even when one of the last 30 s is kept (a test already running is still shared).
 */
export function testRoads(main: string, direct: string, opts: { fresh?: boolean } = {}): Promise<RoadTest> {
  if (running) return running;
  if (!opts.fresh && last && Date.now() - last.at < REUSE_MS) return Promise.resolve(last.roads);
  const none = Promise.resolve(null);
  running = Promise.all([
    main ? arrives(`${main}/cdn-cgi/trace`) : none,
    arrives(CLOUDFLARE),
    direct ? serverAnswers(direct, 8_000) : none,
    arrives(INTERNET),
    main ? serverAnswers(main, 4_000) : none,
  ])
    .then(([edge, cf, directOk, net, app]) => {
      const roads: RoadTest = { edge, cf, direct: directOk, net, app };
      last = { at: Date.now(), roads };
      return roads;
    })
    .finally(() => {
      running = null;
    });
  return running;
}

/** Tests only. */
export const _roads = { reset: () => ((last = null), (running = null)) };
