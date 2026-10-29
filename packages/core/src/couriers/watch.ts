// SERVER ONLY (network). Control room › Sociétés de livraison › « Changements API »: what changed at the delivery
// companies since the last look. No shop's data is used and nothing is created at a company. Looked at:
//  1. their public API documentation (ZR, Maystro and Elogistia publish theirs): lines added or removed;
//  2. the open-source code that follows their APIs on GitHub (Vargo, CourierDZ, DZBuild's guides): a change there
//     usually means the company changed its API;
//  3. the addresses Pilotix calls, with made-up keys: one that answers « not found » twice in a row was removed or
//     moved (only for APIs that say « not found » for a wrong address before looking at the keys);
//  4. with the team's test keys (Tests tab, see checkChanges / fieldChanges): a step that stopped working, and fields
//     new or gone in the companies' answers.
// The caller (the server) keeps the memory it gets back and adds what was found to the to-do list.
import type { NewWatchItem } from '../platform/courierWatch';

export interface WatchMemory {
  /** each documentation's lines when last read */
  docs: Record<string, { hash: string; lines: string[]; at: string; misses: number }>;
  /** the last commit seen in each GitHub repository */
  repos: Record<string, { sha: string; date: string }>;
  /** company → « GET /path » → « not found » answers in a row (0: it exists) */
  addresses: Record<string, Record<string, number>>;
  /** company → endpoint → the fields of its answers (and how many looks in a row each one was missing) */
  fields: Record<string, Record<string, { keys: string[]; miss: Record<string, number> }>>;
}

export const emptyWatchMemory = (): WatchMemory => ({ docs: {}, repos: {}, addresses: {}, fields: {} });

/** A memory read back from the database (any shape) made whole. */
export function watchMemoryOf(v: unknown): WatchMemory {
  const m = (v && typeof v === 'object' ? v : {}) as Partial<WatchMemory>;
  const obj = <T>(x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? (x as T) : ({} as T));
  return { docs: obj(m.docs), repos: obj(m.repos), addresses: obj(m.addresses), fields: obj(m.fields) };
}

const UA = 'Mozilla/5.0 (compatible; PilotixWatch/1.0; +https://pilotix.online)';
const STEP: Record<string, string> = {
  connection: 'Connexion',
  fees: 'Tarifs',
  desks: 'Bureaux',
  tracking: 'Suivi',
  parcel: 'Colis de test',
  label: 'Étiquette',
  status: 'Statut',
  cancel: 'Annulation',
};

/** A short hash (FNV-1a, 2 × 32 bits) to tell two versions apart — never to protect anything. */
export function shortHash(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    a = Math.imul(a ^ s.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ s.charCodeAt(i), 0x811c9dc5) >>> 0;
  }
  return a.toString(36) + b.toString(36);
}

async function get(url: string, headers: Record<string, string> = {}, timeout = 25_000): Promise<{ status: number; text: string; headers: Headers }> {
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
  return { status: r.status, text: await r.text(), headers: r.headers };
}

const quote = (l: string, n = 140) => `« ${l.length > n ? `${l.slice(0, n)}…` : l} »`;
/** A documentation line as people read it: « - [Cancel a claim](https://…md): Cancels… » → « Cancel a claim: Cancels… ». */
export const plainLine = (l: string) =>
  l
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[-*#>\s]+/, '')
    .replace(/[*_`]{1,3}([^*_`]+)[*_`]{1,3}/g, '$1')
    .trim() || l;
const some = (ls: string[], n = 4, w = 140) => ls.slice(0, n).map((l) => quote(l, w)).join(' · ') + (ls.length > n ? ` · … (+${ls.length - n})` : '');

// ---------------------------------------------------------------- 1. documentation
export interface WatchDoc {
  id: string;
  company: string;
  label: string;
  /** the page people read */
  link: string;
  /** what is read (an index or full text made for machines when the company offers one) */
  url: string;
  format: 'text' | 'postman';
}

export const WATCH_DOCS: WatchDoc[] = [
  // readme.io: the index of every guide and endpoint page (a new endpoint = a new line)
  { id: 'zr', company: 'zr', label: 'Documentation API ZR Express', link: 'https://docs.zrexpress.app/', url: 'https://docs.zrexpress.app/llms.txt', format: 'text' },
  // GitBook: the whole documentation as text
  {
    id: 'maystro',
    company: 'maystro',
    label: 'Documentation API Maystro',
    link: 'https://maystro.gitbook.io/maystro-delivery-documentation',
    url: 'https://maystro.gitbook.io/maystro-delivery-documentation/llms-full.txt',
    format: 'text',
  },
  // Postman: every request, its parameters and fields
  {
    id: 'elogistia',
    company: 'elogistia',
    label: 'Documentation API Elogistia (Postman)',
    link: 'https://documenter.getpostman.com/view/21600448/2s8YzP14j2',
    url: 'https://documenter.gw.postman.com/api/collections/21600448/2s8YzP14j2?segregateAuth=true&versionTag=latest',
    format: 'postman',
  },
];

/** A documentation as a list of distinct meaningful lines (the same text gives the same lines). */
export function docLines(body: string, format: WatchDoc['format']): string[] {
  if (format === 'postman') {
    let c: unknown = null;
    try {
      c = JSON.parse(body);
    } catch {
      return [];
    }
    return postmanLines(c);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of body.split(/\r?\n/)) {
    const l = raw.replace(/\s+/g, ' ').trim().slice(0, 400);
    if ((l.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < 3 || seen.has(l)) continue;
    seen.add(l);
    out.push(l);
    if (out.length >= 5000) break;
  }
  return out;
}

/** A Postman collection (v2.0 or v2.1): « METHOD /path — name », then its query parameters and body fields. */
function postmanLines(c: any): string[] {
  const out: string[] = [];
  const walk = (items: unknown, path: string, depth: number) => {
    if (!Array.isArray(items) || depth > 8) return;
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      const name = String((it as any).name ?? '').trim();
      if (Array.isArray((it as any).item)) {
        walk((it as any).item, path ? `${path} › ${name}` : name, depth + 1);
        continue;
      }
      const r = (it as any).request;
      if (!r) continue;
      const raw = typeof r === 'string' ? r : typeof r.url === 'string' ? r.url : String(r.url?.raw ?? '');
      const [where, qs = ''] = raw.replace(/^\{\{[^}]+\}\}/, '').replace(/^https?:\/\/[^/]+/, '').split('?');
      const ep = `${String(r.method ?? 'GET').toUpperCase()} ${where || '/'}`;
      out.push(`${ep} — ${path ? `${path} › ` : ''}${name}`);
      const params = new Set<string>();
      for (const p of qs.split('&')) if (p.split('=')[0]) params.add(p.split('=')[0]);
      for (const p of Array.isArray(r.url?.query) ? r.url.query : []) if (p?.key) params.add(String(p.key));
      for (const p of params) out.push(`${ep} · paramètre ${p}`);
      const b = r.body ?? {};
      for (const f of [...(Array.isArray(b.formdata) ? b.formdata : []), ...(Array.isArray(b.urlencoded) ? b.urlencoded : [])]) if (f?.key) out.push(`${ep} · champ ${f.key}`);
      if (typeof b.raw === 'string' && b.raw.trim()) {
        try {
          const j = JSON.parse(b.raw);
          if (j && typeof j === 'object' && !Array.isArray(j)) for (const k of Object.keys(j)) out.push(`${ep} · champ ${k}`);
        } catch {
          /* not JSON */
        }
      }
    }
  };
  walk(c?.item, '', 0);
  return [...new Set(out)];
}

/** What was added to and removed from a documentation, in words. */
export function docDiff(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const b = new Set(before);
  const a = new Set(after);
  return { added: after.filter((l) => !b.has(l)), removed: before.filter((l) => !a.has(l)) };
}

async function lookDoc(d: WatchDoc, mem: WatchMemory, found: NewWatchItem[], fixed: string[], notes: string[]) {
  const prev = mem.docs[d.id];
  const now = new Date().toISOString();
  let r: Awaited<ReturnType<typeof get>>;
  try {
    r = await get(d.url, { Accept: d.format === 'postman' ? 'application/json' : 'text/plain, text/markdown, */*' });
  } catch (e: any) {
    notes.push(`${d.label} : pas de réponse (${e?.name === 'TimeoutError' ? 'trop lent' : e?.message ?? 'erreur réseau'})`);
    return;
  }
  const lines = r.status === 200 ? docLines(r.text, d.format) : [];
  if (!lines.length) {
    // gone for good (twice « not found » in a row after it was read): worth a line; anything else may pass
    const misses = (prev?.misses ?? 0) + 1;
    if (prev) mem.docs[d.id] = { ...prev, misses };
    if (prev?.hash && misses === 2 && (r.status === 404 || r.status === 410))
      found.push({ company: d.company, kind: 'docs', key: `docs:${d.id}:gone`, title: 'La documentation API n’est plus en ligne', detail: `${d.label} : erreur ${r.status} (deux fois de suite).`, link: d.link });
    else notes.push(`${d.label} : ${r.status === 200 ? 'page vide ou illisible' : `erreur ${r.status}`}`);
    return;
  }
  const hash = shortHash(lines.join('\n'));
  mem.docs[d.id] = { hash, lines, at: now, misses: 0 };
  fixed.push(`docs:${d.id}:gone`);
  // the first look only remembers what the documentation says
  if (!prev?.hash || prev.hash === hash) return;
  const { added, removed } = docDiff(prev.lines ?? [], lines);
  if (!added.length && !removed.length) return;
  const words = (ls: string[]) => some(ls.map(plainLine));
  const detail = [added.length ? `Ajouté (${added.length}) : ${words(added)}` : '', removed.length ? `Retiré (${removed.length}) : ${words(removed)}` : ''].filter(Boolean).join('\n');
  found.push({ company: d.company, kind: 'docs', key: `docs:${d.id}:${hash}`, title: 'La documentation API a changé', detail: `${d.label}\n${detail}`, link: d.link });
}

// ---------------------------------------------------------------- 2. open-source code on GitHub
export interface WatchRepo {
  repo: string;
  label: string;
  /** company → the files (or folders, ending with /) that follow its API */
  paths: Record<string, string[]>;
}

export const WATCH_REPOS: WatchRepo[] = [
  {
    repo: 'KaziSTM/vargo',
    label: 'Vargo (code open-source de 90+ sociétés)',
    paths: {
      zr: ['src/Services/Zr/', 'src/Drivers/ZrExpressDriver.php', 'src/Contracts/Zr/'],
      yalidine: ['src/Services/Yalidine/', 'src/Drivers/YalidineExpressDriver.php'],
      guepex: ['src/Drivers/YalidineClones/GuepexExpressDriver.php'],
      yalitec: ['src/Drivers/YalidineClones/YalitecDriver.php'],
      maystro: ['src/Services/Maystro/', 'src/Drivers/MaystroDriver.php'],
      ecotrack: ['src/Services/Ecotrack/', 'src/Drivers/EcotrackDriver.php'],
      noest: ['src/Services/Noest/', 'src/Drivers/NoestDriver.php'],
      zimou: ['src/Services/Zimou/', 'src/Drivers/ZimouExpressDriver.php', 'src/Contracts/Zimou/'],
      elogistia: ['src/Services/Elogistia/', 'src/Drivers/ElogistiaDriver.php'],
      ecom: ['src/Services/EcomDelivery/', 'src/Drivers/EcomDeliveryDriver.php'],
      mdm: ['src/Services/Mdm/', 'src/Drivers/MdmDriver.php', 'src/Contracts/Mdm/'],
      near: ['src/Services/NearDelivery/', 'src/Drivers/NearDeliveryDriver.php'],
      procolis: ['src/Services/Procolis/', 'src/Drivers/ProcolisDriver.php', 'src/Drivers/ProcolisClones/'],
    },
  },
  {
    repo: 'PiteurStudio/CourierDZ',
    label: 'CourierDZ (code open-source)',
    paths: {
      yalidine: ['src/ProviderIntegrations/YalidineProviderIntegration.php', 'src/ShippingProviders/YalidineProvider.php'],
      yalitec: ['src/ShippingProviders/YalitecProvider.php'],
      maystro: ['src/ShippingProviders/MaystroDeliveryProvider.php'],
      ecotrack: ['src/ProviderIntegrations/EcotrackProviderIntegration.php'],
      procolis: ['src/ProviderIntegrations/ProcolisProviderIntegration.php', 'src/ShippingProviders/ZRExpressProvider.php'],
    },
  },
  {
    repo: 'DZBuild-com/dzship',
    label: 'Guides API de DZBuild',
    paths: {
      zr: ['docs/couriers/zr-express.md'],
      yalidine: ['docs/couriers/yalidine.md'],
      maystro: ['docs/couriers/maystro.md'],
      ecotrack: ['docs/couriers/ecotrack.md'],
      noest: ['docs/couriers/noest.md'],
    },
  },
];

class RateLimited extends Error {}

/** Which companies a commit's files are about. */
export function commitCompanies(r: WatchRepo, files: string[], want: Set<string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [company, prefixes] of Object.entries(r.paths)) {
    if (!want.has(company)) continue;
    const hit = files.filter((f) => prefixes.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)));
    if (hit.length) out[company] = hit;
  }
  return out;
}

async function lookRepo(r: WatchRepo, mem: WatchMemory, want: Set<string>, found: NewWatchItem[], token?: string) {
  const h: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'Pilotix-Watch', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const json = async (url: string) => {
    const x = await get(url, h);
    if ((x.status === 403 || x.status === 429) && x.headers.get('x-ratelimit-remaining') === '0') throw new RateLimited('GitHub : limite de lecture atteinte, nouvel essai au prochain passage');
    if (x.status !== 200) throw new Error(`GitHub ${r.repo} : erreur ${x.status}`);
    return JSON.parse(x.text);
  };
  const api = `https://api.github.com/repos/${r.repo}`;
  const prev = mem.repos[r.repo];
  const list = await json(`${api}/commits?per_page=30${prev ? `&since=${encodeURIComponent(prev.date)}` : ''}`);
  if (!Array.isArray(list)) throw new Error(`GitHub ${r.repo} : réponse inattendue`);
  const dateOf = (c: any) => String(c?.commit?.committer?.date ?? c?.commit?.author?.date ?? '');
  // the first look only remembers where the code is
  if (!prev) {
    if (list[0]?.sha) mem.repos[r.repo] = { sha: list[0].sha, date: dateOf(list[0]) };
    return;
  }
  // oldest first, ten at most per look (the next look goes on from there)
  const fresh = list.filter((c: any) => c?.sha && c.sha !== prev.sha && dateOf(c) >= prev.date).reverse().slice(0, 10);
  for (const c of fresh) {
    const d = await json(`${api}/commits/${c.sha}`);
    const files = (Array.isArray(d?.files) ? d.files : []).map((f: any) => String(f?.filename ?? ''));
    const message = String(d?.commit?.message ?? c?.commit?.message ?? '').split('\n')[0].trim();
    for (const [company, hit] of Object.entries(commitCompanies(r, files, want)))
      found.push({
        company,
        kind: 'code',
        key: `code:${r.repo}:${c.sha}:${company}`,
        title: 'Le code open-source qui suit son API a changé',
        detail: `${r.label} : ${quote(message || 'sans message', 160)} — ${hit.length} fichier${hit.length > 1 ? 's' : ''} : ${hit.slice(0, 3).map((f) => f.split('/').pop()).join(', ')}${hit.length > 3 ? '…' : ''}`,
        link: String(c.html_url ?? d?.html_url ?? `https://github.com/${r.repo}/commit/${c.sha}`),
      });
    mem.repos[r.repo] = { sha: c.sha, date: dateOf(c) };
  }
}

// ---------------------------------------------------------------- 3. the API addresses Pilotix calls
export interface WatchAddresses {
  base: string;
  /** made-up keys: every answer refuses them, before anything is done */
  headers: Record<string, string>;
  list: string[];
}

const BEARER = { Authorization: 'Bearer pilotix-watch' };
/** Only APIs that answer « not found » for a wrong address before looking at the keys (checked Oct 2026): the Yalidine
 *  platform refuses the keys first, whatever the address, so its addresses cannot be told apart this way. */
export const WATCH_ADDRESSES: Record<string, WatchAddresses> = {
  zr: {
    base: 'https://api.zrexpress.app/api/v1',
    headers: { 'X-Api-Key': 'pilotix-watch', 'X-Tenant': '00000000-0000-0000-0000-000000000000' },
    list: [
      'GET /users/profile',
      'POST /parcels',
      'POST /parcels/search',
      'POST /parcels/exchange',
      'POST /parcels/labels/multiple/pdf',
      'POST /parcels/labels/individual/pdf',
      'POST /claims',
      'POST /claim-categories/search',
      'POST /territories/search',
      'POST /hubs/search',
      'POST /delivery-pricing/rates',
      'POST /pickup-bags/search',
      'POST /payment-request/search',
      'POST /supplier-payment/search',
      'GET /supplier-payment/supplier-balance',
      'POST /webhooks/endpoints',
      'POST /workflows/search',
      'POST /parcel-modification-requests/phone',
    ],
  },
  maystro: {
    base: 'https://backend.maystro-delivery.com/api',
    headers: { Authorization: 'Token pilotix-watch' },
    list: ['GET /base/wilayas/?country=1', 'POST /stores/orders/', 'GET /stores/orders/1/', 'PATCH /stores/orders/1/', 'GET /stores/history_order/1/', 'POST /delivery/starter/starter_bordureau/', 'GET /stores/hooks/types/', 'GET /stores/hooks/costume/'],
  },
  ecotrack: {
    base: 'https://platform.dhd-dz.com/api/v1',
    headers: BEARER,
    list: [
      'POST /add/maj',
      'POST /ask/for/order/return',
      'POST /create/order',
      'DELETE /delete/order',
      'GET /get/communes?wilaya_id=16',
      'GET /get/fees',
      'GET /get/order/label?tracking=X1',
      'GET /get/orders',
      'GET /get/orders/status',
      'GET /get/tracking/info?tracking=X1',
      'POST /update/order',
      'POST /valid/order',
      'GET /validate/token?api_token=pilotix-watch',
    ],
  },
  noest: {
    base: 'https://app.noest-dz.com/api/public',
    headers: BEARER,
    list: ['POST /add/maj', 'POST /ask/new-tentative', 'POST /ask/return', 'POST /create/order', 'POST /delete/order', 'GET /desks', 'POST /get/trackings/info', 'POST /update/order', 'POST /valid/order', 'GET /get/order/label?tracking=X1', 'GET /fees'],
  },
  zimou: {
    base: 'https://zimou.express/api',
    headers: BEARER,
    list: [
      'GET /v3/user',
      'GET /v3/helpers/communes',
      'GET /v3/helpers/offices',
      'GET /v3/helpers/wilayas',
      'GET /v3/my/prices',
      'POST /v3/packages',
      'DELETE /v3/packages/bulk',
      'POST /v3/packages/labels',
      'POST /v3/packages/mark-as-returned',
      'GET /v3/packages/status',
      'POST /v3/orders/1/comments',
      'PUT /v3/packages/1',
      'GET /v3/packages/1/histories',
      'GET /v3/packages/1',
    ],
  },
  elogistia: {
    base: 'https://api.elogistia.com',
    headers: {},
    list: ['GET /deleteOrder?key=pilotix-watch&tracking=1', 'GET /getManyTracking?key=pilotix-watch&tracking=1', 'GET /getMunicipalities?key=pilotix-watch&wilaya=16', 'GET /getOrders?key=pilotix-watch&tracking=1', 'GET /getTracking?key=pilotix-watch&tracking=1', 'POST /insertCommande?key=pilotix-watch'],
  },
  ecom: {
    base: 'https://ecom-dz.net',
    headers: { Token: 'pilotix-watch', Key: 'pilotix-watch' },
    list: ['GET /Api_v1/Test', 'POST /Api_v1/Colis', 'PUT /Api_v1/Colis/X1', 'PUT /Api_v1/aExp%C3%A9dier', 'PUT /Api_v1/Supprimer', 'GET /Api_v1/Colis/Tracking/X1', 'POST /Api_v1/Colis/Liste', 'GET /Api_v1/Historique/Tracking/X1', 'GET /Api_v1/Commune/16', 'GET /Api_v1/Stopdesk'],
  },
  mdm: {
    base: 'https://api.mdm.express',
    headers: { 'x-api-key': 'pilotix-watch' },
    list: ['GET /api/auth/me', 'GET /api/geo/cities', 'GET /api/geo/countries', 'POST /api/prints/parcel-slips', 'GET /api/prints/files/1', 'POST /api/v2/orders', 'POST /api/v2/orders/search', 'GET /api/v2/shipping/companies/offices', 'GET /api/v2/orders/X1/status-history', 'GET /api/v2/orders/X1'],
  },
  near: {
    base: 'https://api.neardelivery.app/api/v1',
    headers: { ApiKey: 'pilotix-watch', ApiSecret: 'pilotix-watch' },
    list: ['POST /parcels', 'GET /sender/buralists', 'GET /sender/centers', 'GET /sender/delivery-fees', 'GET /sender/wilayas', 'PATCH /parcels/1', 'DELETE /parcels/1', 'GET /sender/parcels/X1', 'GET /sender/parcels/X1/status-history', 'GET /sender/parcels/X1/bordereau'],
  },
  procolis: {
    base: 'https://procolis.com/api_v1',
    headers: { token: 'pilotix-watch', key: 'pilotix-watch' },
    list: ['GET /token', 'POST /add_colis', 'POST /lire', 'POST /tarification'],
  },
};

/** An address that was never there is not « gone » when it is still not there. */
const NEVER = 99;

async function status(base: string, line: string, headers: Record<string, string>): Promise<number | null> {
  const [method, path] = line.split(' ');
  try {
    const r = await fetch(base + path, {
      method,
      headers: { 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
      body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
      signal: AbortSignal.timeout(20_000),
    });
    await r.arrayBuffer().catch(() => null);
    return r.status;
  } catch {
    return null;
  }
}

/** One company's addresses: « not found » twice in a row after being there = removed or moved. */
export async function lookAddresses(company: string, a: WatchAddresses, mem: WatchMemory, found: NewWatchItem[], fixed: string[], notes: string[], pause = 300) {
  // a made-up address first: it must answer « not found », otherwise nothing can be told apart this time
  const control = await status(a.base, 'GET /pilotix-watch-nope-404', a.headers);
  if (control === null) {
    notes.push(`${company} : l’API ne répond pas (adresses non vérifiées)`);
    return;
  }
  if (control !== 404) {
    notes.push(`${company} : l’API ne dit plus « introuvable » pour une fausse adresse (${control}) : adresses non vérifiées`);
    return;
  }
  const seen = (mem.addresses[company] ??= {});
  for (const line of a.list) {
    const s = await status(a.base, line, a.headers);
    if (pause) await new Promise((res) => setTimeout(res, pause));
    if (s === null) continue;
    const key = `gone:${company}:${line.split('?')[0]}`;
    const before = seen[line];
    if (s !== 404) {
      seen[line] = 0;
      fixed.push(key);
      continue;
    }
    const misses = before === undefined || before >= NEVER ? NEVER : before + 1;
    seen[line] = misses;
    if (misses === 2)
      found.push({
        company,
        kind: 'gone',
        key,
        title: 'Une adresse de son API a disparu',
        detail: `${line.split('?')[0]} répond « introuvable » depuis deux passages : la société l’a supprimée ou déplacée. Pilotix s’en sert : à vérifier dans sa documentation, ou demander la nouvelle adresse.`,
        link: null,
      });
  }
}

// ---------------------------------------------------------------- 4. the team's tests (real keys)
export interface CheckLike {
  steps: { step: string; ok: boolean | null; detail: string }[];
}

/** A test step that worked last time and fails now: one line; a step that works again closes its line. */
export function checkChanges(company: string, prev: CheckLike | null | undefined, next: CheckLike): { found: NewWatchItem[]; fixed: string[] } {
  const found: NewWatchItem[] = [];
  const fixed: string[] = [];
  for (const s of next.steps) {
    const key = `broken:${company}:${s.step}`;
    const before = prev?.steps.find((p) => p.step === s.step)?.ok;
    if (s.ok === true) fixed.push(key);
    else if (s.ok === false && before === true)
      found.push({ company, kind: 'broken', key, title: `Le test « ${STEP[s.step] ?? s.step} » ne marche plus`, detail: `Il marchait au test d’avant. Réponse de la société : ${s.detail}`.slice(0, 1200), link: null });
  }
  return { found, fixed };
}

/** The fields of a JSON answer (« data[].tracking », « per_commune.:n.price »), never their values. */
export function jsonShape(v: unknown, max = 300): string[] {
  const out = new Set<string>();
  const walk = (x: unknown, prefix: string, depth: number) => {
    if (depth > 5 || out.size >= max || x === null || typeof x !== 'object') return;
    if (Array.isArray(x)) {
      for (const y of x.slice(0, 30)) walk(y, `${prefix}[]`, depth + 1);
      return;
    }
    for (const [k, y] of Object.entries(x as Record<string, unknown>)) {
      // keys that are numbers or ids (a list keyed by wilaya or by parcel) count as one field
      const name = /^\d+$/.test(k) ? ':n' : /^[0-9a-f-]{16,}$/i.test(k) ? ':id' : k;
      const p = prefix ? `${prefix}.${name}` : name;
      if (out.size < max) out.add(p);
      walk(y, p, depth + 1);
    }
  };
  walk(v, '', 0);
  return [...out].sort();
}

/** « GET /v1/parcels/:id »: the address of an answer without its numbers, ids or query. */
export function endpointOf(method: string, url: string): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split('?')[0];
  }
  // numbers, trackings and ids become « :id »; versions (v1, Api_v1) stay
  const id = (s: string) => /^\d+$/.test(s) || s.length > 24 || (/\d/.test(s) && s.length >= 5 && !/(^|_)v\d+$/i.test(s));
  const parts = path.split('/').map((s) => (id(s) ? ':id' : s));
  return `${method.toUpperCase()} ${parts.join('/') || '/'}`;
}

/**
 * New fields in a company's answers (never seen before) and fields gone (missing three looks in a row): one line each.
 * The first look only remembers the fields.
 */
export function fieldChanges(company: string, mem: WatchMemory, shapes: Record<string, string[]>): NewWatchItem[] {
  const found: NewWatchItem[] = [];
  const known = (mem.fields[company] ??= {});
  for (const [ep, keys] of Object.entries(shapes)) {
    if (!keys.length) continue;
    const prev = known[ep];
    if (!prev) {
      if (Object.keys(known).length < 60) known[ep] = { keys: [...keys], miss: {} };
      continue;
    }
    const now = new Set(keys);
    const had = new Set(prev.keys);
    const added = keys.filter((k) => !had.has(k));
    const gone: string[] = [];
    for (const k of prev.keys) {
      if (now.has(k)) delete prev.miss[k];
      else if ((prev.miss[k] = (prev.miss[k] ?? 0) + 1) >= 3) gone.push(k);
    }
    for (const k of gone) delete prev.miss[k];
    prev.keys = [...prev.keys.filter((k) => !gone.includes(k)), ...added].sort().slice(0, 400);
    const list = (ks: string[]) => `${ks.slice(0, 12).join(', ')}${ks.length > 12 ? ` … (+${ks.length - 12})` : ''}`;
    if (added.length)
      found.push({
        company,
        kind: 'fields',
        key: `fields:${company}:${ep}:+${shortHash(added.join(','))}`,
        title: 'Nouveaux champs dans les réponses de son API',
        detail: `${ep} : ${list(added)}. La société a peut-être ajouté une fonction : à regarder pour Pilotix.`,
        link: null,
      });
    if (gone.length)
      found.push({
        company,
        kind: 'fields',
        key: `fields:${company}:${ep}:-${shortHash(gone.join(','))}`,
        title: 'Des champs ont disparu des réponses de son API',
        detail: `${ep} : ${list(gone)}. Pilotix s’en sert peut-être : à vérifier avec un test complet.`,
        link: null,
      });
  }
  return found;
}

// ---------------------------------------------------------------- the whole look
/**
 * Documentation, open-source code and API addresses of the companies asked for (the removed ones left out by the
 * caller). The tests with keys are run by the caller (they need the saved keys) through checkChanges / fieldChanges.
 */
export async function watchCouriers(i: { companies: string[]; memory: unknown; githubToken?: string; pause?: number }): Promise<{ found: NewWatchItem[]; fixed: string[]; memory: WatchMemory; notes: string[] }> {
  const mem = watchMemoryOf(i.memory);
  const want = new Set(i.companies);
  const found: NewWatchItem[] = [];
  const fixed: string[] = [];
  const notes: string[] = [];
  await Promise.all([
    (async () => {
      for (const d of WATCH_DOCS) if (want.has(d.company)) await lookDoc(d, mem, found, fixed, notes).catch((e) => notes.push(`${d.label} : ${e?.message ?? e}`));
    })(),
    (async () => {
      for (const r of WATCH_REPOS) {
        try {
          await lookRepo(r, mem, want, found, i.githubToken);
        } catch (e: any) {
          notes.push(String(e?.message ?? e).slice(0, 200));
          if (e instanceof RateLimited) break;
        }
      }
    })(),
    ...Object.entries(WATCH_ADDRESSES)
      .filter(([k]) => want.has(k))
      .map(([k, a]) => lookAddresses(k, a, mem, found, fixed, notes, i.pause ?? 300).catch((e) => notes.push(`${k} : ${e?.message ?? e}`))),
  ]);
  return { found, fixed, memory: mem, notes };
}
