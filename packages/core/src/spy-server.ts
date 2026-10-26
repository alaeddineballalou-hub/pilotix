// AI Spy's network side — SERVER ONLY. Loaded by the server as '@pilotix/core/dist/spy-server' and called through
// ctx.server.spy(action, args, ctx). Never imported by the app: the browser preview has seeded ads and no network.
//  - 'search' → { source, key, query, country, max }: one keyword in Facebook's Ad Library through ScrapeCreators or
//    SearchAPI.io (both mirror Facebook's own library data); the key goes in a header, never in a URL
//  - 'media'  → { url }: a competitor's picture as a data URL (Facebook's picture links expire after a few days)
//  - 'site'   → { url }: a competitor's page read once: shop builder, price, crossed price, order form (58 or 69 wilayas)
// Addresses come from ads (other people's data): only public http(s) hosts are fetched, never the server's own network.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AppError, Ctx } from './rpc';
import { builderOf, fromLibrary, pricesIn, RawAd, SpySearchResult, SpySite } from './modules/spy';

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
const privateV4 = (ip: string) => {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
};
const privateV6 = (ip: string) => {
  const s = ip.toLowerCase();
  return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80') || s.startsWith('::ffff:127.') || s.startsWith('::ffff:10.') || s.startsWith('::ffff:192.168.');
};
/** Only public http(s) addresses (the links come from ads: never let one reach the server's own network). */
async function publicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AppError('bad_request', 'Adresse invalide');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new AppError('bad_request', 'Adresse refusée');
  if (u.username || u.password) throw new AppError('bad_request', 'Adresse refusée');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((r) => r.address);
  if (!ips.length || ips.some((ip) => (isIP(ip) === 4 ? privateV4(ip) : privateV6(ip)))) throw new AppError('bad_request', 'Adresse refusée');
  return u;
}

/** GET with at most 4 redirects, each one checked, and a size limit. */
async function fetchPublic(raw: string, accept: string, maxBytes: number): Promise<{ res: Response; body: Uint8Array; url: URL }> {
  let url = await publicUrl(raw);
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'fr-DZ,fr;q=0.9,ar;q=0.8' }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = await publicUrl(new URL(res.headers.get('location') as string, url).toString());
      continue;
    }
    if (!res.ok || !res.body) throw new AppError('bad_request', `Page indisponible (${res.status})`);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
    const body = new Uint8Array(Math.min(size, maxBytes));
    let at = 0;
    for (const c of chunks) {
      body.set(c.subarray(0, Math.max(0, body.length - at)), at);
      at += c.byteLength;
      if (at >= body.length) break;
    }
    return { res, body, url };
  }
  throw new AppError('bad_request', 'Trop de redirections');
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

async function site(a: { url: string }, ctx: Ctx): Promise<SpySite> {
  try {
    const { body, url } = await fetchPublic(a.url, 'text/html,application/xhtml+xml', 1_500_000);
    return readSite(new TextDecoder('utf-8', { fatal: false }).decode(body), url.toString(), ctx.now());
  } catch {
    return { checkedAt: new Date(ctx.now()).toISOString(), ok: false, platform: builderOf(a.url), title: null, price: null, oldPrice: null, whatsapp: false, wilayas: null, stopdesk: false };
  }
}

export async function runSpy(action: string, args: unknown, ctx: Ctx): Promise<unknown> {
  const a = (args ?? {}) as any;
  if (action === 'search') return search(a);
  if (action === 'media') return media(a).catch(() => null);
  if (action === 'site') return site(a, ctx);
  throw new AppError('bad_request', `Action AI Spy inconnue : ${action}`);
}
