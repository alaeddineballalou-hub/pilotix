// Where the road is cut (owner's ask, 27 Nov 2026). When Pilotix stops answering on someone's screen in Algeria, the
// screen itself tests each road at that moment (web lib/roads) and the server adds the person's internet company, so
// every cut in Control room › Doctor says where it happened: on the device, at the internet company, at Cloudflare, or
// at the server. Cloudflare's own records cannot show the first two: those requests never reach Cloudflare.

/** What answered from the screen, at the moment of the cut (null: not tested). */
export interface RoadTest {
  /** Pilotix's own Cloudflare addresses (https://<site>/cdn-cgi/trace: Cloudflare alone answers it, never the server) */
  edge: boolean | null;
  /** Cloudflare in general (https://www.cloudflare.com/cdn-cgi/trace) */
  cf: boolean | null;
  /** the server without Cloudflare: the backup door (https://direct.<site>/api/health) */
  direct: boolean | null;
  /** plain internet: a site that is not on Cloudflare */
  net: boolean | null;
  /** Pilotix through Cloudflare up to the server (https://<site>/api/health) */
  app: boolean | null;
}

export const ROAD_KEYS = ['edge', 'cf', 'direct', 'net', 'app'] as const;
export type RoadKey = (typeof ROAD_KEYS)[number];

/**
 * - offline: nothing answered at all, the device had no internet
 * - isp_cloudflare: internet and the backup door answered, nothing on Cloudflare did: the internet company blocks Cloudflare
 * - isp_pilotix: Cloudflare answered, only Pilotix's own Cloudflare addresses did not: blocked for Pilotix only
 * - server: Cloudflare answered for Pilotix but the server did not, even without Cloudflare
 * - cf_to_server: the screen reached Cloudflare and the server, Cloudflare could not reach the server
 * - international: only plain internet answered (Cloudflare and the server both cut): the roads abroad
 * - both: Pilotix's Cloudflare addresses and the backup door cut, the rest fine
 * - ok: everything answered: the cut was over before the test
 * - unknown: not enough answers to say
 */
export const ROAD_VERDICTS = ['offline', 'isp_cloudflare', 'isp_pilotix', 'server', 'cf_to_server', 'international', 'both', 'ok', 'unknown'] as const;
export type RoadVerdict = (typeof ROAD_VERDICTS)[number];

/** Where the road was cut, from what answered. */
export function roadVerdict(r: RoadTest): RoadVerdict {
  const { edge, cf, direct, net, app } = r;
  if (edge === false && cf === false && direct === false && net === false) return 'offline';
  if (edge === true && direct === false) return 'server';
  if (edge === true && direct === true) return app === false ? 'cf_to_server' : 'ok';
  if (edge === false && direct === true) return cf === false ? 'isp_cloudflare' : cf === true ? 'isp_pilotix' : 'unknown';
  if (edge === false && direct === false) {
    if (cf === false && net === true) return 'international';
    if (cf === true) return 'both';
  }
  return 'unknown';
}

/** Bad (red), warn (orange) or neutral (grey): the colour of the verdict in Doctor. */
export function roadTone(v: RoadVerdict): 'bad' | 'warn' | 'off' {
  if (v === 'isp_cloudflare' || v === 'server' || v === 'cf_to_server' || v === 'international') return 'bad';
  if (v === 'isp_pilotix' || v === 'both') return 'warn';
  return 'off';
}

/** The test in five letters for the backup door's address (#porte=…&rt=oxoon): o answered, x did not, n not tested. */
export function roadCode(r: RoadTest): string {
  return ROAD_KEYS.map((k) => (r[k] === true ? 'o' : r[k] === false ? 'x' : 'n')).join('');
}

export function parseRoadCode(s: string | null | undefined): RoadTest | null {
  if (!s || !/^[oxn]{5}$/.test(s)) return null;
  const out = {} as RoadTest;
  ROAD_KEYS.forEach((k, i) => (out[k] = s[i] === 'o' ? true : s[i] === 'x' ? false : null));
  return out;
}

/** The internet company's usual name from its network's holder (RIPEstat « holder »: « ALGTEL-AS, DZ »…). */
export function ispName(holder: string | null | undefined): string | null {
  const h = (holder ?? '').trim();
  if (!h) return null;
  // Mobilis first: its company is « Algérie Télécom Mobile » (ATM)
  if (/MOBILIS|\bATM\b|T[EÉ]L[EÉ]COM[\s_-]*MOBILE/i.test(h)) return 'Mobilis';
  if (/ALGTEL|ALG[EÉ]RIE[\s_-]*T[EÉ]L[EÉ]COM/i.test(h)) return 'Algérie Télécom';
  if (/DJEZZY|\bOTA\b|ORASCOM|OPTIMUM/i.test(h)) return 'Djezzy';
  if (/OOREDOO|WATANIYA|NEDJMA|\bWTA\b/i.test(h)) return 'Ooredoo';
  return h.split(',')[0].trim().slice(0, 40) || null;
}

/** A cut as Control room › Doctor lists it (newest first, the last 14 days). */
export interface DoctorCut {
  /** when the cut started on the screen (or when the person was moved to the backup door) */
  at: string;
  /** when it ended (null: the person was moved to the backup door, the end is not known) */
  endAt: string | null;
  shop: string | null;
  /** the person's internet company (null: unknown) */
  isp: string | null;
  device: 'phone' | 'computer';
  page: string;
  roads: RoadTest;
  verdict: RoadVerdict;
  /** cut = it ended on the same page · door = the person was moved to the backup door */
  via: 'cut' | 'door';
}
