// Calls to an address someone typed (a courier's API address, an SMS service, a competitor's page): only the public
// internet, never the server's own network (its database, its private services, the cloud's metadata address).
// - The address is checked when the connection is made, on every IP its name gives: a name that points inside, or
//   that changes to an inside address after a first check (DNS rebinding), is refused.
// - Every redirect is checked the same way (5 at most); a password or key header never follows to another host.
// - IPv4 written inside IPv6 (::ffff:127.0.0.1, ::ffff:7f00:1, 64:ff9b::…, 2002:…) counts as the IPv4 it holds.
// Tests that put their own fetch in place (globalThis.fetch) get it called, after the same address check.
// PILOTIX_ALLOW_PRIVATE_URLS=1 (a server on a private network, development) turns the address checks off.
import type { LookupAddress } from 'node:dns';
import { AppError } from './rpc';

const NATIVE_FETCH = globalThis.fetch;
/** On the server (the demo in the browser has no network of its own to protect, and no node modules). */
const onServer = () => typeof process !== 'undefined' && !!process.versions?.node;
const allowPrivate = () => onServer() && process.env.PILOTIX_ALLOW_PRIVATE_URLS === '1';

/** An IPv4 address of a private, local or reserved network (anything that is not the public internet). */
function private4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const [a, b, c] = p;
  return (
    a === 0 || // « this network »
    a === 10 ||
    a === 127 || // loopback
    a >= 224 || // multicast, reserved, broadcast
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, the cloud's metadata address
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // protocol assignments, documentation
    (a === 192 && b === 88 && c === 99) || // 6to4 relays
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // documentation
    (a === 203 && b === 0 && c === 113) // documentation
  );
}

/** The 8 groups of an IPv6 address (an IPv4 tail turned into the last 2), null when it is not one. */
function groups6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const tail4 = s.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (tail4) {
    const q = tail4.slice(2).map(Number);
    if (q.some((x) => x > 255)) return null;
    s = `${tail4[1]}${((q[0] << 8) | q[1]).toString(16)}:${((q[2] << 8) | q[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array(fill).fill('0'), ...tail];
  if (all.length !== 8 || all.some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return null;
  return all.map((h) => parseInt(h, 16));
}

/** An IPv6 address that is not public: only global unicast (2000::/3) is, and the IPv4 it may hold must be public too. */
function private6(ip: string): boolean {
  const g = groups6(ip);
  if (!g) return true;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  // ::, ::1 and the old « IPv4-compatible » ::a.b.c.d
  if (zeros(6)) return g[6] === 0 ? true : private4(v4(g[6], g[7]));
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-translated ::ffff:0:a.b.c.d
  if (zeros(5) && g[5] === 0xffff) return private4(v4(g[6], g[7]));
  if (zeros(4) && g[4] === 0xffff && g[5] === 0) return private4(v4(g[6], g[7]));
  // NAT64 64:ff9b::a.b.c.d (64:ff9b:1::/48 is for local use)
  if (g[0] === 0x64 && g[1] === 0xff9b) return g[2] !== 0 ? true : private4(v4(g[6], g[7]));
  // 6to4 2002:aabb:ccdd::
  if (g[0] === 0x2002) return private4(v4(g[1], g[2]));
  // Teredo 2001:0::/32, documentation 2001:db8::/32
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0x0db8)) return true;
  return (g[0] & 0xe000) !== 0x2000;
}

/** True for every address that is not the public internet (and for anything that is not an IP address). */
export function privateAddress(ip: string): boolean {
  const s = ip.replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return private4(s);
  if (s.includes(':')) return private6(s);
  return true;
}

const refused = (who: string) => new AppError('bad_request', `${who} : adresse refusée (réseau interne)`);
/** Names that only exist inside a network (and single-word names, which a server resolves inside its own). */
const INSIDE_NAME = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|home\.arpa)$/;

/**
 * The address as a URL when it may be called: http(s), no user or password in it, not a name or an IP of a private
 * network. Its name's IPs are checked again when the connection is made (publicFetch).
 */
export function checkPublicUrl(raw: string, who = 'Adresse'): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AppError('bad_request', `${who} : adresse invalide`);
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) throw new AppError('bad_request', `${who} : adresse refusée`);
  if (allowPrivate()) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    if (privateAddress(host)) throw refused(who);
    return u;
  }
  if (!host.includes('.') || INSIDE_NAME.test(host)) throw refused(who);
  return u;
}

/** The address checked now, with its name looked up (for a clear message when it is saved or tested). */
export async function assertPublicAddress(raw: string, who = 'Adresse'): Promise<URL> {
  const u = checkPublicUrl(raw, who);
  if (allowPrivate()) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return u;
  const { lookup } = await import('node:dns/promises');
  const ips = (await lookup(host, { all: true }).catch(() => [])).map((r) => r.address);
  if (!ips.length) throw new AppError('bad_request', `${who} : adresse introuvable`);
  if (ips.some(privateAddress)) throw refused(who);
  return u;
}

class PrivateAddress extends Error {
  code = 'EPRIVATE';
}

/** dns.lookup for the connection: refuses a name when any of its IPs is not public (what is checked is what is used). */
function pinnedLookup(hostname: string, options: any, cb: (...a: any[]) => void) {
  const opts = typeof options === 'object' && options ? options : {};
  import('node:dns').then((dns) =>
    dns.lookup(hostname, { ...opts, all: true }, (err, list) => {
      if (err) return cb(err);
      const ips = list as unknown as LookupAddress[];
      if (!ips.length) return cb(Object.assign(new Error(`${hostname} introuvable`), { code: 'ENOTFOUND' }));
      if (ips.some((a) => privateAddress(a.address))) return cb(new PrivateAddress(hostname));
      if (opts.all) return cb(null, ips);
      return cb(null, ips[0].address, ips[0].family);
    }),
  );
}

export interface PublicInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | null;
  /** the whole call, redirects included (25 s) */
  timeoutMs?: number;
  /** the most the answer may weigh (20 MB) */
  maxBytes?: number;
  /** redirects followed (5); 0: a redirect answer is returned as it is */
  maxRedirects?: number;
  /** an answer heavier than maxBytes is cut there instead of refused (a web page read for its first part) */
  truncate?: boolean;
}

const SECRET_HEADERS = /^(authorization|cookie|proxy-authorization|x-api-key|api-key|apikey|token|key|x-auth-token)$/i;

/** One request, no redirect followed: the answer as a fetch Response (decompressed, size-limited). */
async function once(url: URL, method: string, headers: Record<string, string>, body: string | Uint8Array | null, deadline: number, maxBytes: number, truncate: boolean): Promise<Response> {
  const mod = url.protocol === 'https:' ? await import('node:https') : await import('node:http');
  const zlib = await import('node:zlib');
  return new Promise<Response>((resolve, reject) => {
    const left = deadline - Date.now();
    if (left <= 0) return reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
    const h: Record<string, string> = { ...headers };
    if (body !== null && !Object.keys(h).some((k) => k.toLowerCase() === 'content-length')) h['Content-Length'] = String(Buffer.byteLength(body));
    const req = mod.request(url, { method, headers: h, ...(allowPrivate() ? {} : { lookup: pinnedLookup as any }) }, (res) => {
      const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
      const stream: NodeJS.ReadableStream =
        enc === 'gzip' || enc === 'x-gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : enc === 'br' ? res.pipe(zlib.createBrotliDecompress()) : res;
      if (stream !== res) res.on('error', reject);
      const chunks: Buffer[] = [];
      let size = 0;
      let cut = false;
      const finish = () => {
        clearTimeout(timer);
        const out = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined || k === 'content-encoding' || k === 'content-length') continue;
          for (const x of Array.isArray(v) ? v : [v]) out.append(k, String(x));
        }
        const status = res.statusCode && res.statusCode >= 200 && res.statusCode <= 599 ? res.statusCode : 502;
        const empty = [204, 205, 304].includes(status) || method === 'HEAD';
        const r = new Response(empty ? null : Buffer.concat(chunks), { status, statusText: res.statusMessage ?? '', headers: out });
        Object.defineProperty(r, 'url', { value: url.toString() });
        resolve(r);
      };
      stream.on('data', (c: Buffer) => {
        if (cut) return;
        if (size + c.length > maxBytes) {
          // too heavy: refused, or cut there (truncate); the rest is not read
          cut = true;
          if (truncate) {
            chunks.push(c.subarray(0, maxBytes - size));
            size = maxBytes;
            finish();
          } else {
            clearTimeout(timer);
            reject(Object.assign(new Error('Réponse trop lourde'), { code: 'ETOOBIG' }));
          }
          res.destroy();
          return;
        }
        size += c.length;
        chunks.push(c);
      });
      stream.on('error', (e) => (cut ? undefined : reject(e)));
      stream.on('end', () => (cut ? undefined : finish()));
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), left);
    // (an error after the answer was settled changes nothing: a promise settles once)
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    if (body !== null) req.write(body);
    req.end();
  });
}

/**
 * fetch for an address someone typed: public internet only (checked on the IPs really connected to, redirects
 * included), a time limit and a size limit. `who` names the service in the messages (« Service SMS : adresse refusée »).
 */
export async function publicFetch(raw: string, init: PublicInit = {}, who = 'Adresse'): Promise<Response> {
  let url = checkPublicUrl(raw, who);
  let method = (init.method ?? 'GET').toUpperCase();
  let headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body: string | Uint8Array | null = init.body ?? null;
  const deadline = Date.now() + (init.timeoutMs ?? 25_000);
  const maxBytes = init.maxBytes ?? 20 * 1024 * 1024;
  const maxRedirects = init.maxRedirects ?? 5;
  // a test's own fetch (or the demo in the browser): called for each address checked here
  const stand = globalThis.fetch !== NATIVE_FETCH || !onServer();
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = stand
        ? await globalThis.fetch(url.toString(), { method, headers, ...(body !== null ? { body: body as any } : {}), redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) })
        : await once(url, method, headers, body, deadline, maxBytes, !!init.truncate);
    } catch (e: any) {
      if (e instanceof PrivateAddress || e?.code === 'EPRIVATE') throw refused(who);
      if (e?.code === 'ETOOBIG') throw new AppError('bad_request', `${who} : réponse trop lourde`);
      throw e;
    }
    const to = res.headers.get('location');
    if (!(res.status >= 300 && res.status < 400 && to) || hop >= maxRedirects) return res;
    const next = checkPublicUrl(new URL(to, url).toString(), who);
    // a key or a password never goes to another host
    if (next.host !== url.host) headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !SECRET_HEADERS.test(k)));
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      method = 'GET';
      body = null;
      headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^content-(type|length)$/i.test(k)));
    }
    url = next;
  }
}
