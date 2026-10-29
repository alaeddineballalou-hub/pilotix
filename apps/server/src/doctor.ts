// Doctor (control room, Pilotix staff): the health of the server that runs every shop.
//   - the machine: processor, memory, disk
//   - the database: answer time, size, connections, queries stuck
//   - Redis and the background jobs (courier sync, Dellal, landing pages…): late, failing
//   - the code: every error / warning the server writes is kept here (24 h, grouped), so a repeating bug shows
//   - the shops: one that received orders every day and suddenly none (its website link may be broken)
//   - the settings: e-mail, public address, production mode
// What it keeps lives in memory: a restart starts from zero (the page says so).
import { ConsoleLogger } from '@nestjs/common';
import { DoctorAction, DoctorError, DoctorMuted, DoctorItem, DoctorJob, DoctorLine, doctorScore, doctorSort, ServerDoctorReport } from '@pilotix/shared';
import IORedis from 'ioredis';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { config } from './config';
import type { CoreService } from './core.service';
import { turnstileStatus } from './turnstile';

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

/** The background jobs and how often each one should run (jobs.ts). */
export const JOB_EVERY: Record<string, number> = {
  'courier-sync': 30 * MIN,
  'sheets-sync': 2 * MIN,
  'notify-run': MIN,
  'landing-run': MIN,
  'cm-sweep': 3 * MIN,
  'dellal-followups': 15 * MIN,
  'spy-scan': H,
  'meta-sync': D,
  'demo-reset': D,
  'platform-reminders': D,
  'courier-watch': D,
  'turnstile-sync': 30 * MIN,
};

interface Seen {
  level: 'error' | 'warn';
  source: string;
  shop: string | null;
  message: string;
  times: number[];
}

interface JobSeen {
  runs: number;
  fails: number;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
}

export class DoctorState {
  readonly startedAt = Date.now();
  private seen = new Map<string, Seen>();
  private jobs = new Map<string, JobSeen>();

  /** One line the server wrote (error / warning). Numbers are blurred so the same bug groups together. */
  record(level: 'error' | 'warn', source: string, raw: unknown) {
    let text = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (!text) return;
    let shop: string | null = null;
    const m = /^\[([a-z0-9-]{1,60})\]\s*/i.exec(text);
    if (m) {
      shop = m[1];
      text = text.slice(m[0].length);
    }
    text = text.slice(0, 400);
    const key = `${level}|${source}|${shop ?? ''}|${text.replace(/\d+/g, '#').slice(0, 160)}`;
    const now = Date.now();
    let s = this.seen.get(key);
    if (!s) {
      if (this.seen.size >= 400) this.prune(now, true);
      s = { level, source, shop, message: text, times: [] };
      this.seen.set(key, s);
    }
    s.message = text;
    s.times.push(now);
    if (s.times.length > 500) s.times.splice(0, s.times.length - 500);
  }

  /** Forget what is older than 24 h (and, when full, the oldest groups). */
  private prune(now: number, full = false) {
    for (const [k, s] of this.seen) {
      s.times = s.times.filter((t) => now - t < D);
      if (!s.times.length) this.seen.delete(k);
    }
    if (full && this.seen.size >= 400) {
      const old = [...this.seen.entries()].sort((a, b) => a[1].times[a[1].times.length - 1] - b[1].times[b[1].times.length - 1]).slice(0, 100);
      for (const [k] of old) this.seen.delete(k);
    }
  }

  errors(now = Date.now()): DoctorError[] {
    this.prune(now);
    return [...this.seen.values()]
      .map((s) => ({ at: new Date(s.times[s.times.length - 1]).toISOString(), level: s.level, source: s.source, shop: s.shop, message: s.message, count: s.times.length }))
      .sort((a, b) => (a.level === b.level ? b.at.localeCompare(a.at) : a.level === 'error' ? -1 : 1));
  }

  inLast(ms: number, level: 'error' | 'warn', now = Date.now()) {
    let n = 0;
    for (const s of this.seen.values()) if (s.level === level) n += s.times.filter((t) => now - t < ms).length;
    return n;
  }

  /** « Résolu » on the errors: forget what was written (all of it, or the lines that match). */
  clear(match?: (s: { level: 'error' | 'warn'; source: string; shop: string | null; message: string }) => boolean) {
    for (const [k, s] of this.seen) if (!match || match(s)) this.seen.delete(k);
  }

  /** « Résolu » on the jobs: start counting again from now (each job waits for its next run). */
  resetJobs() {
    this.jobs.clear();
    this.jobsSince = Date.now();
  }
  private jobsSince = Date.now();

  job(name: string, ok: boolean, error?: string) {
    const j = this.jobs.get(name) ?? { runs: 0, fails: 0, lastOkAt: null, lastErrorAt: null, lastError: null };
    j.runs++;
    if (ok) j.lastOkAt = Date.now();
    else {
      j.fails++;
      j.lastErrorAt = Date.now();
      j.lastError = (error ?? '').slice(0, 300);
    }
    this.jobs.set(name, j);
  }

  jobList(now = Date.now()): DoctorJob[] {
    const up = now - Math.max(this.startedAt, this.jobsSince);
    return Object.entries(JOB_EVERY).map(([name, every]) => {
      const j = this.jobs.get(name);
      let state: DoctorJob['state'];
      if (!config.redisUrl) state = 'off';
      else if (j?.lastErrorAt && (!j.lastOkAt || j.lastErrorAt >= j.lastOkAt)) state = 'failing';
      else if (j?.lastOkAt) state = now - j.lastOkAt > 3 * every + 2 * MIN ? 'late' : 'ok';
      else state = up > 3 * every + 2 * MIN ? 'late' : 'waiting';
      const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString() : null);
      return { name, every, state, lastOkAt: iso(j?.lastOkAt), lastErrorAt: iso(j?.lastErrorAt), lastError: j?.lastError ?? null, runs: j?.runs ?? 0, fails: j?.fails ?? 0 };
    });
  }
}

export const doctorState = new DoctorState();

/** Nest's logger, writing as before, and also telling the Doctor every error and warning. */
export class DoctorLogger extends ConsoleLogger {
  private ctxOf(rest: unknown[]) {
    const last = rest[rest.length - 1];
    return typeof last === 'string' && last.length < 60 && !last.includes('\n') ? last : this.context || 'Pilotix';
  }
  error(message: any, ...rest: any[]) {
    super.error(message, ...rest);
    try {
      doctorState.record('error', this.ctxOf(rest), message);
    } catch {
      /* the Doctor never breaks the log */
    }
  }
  warn(message: any, ...rest: any[]) {
    super.warn(message, ...rest);
    try {
      doctorState.record('warn', this.ctxOf(rest), message);
    } catch {
      /* idem */
    }
  }
}

/** Errors that escape everything (they would otherwise only be in the console). */
export function watchProcess() {
  process.on('unhandledRejection', (e) => doctorState.record('error', 'Process (promise)', e));
  process.on('uncaughtExceptionMonitor', (e) => doctorState.record('error', 'Process', e));
}

// ---------------------------------------------------------------- measures
function memoryUsed(): number {
  try {
    // MemAvailable counts the cache the system gives back: free memory alone looks too low on Linux
    const t = fs.readFileSync('/proc/meminfo', 'utf8');
    const total = Number(/MemTotal:\s+(\d+)/.exec(t)?.[1]);
    const avail = Number(/MemAvailable:\s+(\d+)/.exec(t)?.[1]);
    if (total > 0 && avail >= 0) return 1 - avail / total;
  } catch {
    /* not Linux */
  }
  return 1 - os.freemem() / os.totalmem();
}

function disk(): { used: number; totalMb: number } | null {
  try {
    const s = fs.statfsSync('/');
    if (!s.blocks) return null;
    return { used: 1 - s.bavail / s.blocks, totalMb: Math.round((s.blocks * s.bsize) / 1048576) };
  } catch {
    return null;
  }
}

async function redisPing(): Promise<number | null> {
  if (!config.redisUrl) return null;
  const r = new IORedis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 2500, retryStrategy: () => null });
  r.on('error', () => {});
  const t = Date.now();
  try {
    await r.connect();
    await Promise.race([r.ping(), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 2500))]);
    return Date.now() - t;
  } catch {
    return -1;
  } finally {
    r.disconnect();
  }
}

// ---------------------------------------------------------------- « Résolu » / « Ignorer » (owner and managers)
/** The alerts no page of Pilotix can fix, and what the owner may do with each. */
export const DISMISSABLE: Record<string, DoctorAction[]> = {
  restarted: ['solve'],
  errors: ['solve', 'ignore'],
  courierSync: ['solve', 'ignore'],
  jobs: ['solve', 'ignore'],
  dbSlow: ['solve'],
  dbPoolFull: ['solve'],
  silentShops: ['solve', 'ignore'],
  config: ['ignore'],
  redisOff: ['ignore'],
};
const DISMISS_KEY = 'doctor_dismissed';
const IGNORE_DAYS = 7;
interface Dismissed {
  kind: DoctorAction;
  at: string;
  by: string;
  /** solve: hidden while the alert stays the same (its level and numbers) */
  sig?: string;
  /** ignore: hidden until */
  until?: string;
}
const sigOf = (i: DoctorItem) => (i.id === 'restarted' ? `start:${doctorState.startedAt}` : JSON.stringify([i.level, i.params ?? {}, (i.list ?? []).map((l) => l.label)]));

async function readDismissed(core: CoreService): Promise<Record<string, Dismissed>> {
  const r = (await core.t.platform.query(`SELECT value FROM platform.settings WHERE key = $1`, [DISMISS_KEY]))[0];
  const v = r?.value;
  return v && typeof v === 'object' ? (v as Record<string, Dismissed>) : {};
}
async function writeDismissed(core: CoreService, v: Record<string, Dismissed>) {
  await core.t.platform.query(
    `INSERT INTO platform.settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [DISMISS_KEY, JSON.stringify(v)],
  );
}

/**
 * « Résolu »: the errors are forgotten (they come back if they happen again), the jobs are counted again from now, the
 * other alerts are hidden while they stay the same. « Ignorer »: hidden 7 days. « Ré-afficher »: shown again.
 */
export async function dismissDoctor(core: CoreService, id: string, kind: DoctorAction | 'restore', by: string) {
  const allowed = DISMISSABLE[id];
  if (!allowed) throw new Error('Cette alerte ne peut pas être cachée : elle se règle dans Pilotix');
  const all = await readDismissed(core);
  if (kind === 'restore') delete all[id];
  else {
    if (!allowed.includes(kind)) throw new Error('Action impossible pour cette alerte');
    const now = Date.now();
    if (kind === 'ignore') all[id] = { kind, at: new Date(now).toISOString(), by, until: new Date(now + IGNORE_DAYS * D).toISOString() };
    else if (id === 'errors') {
      doctorState.clear();
      delete all[id];
    } else if (id === 'courierSync') {
      doctorState.clear((s) => /courier/i.test(s.source));
      delete all[id];
    } else if (id === 'jobs') {
      doctorState.resetJobs();
      delete all[id];
    } else {
      // hidden while it stays the same: the report that is shown right now gives its signature
      const cur = (await serverDoctor(core, { raw: true })).items.find((i) => i.id === id);
      if (!cur) return;
      all[id] = { kind, at: new Date(now).toISOString(), by, sig: sigOf(cur) };
    }
  }
  await writeDismissed(core, all);
}

const lv = (v: number | null, warn: number, bad: number): DoctorItem['level'] => (v === null ? 'info' : v >= bad ? 'bad' : v >= warn ? 'warn' : 'ok');
const pct = (x: number) => Math.round(x * 1000) / 10;

/** The whole check (a few hundred milliseconds: one small query per shop). */
export async function serverDoctor(core: CoreService, opts: { raw?: boolean } = {}): Promise<ServerDoctorReport> {
  const now = Date.now();
  const items: DoctorItem[] = [];
  const cores = os.cpus().length || 1;

  // ------------------------------------------------------------ the machine
  const cpu = Math.min(1, os.loadavg()[1] / cores); // 5-minute average
  items.push({ id: 'cpu', level: lv(cpu, 0.75, 0.95), area: 'server', params: { pct: pct(cpu), cores } });
  const mem = memoryUsed();
  items.push({ id: 'memory', level: lv(mem, 0.8, 0.92), area: 'server', params: { pct: pct(mem), total: Math.round(os.totalmem() / 1048576) } });
  const dk = disk();
  items.push({ id: 'disk', level: lv(dk?.used ?? null, 0.8, 0.9), area: 'server', params: { pct: dk ? pct(dk.used) : 0, free: dk ? Math.round(dk.totalMb * (1 - dk.used)) : 0 } });
  const appUp = Math.round(process.uptime());
  items.push({ id: 'restarted', level: appUp < 15 * 60 ? 'warn' : 'ok', area: 'server', params: { minutes: Math.round(appUp / 60) } });

  // ------------------------------------------------------------ the database
  let dbPing: number | null = null;
  let dbSize: number | null = null;
  let dbConn: number | null = null;
  try {
    const t = Date.now();
    await core.t.platform.query('SELECT 1');
    dbPing = Date.now() - t;
    const r = (
      await core.t.platform.query(
        `SELECT pg_database_size(current_database())::bigint AS size,
                (SELECT count(*) FROM pg_stat_activity)::int AS conns,
                current_setting('max_connections')::int AS max_conns,
                (SELECT count(*) FROM pg_stat_activity WHERE state = 'active' AND query_start < now() - interval '30 seconds' AND pid <> pg_backend_pid())::int AS slow`,
      )
    )[0];
    dbSize = Math.round(Number(r.size) / 1048576);
    dbConn = Number(r.conns) / Math.max(1, Number(r.max_conns));
    items.push({ id: 'dbPing', level: lv(dbPing, 150, 500), area: 'database', params: { ms: dbPing } });
    items.push({ id: 'dbConnections', level: lv(dbConn, 0.7, 0.9), area: 'database', params: { used: Number(r.conns), max: Number(r.max_conns), waiting: core.pool.waitingCount } });
    items.push({ id: 'dbSlow', level: Number(r.slow) ? (Number(r.slow) >= 5 ? 'bad' : 'warn') : 'ok', area: 'database', params: { count: Number(r.slow) } });
  } catch (e) {
    items.push({ id: 'dbDown', level: 'bad', area: 'database', params: { error: (e as Error).message.slice(0, 120) } });
  }
  if (core.pool.waitingCount > 0) items.push({ id: 'dbPoolFull', level: 'warn', area: 'database', params: { waiting: core.pool.waitingCount, max: config.dbPoolMax } });

  // ------------------------------------------------------------ Redis and the jobs
  const rp = await redisPing();
  if (rp === null) items.push({ id: 'redisOff', level: 'warn', area: 'jobs' });
  else if (rp < 0) items.push({ id: 'redisDown', level: 'bad', area: 'jobs' });
  else items.push({ id: 'redis', level: lv(rp, 100, 1000), area: 'jobs', params: { ms: rp } });
  const jobs = doctorState.jobList(now);
  const badJobs = jobs.filter((j) => j.state === 'failing' || j.state === 'late');
  if (config.redisUrl)
    items.push(
      badJobs.length
        ? {
            id: 'jobs',
            level: badJobs.some((j) => j.state === 'failing' || j.name === 'courier-sync') ? 'bad' : 'warn',
            area: 'jobs',
            params: { count: badJobs.length },
            list: badJobs.map((j) => ({ label: j.name, n: j.lastOkAt ? Math.round((now - Date.parse(j.lastOkAt)) / MIN) : Math.round((now - doctorState.startedAt) / MIN), unit: 'min' as const })),
          }
        : { id: 'jobs', level: jobs.some((j) => j.state === 'waiting') ? 'info' : 'ok', area: 'jobs' },
    );

  // ------------------------------------------------------------ the code (errors the server wrote)
  const errors = doctorState.errors(now);
  const errH = doctorState.inLast(H, 'error', now);
  const err24 = doctorState.inLast(D, 'error', now);
  const repeat = errors.filter((e) => e.level === 'error' && e.count >= 10);
  const topErr: DoctorLine[] = errors
    .filter((e) => e.level === 'error')
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((e) => ({ label: `${e.shop ? `[${e.shop}] ` : ''}${e.message.slice(0, 90)}`, n: e.count, unit: 'n' as const }));
  items.push({ id: 'errors', level: errH >= 20 || repeat.length ? 'bad' : err24 ? 'warn' : 'ok', area: 'code', params: { hour: errH, day: err24, repeat: repeat.length }, list: topErr.length ? topErr : undefined });
  const courier = errors.filter((e) => /courier/i.test(e.source) && e.shop);
  if (courier.length)
    items.push({
      id: 'courierSync',
      level: courier.some((e) => e.count >= 6) ? 'bad' : 'warn',
      area: 'code',
      params: { count: new Set(courier.map((e) => e.shop)).size },
      list: courier.slice(0, 5).map((e) => ({ label: `${e.shop} · ${e.message.slice(0, 70)}`, n: e.count, unit: 'n' as const })),
    });

  // ------------------------------------------------------------ the shops
  let shopsN = 0;
  const silent: DoctorLine[] = [];
  try {
    for (const ref of await core.jobShops()) {
      if (ref.shop.demo) continue;
      shopsN++;
      const r = (await ref.db.query(`SELECT max(created_at) AS last, count(*) FILTER (WHERE created_at >= now() - interval '14 days')::int AS n14 FROM orders`))[0];
      const last = r?.last ? new Date(r.last).getTime() : 0;
      if (Number(r?.n14) >= 14 && last && now - last > 36 * H) silent.push({ label: ref.shop.name, n: Math.round((now - last) / H), unit: 'hours' });
    }
  } catch (e) {
    doctorState.record('warn', 'Doctor', `shops check: ${(e as Error).message}`);
  }
  silent.sort((a, b) => b.n - a.n);
  items.push(silent.length ? { id: 'silentShops', level: 'warn', area: 'shops', params: { count: silent.length }, list: silent.slice(0, 8) } : { id: 'silentShops', level: 'ok', area: 'shops', params: { count: shopsN } });

  // ------------------------------------------------------------ the settings
  const missing: DoctorLine[] = [];
  if (process.env.NODE_ENV !== 'production') missing.push({ label: 'NODE_ENV=production', n: 0, unit: 'text' });
  if (!config.smtp.host) missing.push({ label: 'SMTP_HOST (e-mails)', n: 0, unit: 'text' });
  if (!config.publicUrl) missing.push({ label: 'PUBLIC_URL', n: 0, unit: 'text' });
  if (!config.trustProxy) missing.push({ label: 'TRUST_PROXY', n: 0, unit: 'text' });
  items.push(missing.length ? { id: 'config', level: 'warn', area: 'config', params: { count: missing.length }, list: missing } : { id: 'config', level: 'ok', area: 'config' });

  // ------------------------------------------------------------ Cloudflare (robot check of every shop's pages)
  const ts = await turnstileStatus(core).catch(() => null);
  if (ts) {
    const used = ts.domains / ts.maxDomains;
    items.push(
      !ts.configured
        ? { id: 'turnstileOff', level: 'info', area: 'config', params: { max: ts.maxDomains } }
        : {
            id: 'turnstile',
            level: ts.waiting.length || used >= 0.95 ? 'bad' : used >= 0.8 || ts.lastError ? 'warn' : 'ok',
            area: 'config',
            params: { domains: ts.domains, max: ts.maxDomains, pct: pct(used), widgets: ts.widgets.length, maxWidgets: ts.maxWidgets, waiting: ts.waiting.length },
            ...(ts.lastError ? { list: [{ label: ts.lastError.slice(0, 140), n: 0, unit: 'text' as const }] } : {}),
          },
    );
  }

  // what the owner hid: « Ignorer » for 7 days, « Résolu » while the alert stays the same; what can be hidden says so
  const muted: DoctorMuted[] = [];
  let shown = items;
  if (!opts.raw) {
    const dis = await readDismissed(core).catch(() => ({}) as Record<string, Dismissed>);
    let changed = false;
    shown = [];
    for (const i of items) {
      const d = dis[i.id];
      const problem = i.level === 'bad' || i.level === 'warn';
      if (d && d.kind === 'ignore' && d.until && Date.parse(d.until) > now) {
        muted.push({ id: i.id, until: d.until, by: d.by, ...(i.params ? { params: i.params } : {}) });
        continue;
      }
      if (d && d.kind === 'solve' && problem && d.sig === sigOf(i)) continue;
      if (d && (d.kind === 'ignore' || !problem || d.sig !== sigOf(i))) {
        // expired, fixed, or changed: forgotten
        delete dis[i.id];
        changed = true;
      }
      shown.push(problem && DISMISSABLE[i.id] ? { ...i, actions: DISMISSABLE[i.id] } : i);
    }
    if (changed) await writeDismissed(core, dis).catch(() => {});
  }
  const sorted = doctorSort(shown);
  return {
    checkedAt: new Date(now).toISOString(),
    score: doctorScore(sorted),
    items: sorted,
    gauges: { cpu, memory: mem, disk: dk?.used ?? null, dbConnections: dbConn },
    facts: {
      serverUptimeS: Math.round(os.uptime()),
      appUptimeS: appUp,
      node: process.version,
      version: process.env.APP_VERSION || process.env.GIT_SHA || process.env.npm_package_version || '3.0.0',
      cores,
      memoryTotalMb: Math.round(os.totalmem() / 1048576),
      diskTotalMb: dk?.totalMb ?? null,
      dbSizeMb: dbSize,
      dbPingMs: dbPing,
      shops: shopsN,
    },
    jobs,
    errors: errors.slice(0, 40),
    muted,
    ...(ts ? { turnstile: ts } : {}),
  };
}
