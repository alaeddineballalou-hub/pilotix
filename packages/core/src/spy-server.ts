// AI Spy's network side — SERVER ONLY. Loaded by the server as '@pilotix/core/dist/spy-server' and called through
// ctx.server.spy(action, args, ctx). Never imported by the app: the browser preview has seeded ads and no network.
//  - 'search' → { source, key, query, country, max }: one keyword in Facebook's Ad Library through ScrapeCreators or
//    SearchAPI.io (both mirror Facebook's own library data); the key goes in a header, never in a URL
//  - 'media'  → { url }: a competitor's picture as a data URL (Facebook's picture links expire after a few days)
//  - 'site'   → { url }: a competitor's page read once: shop builder, price, crossed price, order form (58 or 69 wilayas)
//    never forced: the site's « no robots » rule (robots.txt) is followed, and a protection wall against robots (Cloudflare's
//    check, DDoS-Guard…) is taken as a no: one try, nothing to get round it, the reason kept (SpySite.blocked)
// Addresses come from ads (other people's data): only public http(s) hosts are fetched, never the server's own network.
import { AppError, Ctx } from './rpc';
import { publicFetch } from './publicfetch';
import { builderOf, fromLibrary, pricesIn, RawAd, SpySearchResult, SpySite, SpySiteBlock } from './modules/spy';

const UA = 'Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const LABEL = { scrapecreators: 'ScrapeCreators', searchapi: 'SearchAPI.io' } as const;

async function getJson(url: string, headers: Record<string, string>, label: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(45_000) });
  } catch {
    throw new AppError('bad_request', `${label} injoignable. Réessayez plus tard.`);
  }
  const data: any = await res.json().catch(() => null);
  if (res.status === 401 || res.status === 403) throw new AppError('bad_request', `${label} refuse la clé : vérifiez-la dans AI Spy › Réglages.`);
  if (res.status === 402) throw new AppError('bad_request', `${label} : crédits épuisés.`);
  if (res.status === 429) throw new AppError('conflict', `${label} limite les demandes pour l’instant : réessayez plus tard.`);
  if (!res.ok || !data) throw new AppError('bad_request', `${label} : ${data?.error ?? data?.message ?? res.statusText}`);
  return data;
}

/** Every library item in a provider's answer, wherever its list is (searchResults, ads, edges › node › collated_results…). */
export function libraryItems(data: unknown, out: any[] = [], depth = 0): any[] {
  if (!data || typeof data !== 'object' || depth > 8) return out;
  if (Array.isArray(data)) {
    for (const x of data) libraryItems(x, out, depth + 1);
    return out;
  }
  const o = data as Record<string, unknown>;
  if ('ad_archive_id' in o || 'adArchiveID' in o) {
    out.push(o);
    return out;
  }
  for (const v of Object.values(o)) if (v && typeof v === 'object') libraryItems(v, out, depth + 1);
  return out;
}
const totalOf = (d: any): number | null => {
  const v = d?.searchResultsCount ?? d?.search_results_count ?? d?.search_information?.total_results ?? d?.count ?? d?.total;
  return Number.isFinite(Number(v)) ? Number(v) : null;
};

async function search(a: { source: 'scrapecreators' | 'searchapi'; key: string; query: string; country: string; max: number }): Promise<SpySearchResult> {
  const country = /^[A-Z]{2}$/.test(a.country) ? a.country : 'DZ';
  const q = a.query.trim().slice(0, 60);
  if (!q) throw new AppError('bad_request', 'Mot-clé vide');
  let data: any;
  if (a.source === 'scrapecreators') {
    const p = new URLSearchParams({ query: q, country, status: 'ACTIVE', ad_type: 'all', media_type: 'ALL' });
    data = await getJson(`https://api.scrapecreators.com/v1/facebook/adLibrary/search/ads?${p}`, { 'x-api-key': a.key }, LABEL.scrapecreators);
  } else {
    const p = new URLSearchParams({ engine: 'meta_ad_library', q, country, ad_type: 'all', active_status: 'active' });
    data = await getJson(`https://www.searchapi.io/api/v1/search?${p}`, { Authorization: `Bearer ${a.key}` }, LABEL.searchapi);
  }
  const seen = new Set<string>();
  const ads: RawAd[] = [];
  for (const it of libraryItems(data)) {
    const ad = fromLibrary(it);
    if (!ad || seen.has(ad.id)) continue;
    seen.add(ad.id);
    ads.push(ad);
    if (ads.length >= Math.max(1, Math.min(100, a.max))) break;
  }
  return { count: totalOf(data) ?? ads.length, ads };
}

// ---------------------------------------------------------------- fetching other people's addresses safely
/**
 * GET with at most 4 redirects and a size limit (a longer page is cut): only public http(s) addresses, checked on the
 * IPs really connected to (the links come from ads: never let one reach the server's own network).
 */
async function fetchPublic(raw: string, accept: string, maxBytes: number): Promise<{ res: Response; body: Uint8Array; url: URL }> {
  const res = await publicFetch(raw, { headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'fr-DZ,fr;q=0.9,ar;q=0.8' }, timeoutMs: 15_000, maxBytes, maxRedirects: 4, truncate: true });
  if (!res.ok || !res.body) throw new AppError('bad_request', `Page indisponible (${res.status})`);
  const body = new Uint8Array(await res.arrayBuffer()).slice(0, maxBytes);
  return { res, body, url: new URL(res.url || raw) };
}

async function media(a: { url: string }): Promise<string | null> {
  const { res, body } = await fetchPublic(a.url, 'image/*', 600_000);
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  if (!/^image\/(jpeg|png|webp|gif)$/.test(type) || body.length >= 600_000 || body.length < 200) return null;
  return `data:${type};base64,${Buffer.from(body).toString('base64')}`;
}

const FOOTPRINTS: [RegExp, string][] = [
  [/dzbuild/i, 'DZBuild'],
  [/ayor\.ai|ayor-/i, 'Ayor'],
  [/cdn\.shopify|Shopify\.theme|myshopify/i, 'Shopify'],
  [/youcan/i, 'YouCan'],
  [/lightfunnels/i, 'LightFunnels'],
  [/tassyir/i, 'Tassyir'],
  [/justsell/i, 'JustSell'],
  [/myecomsite/i, 'MyEcomSite'],
  [/foorweb/i, 'Foorweb'],
  [/hanotify/i, 'Hanotify'],
  [/woocommerce|wp-content/i, 'WordPress'],
  [/wixstatic|wix\.com/i, 'Wix'],
];

/** Reads a competitor's page once: builder, price (and crossed price), WhatsApp, the order form. */
export function readSite(html: string, url: string, now: number): SpySite {
  const title = (/<title[^>]*>([^<]{0,200})/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim() || null;
  const text = html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ');
  const platform = builderOf(url) ?? FOOTPRINTS.find(([re]) => re.test(html))?.[1] ?? null;
  // the first price block of the page is the product's (« 11,900.00 دج 15,000.00 دج »)
  const head = text.slice(0, 6000);
  const pr = pricesIn(head);
  const nums = [...head.matchAll(/(\d{1,3}(?:[\s.,]\d{3})+|\d{3,6})(?:[.,]00)?\s*(?:دج|د\.ج|DZD|DA)(?![a-zA-Z])/g)].map((m) => Number(m[1].replace(/[\s.,]/g, ''))).filter((v) => v >= 300 && v <= 400_000);
  let price = pr.price;
  let oldPrice = pr.old;
  if (!oldPrice && nums.length >= 2 && nums[0] !== nums[1]) {
    price = Math.min(nums[0], nums[1]);
    oldPrice = Math.max(nums[0], nums[1]);
  }
  const json = /"(?:price|sale_price|salePrice|selling_price)"\s*:\s*"?(\d{3,6})(?:\.\d+)?"?/.exec(html);
  if (!price && json) price = Number(json[1]);
  const sel = /<select[^>]*(?:wilaya|state|province|willaya)[^>]*>([\s\S]*?)<\/select>/i.exec(html);
  const options = sel ? (sel[1].match(/<option/gi) ?? []).length : 0;
  const wilayas = options >= 48 ? (options >= 66 ? 69 : 58) : /69\s*(?:ولاية|wilaya)/i.test(text) ? 69 : /58\s*(?:ولاية|wilaya)/i.test(text) ? 58 : null;
  return {
    checkedAt: new Date(now).toISOString(),
    ok: true,
    platform,
    title,
    price: price ?? null,
    oldPrice: oldPrice ?? null,
    whatsapp: /wa\.me\/|api\.whatsapp\.com/i.test(html),
    wilayas,
    stopdesk: /stop\s*-?desk|bureau de livraison|توصيل (?:إلى|الى) المكتب|مكتب شركة التوصيل/i.test(text),
  };
}

// ---------------------------------------------------------------- a site's « no robots » rule and its protection wall
/** Pilotix's robot in a site's robots.txt: its own rules when the site names « PilotixSpy », else the ones for every robot (*). */
export const ROBOT_NAME = 'PilotixSpy';

const decode = (s: string) => {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
};
const escRe = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/**
 * May the robot `agent` read `path` (its query included) under these robots.txt rules? (RFC 9309: the groups that name
 * the robot, else the « * » ones; the longest matching rule decides, Allow wins a tie; « * » is anything, a final « $ »
 * the end of the address; « Disallow: » with nothing after forbids nothing.)
 */
export function robotsAllow(txt: string, path: string, agent = ROBOT_NAME): boolean {
  type Group = { agents: string[]; rules: { allow: boolean; pat: string }[] };
  const groups: Group[] = [];
  let cur: Group | null = null;
  let agentLine = false;
  for (const raw of txt.split(/\r\n|\r|\n/)) {
    const m = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/.exec(raw.replace(/#.*$/, ''));
    if (!m) continue;
    const field = m[1].toLowerCase();
    if (field === 'user-agent') {
      if (!cur || !agentLine) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(m[2].toLowerCase());
      agentLine = true;
      continue;
    }
    agentLine = false;
    if (!cur || (field !== 'allow' && field !== 'disallow')) continue;
    if (field === 'disallow' && m[2] === '') continue;
    cur.rules.push({ allow: field === 'allow', pat: m[2] });
  }
  const name = agent.toLowerCase();
  const own = groups.filter((g) => g.agents.includes(name));
  const rules = (own.length ? own : groups.filter((g) => g.agents.includes('*'))).flatMap((g) => g.rules);
  const p = decode(path || '/');
  let best: { allow: boolean; len: number } | null = null;
  for (const r of rules) {
    const pat = decode(r.pat);
    const end = pat.endsWith('$');
    const body = end ? pat.slice(0, -1) : pat;
    if (!new RegExp(`^${body.split('*').map(escRe).join('.*')}${end ? '$' : ''}`).test(p)) continue;
    if (!best || pat.length > best.len || (pat.length === best.len && r.allow)) best = { allow: r.allow, len: pat.length };
  }
  return !best || best.allow;
}

/**
 * A protection wall against robots instead of the page: Cloudflare's check (« Just a moment… », cf-mitigated), a
 * « too many visits » answer, DDoS-Guard, Sucuri, a captcha page.
 */
export function wallIn(status: number, headers: { get(name: string): string | null }, html: string): boolean {
  if ((headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge' || status === 429) return true;
  const head = html.slice(0, 30_000);
  const marks = /challenge-platform|cf-chl-|cf_chl_|__cf_chl|Just a moment\.\.\.|Attention Required! \| Cloudflare|cf-browser-verification|ddos-guard|Sucuri WebSite Firewall|captcha-delivery|px-captcha|hcaptcha\.com\/1\/api|g-recaptcha/i;
  if (status === 403) return marks.test(head) || /cloudflare|ddos-guard|sucuri/i.test(headers.get('server') ?? '');
  if (status === 503) return marks.test(head);
  // a « 200 » that is only the check page
  return status >= 200 && status < 300 && /<title>\s*(Just a moment\.\.\.|Attention Required! \| Cloudflare|DDoS-Guard|One moment, please\.\.\.)/i.test(head);
}

const ROBOTS_TTL = 6 * 3_600_000;
const robotsCache = new Map<string, { at: number; txt: string | null; down: boolean }>();

/** A site's robots.txt, read at most once every 6 hours (null: none, nothing forbidden; down: no answer, wait). */
async function robotsOf(origin: string, now: number): Promise<{ txt: string | null; down: boolean }> {
  const known = robotsCache.get(origin);
  if (known && now - known.at < ROBOTS_TTL) return known;
  let out: { txt: string | null; down: boolean };
  try {
    const res = await publicFetch(`${origin}/robots.txt`, { headers: { 'User-Agent': UA, Accept: 'text/plain,*/*;q=0.5' }, timeoutMs: 10_000, maxBytes: 500_000, maxRedirects: 4, truncate: true });
    if (res.ok) out = { txt: new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(await res.arrayBuffer()).slice(0, 500_000)), down: false };
    // no file (or a file the site keeps to itself): nothing forbidden; the site's trouble or « too many »: not now
    else if (res.status >= 400 && res.status < 500 && res.status !== 429) out = { txt: null, down: false };
    else out = { txt: null, down: true };
  } catch {
    out = { txt: null, down: true };
  }
  if (robotsCache.size >= 1000) robotsCache.clear();
  robotsCache.set(origin, { at: now, ...out });
  return out;
}

async function site(a: { url: string }, ctx: Ctx): Promise<SpySite> {
  const now = ctx.now();
  const no = (blocked: SpySiteBlock): SpySite => ({
    checkedAt: new Date(now).toISOString(),
    ok: false,
    blocked,
    platform: builderOf(a.url),
    title: null,
    price: null,
    oldPrice: null,
    whatsapp: false,
    wilayas: null,
    stopdesk: false,
  });
  let url: URL;
  try {
    url = new URL(a.url);
  } catch {
    return no('down');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return no('down');
  // the site's « no robots » rule first: a page it keeps from robots is never asked for
  const robots = await robotsOf(url.origin, now);
  if (robots.down) return no('down');
  if (robots.txt !== null && !robotsAllow(robots.txt, url.pathname + url.search)) return no('robots');
  let res: Response;
  let html: string;
  try {
    res = await publicFetch(a.url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'fr-DZ,fr;q=0.9,ar;q=0.8' }, timeoutMs: 15_000, maxBytes: 1_500_000, maxRedirects: 4, truncate: true });
    html = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(await res.arrayBuffer()).slice(0, 1_500_000));
  } catch {
    return no('down');
  }
  // one try: a wall against robots is a no, never got round
  if (wallIn(res.status, res.headers, html)) return no('wall');
  if (!res.ok) return no('down');
  // sent on to another site: that site's rule counts too
  let final = url;
  try {
    if (res.url) final = new URL(res.url);
  } catch {
    /* the address asked for */
  }
  if (final.origin !== url.origin) {
    const theirs = await robotsOf(final.origin, now);
    if (theirs.txt !== null && !robotsAllow(theirs.txt, final.pathname + final.search)) return no('robots');
  }
  return readSite(html, final.toString(), now);
}

export async function runSpy(action: string, args: unknown, ctx: Ctx): Promise<unknown> {
  const a = (args ?? {}) as any;
  if (action === 'search') return search(a);
  if (action === 'media') return media(a).catch(() => null);
  if (action === 'site') return site(a, ctx);
  throw new AppError('bad_request', `Action AI Spy inconnue : ${action}`);
}
