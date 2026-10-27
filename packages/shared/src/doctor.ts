// The Doctor: checks that warn before a problem grows.
//   - Pilotix Doctor (each shop, Dashboard › Doctor): the shop's business — stock, orders waiting, returns, agents, cash.
//   - Doctor (Pilotix's control room): the server, the database, background jobs, errors in the code, silent shops.
// Both answer with the same items; the app writes the sentences (doctor.c.<id> in the locales).

/** bad = act today · warn = look soon · ok = checked, fine · info = nothing to judge yet */
export type DoctorLevel = 'bad' | 'warn' | 'ok' | 'info';

export interface DoctorLine {
  label: string;
  /** a wilaya: the app writes its name */
  wilaya?: number;
  n: number;
  /** text = no number shown */
  unit: 'n' | 'pct' | 'days' | 'hours' | 'min' | 'da' | 'ms' | 'mb' | 'text';
}

export interface DoctorItem {
  /** the check (its sentences: doctor.c.<id>.title / .fix) */
  id: string;
  level: DoctorLevel;
  /** the part of the shop / of the system it is about (groups and icons) */
  area: string;
  /** numbers for the sentence */
  params?: Record<string, string | number>;
  /** the worst cases (products, wilayas, agents, errors…) */
  list?: DoctorLine[];
  /** where to fix it */
  href?: string;
}

export interface ShopDoctorReport {
  checkedAt: string;
  /** 0–100: 100 = nothing to worry about */
  score: number;
  items: DoctorItem[];
  /** whose work it looks at: the whole shop (admin / vendeur), or this person's own orders / parcels (an agent) */
  scope?: { whole: boolean; mine: boolean };
}

export interface DoctorJob {
  name: string;
  /** expected time between runs (ms) */
  every: number;
  state: 'ok' | 'late' | 'failing' | 'waiting' | 'off';
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  runs: number;
  fails: number;
}

export interface DoctorError {
  /** last time seen */
  at: string;
  level: 'error' | 'warn';
  /** the part of the server that wrote it (Jobs, Courier sync, ExceptionsHandler…) */
  source: string;
  shop: string | null;
  message: string;
  /** times seen in the last 24 h */
  count: number;
}

export interface ServerDoctorReport {
  checkedAt: string;
  score: number;
  items: DoctorItem[];
  /** 0–1 (null: unknown) */
  gauges: { cpu: number | null; memory: number | null; disk: number | null; dbConnections: number | null };
  facts: {
    serverUptimeS: number;
    appUptimeS: number;
    node: string;
    version: string;
    cores: number;
    memoryTotalMb: number;
    diskTotalMb: number | null;
    dbSizeMb: number | null;
    dbPingMs: number | null;
    shops: number;
  };
  jobs: DoctorJob[];
  errors: DoctorError[];
  /** Cloudflare Turnstile kept by Pilotix for every shop: how full the free plan is */
  turnstile?: DoctorTurnstile;
}

export interface DoctorTurnstile {
  configured: boolean;
  /** shortened (the token never leaves the server) */
  accountId: string | null;
  widgets: { sitekey: string; name: string; domains: string[] }[];
  domains: number;
  maxDomains: number;
  maxWidgets: number;
  perWidget: number;
  /** domains with no place left (every widget full) */
  waiting: string[];
  lastSyncAt: string | null;
  lastError: string | null;
}

/** 100 minus 15 per "bad" and 5 per "warn" (never below 5). */
export function doctorScore(items: readonly DoctorItem[]): number {
  let s = 100;
  for (const i of items) s -= i.level === 'bad' ? 15 : i.level === 'warn' ? 5 : 0;
  return Math.max(5, s);
}

/** Worst first (bad, warn, info, ok), the order of the checks kept inside each level. */
export function doctorSort(items: DoctorItem[]): DoctorItem[] {
  const rank: Record<DoctorLevel, number> = { bad: 0, warn: 1, info: 2, ok: 3 };
  return items.map((x, i) => [x, i] as const).sort((a, b) => rank[a[0].level] - rank[b[0].level] || a[1] - b[1]).map(([x]) => x);
}
