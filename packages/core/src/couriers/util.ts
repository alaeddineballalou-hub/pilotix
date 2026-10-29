// HTTP and text helpers for the courier adapters (server only: global fetch).
import { AppError } from '../rpc';

export class CourierError extends AppError {
  constructor(message: string, public status = 400) {
    super('bad_request', message);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stop long loops before the request times out (track of many parcels). */
let deadline = 0;
export const setDeadline = (ms: number) => (deadline = Date.now() + ms);
export const timeUp = () => deadline > 0 && Date.now() > deadline;

/**
 * Short readable error from any API answer, with the courier's field-by-field reasons when it gives them.
 * A general title alone (« One or more validation errors occurred ») tells the user nothing: the list of
 * fields it refers to (errors / validationErrors / failures… under any key) is added after it.
 */
export function errText(e: unknown): string {
  const main = mainErr(e);
  if (!e || typeof e !== 'object') return main;
  const details: string[] = [];
  fieldErrs(e, '', details, 0);
  const extra = [...new Set(details)].filter((d) => d && d !== main && !main.includes(d) && !(main && d.endsWith(` : ${main}`)));
  return (extra.length ? `${main ? `${main} — ` : ''}${extra.join(' · ')}` : main).slice(0, 500);
}

const NOISE = new Set(['type', 'traceid', 'instance', 'status', 'statuscode', 'code', 'issuccess', 'isfailure', 'timestamp', 'title', 'detail', 'message', 'error_description', 'msg', 'requestid', 'path', 'method']);
const NAME_KEYS = ['propertyName', 'field', 'fieldName', 'property', 'name', 'key', 'code'];
const MSG_KEYS = ['errorMessage', 'message', 'description', 'detail', 'reason', 'error', 'msg'];

/** Collects « field : reason » lines from a courier's error answer (dictionary or list form, nested). */
function fieldErrs(v: unknown, field: string, out: string[], depth: number) {
  if (depth > 5 || out.length > 12 || v === null || v === undefined) return;
  if (typeof v === 'string' || typeof v === 'number') {
    const s = clean(String(v));
    if (s && field) out.push(`${field} : ${s}`);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) fieldErrs(x, field, out, depth + 1);
    return;
  }
  if (typeof v !== 'object') return;
  const o = v as Record<string, unknown>;
  // {propertyName: 'Phone', errorMessage: 'invalid'} → « Phone : invalid »
  const nk = NAME_KEYS.find((k) => typeof o[k] === 'string' && o[k]);
  const mk = MSG_KEYS.find((k) => typeof o[k] === 'string' && o[k] && k !== nk);
  if (mk && depth > 0) {
    out.push(`${nk ? `${o[nk]} : ` : field ? `${field} : ` : ''}${clean(String(o[mk]))}`);
    return;
  }
  for (const [k, x] of Object.entries(o)) {
    if (depth === 0 && NOISE.has(k.toLowerCase())) continue;
    // container keys (errors, validationErrors, failures, extensions…) keep the field name of the level above
    const container = /^(errors?|validationerrors|failures|details|extensions|value|data|result)$/i.test(k);
    fieldErrs(x, container ? field : k, out, depth + 1);
  }
}

const clean = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

/** The answer's main sentence (as before). */
function mainErr(e: unknown): string {
  if (!e) return '';
  if (typeof e === 'string') return e.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (Array.isArray(e)) return e.map(mainErr).filter(Boolean).join(' · ');
  const o = e as any;
  const t = o.detail || o.message || o.error_description || o.msg || o.description || (typeof o.error === 'string' ? o.error : null) || o.title || (o.errors ? null : o.error);
  if (t) return typeof t === 'string' ? clean(t) : mainErr(t);
  if (o.errors) return '';
  return Object.entries(o)
    .filter(([, v]) => typeof v === 'string' || Array.isArray(v))
    .map(([k, v]) => `${k} : ${mainErr(v)}`)
    .join(' · ')
    .slice(0, 300);
}

export interface HttpOpts {
  method?: string;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, unknown>;
  binary?: boolean;
  timeout?: number;
}

/** fetch with timeout, one retry on 429, and French errors naming the courier. */
export async function http(who: string, url: string, o: HttpOpts = {}, retried = false): Promise<any> {
  const headers: Record<string, string> = { Accept: o.binary ? 'application/pdf, */*' : 'application/json', ...(o.headers ?? {}) };
  let body: string | undefined;
  if (o.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(o.json);
  }
  if (o.form) {
    const f = new URLSearchParams();
    for (const [k, v] of Object.entries(o.form)) if (v !== null && v !== undefined) f.append(k, String(v));
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = f.toString();
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeout ?? 25_000);
  let res: Response;
  try {
    res = await fetch(url, { method: o.method ?? (body ? 'POST' : 'GET'), headers, body, signal: ac.signal });
  } catch (e: any) {
    throw new CourierError(`${who} ne répond pas (${e?.name === 'AbortError' ? 'trop lent' : e?.message ?? 'erreur réseau'})`, 502);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429 && !retried) {
    const wait = Math.min(20, Number(res.headers.get('retry-after')) || 5);
    await sleep(wait * 1000);
    return http(who, url, o, true);
  }
  if (o.binary && res.ok) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return { pdf: btoa(bin), type: res.headers.get('content-type') || 'application/pdf' };
  }
  const text = await res.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  if (res.status === 401 || res.status === 403) throw new CourierError(`${who} refuse les clés API (${errText(data) || res.status}). Vérifiez-les dans Sociétés de livraison.`);
  if (res.status === 429) throw new CourierError(`${who} : trop de demandes, réessayez dans une minute`, 429);
  if (!res.ok) {
    // the courier's whole answer goes to the server log: what the user sees is short, this shows everything
    console.warn(`[courier ${who}] ${o.method ?? (body ? 'POST' : 'GET')} ${url.replace(/[?#].*$/, '')} → ${res.status} ${(typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 2000)}`);
    throw new CourierError(`${who} : ${errText(data) || `erreur ${res.status}`}`);
  }
  return data;
}

/** Throws when a key is missing. */
export function needKeys(c: { name: string; secret: Record<string, string> }, ...keys: string[]) {
  for (const k of keys) if (!String(c.secret[k] ?? '').trim()) throw new CourierError(`Clés API manquantes pour ${c.name} (Sociétés de livraison → ${c.name})`);
}

/** Base URL from settings (or default), without trailing slash, optionally ending with `suffix`. */
export function baseUrl(c: { settings: Record<string, any> }, def: string, suffix = ''): string {
  let b = String(c.settings?.base_url || def).trim().replace(/\/+$/, '');
  if (suffix && !b.endsWith(suffix)) b += suffix;
  return b;
}

/** Boolean setting with default. */
export const flag = (c: { settings: Record<string, any> }, k: string, def: boolean) => {
  const v = c.settings?.[k];
  return v === undefined || v === '' ? def : !!v && v !== 'false';
};

export const cut = (s: unknown, n: number) => String(s ?? '').slice(0, n);
export const splitName = (s: string) => {
  const p = String(s || '').trim().split(/\s+/);
  return { first: p[0] || '-', last: p.slice(1).join(' ') || p[0] || '-' };
};
/** 0661… → +213661… */
export const intl = (p: string | null | undefined) => (p ? '+213' + String(p).replace(/\D/g, '').replace(/^213/, '').replace(/^0/, '') : null);
export const chunks = <T>(a: T[], n: number) => {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
};
export const query = (o: Record<string, unknown>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
/** a_b → "A b" (courier keys shown to people) */
export const humanize = (k: string) => (/^[a-z0-9_]+$/.test(k) ? (k.charAt(0).toUpperCase() + k.slice(1)).replace(/_/g, ' ') : k);
/** Reads a.b.0.c in an object (custom API paths). */
export function getPath(o: any, path: string | undefined): any {
  if (!path) return o;
  let cur = o;
  for (const k of String(path).replace(/\[(-?\d+)\]/g, '.$1').split('.').filter(Boolean)) {
    if (cur == null) return undefined;
    if (Array.isArray(cur) && /^-?\d+$/.test(k)) {
      const i = Number(k);
      cur = cur[i < 0 ? cur.length + i : i];
    } else cur = cur[k];
  }
  return cur;
}

// ---------------------------------------------------------------- fuzzy matching of names (communes, statuses)
const norm = (s: unknown) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9؀-ۿ]+/g, ' ')
    .trim();
const squash = (s: unknown) => norm(s).replace(/\b(el|al|ell|e|d|de|des|du|la|le|les)\b/g, '').replace(/\s+/g, '');

function lev(a: string, b: string) {
  if (!a.length || !b.length) return a.length || b.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

/** Best match of `name` in `list` ("Bab Ezzouar" ↔ "BAB-EZZOUAR", "El Harrach" ↔ "Harrach"), or null when unsure. */
export function bestMatch(name: string, list: string[]): string | null {
  const a = squash(name);
  if (!a) return null;
  const same = list.filter((x) => squash(x) === a);
  if (same.length) return same[0];
  const pre = list.filter((x) => {
    const p = squash(x);
    return p.length >= 3 && a.length >= 4 && (p.startsWith(a) || a.startsWith(p));
  });
  if (pre.length === 1) return pre[0];
  if (a.length >= 5) {
    const d = list.map((x) => ({ x, d: lev(squash(x), a) })).sort((p, q) => p.d - q.d);
    if (d[0] && d[0].d <= (a.length >= 9 ? 2 : 1) && (!d[1] || d[1].d > d[0].d)) return d[0].x;
  }
  return null;
}
