// Control room › Doctor › Coupures (owner's ask, 27 Nov 2026): every cut a screen saw, with where the road was cut.
// The screen sends what still answered from it (web lib/roads, shared/roads); this adds the person's internet company
// (from the network of the address the report came from: never the address itself) and keeps the last 14 days in
// platform.settings, so a restart of the server keeps them.
import { DoctorCut, ispName, roadVerdict, RoadTest } from '@pilotix/shared';
import type { CoreService } from './core.service';

const KEY = 'doctor:cuts';
const KEEP_MS = 14 * 24 * 3_600_000;
const MAX = 300;
const ISP_CACHE_MS = 24 * 3_600_000;

/**
 * The network an address belongs to, without the address itself: a.b.c.0 for IPv4, the first three groups (/48) for
 * IPv6. null for a private or unreadable address (the server's own network, a test).
 */
export function networkOf(ip: string | null | undefined): string | null {
  const a = String(ip ?? '').trim().replace(/^::ffff:/i, '');
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (v4) {
    const [p, q] = [Number(v4[1]), Number(v4[2])];
    if (p === 10 || p === 127 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || p === 0) return null;
    return `${v4[1]}.${v4[2]}.${v4[3]}.0`;
  }
  if (!a.includes(':') || /^(::1|f[cd]|fe8)/i.test(a)) return null;
  const parts = a.split('::')[0].split(':').filter(Boolean);
  if (parts.length < 3) return null;
  return `${parts.slice(0, 3).join(':')}::/48`;
}

const isps = new Map<string, { name: string | null; at: number }>();

/**
 * The internet company of a network (RIPEstat, the internet registries' public data: the network that announces it and
 * its holder's name), kept a day per network. null when unknown or when RIPEstat does not answer within 4 s.
 */
export async function ispOf(ip: string | null | undefined, fetcher: typeof fetch = fetch): Promise<string | null> {
  const net = networkOf(ip);
  if (!net) return null;
  const known = isps.get(net);
  if (known && Date.now() - known.at < ISP_CACHE_MS) return known.name;
  let name: string | null = null;
  try {
    const r = await fetcher(`https://stat.ripe.net/data/prefix-overview/data.json?resource=${encodeURIComponent(net)}&sourceapp=pilotix`, { signal: AbortSignal.timeout(4_000) });
    if (r.ok) {
      const j = (await r.json()) as { data?: { asns?: { asn?: number; holder?: string }[] } };
      name = ispName(j.data?.asns?.[0]?.holder ?? null);
    }
  } catch {
    /* RIPEstat did not answer: unknown this time, asked again at the next cut */
    return null;
  }
  if (isps.size > 2_000) isps.clear();
  isps.set(net, { name, at: Date.now() });
  return name;
}

/** The cuts kept (newest first). */
export async function listCuts(core: CoreService, now = Date.now()): Promise<DoctorCut[]> {
  const row = (await core.t.platform.query(`SELECT value FROM platform.settings WHERE key = $1`, [KEY]).catch(() => []))[0];
  const all = Array.isArray(row?.value) ? (row.value as DoctorCut[]) : [];
  return all.filter((c) => c && typeof c.at === 'string' && now - Date.parse(c.at) < KEEP_MS);
}

export interface CutSeen {
  start: number;
  end: number | null;
  shop: string | null;
  device: 'phone' | 'computer';
  page: string;
  roads: RoadTest | null;
  via: 'cut' | 'door';
}

/** A screen's times are trusted within the last day only (a wrong clock on a phone must not hide a cut). */
function when(ms: number | null, now: number): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  return new Date(Math.min(now, Math.max(now - 24 * 3_600_000, ms))).toISOString();
}

/** One cut from a screen, with its internet company and verdict, kept with the others. */
export async function recordCut(core: CoreService, seen: CutSeen, ip: string | null | undefined, now = Date.now()): Promise<DoctorCut> {
  const roads: RoadTest = seen.roads ?? { edge: null, cf: null, direct: null, net: null, app: null };
  const cut: DoctorCut = {
    at: when(seen.start, now) ?? new Date(now).toISOString(),
    endAt: when(seen.end, now),
    shop: seen.shop,
    isp: await ispOf(ip).catch(() => null),
    device: seen.device,
    page: seen.page,
    roads,
    verdict: roadVerdict(roads),
    via: seen.via,
  };
  const all = [cut, ...(await listCuts(core, now))].sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX);
  await core.t.platform.query(
    `INSERT INTO platform.settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [KEY, JSON.stringify(all)],
  );
  return cut;
}

/** Tests only. */
export const _cuts = { isps };
