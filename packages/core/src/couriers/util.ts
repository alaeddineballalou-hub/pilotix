// HTTP and text helpers for the courier adapters (server only: global fetch).
import { communesOf } from '@pilotix/shared';
import { AppError } from '../rpc';
import { assertPublicAddress, publicFetch } from '../publicfetch';

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
  /** an address a shop typed itself (« API personnalisée »): never a redirect (every address is public-only anyway) */
  publicOnly?: boolean;
}

// ---------------------------------------------------------------- addresses a shop types (never the server's own network)
/** Refuses an address that is not public http(s) (a shop's « API personnalisée » must never reach the server's network). */
export async function assertPublicUrl(who: string, raw: string): Promise<void> {
  try {
    await assertPublicAddress(raw, who);
  } catch (e: any) {
    throw new CourierError(e?.message ?? `${who} : adresse de l’API refusée`, 400);
  }
}

/**
 * Control room tests only: each JSON answer of one company (by the name its test runs under, never a shop's company),
 * handed to the test so it can note the answer's fields — never their values.
 */
const answerWatchers = new Map<string, (method: string, url: string, data: unknown) => void>();
export function watchAnswers(who: string, fn: (method: string, url: string, data: unknown) => void): () => void {
  answerWatchers.set(who, fn);
  return () => answerWatchers.delete(who);
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
  let res: Response;
  try {
    // every courier address (a company's own, one a shop typed in its settings, an « API personnalisée »): public
    // internet only, checked on the IPs really connected to, redirects included
    res = await publicFetch(url, { method: o.method ?? (body ? 'POST' : 'GET'), headers, body: body ?? null, timeoutMs: o.timeout ?? 25_000, maxRedirects: o.publicOnly ? 0 : 5 }, who);
  } catch (e: any) {
    if (e instanceof AppError) throw new CourierError(e.message, 400);
    throw new CourierError(`${who} ne répond pas (${e?.name === 'AbortError' || e?.name === 'TimeoutError' ? 'trop lent' : e?.message ?? 'erreur réseau'})`, 502);
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
  const watcher = answerWatchers.get(who);
  if (watcher && data && typeof data === 'object') {
    try {
      watcher(o.method ?? (body ? 'POST' : 'GET'), url, data);
    } catch {
      /* a test's note never breaks the call */
    }
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
/** The same name once accents, case, spaces and little words are left aside (« Ne répond pas 3 » = « ne repond pas 3 »). */
export const sameName = (a: unknown, b: unknown) => !!squash(a) && squash(a) === squash(b);

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

/**
 * A commune's name as it sounds: doubled letters as one, a mute « e » at the end, and the few ways Algerian names are
 * written in French letters (« dj » / « j », « ou » / « u », « q » / « k », « y » / « i », « sh » / « ch »). « Azzefoun »,
 * « Azeffoun » and « azefoune » sound the same. Inside one wilaya no two communes of Pilotix's list share one (all 1,541
 * checked on 22 Nov 2026).
 */
export function soundKey(s: unknown): string {
  return squash(s)
    .replace(/([a-z])\1+/g, '$1')
    .replace(/dj/g, 'j')
    .replace(/ou/g, 'u')
    .replace(/q/g, 'k')
    .replace(/y/g, 'i')
    .replace(/sh/g, 'ch')
    .replace(/([a-z])\1+/g, '$1')
    .replace(/([^aeiou])e$/, '$1');
}

/** Arabic written one way: its letters only (NFKC for the old « presentation » letters), one alef, one ya, ه for ة, no
 *  hamza seat, short vowels, tatweel or spaces; ڨ / ڤ as ق / ف. */
export function arKey(s: unknown): string {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[ءؤئ]/g, '')
    .replace(/ڨ/g, 'ق')
    .replace(/ڤ/g, 'ف')
    .replace(/[^\u0621-\u064A]/g, '');
}
const isArabic = (s: string) => /[\u0600-\u06FF]/.test(s);

/** A company's list of communes is read again after an hour (a commune it removed is seen then)... */
export const LIST_KEPT_MS = 3600_000;
/** ...and at once when the order's commune is not on it (a commune it just added is found), at most once a minute. */
export const ASK_AGAIN_MS = 60_000;
/** The clock of those lists (tests move it forward). */
export const listClock = { now: () => Date.now() };

/** A commune's name, and its Arabic name when known. */
export interface CommuneName {
  name: string;
  ar?: string | null;
}

/** Pilotix's own communes of a wilaya (French and Arabic names: the landing page shows the Arabic one). */
export const ourCommunes = (wilayaId: number): CommuneName[] => communesOf(wilayaId).map(([, name, ar]) => ({ name, ar }));

/** Pilotix's commune for a name (the same name, or the same sound; an Arabic name: the same Arabic name). */
function ourOne(name: string, ours: CommuneName[]): CommuneName | undefined {
  if (isArabic(name)) return ours.find((o) => o.ar && arKey(o.ar) === arKey(name));
  const a = squash(name);
  if (!a) return undefined;
  return ours.find((o) => squash(o.name) === a) ?? ours.find((o) => soundKey(o.name) === soundKey(name));
}

/**
 * The delivery company's commune for ours, found by Pilotix alone, for every company (22 Nov 2026, the owner: nobody
 * fixes a commune by hand). `list`: the company's communes of the wilaya; `wilayaId`: where (Pilotix's own list).
 *  1. the same name (« BAB-EZZOUAR » = « Bab Ezzouar »);
 *  2. the same sound (« Azzefoun » = « Azeffoun » = « azefoune »);
 *  3. the same Arabic name — the one the customer picks on the landing page, when the company gives Arabic names (ZR:
 *     « Beni Zmenzer » is أيت زمنزر in Arabic, ZR writes it « Ait Zmenzer »);
 *  4. close enough (the start of the name, a letter or two: bestMatch).
 * Never a name the company has for ANOTHER commune of Pilotix's list (« Ait Yahia » is not « Ait Yahia Moussa »): a
 * parcel sent to the wrong town is worse than one stopped before « Confirmer ». Two names that fit: none.
 */
export function matchCommune<T extends CommuneName>(name: string, list: T[], wilayaId: number | null): T | null {
  const want = String(name ?? '').trim();
  if (!want || !list.length) return null;
  const ours = wilayaId ? ourCommunes(wilayaId) : [];
  const self = ourOne(want, ours);
  const others = ours.filter((o) => o !== self);
  const ar = isArabic(want) ? want : (self?.ar ?? '');
  /** this company name is another commune of ours */
  const other = (x: T) =>
    others.some((o) => squash(o.name) === squash(x.name) || soundKey(o.name) === soundKey(x.name) || (!!o.ar && !!x.ar && arKey(o.ar) === arKey(x.ar)));
  const one = (c: T[]) => {
    const u = [...new Set(c)];
    return u.length === 1 && !other(u[0]) ? u[0] : null;
  };
  if (!isArabic(want)) {
    const a = squash(want);
    const same = list.find((x) => squash(x.name) === a);
    if (same) return same;
    const k = soundKey(want);
    const s = k.length >= 3 ? one(list.filter((x) => soundKey(x.name) === k)) : null;
    if (s) return s;
  }
  const k = arKey(ar);
  if (k.length >= 2) {
    const r = one(list.filter((x) => !!x.ar && arKey(x.ar) === k));
    if (r) return r;
  }
  if (isArabic(want)) return null;
  const close = bestMatch(want, list.map((x) => x.name));
  const hit = close ? list.find((x) => x.name === close) : undefined;
  return hit && !other(hit) ? hit : null;
}

/** The names of `list` closest to `name` (fewest letters to change, at most a third of it): « did you mean ». */
export function nearest(name: string, list: string[], n = 2): string[] {
  const a = squash(name);
  if (!a) return [];
  const most = Math.max(2, Math.ceil(a.length / 3));
  return list
    .map((x) => ({ x, d: lev(squash(x), a) }))
    .filter((r) => r.d <= most)
    .sort((p, q) => p.d - q.d)
    .slice(0, n)
    .map((r) => r.x);
}

/**
 * The weight a company found for a parcel, in its tracking answer (kg): the real / billed weight first, else the parcel's
 * weight (it writes the one it weighed there). null when the answer has none. Grams (« 6500 ») are read as kilos.
 */
const WEIGHT_KEYS = ['real_weight', 'weight_real', 'actual_weight', 'billable_weight', 'billed_weight', 'effective_weight', 'poids_reel', 'poids_facture', 'weight', 'poids', 'weight_kg', 'kg'];
export function weightIn(...objs: unknown[]): number | null {
  for (const o of objs) {
    if (!o || typeof o !== 'object') continue;
    for (const k of WEIGHT_KEYS) {
      const raw = (o as any)[k];
      const v = typeof raw === 'string' ? Number(raw.replace(',', '.').replace(/[^\d.]/g, '')) : Number(raw);
      if (raw === null || raw === undefined || raw === '' || !isFinite(v) || v <= 0) continue;
      return v >= 500 ? Math.round(v / 100) / 10 : v;
    }
  }
  return null;
}
/** A price a company wrote for this parcel (DA): the first of these keys it gives; 0 is a price (a free return). */
export function priceIn(keys: string[], ...objs: unknown[]): number | null {
  for (const o of objs) {
    if (!o || typeof o !== 'object') continue;
    for (const k of keys) {
      const raw = (o as any)[k];
      if (raw === null || raw === undefined || raw === '') continue;
      const v = typeof raw === 'string' ? Number(raw.replace(/\s/g, '').replace(',', '.').replace(/[^\d.]/g, '')) : Number(raw);
      if (isFinite(v) && v >= 0) return Math.round(v);
    }
  }
  return null;
}
const DELIVERY_KEYS = ['delivery_fee', 'delivery_price', 'deliveryPrice', 'shipping_fee', 'frais_livraison', 'tarif_livraison'];
const RETURN_KEYS = ['return_fee', 'return_price', 'returnPrice', 'retour_fee', 'frais_retour', 'tarif_retour', 'taxe_retour'];
/**
 * What a tracking answer says the company charges for this parcel: its delivery price, its return price (0: a free
 * return) and the weight it found — counted instead of the price list and of the products' weight.
 */
export const weighed = (...objs: unknown[]) => {
  const kg = weightIn(...objs);
  const delivery = priceIn(DELIVERY_KEYS, ...objs);
  const ret = priceIn(RETURN_KEYS, ...objs);
  return kg === null && delivery === null && ret === null ? {} : { costs: { delivery, ret, kg } };
};
