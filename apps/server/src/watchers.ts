// The bug detector's watchers (Control room › Doctor), run every 10 minutes by the job « doctor-watch »:
//   - the test robot: does the main work in the demo shop (lists, counts, the home page's numbers, a test order made
//     then deleted) and opens the public site and its API, as a person would — a broken action shows before anyone
//     complains;
//   - the outside services: e-mail sending, the websites' certificates, the Meta / TikTok links, the off-site backups;
//   - the data checker (every 30 minutes): orders whose total is not their products', orders without products,
//     negative stock, the same order saved twice within a minute — the traces a bug leaves in the data;
//   - the judge: 7 days of measures (disk, memory, database, errors) to warn BEFORE it breaks — the disk full in a few
//     days, the server's memory that keeps growing (a leak), errors that jump after an update;
//   - red alerts by e-mail to the owner and managers (once per alert per 6 hours).
// The browser watcher (errors, loops and slow actions on people's screens) lives in web lib/watch → /client-report.
import * as fs from "node:fs";
import * as tls from "node:tls";
import { Logger } from "@nestjs/common";
import * as core from "@pilotix/core";
import type { DoctorItem, DoctorLine } from "@pilotix/shared";
import { config } from "./config";
import type { CoreService, ShopRef } from "./core.service";
import { checkSmtp, mailConfigured, sendMail } from "./mail";
import { doctorState } from "./doctor";
import { offsiteStatus } from "./offsite";
import { doctorAlertMail } from "./mails";

const log = new Logger("Doctor watch");
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

// ---------------------------------------------------------------- what the watchers saw (in memory, like the errors)
export interface RobotStep {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
  skipped?: boolean;
}
interface RobotRun {
  at: number;
  steps: RobotStep[];
  shop: string | null;
}
interface DataFinding {
  shop: string;
  check: "totals" | "noItems" | "negStock" | "doubles";
  n: number;
}
export interface Sample {
  at: number;
  v: string;
  disk: number | null;
  rss: number;
  db: number | null;
  errH: number;
  brH: number;
}

class WatchState {
  robot: RobotRun | null = null;
  /** the steps that failed in the run before (a step is « broken » when it fails twice in a row) */
  robotFailedBefore = new Set<string>();
  outside: {
    at: number;
    smtp: "ok" | "off" | string;
    certs: { host: string; days: number | null; error?: string }[];
    links: { name: string; why: "error" | "expires"; days: number | null }[];
    backup: { configured: boolean; hours: number | null; error: string | null };
  } | null = null;
  data: { at: number; findings: DataFinding[]; shops: number } | null = null;
  runs = 0;
  running = false;
}
export const watchState = new WatchState();

const version = () =>
  process.env.APP_VERSION ||
  process.env.GIT_SHA ||
  process.env.npm_package_version ||
  "3.0.0";

// ---------------------------------------------------------------- the test robot
/**
 * Where the robot works: the demo shop (reset every night), where it may also make and delete a test order; without
 * one, the first active store, where it only reads (it never writes in a real shop).
 */
async function robotShop(
  c: CoreService,
): Promise<{ ref: ShopRef; demo: boolean } | null> {
  const shops = await core.loadShops(c.t);
  const demo = shops.find((s) => s.demo && !s.primary && s.status === "active");
  if (demo) {
    const ref = await c.shop({ id: demo.id });
    if (ref) return { ref, demo: true };
  }
  for (const ref of await c.jobShops())
    if (!ref.shop.demo) return { ref, demo: false };
  return null;
}

async function step(
  steps: RobotStep[],
  name: string,
  f: () => Promise<unknown>,
) {
  const t = Date.now();
  try {
    const r = await Promise.race([
      f(),
      new Promise((_, no) =>
        setTimeout(() => no(new Error("plus de 20 s")), 20_000),
      ),
    ]);
    steps.push({
      name,
      ok: true,
      ms: Date.now() - t,
      ...(r === "skipped" ? { skipped: true } : {}),
    });
  } catch (e) {
    steps.push({
      name,
      ok: false,
      ms: Date.now() - t,
      error: core
        .maskPersonal(String((e as Error)?.message ?? e))
        .slice(0, 200),
    });
  }
}

async function fetchOk(url: string, want?: RegExp) {
  const r = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
    headers: { "user-agent": "Pilotix-Doctor/1.0" },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (want && !want.test(await r.text())) throw new Error("page incomplète");
}

export async function runRobot(c: CoreService): Promise<RobotRun> {
  const steps: RobotStep[] = [];
  const site = config.publicUrl?.replace(/\/+$/, "");
  if (site) {
    await step(steps, "site", () => fetchOk(site, /id="root"/));
    await step(steps, "api", () => fetchOk(`${site}/api/health`));
  }
  const at = await robotShop(c).catch(() => null);
  const ref = at?.ref;
  if (ref) {
    const sys = await c.systemSession(ref);
    const now = Date.now();
    await step(steps, "orders.list", () => c.call(ref, "orders.list", sys, {}));
    await step(steps, "orders.counts", () =>
      c.call(ref, "orders.counts", sys, {}),
    );
    await step(steps, "stats.overview", () =>
      c.call(ref, "stats.overview", sys, {
        from: new Date(now - 7 * D).toISOString(),
        to: new Date(now).toISOString(),
      }),
    );
    // a test order, made then deleted at once: only in the demo shop (reset every night anyway)
    if (at.demo)
      await step(steps, "orders.create", async () => {
        const p = (
          await ref.db.query(
            `SELECT p.id, (SELECT v.id FROM product_variants v WHERE v.product_id = p.id ORDER BY v.id LIMIT 1) AS vid FROM products p WHERE p.active ORDER BY p.id LIMIT 1`,
          )
        )[0];
        if (!p) return "skipped";
        const o: any = await c.call(ref, "orders.create", sys, {
          customerName: "Robot Pilotix",
          phone: "0550000000",
          wilayaId: 16,
          items: [
            {
              productId: Number(p.id),
              variantId: p.vid ? Number(p.vid) : null,
              qty: 1,
            },
          ],
          internalNote: "Test automatique du Doctor (supprimé tout de suite)",
        });
        const id = Number(o?.id ?? o?.order?.id);
        if (!id) throw new Error("la commande n’a pas de numéro");
        await c.call(ref, "orders.delete", sys, { ids: [id] });
      });
  }
  const run = { at: Date.now(), steps, shop: ref?.shop.slug ?? null };
  watchState.robot = run;
  return run;
}

// ---------------------------------------------------------------- the outside services
function certDays(host: string): Promise<number | null> {
  return new Promise((ok, no) => {
    const s = tls.connect(
      {
        host,
        port: 443,
        servername: host,
        timeout: 8000,
        rejectUnauthorized: false,
      },
      () => {
        const c = s.getPeerCertificate();
        s.end();
        const until = c?.valid_to ? Date.parse(c.valid_to) : NaN;
        ok(isNaN(until) ? null : Math.floor((until - Date.now()) / D));
      },
    );
    s.on("timeout", () => (s.destroy(), no(new Error("pas de réponse"))));
    s.on("error", (e) => no(e));
  });
}

export async function runOutside(c: CoreService) {
  // e-mail (the control room's codes, the shops' mails)
  let smtp: string = "off";
  if (mailConfigured())
    smtp = await checkSmtp().then(
      () => "ok",
      (e) => String((e as Error)?.message ?? e).slice(0, 160),
    );
  // the certificates: the platform's address and every shop's own domain that is ready
  const hosts = new Set<string>();
  try {
    if (config.publicUrl) hosts.add(new URL(config.publicUrl).hostname);
  } catch {
    /* not a URL */
  }
  for (const s of await core.loadShops(c.t).catch(() => []))
    if (
      s.domain &&
      s.domainStatus === "ok" &&
      s.status !== "archived" &&
      s.status !== "deleted"
    )
      hosts.add(s.domain);
  const certs: { host: string; days: number | null; error?: string }[] = [];
  for (const host of [...hosts].slice(0, 40)) {
    if (host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host)) continue;
    certs.push(
      await certDays(host).then(
        (days) => ({ host, days }),
        (e) => ({
          host,
          days: null,
          error: String((e as Error)?.message ?? e).slice(0, 120),
        }),
      ),
    );
  }
  // the Meta / TikTok links of the shops: broken, or their key ending within 7 days
  const links: {
    name: string;
    why: "error" | "expires";
    days: number | null;
  }[] = [];
  try {
    const rows = await c.t.platform.query(
      `SELECT l.provider, l.name, l.status, l.expires_at, s.name AS shop
         FROM platform.social_links l LEFT JOIN platform.shops s ON s.id = l.shop_id
        WHERE l.status = 'error' OR (l.expires_at IS NOT NULL AND l.expires_at < now() + interval '7 days')
        ORDER BY l.expires_at NULLS FIRST LIMIT 20`,
    );
    for (const r of rows)
      links.push({
        name: `${r.provider === "tiktok" ? "TikTok" : "Meta"} · ${r.name || "—"}${r.shop ? ` (${r.shop})` : ""}`,
        why: r.status === "error" ? "error" : "expires",
        days: r.expires_at
          ? Math.floor((new Date(r.expires_at).getTime() - Date.now()) / D)
          : null,
      });
  } catch {
    /* an older database without social links */
  }
  // the off-site backups
  const o = await offsiteStatus(c).catch(() => null);
  const backup = {
    configured: !!o?.configured,
    hours: o?.lastAt
      ? Math.floor((Date.now() - Date.parse(o.lastAt)) / H)
      : null,
    error: o?.lastError ?? null,
  };
  watchState.outside = { at: Date.now(), smtp, certs, links, backup };
  return watchState.outside;
}

// ---------------------------------------------------------------- the data checker
export async function runData(c: CoreService) {
  const findings: DataFinding[] = [];
  let shops = 0;
  for (const ref of await c.jobShops()) {
    if (ref.shop.demo) continue;
    shops++;
    try {
      const r = (
        await ref.db.query(
          `SELECT
             (SELECT count(*) FROM orders o WHERE o.created_at > now() - interval '30 days'
                AND o.subtotal <> COALESCE((SELECT sum(i.qty * i.unit_price) FROM order_items i WHERE i.order_id = o.id), 0)
                AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id))::int AS totals,
             (SELECT count(*) FROM orders o WHERE o.created_at > now() - interval '30 days' AND o.created_at < now() - interval '2 minutes'
                AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id))::int AS no_items,
             (SELECT count(*) FROM stock WHERE qty < 0)::int AS neg_stock,
             (SELECT count(*) FROM orders a JOIN orders b ON b.phone = a.phone AND b.id > a.id AND b.subtotal = a.subtotal
                AND b.created_at BETWEEN a.created_at AND a.created_at + interval '60 seconds'
               WHERE a.created_at > now() - interval '7 days' AND a.conf_status NOT IN ('cancelled', 'duplicate', 'fake')
                 AND b.conf_status NOT IN ('cancelled', 'duplicate', 'fake'))::int AS doubles`,
        )
      )[0];
      const add = (check: DataFinding["check"], n: unknown) =>
        Number(n) > 0 &&
        findings.push({ shop: ref.shop.name, check, n: Number(n) });
      add("totals", r?.totals);
      add("noItems", r?.no_items);
      add("negStock", r?.neg_stock);
      add("doubles", r?.doubles);
    } catch (e) {
      doctorState.record(
        "warn",
        "Doctor",
        `[${ref.shop.slug}] data check: ${(e as Error).message}`,
      );
    }
  }
  watchState.data = { at: Date.now(), findings, shops };
  return watchState.data;
}

// ---------------------------------------------------------------- the judge's measures (7 days, every 10 minutes)
const SAMPLES_KEY = "doctor_samples";
const KEEP_MS = 7 * D;

function diskUsed(): number | null {
  try {
    const s = fs.statfsSync("/");
    return s.blocks ? 1 - s.bavail / s.blocks : null;
  } catch {
    return null;
  }
}

export async function readSamples(c: CoreService): Promise<Sample[]> {
  const r = (
    await c.t.platform
      .query(`SELECT value FROM platform.settings WHERE key = $1`, [
        SAMPLES_KEY,
      ])
      .catch(() => [])
  )[0];
  return Array.isArray(r?.value) ? (r.value as Sample[]) : [];
}

async function addSample(c: CoreService): Promise<Sample[]> {
  let dbMb: number | null = null;
  try {
    dbMb = Math.round(
      Number(
        (
          await c.t.platform.query(
            `SELECT pg_database_size(current_database())::bigint AS s`,
          )
        )[0].s,
      ) / 1048576,
    );
  } catch {
    /* the database is down: the Doctor says so elsewhere */
  }
  const browserH = doctorState
    .errors()
    .filter(
      (e) =>
        e.source.startsWith("Navigateur") && Date.now() - Date.parse(e.at) < H,
    )
    .reduce((n, e) => n + e.count, 0);
  const s: Sample = {
    at: Date.now(),
    v: version(),
    disk: diskUsed(),
    rss: process.memoryUsage().rss,
    db: dbMb,
    errH: doctorState.inLast(H, "error"),
    brH: browserH,
  };
  const all = [...(await readSamples(c)), s].filter(
    (x) => s.at - x.at < KEEP_MS,
  );
  await c.t.platform.query(
    `INSERT INTO platform.settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [SAMPLES_KEY, JSON.stringify(all)],
  );
  return all;
}

/** Least squares: how much y grows per millisecond (null: too few points). */
export function slope(points: { x: number; y: number }[]): number | null {
  if (points.length < 6) return null;
  const n = points.length;
  const mx = points.reduce((a, p) => a + p.x, 0) / n;
  const my = points.reduce((a, p) => a + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  return den ? num / den : null;
}

/**
 * The early warnings, from the measures:
 * - diskSoon: at the speed of the last 3 days, the disk is full (95 %) within 14 days;
 * - memoryLeak: the server process kept growing for 6 hours since its start (it never gives memory back);
 * - errorsAfterUpdate: since the last update, errors per hour at least 3 times what they were before (and 5+ an hour).
 */
export function judge(
  samples: Sample[],
  now = Date.now(),
  startedAt = doctorState.startedAt,
): DoctorItem[] {
  const items: DoctorItem[] = [];
  // the disk
  const d3 = samples.filter((s) => now - s.at < 3 * D && s.disk !== null);
  const sl = slope(d3.map((s) => ({ x: s.at, y: s.disk as number })));
  const last = d3[d3.length - 1]?.disk ?? null;
  if (sl !== null && last !== null && sl > 0) {
    const days = (0.95 - last) / sl / D;
    if (days < 14)
      items.push({
        id: "diskSoon",
        level: days < 3 ? "bad" : "warn",
        area: "trends",
        params: {
          days: Math.max(0, Math.round(days * 10) / 10),
          pct: Math.round(last * 1000) / 10,
        },
      });
  }
  // the server's memory since it started (a restart gives everything back: only this run counts)
  const run = samples.filter((s) => s.at >= startedAt);
  if (run.length >= 36 && now - run[0].at >= 6 * H) {
    const half = Math.floor(run.length / 2);
    const avg = (xs: Sample[]) => xs.reduce((a, s) => a + s.rss, 0) / xs.length;
    const first = avg(run.slice(0, half));
    const second = avg(run.slice(half));
    const ms = slope(run.map((s) => ({ x: s.at, y: s.rss })));
    // steadily up, by half again at least, and big enough to matter
    const rising =
      ms !== null &&
      ms > 0 &&
      run.slice(1).filter((s, i) => s.rss >= run[i].rss).length >=
        run.length * 0.7;
    if (rising && second > first * 1.5 && second > 400 * 1048576)
      items.push({
        id: "memoryLeak",
        level: second > first * 2.5 ? "bad" : "warn",
        area: "trends",
        params: {
          from: Math.round(first / 1048576),
          to: Math.round(second / 1048576),
          hours: Math.round((now - run[0].at) / H),
        },
      });
  }
  // errors since the last update
  const cur = samples[samples.length - 1]?.v;
  if (cur) {
    const after = samples.filter((s) => s.v === cur);
    const before = samples.filter((s) => s.v !== cur);
    if (after.length >= 3 && before.length >= 6) {
      const a = after.reduce((n, s) => n + s.errH, 0) / after.length;
      const b = before.reduce((n, s) => n + s.errH, 0) / before.length;
      if (a >= 5 && a >= 3 * Math.max(b, 1))
        items.push({
          id: "errorsAfterUpdate",
          level: a >= 6 * Math.max(b, 1) ? "bad" : "warn",
          area: "trends",
          params: {
            now: Math.round(a),
            before: Math.round(b * 10) / 10,
            version: cur.slice(0, 12),
          },
        });
    }
  }
  return items;
}

// ---------------------------------------------------------------- what the Doctor shows of all this
const STEP_LABEL: Record<string, string> = {
  site: "Site (page d’accueil)",
  api: "Serveur (API)",
  "orders.list": "Liste des commandes",
  "orders.counts": "Compteurs du menu",
  "stats.overview": "Chiffres de l’Accueil",
  "orders.create": "Créer une commande (test)",
};

export function watchItems(samples: Sample[], now = Date.now()): DoctorItem[] {
  const items: DoctorItem[] = [];
  const w = watchState;

  // the test robot
  if (w.robot) {
    const failed = w.robot.steps.filter((s) => !s.ok);
    const broken = failed.filter((s) => w.robotFailedBefore.has(s.name));
    const slow = w.robot.steps.filter(
      (s) => s.ok && !s.skipped && s.ms >= 5000,
    );
    const list: DoctorLine[] = [
      ...failed.map((s) => ({
        label: `${STEP_LABEL[s.name] ?? s.name} · ${s.error ?? ""}`,
        n: 0,
        unit: "text" as const,
      })),
      ...slow.map((s) => ({
        label: STEP_LABEL[s.name] ?? s.name,
        n: s.ms,
        unit: "ms" as const,
      })),
    ];
    items.push({
      id: "robot",
      level: broken.length
        ? "bad"
        : failed.length || slow.length
          ? "warn"
          : "ok",
      area: "robot",
      params: {
        steps: w.robot.steps.length,
        failed: failed.length,
        min: Math.max(0, Math.round((now - w.robot.at) / MIN)),
      },
      ...(list.length ? { list } : {}),
    });
  } else items.push({ id: "robotWaiting", level: "info", area: "robot" });

  // the browser watcher (screens of every shop: errors, loops, slow actions in the last 24 h)
  const br = doctorState
    .errors(now)
    .filter((e) => e.source.startsWith("Navigateur"));
  const brErr = br.filter((e) => e.level === "error");
  const loops = brErr.filter((e) => /Boucle :/.test(e.message));
  items.push(
    br.length
      ? {
          id: "browser",
          level:
            loops.length || brErr.some((e) => e.count >= 10)
              ? "bad"
              : brErr.length
                ? "warn"
                : "info",
          area: "code",
          params: {
            errors: brErr.reduce((n, e) => n + e.count, 0),
            loops: loops.length,
            slow: br.length - brErr.length,
          },
          list: br
            .sort((a, b) => b.count - a.count)
            .slice(0, 6)
            .map((e) => ({
              label: `${e.source.replace("Navigateur · ", "#/")} · ${e.message.slice(0, 100)}`,
              n: e.count,
              unit: "n" as const,
            })),
        }
      : { id: "browser", level: "ok", area: "code" },
  );

  // the outside services
  const o = w.outside;
  if (o) {
    if (o.smtp !== "off")
      items.push(
        o.smtp === "ok"
          ? { id: "smtp", level: "ok", area: "outside" }
          : {
              id: "smtp",
              level: "bad",
              area: "outside",
              list: [{ label: o.smtp, n: 0, unit: "text" }],
            },
      );
    const bad = o.certs.filter((x) => x.days === null || x.days < 14);
    items.push(
      bad.length
        ? {
            id: "certs",
            level: bad.some((x) => x.days !== null && x.days < 3)
              ? "bad"
              : "warn",
            area: "outside",
            params: { count: bad.length },
            list: bad.map((x) =>
              x.days === null
                ? {
                    label: `${x.host} · ${x.error ?? "?"}`,
                    n: 0,
                    unit: "text" as const,
                  }
                : { label: x.host, n: x.days, unit: "days" as const },
            ),
          }
        : {
            id: "certs",
            level: "ok",
            area: "outside",
            params: { count: o.certs.length },
          },
    );
    if (o.links.length)
      items.push({
        id: "socialLinks",
        level: o.links.some(
          (l) => l.why === "error" || (l.days !== null && l.days < 2),
        )
          ? "bad"
          : "warn",
        area: "outside",
        params: { count: o.links.length },
        list: o.links.map((l) =>
          l.why === "error" || l.days === null
            ? { label: `${l.name} · erreur`, n: 0, unit: "text" as const }
            : { label: l.name, n: Math.max(0, l.days), unit: "days" as const },
        ),
      });
    if (o.backup.configured) {
      const h = o.backup.hours;
      items.push({
        id: "backup",
        level:
          h === null || h >= 48
            ? "bad"
            : h >= 26 || o.backup.error
              ? "warn"
              : "ok",
        area: "outside",
        params: { hours: h ?? 0 },
        ...(o.backup.error
          ? {
              list: [
                {
                  label: o.backup.error.slice(0, 140),
                  n: 0,
                  unit: "text" as const,
                },
              ],
            }
          : {}),
      });
    }
  }

  // the data checker
  const dt = w.data;
  if (dt) {
    const f = dt.findings;
    items.push(
      f.length
        ? {
            id: "dataIssues",
            level: f.some((x) => x.check === "totals" || x.check === "noItems")
              ? "bad"
              : "warn",
            area: "data",
            params: {
              count: f.reduce((n, x) => n + x.n, 0),
              shops: new Set(f.map((x) => x.shop)).size,
            },
            list: f
              .slice(0, 10)
              .map((x) => ({
                label: `${x.shop} · ${DATA_LABEL[x.check]}`,
                n: x.n,
                unit: "n" as const,
              })),
          }
        : {
            id: "dataIssues",
            level: "ok",
            area: "data",
            params: { shops: dt.shops },
          },
    );
  }

  // the early warnings
  items.push(...judge(samples, now));
  return items;
}

const DATA_LABEL: Record<DataFinding["check"], string> = {
  totals: "total différent de ses produits",
  noItems: "commande sans produit",
  negStock: "stock négatif",
  doubles: "même commande enregistrée 2 fois en 1 min",
};

// ---------------------------------------------------------------- one run (the job, or « Lancer maintenant »)
const ALERTED_KEY = "doctor_alerted";
const ALERT_EVERY = 6 * H;

export async function runWatch(
  c: CoreService,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (watchState.running) return;
  watchState.running = true;
  try {
    const before = new Set(
      (watchState.robot?.steps ?? []).filter((s) => !s.ok).map((s) => s.name),
    );
    await runRobot(c).catch((e) => log.warn(`robot: ${(e as Error).message}`));
    watchState.robotFailedBefore = before;
    await runOutside(c).catch((e) =>
      log.warn(`outside: ${(e as Error).message}`),
    );
    if (opts.force || watchState.runs % 3 === 0 || !watchState.data)
      await runData(c).catch((e) => log.warn(`data: ${(e as Error).message}`));
    watchState.runs++;
    await addSample(c).catch((e) =>
      log.warn(`samples: ${(e as Error).message}`),
    );
    await alertStaff(c).catch((e) =>
      log.warn(`alert: ${(e as Error).message}`),
    );
  } finally {
    watchState.running = false;
  }
}

/**
 * Red alerts by e-mail: each alert that is « bad » (and not hidden by the owner) to the active owners and managers,
 * once per alert per 6 hours, all of them in one e-mail.
 */
async function alertStaff(c: CoreService) {
  if (!mailConfigured()) return;
  const { serverDoctor } = await import("./doctor");
  const rep = await serverDoctor(c);
  const bad = rep.items.filter((i) => i.level === "bad");
  const r = (
    await c.t.platform.query(
      `SELECT value FROM platform.settings WHERE key = $1`,
      [ALERTED_KEY],
    )
  )[0];
  const sent: Record<string, number> =
    r?.value && typeof r.value === "object" ? r.value : {};
  const now = Date.now();
  const fresh = bad.filter(
    (i) => !sent[i.id] || now - sent[i.id] >= ALERT_EVERY,
  );
  // an alert that went away may come back later and be told again
  for (const k of Object.keys(sent))
    if (!bad.some((i) => i.id === k)) delete sent[k];
  if (fresh.length) {
    const staff = await c.t.platform.query<{ name: string; email: string }>(
      `SELECT name, email FROM platform.staff WHERE active AND role IN ('owner', 'manager')`,
    );
    const lines = fresh.map(
      (i) =>
        [
          alertTitle(i),
          (i.list ?? [])
            .slice(0, 2)
            .map((l) => l.label)
            .join(" · ") || "",
        ] as [string, string],
    );
    for (const s of staff)
      await sendMail(
        doctorAlertMail({ to: s.email, name: s.name, lines }),
      ).catch((e) => log.warn(`e-mail to ${s.email}: ${e?.message || e}`));
    for (const i of fresh) sent[i.id] = now;
  }
  await c.t.platform.query(
    `INSERT INTO platform.settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [ALERTED_KEY, JSON.stringify(sent)],
  );
}

/** The alert's name in the e-mail (French, like the control room's other mails). */
const TITLE: Record<string, string> = {
  cpu: "Processeur saturé",
  memory: "Mémoire presque pleine",
  disk: "Disque presque plein",
  dbDown: "Base de données arrêtée",
  dbPing: "Base de données lente",
  dbConnections: "Connexions à la base presque toutes prises",
  dbSlow: "Requêtes bloquées dans la base",
  redisDown: "Redis arrêté (tâches de fond)",
  jobs: "Tâches de fond en retard ou en échec",
  errors: "Erreurs dans le code",
  courierSync: "Synchronisation des sociétés de livraison en échec",
  turnstile: "Cloudflare (contrôle anti-robot)",
  robot: "Le robot de test trouve une action cassée",
  browser: "Erreurs ou boucle sur les écrans des utilisateurs",
  smtp: "Les e-mails ne partent plus",
  certs: "Certificat de site qui expire",
  socialLinks: "Lien Meta / TikTok cassé ou qui expire",
  backup: "Sauvegarde hors serveur en retard",
  dataIssues: "Données incohérentes (trace d’un bug)",
  diskSoon: "Le disque sera plein dans quelques jours",
  memoryLeak: "La mémoire du serveur grandit sans arrêt (fuite)",
  errorsAfterUpdate: "Erreurs en hausse depuis la dernière mise à jour",
};
const alertTitle = (i: DoctorItem) => TITLE[i.id] ?? i.id;

/** For the page: when the robot last ran, and each of its steps. */
export function robotReport() {
  const r = watchState.robot;
  return r
    ? {
        at: new Date(r.at).toISOString(),
        shop: r.shop,
        steps: r.steps.map((s) => ({
          ...s,
          label: STEP_LABEL[s.name] ?? s.name,
        })),
      }
    : null;
}
