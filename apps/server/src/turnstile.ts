// Cloudflare Turnstile, managed by Pilotix for every shop (the invisible robot check of the landing pages).
// The platform's owner gives, once, the Cloudflare account id and an API token allowed to edit Turnstile (control
// room › Doctor). Then Pilotix keeps the widgets itself:
//   - the platform's own address (pilotix.online) is in the first widget: every shop's pages on it are covered;
//   - a shop's own domain, once ready (its DNS points here), is added to a widget with room (10 domains each on the free
//     plan), a new widget is made when all are full (20 at most on the free plan), and it is taken out when the shop
//     removes it or stops;
//   - the landing page gets the site key of the widget that holds its domain; the order is checked with that widget's
//     secret. The secrets and the token never leave the server.
// Cloudflare unreachable, not set up, or full: nothing breaks, the check is simply off (no points for the order).
import { Logger } from '@nestjs/common';
import type { CoreService } from './core.service';
import { config } from './config';

const log = new Logger('Turnstile');
const API = 'https://api.cloudflare.com/client/v4';
/** Cloudflare's free plan: domains per widget, widgets per account */
export const TS_PER_WIDGET = 10;
export const TS_MAX_WIDGETS = 20;
const SETTING = 'cloudflare_turnstile';

interface TsConfig {
  accountId: string;
  token: string;
  lastSyncAt?: string | null;
  lastError?: string | null;
  /** domains that could not get a place (every widget full) */
  waiting?: string[];
}

interface Widget {
  sitekey: string;
  secret: string;
  name: string;
  domains: string[];
}

export const platformHost = () => {
  try {
    return new URL(config.publicUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

async function readConfig(core: CoreService): Promise<TsConfig | null> {
  const r = (await core.t.platform.query(`SELECT value FROM platform.settings WHERE key = $1`, [SETTING]))[0];
  const v = r?.value as TsConfig | undefined;
  return v && v.accountId && v.token ? v : null;
}

async function writeConfig(core: CoreService, v: TsConfig | null) {
  if (!v) await core.t.platform.query(`DELETE FROM platform.settings WHERE key = $1`, [SETTING]);
  else
    await core.t.platform.query(
      `INSERT INTO platform.settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [SETTING, JSON.stringify(v)],
    );
}

async function widgets(core: CoreService): Promise<Widget[]> {
  return (await core.t.platform.query(`SELECT sitekey, secret, name, domains FROM platform.turnstile_widgets ORDER BY created_at, sitekey`)).map((r: any) => ({
    sitekey: String(r.sitekey),
    secret: String(r.secret),
    name: String(r.name),
    domains: (r.domains as string[] | null) ?? [],
  }));
}

/** One call to Cloudflare's API; its error message when it refuses. */
async function cf(c: TsConfig, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}/accounts/${encodeURIComponent(c.accountId)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const r: any = await res.json().catch(() => null);
  if (!res.ok || !r?.success) {
    const msg = r?.errors?.map((e: any) => `${e.code}: ${e.message}`).join(' · ') || `HTTP ${res.status}`;
    throw new Error(`Cloudflare : ${msg}`);
  }
  return r.result;
}

/** The domains that must be covered: the platform's address, and every active shop's own domain that is ready. */
async function wanted(core: CoreService): Promise<string[]> {
  const host = platformHost();
  const shops = await core.t.platform.query(
    `SELECT DISTINCT lower(domain) AS d FROM platform.shops WHERE domain IS NOT NULL AND domain_status = 'ok' AND status = 'active' ORDER BY 1`,
  );
  const out = [...(host ? [host] : []), ...shops.map((r: any) => String(r.d))];
  // a domain under one already listed is covered by it (pilotix.online covers shop.pilotix.online)
  return [...new Set(out)].filter((d, _i, all) => !all.some((p) => p !== d && d.endsWith(`.${p}`)));
}

let running: Promise<TsStatus> | null = null;

/**
 * Brings the widgets in step with the domains: removes the domains no longer wanted, puts each new one in a widget with
 * room (a new widget when all are full), and tells Cloudflare. Runs after a shop's domain changes, every 30 minutes,
 * and from the Doctor. One at a time.
 */
export function syncTurnstile(core: CoreService): Promise<TsStatus> {
  if (!running)
    running = doSync(core).finally(() => {
      running = null;
    });
  return running;
}

async function doSync(core: CoreService): Promise<TsStatus> {
  const c = await readConfig(core);
  if (!c) return turnstileStatus(core);
  const want = await wanted(core);
  const list = await widgets(core);
  const changed = new Set<string>();
  let error: string | null = null;
  // 1. take out what is no longer wanted
  for (const w of list) {
    const keep = w.domains.filter((d) => want.includes(d));
    if (keep.length !== w.domains.length) {
      w.domains = keep;
      changed.add(w.sitekey);
    }
  }
  // 2. place the new ones (the platform's own address first)
  const placed = new Set(list.flatMap((w) => w.domains));
  const waiting: string[] = [];
  for (const d of want) {
    if (placed.has(d)) continue;
    let w = list.find((x) => x.domains.length < TS_PER_WIDGET);
    if (!w) {
      if (list.length >= TS_MAX_WIDGETS) {
        waiting.push(d);
        continue;
      }
      try {
        const name = `Pilotix ${list.length + 1}`;
        const r = await cf(c, 'POST', '/challenges/widgets', { name, domains: [d], mode: 'invisible' });
        w = { sitekey: String(r.sitekey), secret: String(r.secret), name, domains: [d] };
        await core.t.platform.query(`INSERT INTO platform.turnstile_widgets (sitekey, secret, name, domains) VALUES ($1, $2, $3, $4)`, [w.sitekey, w.secret, w.name, w.domains]);
        list.push(w);
        placed.add(d);
        continue;
      } catch (e) {
        error = (e as Error).message;
        waiting.push(d);
        break;
      }
    }
    w.domains.push(d);
    placed.add(d);
    changed.add(w.sitekey);
  }
  // 3. tell Cloudflare (an empty widget is deleted: Cloudflare wants at least one domain)
  for (const w of list.filter((x) => changed.has(x.sitekey))) {
    try {
      if (!w.domains.length) {
        await cf(c, 'DELETE', `/challenges/widgets/${encodeURIComponent(w.sitekey)}`).catch((e) => {
          if (!/10001|not found|404/i.test((e as Error).message)) throw e;
        });
        await core.t.platform.query(`DELETE FROM platform.turnstile_widgets WHERE sitekey = $1`, [w.sitekey]);
      } else {
        await cf(c, 'PUT', `/challenges/widgets/${encodeURIComponent(w.sitekey)}`, { name: w.name, domains: w.domains, mode: 'invisible' });
        await core.t.platform.query(`UPDATE platform.turnstile_widgets SET domains = $2, updated_at = now() WHERE sitekey = $1`, [w.sitekey, w.domains]);
      }
    } catch (e) {
      error = (e as Error).message;
    }
  }
  if (!error && waiting.length) error = `Limite gratuite atteinte (${TS_MAX_WIDGETS} widgets × ${TS_PER_WIDGET} domaines) : ${waiting.length} domaine(s) en attente`;
  if (error) log.warn(error);
  cache.clear();
  await writeConfig(core, { ...c, lastSyncAt: new Date().toISOString(), lastError: error, waiting });
  return turnstileStatus(core);
}

// ---------------------------------------------------------------- what the pages use
const cache = new Map<string, { at: number; v: string | null }>();

/** The site key for a page served on this host (the widget that holds it, or a parent domain of it), null when none. */
export async function turnstileSiteKey(core: CoreService, host: string): Promise<string | null> {
  const h = host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (!h) return null;
  const hit = cache.get(h);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  let v: string | null = null;
  try {
    if (await readConfig(core)) {
      const r = (
        await core.t.platform.query(
          `SELECT sitekey FROM platform.turnstile_widgets w WHERE EXISTS (SELECT 1 FROM unnest(w.domains) d WHERE $1 = d OR $1 LIKE '%.' || d) LIMIT 1`,
          [h],
        )
      )[0];
      v = r ? String(r.sitekey) : null;
    }
  } catch {
    v = null;
  }
  cache.set(h, { at: Date.now(), v });
  return v;
}

/** Cloudflare's own check of a page token, with the secret of the widget that made it; null when it cannot tell. */
export async function turnstileCheck(core: CoreService, sitekey: string, token: string, ip: string): Promise<boolean | null> {
  const r = (await core.t.platform.query(`SELECT secret FROM platform.turnstile_widgets WHERE sitekey = $1`, [sitekey]).catch(() => []))[0];
  if (!r) return null;
  const body = new URLSearchParams({ secret: String(r.secret), response: token, ...(ip ? { remoteip: ip } : {}) });
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body, signal: AbortSignal.timeout(5_000) }).catch(() => null);
  if (!res?.ok) return null;
  const out: any = await res.json().catch(() => null);
  return out ? !!out.success : null;
}

// ---------------------------------------------------------------- the Doctor
export interface TsStatus {
  configured: boolean;
  accountId: string | null;
  widgets: { sitekey: string; name: string; domains: string[] }[];
  domains: number;
  maxDomains: number;
  maxWidgets: number;
  perWidget: number;
  waiting: string[];
  lastSyncAt: string | null;
  lastError: string | null;
}

export async function turnstileStatus(core: CoreService): Promise<TsStatus> {
  const c = await readConfig(core).catch(() => null);
  const list = await widgets(core).catch(() => [] as Widget[]);
  return {
    configured: !!c,
    // the id is shown shortened; the token never leaves the server
    accountId: c ? `${c.accountId.slice(0, 4)}…${c.accountId.slice(-4)}` : null,
    widgets: list.map((w) => ({ sitekey: w.sitekey, name: w.name, domains: w.domains })),
    domains: list.reduce((n, w) => n + w.domains.length, 0),
    maxDomains: TS_PER_WIDGET * TS_MAX_WIDGETS,
    maxWidgets: TS_MAX_WIDGETS,
    perWidget: TS_PER_WIDGET,
    waiting: c?.waiting ?? [],
    lastSyncAt: c?.lastSyncAt ?? null,
    lastError: c?.lastError ?? null,
  };
}

/**
 * The control room's owner connects the Cloudflare account, or replaces it with a new one (never removed: the robot
 * check stays on). The new account id and token are checked with Cloudflare first: refused, the old ones stay.
 */
export async function saveTurnstileConfig(core: CoreService, input: { accountId: string; token: string }): Promise<TsStatus> {
  const accountId = input.accountId.trim();
  if (!/^[0-9a-f]{32}$/i.test(accountId)) throw new Error('Account ID Cloudflare invalide (32 caractères, sur la page d’accueil du compte)');
  const old = await readConfig(core);
  const token = input.token.trim();
  if (token.length < 20) throw new Error('Collez le nouveau jeton API Cloudflare (l’ancien reste tant que le nouveau n’est pas accepté)');
  // the token can read the account's widgets: it works
  await cf({ accountId, token }, 'GET', '/challenges/widgets?per_page=1');
  // another Cloudflare account: the widgets of the old one are not usable with it (made again by the sync)
  if (old && old.accountId !== accountId) await core.t.platform.query(`DELETE FROM platform.turnstile_widgets`);
  await writeConfig(core, { ...(old ?? {}), accountId, token, ...(old && old.accountId !== accountId ? { waiting: [], lastError: null } : {}) });
  return syncTurnstile(core);
}
