// Meta Ads (Marketing API v26.0) — SERVER ONLY. Loaded by the server as '@pilotix/core/dist/meta' and called through
// ctx.server.meta(action, args, ctx). Never imported by the app: the browser demo uses the seeded tables instead.
// The access token is read from the settings table (written by admin.meta.save) and never leaves the server.
import { createHash } from 'node:crypto';
import { getSetting } from './settings';
import { getRaw, META_TOKEN_KEY } from './modules/admin';
import type { LaunchPlan } from './modules/pilotads';
import { AppError, Ctx } from './rpc';

/** Meta's current Marketing API (v21.0 ended for ads on 9 Sep 2025; v26.0 came out on 29 Jul 2026). */
const GRAPH = 'https://graph.facebook.com/v26.0';
/** The Conversions API (landing pages' events): a recent version, supported until mid-2028. */
const GRAPH_CAPI = 'https://graph.facebook.com/v25.0';

/**
 * Sends events to a pixel through the Conversions API (landing pages: Purchase of real orders, InitiateCheckout of
 * abandoned ones). The token goes in the body, never in a URL; a hanging Meta never holds the job more than 15 s.
 */
async function sendCapi(a: { pixelId: string; token: string; events: unknown[]; testEventCode?: string }): Promise<{ received: number; trace: string | null }> {
  if (!/^\d{5,20}$/.test(a.pixelId)) throw new AppError('bad_request', 'Pixel Meta invalide');
  if (!a.token) throw new AppError('bad_request', 'Jeton Conversions API manquant');
  let res: Response;
  try {
    res = await fetch(`${GRAPH_CAPI}/${a.pixelId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ data: a.events, access_token: a.token, ...(a.testEventCode ? { test_event_code: a.testEventCode } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new AppError('bad_request', 'Meta injoignable. Réessayez plus tard.');
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    const e = data?.error;
    if (e?.code === 190) throw new AppError('bad_request', 'Jeton Conversions API expiré ou révoqué : changez-le dans Landing pages › Réglages.');
    if (e?.code === 4 || e?.code === 17 || e?.code === 613 || res.status === 429) throw new AppError('conflict', 'Meta limite les demandes pour l’instant.');
    throw new AppError('bad_request', `Meta : ${e?.error_user_msg ?? e?.message ?? res.statusText}`);
  }
  return { received: Number(data?.events_received ?? 0), trace: data?.fbtrace_id ? String(data.fbtrace_id) : null };
}

/** The dataset of each Page / Instagram account (Meta gives back the same one every time: kept for the server's life). */
const chatDatasets = new Map<string, string>();

/** Meta's refusal of a chat event, sorted like sendCapi's (a permission not granted yet waits: it comes with App Review). */
function chatError(res: Response, data: any): AppError {
  const e = data?.error;
  if (e?.code === 190) return new AppError('bad_request', 'Jeton de la Page expiré ou révoqué : liez le compte à nouveau (Pilot AI › Comptes).');
  if (e?.code === 4 || e?.code === 17 || e?.code === 613 || res.status === 429) return new AppError('conflict', 'Meta limite les demandes pour l’instant.');
  if (e?.code === 10 || e?.code === 200 || /permission/i.test(String(e?.message ?? '')))
    return new AppError('bad_request', 'Meta n’a pas encore accordé page_events / instagram_manage_events à Pilotix : réessayez après l’App Review.');
  return new AppError('bad_request', `Meta : ${e?.error_user_msg ?? e?.message ?? res.statusText}`);
}

async function graphPost(url: string, body: Record<string, unknown>): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new AppError('bad_request', 'Meta injoignable. Réessayez plus tard.');
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) throw chatError(res, data);
  return data;
}

/**
 * Sends the Purchases of chat orders (Conversions API for Business Messaging). target is « messenger:<page id> » or
 * « instagram:<ig id> »: its dataset is asked first (POST /{id}/dataset gives the one already there, or makes it), then
 * the events go to /{dataset}/events. The token goes in the body, never in a URL; 15 s at most per call.
 */
async function sendChatCapi(a: { target: string; token: string; events: unknown[] }): Promise<{ received: number; dataset: string }> {
  const m = /^(messenger|instagram):(\d{5,30})$/.exec(a.target);
  if (!m) throw new AppError('bad_request', 'Page ou compte Instagram invalide');
  if (!a.token) throw new AppError('bad_request', 'Jeton de la Page manquant');
  let dataset = chatDatasets.get(a.target);
  if (!dataset) {
    dataset = String((await graphPost(`${GRAPH_CAPI}/${m[2]}/dataset`, { access_token: a.token }))?.id ?? '');
    if (!/^\d{5,30}$/.test(dataset)) throw new AppError('bad_request', 'Meta n’a pas donné de jeu de données pour cette conversation.');
    chatDatasets.set(a.target, dataset);
  }
  const data = await graphPost(`${GRAPH_CAPI}/${dataset}/events`, { data: a.events, access_token: a.token });
  return { received: Number(data?.events_received ?? 0), dataset };
}

/**
 * Sends events to a TikTok pixel through the Events API 2.0 (landing pages: CompletePayment of real orders,
 * InitiateCheckout of abandoned ones). The token goes in a header, never in a URL; 15 s at most.
 */
async function sendTiktok(a: { pixelCode: string; token: string; events: unknown[]; testEventCode?: string }): Promise<{ received: number }> {
  if (!/^[A-Z0-9]{10,30}$/.test(a.pixelCode)) throw new AppError('bad_request', 'Pixel TikTok invalide');
  if (!a.token) throw new AppError('bad_request', 'Jeton TikTok Events API manquant');
  let res: Response;
  try {
    res = await fetch('https://business-api.tiktok.com/open_api/v1.3/event/track/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Access-Token': a.token },
      body: JSON.stringify({ event_source: 'web', event_source_id: a.pixelCode, data: a.events, ...(a.testEventCode ? { test_event_code: a.testEventCode } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new AppError('bad_request', 'TikTok injoignable. Réessayez plus tard.');
  }
  const data: any = await res.json().catch(() => ({}));
  // TikTok answers 200 with its own code: 0 is OK
  if (!res.ok || (data?.code !== undefined && data.code !== 0)) {
    const code = Number(data?.code);
    if (code === 40001 || code === 40100 || code === 40105 || res.status === 401) throw new AppError('bad_request', 'Jeton TikTok refusé ou expiré : changez-le dans Landing pages › Réglages › Pixels.');
    if (code === 40016 || code === 51021 || res.status === 429) throw new AppError('conflict', 'TikTok limite les demandes pour l’instant.');
    throw new AppError('bad_request', `TikTok : ${data?.message ?? res.statusText}`);
  }
  return { received: a.events.length };
}

/** One day of results for an ad set or an ad (spend in the ad account currency, in cents). */
export interface MetaDay {
  day: string; // YYYY-MM-DD
  adsetId: string;
  adsetName: string;
  campaign: string;
  adId?: string;
  adName?: string;
  spendCents: number;
  impressions: number;
  reach: number;
  clicks: number;
  lpv: number;
  purchases: number;
  video3s: number;
  thruplays: number;
  /** the ad account's currency (USD, DZD…), as Meta gives it */
  currency?: string;
}

export interface MetaInsights {
  adsets: { id: string; name: string; campaign: string; status: string | null; currency?: string }[];
  ads: { id: string; adsetId: string; name: string; status: string | null; isVideo: boolean }[];
  adsetDays: MetaDay[];
  adDays: MetaDay[];
}

const PURCHASE = ['offsite_conversion.fb_pixel_purchase', 'purchase', 'omni_purchase', 'onsite_web_purchase'];
const actionValue = (list: any[] | undefined, types: string[]): number => {
  if (!Array.isArray(list)) return 0;
  for (const t of types) {
    const a = list.find((x) => x?.action_type === t);
    if (a) return Math.round(Number(a.value) || 0);
  }
  return 0;
};

async function graph(path: string, params: Record<string, string>, token: string): Promise<any> {
  const url = path.startsWith('http') ? path : `${GRAPH}/${path}?${new URLSearchParams({ ...params, access_token: token })}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch {
    throw new AppError('bad_request', 'Meta injoignable. Réessayez plus tard.');
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    const code = data?.error?.code;
    if (code === 190) throw new AppError('bad_request', 'Le jeton Meta a expiré ou a été révoqué : reconnectez Meta dans Réglages.');
    if (code === 4 || code === 17 || code === 613) throw new AppError('conflict', 'Meta limite les demandes pour l’instant : réessayez dans quelques minutes.');
    throw new AppError('bad_request', `Meta : ${data?.error?.message ?? res.statusText}`);
  }
  return data;
}

/** Follows paging.next up to `max` pages. */
async function all(path: string, params: Record<string, string>, token: string, max = 50): Promise<any[]> {
  const out: any[] = [];
  let page = await graph(path, params, token);
  for (let i = 0; i < max; i++) {
    out.push(...(page.data ?? []));
    const next = page.paging?.next;
    if (!next) break;
    page = await graph(next, {}, token);
  }
  return out;
}

/** A change on Meta (creating or editing): the token goes in the body, never in a URL; 30 s at most. */
async function post(path: string, body: Record<string, unknown>, token: string): Promise<any> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) if (v !== undefined && v !== null) form.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  form.set('access_token', token);
  let res: Response;
  try {
    res = await fetch(`${GRAPH}/${path}`, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new AppError('bad_request', 'Meta injoignable. Réessayez plus tard.');
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    const e = data?.error;
    if (e?.code === 190) throw new AppError('bad_request', 'Le jeton Meta a expiré ou a été révoqué : reconnectez Meta (Pilot AI › Comptes).');
    if ([4, 17, 613, 80000, 80004].includes(Number(e?.code))) throw new AppError('conflict', 'Meta limite les demandes pour l’instant : réessayez dans quelques minutes.');
    throw new AppError('bad_request', `Meta : ${e?.error_user_msg ?? e?.message ?? res.statusText}`);
  }
  return data;
}
const cents = (v: unknown): number | null => (v === undefined || v === null || v === '' ? null : Math.round(Number(v)) || 0);
const actOf = (x: string) => `act_${String(x).replace(/^act_/, '')}`;
/** fills `{campaign}`, `{adset:k}`, `{creative:k}`, `{video:k}`, `{image:k}`, `{form}` with the ids Meta gave */
function fill(v: unknown, ids: Record<string, string>): unknown {
  if (typeof v === 'string') return v.replace(/\{(campaign|form|adset:\w+|creative:\w+|video:\w+|image:\w+)\}/g, (m, k) => ids[k] ?? m);
  if (Array.isArray(v)) return v.map((x) => fill(x, ids));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, ids)]));
  return v;
}

const toDay = (r: any, level: 'adset' | 'ad', currency: string): MetaDay => ({
  currency,
  day: String(r.date_start),
  adsetId: String(r.adset_id),
  adsetName: String(r.adset_name ?? ''),
  campaign: String(r.campaign_name ?? ''),
  ...(level === 'ad' ? { adId: String(r.ad_id), adName: String(r.ad_name ?? '') } : {}),
  spendCents: Math.round((Number(r.spend) || 0) * 100),
  impressions: Math.round(Number(r.impressions) || 0),
  reach: Math.round(Number(r.reach) || 0),
  clicks: Math.round(Number(r.inline_link_clicks) || 0),
  lpv: actionValue(r.actions, ['landing_page_view', 'omni_landing_page_view']),
  purchases: actionValue(r.actions, PURCHASE),
  video3s: actionValue(r.actions, ['video_view']),
  thruplays: actionValue(r.video_thruplay_watched_actions, ['video_view']),
});

// ---------------------------------------------------------------- Marketing › Catalogue (Commerce: catalogs)
/** A POST or DELETE to the Graph API, the token in the body (never in the address). */
async function graphWrite(path: string, body: Record<string, unknown>, token: string, method: 'POST' | 'DELETE' = 'POST'): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${GRAPH}/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ...body, access_token: token }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new AppError('bad_request', 'Meta injoignable. Réessayez plus tard.');
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) throw catalogError(data?.error, res.statusText);
  return data;
}
/** Meta's catalog errors, said to the seller. */
function catalogError(e: any, fallback: string): AppError {
  const code = Number(e?.code);
  if (code === 190) return new AppError('bad_request', 'Le compte Meta n’est plus relié : reliez-le à nouveau dans Pilot AI › Comptes.');
  if (code === 10 || code === 200 || code === 3 || (code >= 200 && code < 300))
    return new AppError('bad_request', 'Meta refuse : Pilotix n’a pas la permission de gérer vos catalogues. Reliez Meta à nouveau dans Pilot AI › Comptes et acceptez « catalogue ».');
  if (code === 80014 || code === 4 || code === 17 || code === 613) return new AppError('conflict', 'Meta limite les envois pour l’instant : réessayez dans quelques minutes.');
  return new AppError('bad_request', `Meta : ${e?.error_user_msg ?? e?.message ?? fallback}`);
}

/**
 * The catalog actions (the token and the ad account of the shop):
 *  - 'catalogSetup'  → { catalogId?, name, pixelIds }: the shop's catalog (made in the ad account's business when there is
 *    none) and its pixels linked to it (each visit of a page finds its product)
 *  - 'catalogBatch'  → { catalogId, requests }: up to 5,000 lines sent at once; Meta's first checks come back at once
 *  - 'catalogStatus' → { catalogId, handle }: how a batch ended, line by line
 *  - 'catalogSet'    → { catalogId, setId?, name, ids }: a list as a product set (made, or changed)
 *  - 'catalogSetDelete' → { setId }
 */
async function runCatalog(action: string, args: any, token: string, acts: string[]): Promise<unknown> {
  const enc = encodeURIComponent;
  if (action === 'catalogSetup') {
    let catalogId = args?.catalogId ? String(args.catalogId) : '';
    let businessId: string | null = null;
    let businessName: string | null = null;
    if (!catalogId) {
      const acc = await graph(acts[0], { fields: 'business{id,name}' }, token).catch((e) => {
        throw e instanceof AppError ? e : catalogError(null, 'compte pub illisible');
      });
      if (!acc?.business?.id) throw new AppError('bad_request', 'Votre compte pub n’est pas dans un portefeuille business Meta : ajoutez-le dans Meta Business Suite, puis réessayez.');
      businessId = String(acc.business.id);
      businessName = String(acc.business.name ?? '');
      const made = await graphWrite(`${enc(businessId)}/owned_product_catalogs`, { name: String(args?.name ?? 'Pilotix').slice(0, 100) }, token);
      catalogId = String(made.id);
    }
    const pixels = (Array.isArray(args?.pixelIds) ? args.pixelIds : []).map(String).filter((x: string) => /^\d{5,20}$/.test(x));
    let pixelsLinked = false;
    if (pixels.length)
      pixelsLinked = await graphWrite(`${enc(catalogId)}/external_event_sources`, { external_event_sources: pixels }, token)
        .then(() => true)
        .catch(() => false);
    return { catalogId, businessId, businessName, pixelsLinked };
  }
  if (action === 'catalogBatch') {
    const r = await graphWrite(`${enc(String(args.catalogId))}/items_batch`, { item_type: 'PRODUCT_ITEM', allow_upsert: true, requests: args.requests }, token);
    const errors: { id: string; message: string }[] = [];
    for (const v of Array.isArray(r?.validation_status) ? r.validation_status : [])
      for (const e of Array.isArray(v?.errors) ? v.errors : []) errors.push({ id: String(v.retailer_id ?? ''), message: String(e?.message ?? 'refusé').slice(0, 300) });
    return { handle: Array.isArray(r?.handles) && r.handles[0] ? String(r.handles[0]) : null, errors };
  }
  if (action === 'catalogStatus') {
    const r = await graph(`${enc(String(args.catalogId))}/check_batch_request_status`, { handle: String(args.handle) }, token);
    const d = Array.isArray(r?.data) ? r.data[0] : r;
    const errors: { id: string; message: string }[] = [];
    for (const e of Array.isArray(d?.errors) ? d.errors : []) errors.push({ id: String(e?.id ?? e?.retailer_id ?? ''), message: String(e?.message ?? 'refusé').slice(0, 300) });
    return { done: String(d?.status ?? '').toLowerCase() === 'finished', errors };
  }
  if (action === 'catalogSet') {
    const filter = { retailer_id: { is_any: (args.ids as string[]).slice(0, 5000) } };
    if (args.setId) {
      await graphWrite(enc(String(args.setId)), { name: String(args.name).slice(0, 100), filter }, token);
      return { setId: String(args.setId) };
    }
    const made = await graphWrite(`${enc(String(args.catalogId))}/product_sets`, { name: String(args.name).slice(0, 100), filter }, token);
    return { setId: String(made.id) };
  }
  if (action === 'catalogSetDelete') {
    await graphWrite(enc(String(args.setId)), {}, token, 'DELETE').catch(() => null);
    return { ok: true };
  }
  throw new AppError('bad_request', `Action Meta inconnue : ${action}`);
}

// ---------------------------------------------------------------- Marketing › Influenceurs (partnership ads)
/** What Pilotix reads of each creator's post that tags the shop (Meta's Advertisable Content API). */
const CONTENT_FIELDS =
  'content_id,platform,media_type,post_type,caption,permalink,creation_time,author{display_name,ig_user_id,fb_page_id,profile_picture_url},ad_usage,is_recommended,' +
  'partnership_info{ad_eligibility,permission_status,permission_type,ad_code,content_types,eligibility_errors},organic_insights{likes,comments,views,reach,shares,saves}';

/** Meta's partnership errors, said to the seller. */
function partnerError(e: any, fallback: string): AppError {
  const code = Number(e?.code);
  if (code === 190) return new AppError('bad_request', 'Le compte Meta n’est plus relié : reliez-le à nouveau dans Pilot AI › Comptes.');
  if (code === 10 || code === 3 || (code >= 200 && code < 300))
    return new AppError('bad_request', 'Meta refuse : Pilotix n’a pas encore la permission des pubs avec des influenceurs. Reliez Meta à nouveau (Pilot AI › Comptes) et acceptez-la.');
  if (code === 4 || code === 17 || code === 613 || code === 80004) return new AppError('conflict', 'Meta limite les demandes pour l’instant : réessayez dans quelques minutes.');
  return new AppError('bad_request', `Meta : ${e?.error_user_msg ?? e?.message ?? fallback}`);
}
/** A Graph call for partnership ads: GET with the token in the Authorization header, POST with it in the body. */
async function pcall(path: string, token: string, o: { params?: Record<string, string>; body?: Record<string, unknown> } = {}): Promise<any> {
  const url = `${GRAPH}/${path}${o.params ? `?${new URLSearchParams(o.params)}` : ''}`;
  let res: Response;
  try {
    res = await fetch(
      url,
      o.body
        ? { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ ...o.body, access_token: token }), signal: AbortSignal.timeout(30_000) }
        : { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) },
    );
  } catch {
    throw new AppError('bad_request', 'Meta injoignable. Réessayez plus tard.');
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) throw partnerError(data?.error, res.statusText);
  return data;
}
/** The pages of a list (cursor `after`), `max` pages at most. */
async function pall(path: string, token: string, params: Record<string, string>, max: number): Promise<any[]> {
  const out: any[] = [];
  let after: string | null = null;
  for (let k = 0; k < max; k++) {
    const r = await pcall(path, token, { params: { ...params, ...(after ? { after } : {}) } });
    const data = Array.isArray(r?.data) ? r.data : [];
    out.push(...data);
    after = r?.paging?.cursors?.after && (r.paging.next || data.length >= Number(params.limit ?? 25)) ? String(r.paging.cursors.after) : null;
    if (!after || !data.length) break;
  }
  return out;
}
/** The business that holds the shop's ad account (else its Page): the Advertisable Content API asks through it. */
async function businessOf(token: string, acts: string[], pageId: string | null): Promise<string | null> {
  for (const act of acts.slice(0, 3)) {
    const r = await pcall(act, token, { params: { fields: 'business{id}' } }).catch(() => null);
    if (r?.business?.id) return String(r.business.id);
  }
  if (pageId && /^\d{5,25}$/.test(pageId)) {
    const r = await pcall(pageId, token, { params: { fields: 'business{id}' } }).catch(() => null);
    if (r?.business?.id) return String(r.business.id);
  }
  return null;
}
const igOk = (v: unknown) => /^\d{5,25}$/.test(String(v ?? ''));
const said = (e: unknown) => String((e as any)?.message ?? e).slice(0, 300);

/**
 * The partnership actions (the shop's Instagram account `igId` and Page `pageId` come from Pilotix):
 *  - 'partnerRequest' → { igId, username }: asks the creator for the right to run ads in both names (they say yes in the
 *    Instagram app)
 *  - 'partnerRevoke'  → { igId, creatorId?, username? }: that right ends
 *  - 'partnerSync'    → { igId, pageId }: every request and where it is, and the creators' posts that tag the shop
 *    (Instagram and Facebook together); each part's error is given back, never thrown
 *  - 'partnerLookup'  → { igId, pageId, adCode? | permalink? }: one post, by the creator's ad code or its link
 */
async function runPartners(action: string, args: any, token: string, acts: string[]): Promise<unknown> {
  const enc = encodeURIComponent;
  const ig = igOk(args?.igId) ? String(args.igId) : null;
  const page = igOk(args?.pageId) ? String(args.pageId) : null;
  if (action === 'partnerRequest') {
    if (!ig) throw new AppError('bad_request', 'Reliez le compte Instagram de la boutique (Pilot AI › Comptes).');
    const r = await pcall(`${enc(ig)}/branded_content_ad_permissions`, token, { body: { creator_instagram_username: String(args.username) } });
    return { id: r?.id ? String(r.id) : null };
  }
  if (action === 'partnerRevoke') {
    if (!ig) throw new AppError('bad_request', 'Reliez le compte Instagram de la boutique (Pilot AI › Comptes).');
    const who = igOk(args?.creatorId) ? { creator_instagram_account: String(args.creatorId) } : { creator_instagram_username: String(args?.username ?? '') };
    await pcall(`${enc(ig)}/branded_content_ad_permissions`, token, { body: { ...who, revoke: true } });
    return { ok: true };
  }
  const where: Record<string, string> = { ...(ig ? { ig_user_id: ig } : {}), ...(page ? { fb_page_id: page } : {}) };
  if (action === 'partnerSync') {
    const errors: string[] = [];
    let permissions: any[] = [];
    if (ig)
      permissions = await pall(`${enc(ig)}/branded_content_ad_permissions`, token, { limit: '100' }, 10).catch((e) => {
        errors.push(said(e));
        return [];
      });
    let content: any[] = [];
    const business = await businessOf(token, acts, page);
    if (!business) errors.push('Votre Page n’est pas dans un portefeuille business Meta : ajoutez-la dans Meta Business Suite, puis actualisez.');
    else if (Object.keys(where).length)
      content = await pall(`${enc(business)}/partnership-ads-advertisable-content`, token, { ...where, fields: CONTENT_FIELDS, sort_by: 'DATE', limit: '50' }, 4).catch((e) => {
        errors.push(said(e));
        return [];
      });
    return { permissions, content, errors };
  }
  if (action === 'partnerLookup') {
    const business = await businessOf(token, acts, page);
    if (!business) throw new AppError('bad_request', 'Votre Page n’est pas dans un portefeuille business Meta : ajoutez-la dans Meta Business Suite.');
    const one: Record<string, string> = args?.adCode ? { ad_codes: JSON.stringify([String(args.adCode)]) } : { permalinks: JSON.stringify([String(args?.permalink ?? '')]) };
    const r = await pcall(`${enc(business)}/partnership-ads-advertisable-content`, token, { params: { ...where, ...one, fields: CONTENT_FIELDS } });
    return { content: Array.isArray(r?.data) ? r.data : [] };
  }
  throw new AppError('bad_request', `Action Meta inconnue : ${action}`);
}

/**
 * Runs one Meta action with the stored connection.
 *  - 'test'      → { name, currency } of the ad account (checks the token)
 *  - 'insights'  → { from, to } (YYYY-MM-DD): daily results at ad set AND ad level, plus the ad sets / ads (status, video or not)
 *  - 'capi'      → { pixelId, token, events, testEventCode? }: Conversions API events (landing pages)
 *  - 'chatCapi'  → { target, token, events }: Purchases of Messenger / Instagram chat orders (Business Messaging)
 *  - 'catalog…'  → Marketing › Catalogue (runCatalog above)
 */
export async function runMeta(action: string, args: unknown, ctx: Ctx): Promise<unknown> {
  // the Conversions API needs a pixel and its token, not the ad account
  if (action === 'capi') return sendCapi(args as Parameters<typeof sendCapi>[0]);
  if (action === 'tiktok') return sendTiktok(args as Parameters<typeof sendTiktok>[0]);
  if (action === 'chatCapi') return sendChatCapi(args as Parameters<typeof sendChatCapi>[0]);
  const meta = await getSetting(ctx.db, 'meta');
  const token = await getRaw<string>(ctx.db, META_TOKEN_KEY, '');
  if (!meta.adAccountId || !token) throw new AppError('bad_request', 'Meta n’est pas connecté : ajoutez le compte pub et le jeton dans Réglages.');
  // a linked Facebook account: every one of its ad accounts, added up (Pilot AI › Comptes); pasted by hand: the one
  const acts = [...new Set((meta.adAccountIds?.length ? meta.adAccountIds : [meta.adAccountId]).map((x) => `act_${String(x).replace(/^act_/, '')}`))];

  if (action.startsWith('catalog')) return runCatalog(action, args, token, acts);
  if (action.startsWith('partner')) return runPartners(action, args, token, acts);

  // the pixels of every connected ad account (Réglages › Pixels takes them in): one that cannot be read is skipped
  if (action === 'pixels') {
    const out: { id: string; name: string; account: string }[] = [];
    for (const act of acts) {
      const got = await all(`${act}/adspixels`, { fields: 'id,name', limit: '100' }, token, 5).catch(() => []);
      for (const p of got) if (/^\d{5,20}$/.test(String(p?.id ?? ''))) out.push({ id: String(p.id), name: String(p.name ?? '').slice(0, 80), account: act.replace(/^act_/, '') });
    }
    return out;
  }

  if (action === 'test') {
    const r = await graph(acts[0], { fields: 'name,currency,account_status' }, token);
    return { name: r.name as string, currency: r.currency as string };
  }

  if (action === 'insights') {
    const a = (args ?? {}) as { from?: string; to?: string };
    const re = /^\d{4}-\d{2}-\d{2}$/;
    if (!a.from || !a.to || !re.test(a.from) || !re.test(a.to)) throw new AppError('bad_request', 'Dates invalides');
    const base = {
      time_range: JSON.stringify({ since: a.from, until: a.to }),
      time_increment: '1',
      limit: '500',
      fields: 'date_start,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,reach,inline_link_clicks,actions,video_thruplay_watched_actions',
      action_breakdowns: 'action_type',
    };
    const out: MetaInsights = { adsets: [], ads: [], adsetDays: [], adDays: [] };
    // one ad account after the other (Meta counts the calls); one that cannot be read (closed, no access) is left out,
    // all of them failing is an error
    let read = 0;
    let firstError: unknown = null;
    for (const act of acts) {
      try {
        const [account, adsetRows, adRows, adsets, ads] = await Promise.all([
          graph(act, { fields: 'currency' }, token),
          all(`${act}/insights`, { ...base, level: 'adset' }, token),
          all(`${act}/insights`, { ...base, level: 'ad' }, token),
          all(`${act}/adsets`, { fields: 'id,name,effective_status,campaign{name}', limit: '200' }, token, 20),
          all(`${act}/ads`, { fields: 'id,name,adset_id,effective_status,creative{object_type,video_id}', limit: '200' }, token, 20),
        ]);
        // spend comes in the account's own money: Publicité counts a DZD account in dinars (see ../modules/ads.ts)
        const currency = String(account?.currency || 'USD').toUpperCase();
        out.adsets.push(...adsets.map((s: any) => ({ id: String(s.id), name: String(s.name ?? ''), campaign: String(s.campaign?.name ?? ''), status: s.effective_status ?? null, currency })));
        out.ads.push(
          ...ads.map((x: any) => ({
            id: String(x.id),
            adsetId: String(x.adset_id),
            name: String(x.name ?? ''),
            status: x.effective_status ?? null,
            isVideo: !!x.creative?.video_id || x.creative?.object_type === 'VIDEO',
          })),
        );
        out.adsetDays.push(...adsetRows.map((r) => toDay(r, 'adset', currency)));
        out.adDays.push(...adRows.map((r) => toDay(r, 'ad', currency)));
        read++;
      } catch (e) {
        firstError ??= e;
      }
    }
    if (!read && firstError) throw firstError;
    return out;
  }

  // ---- Pilot Ads (./modules/adsmgr.ts, ./modules/adslaunch.ts) ----
  /** campaigns and ad sets with their budget and state, and each ad account's health (paid, limit, spent) */
  if (action === 'structure') {
    const out = { accounts: [] as any[], campaigns: [] as any[], adsets: [] as any[] };
    for (const act of acts) {
      try {
        const [account, campaigns, adsets] = await Promise.all([
          graph(act, { fields: 'name,currency,account_status,disable_reason,spend_cap,amount_spent,balance,min_daily_budget' }, token),
          all(`${act}/campaigns`, { fields: 'id,name,objective,effective_status,daily_budget,bid_strategy', limit: '200' }, token, 10),
          all(`${act}/adsets`, { fields: 'id,name,campaign_id,effective_status,daily_budget', limit: '200' }, token, 20),
        ]);
        const id = act.replace(/^act_/, '');
        out.accounts.push({ id, name: String(account?.name ?? ''), currency: String(account?.currency ?? 'USD').toUpperCase(), status: Number(account?.account_status ?? 0), disableReason: Number(account?.disable_reason ?? 0), spendCap: cents(account?.spend_cap), spent: cents(account?.amount_spent), balance: cents(account?.balance), minDaily: cents(account?.min_daily_budget) });
        out.campaigns.push(...campaigns.map((c: any) => ({ id: String(c.id), accountId: id, name: String(c.name ?? ''), objective: c.objective ?? null, status: c.effective_status ?? null, dailyBudgetCents: cents(c.daily_budget), bidStrategy: c.bid_strategy ?? null })));
        out.adsets.push(...adsets.map((x: any) => ({ id: String(x.id), accountId: id, campaignId: String(x.campaign_id ?? ''), name: String(x.name ?? ''), status: x.effective_status ?? null, dailyBudgetCents: cents(x.daily_budget) })));
      } catch {
        // an account that cannot be read is left out (the others still count)
      }
    }
    return out;
  }

  /** pause, start again, or a new daily budget (cents, the account's money); Meta's answer is read back */
  if (action === 'update') {
    const a = (args ?? {}) as { id?: string; status?: 'ACTIVE' | 'PAUSED'; dailyBudgetCents?: number };
    if (!a.id || !/^\d{6,25}$/.test(a.id)) throw new AppError('bad_request', 'Objet Meta invalide');
    const body: Record<string, unknown> = {};
    if (a.status) body.status = a.status;
    if (a.dailyBudgetCents) body.daily_budget = Math.round(a.dailyBudgetCents);
    if (!Object.keys(body).length) throw new AppError('bad_request', 'Rien à changer');
    await post(a.id, body, token);
    const r = await graph(a.id, { fields: 'effective_status,daily_budget' }, token);
    return { status: r.effective_status ?? null, dailyBudgetCents: cents(r.daily_budget) };
  }

  /** a copy of an ad set or a campaign with all its ads, PAUSED (Meta's copies) */
  if (action === 'copy') {
    const a = (args ?? {}) as { id?: string; level?: 'adset' | 'campaign' };
    if (!a.id || !/^\d{6,25}$/.test(a.id)) throw new AppError('bad_request', 'Objet Meta invalide');
    const r = await post(`${a.id}/copies`, { deep_copy: true, status_option: 'PAUSED', rename_options: { rename_suffix: ' · copie' } }, token);
    return { id: String(r.copied_adset_id ?? r.copied_campaign_id ?? r.ad_object_ids?.[0]?.copied_id ?? '') };
  }

  /**
   * A launch: the photos first (their bytes, from the shop's library), the videos (Meta downloads them from Pilotix),
   * then the campaign, its ad sets, the créas and the ads, all PAUSED. `done` holds the ids of an earlier try: a retry
   * goes on where it stopped and creates nothing twice. Never throws halfway: it answers with the ids made and the error.
   */
  if (action === 'launch') {
    const a = (args ?? {}) as { plan: LaunchPlan; accountId?: string; done?: Record<string, string> };
    const act = a.accountId ? actOf(a.accountId) : acts[0];
    if (!acts.includes(act)) throw new AppError('bad_request', 'Ce compte pub n’est pas relié à la boutique.');
    const ids: Record<string, string> = { ...(a.done ?? {}) };
    let step = 'images';
    try {
      for (const im of a.plan.images ?? []) {
        if (ids[`image:${im.key}`]) continue;
        const row = (await ctx.db.query(`SELECT ${im.col === 'thumb' ? 'thumb' : 'jpeg'} AS b FROM cm_media WHERE id = $1`, [im.mediaId]))[0];
        if (!row?.b) throw new AppError('bad_request', 'Une photo n’est plus dans la bibliothèque : choisissez-la à nouveau.');
        const r = await post(`${act}/adimages`, { bytes: String(row.b) }, token);
        const hash = (Object.values(r?.images ?? {})[0] as { hash?: string } | undefined)?.hash;
        if (!hash) throw new AppError('bad_request', 'Meta n’a pas pris la photo.');
        ids[`image:${im.key}`] = String(hash);
      }
      step = 'videos';
      for (const c of a.plan.creatives) {
        if (!c.video || ids[`video:${c.video.key}`]) continue;
        const v = await post(`${act}/advideos`, { file_url: c.video.url, name: String(c.body.name ?? 'video') }, token);
        ids[`video:${c.video.key}`] = String(v.id);
      }
      // a video is ready a little after: wait up to 90 s for each one
      for (const k of Object.keys(ids).filter((x) => x.startsWith('video:'))) {
        for (let t = 0; t < 18; t++) {
          const st = await graph(ids[k], { fields: 'status' }, token);
          if (st?.status?.video_status === 'ready') break;
          if (st?.status?.video_status === 'error') throw new AppError('bad_request', 'Meta n’a pas pu lire la vidéo.');
          await new Promise((r) => setTimeout(r, 5_000));
        }
      }
      step = 'campaign';
      if (!ids.campaign) ids.campaign = String((await post(`${act}/campaigns`, fill(a.plan.campaign, ids) as Record<string, unknown>, token)).id);
      step = 'adsets';
      for (const x of a.plan.adsets) if (!ids[`adset:${x.key}`]) ids[`adset:${x.key}`] = String((await post(`${act}/adsets`, fill(x.body, ids) as Record<string, unknown>, token)).id);
      step = 'creatives';
      for (const x of a.plan.creatives) if (!ids[`creative:${x.key}`]) ids[`creative:${x.key}`] = String((await post(`${act}/adcreatives`, fill(x.body, ids) as Record<string, unknown>, token)).id);
      step = 'ads';
      for (const x of a.plan.ads)
        if (!ids[`ad:${x.key}`]) ids[`ad:${x.key}`] = String((await post(`${act}/ads`, { ...(fill(x.body, ids) as Record<string, unknown>), adset_id: ids[`adset:${x.adset}`], creative: { creative_id: ids[`creative:${x.creative}`] } }, token)).id);
      return { ids, error: null, step: 'done' };
    } catch (e: any) {
      return { ids, error: String(e?.message ?? e), step };
    }
  }

  /** turns on what a launch made: the campaign, then its ad sets, then the ads */
  if (action === 'activate') {
    const a = (args ?? {}) as { ids?: string[] };
    for (const id of a.ids ?? []) if (/^\d{6,25}$/.test(id)) await post(id, { status: 'ACTIVE' }, token);
    return { ok: true };
  }

  /** an instant form on the Page (lead ads): with the Page's own token, read from the person's token */
  if (action === 'leadform') {
    const a = (args ?? {}) as { pageId?: string; body?: Record<string, unknown> };
    if (!a.pageId || !/^\d{5,25}$/.test(a.pageId) || !a.body) throw new AppError('bad_request', 'Page invalide');
    const page = await graph(a.pageId, { fields: 'access_token' }, token);
    if (!page?.access_token) throw new AppError('bad_request', 'Pilotix ne peut pas gérer cette Page : reliez-la à nouveau (Pilot AI › Comptes).');
    const r = await post(`${a.pageId}/leadgen_forms`, a.body, String(page.access_token));
    return { id: String(r.id) };
  }

  /** Algeria's regions as Meta names them (their keys are kept, not their names) */
  if (action === 'geo') {
    const r = await graph('search', { type: 'adgeolocation', location_types: JSON.stringify(['region']), country_code: 'DZ', limit: '100', q: String((args as any)?.q ?? '') }, token);
    return { regions: (r.data ?? []).filter((x: any) => x.type === 'region').map((x: any) => ({ key: String(x.key), name: String(x.name) })) };
  }

  /**
   * An audience from the shop's own customers: phones hashed here (SHA-256 of 213XXXXXXXXX), never sent in clear.
   * Made the first time, then refilled (Meta adds; Pilotix sends the whole list each night).
   */
  if (action === 'audience') {
    const a = (args ?? {}) as { name?: string; metaId?: string | null; phones?: string[] };
    let id = a.metaId ?? null;
    if (!id) id = String((await post(`${acts[0]}/customaudiences`, { name: String(a.name ?? 'Pilotix').slice(0, 100), subtype: 'CUSTOM', customer_file_source: 'USER_PROVIDED_ONLY', description: 'Pilotix' }, token)).id);
    const hashed = (a.phones ?? []).map((p) => [createHash('sha256').update(p).digest('hex')]);
    let received = 0;
    for (let k = 0; k < hashed.length; k += 10_000) {
      const r = await post(`${id}/users`, { payload: { schema: ['PHONE'], data: hashed.slice(k, k + 10_000) } }, token);
      received += Number(r.num_received ?? 0);
    }
    return { id, received };
  }

  /** people who look like the shop's delivered customers (1 % of Algeria by default) */
  if (action === 'lookalike') {
    const a = (args ?? {}) as { seedId?: string; ratio?: number };
    if (!a.seedId) throw new AppError('bad_request', 'Audience de départ manquante');
    const r = await post(`${acts[0]}/customaudiences`, { name: 'Pilotix · comme mes clients livrés', subtype: 'LOOKALIKE', origin_audience_id: a.seedId, lookalike_spec: { country: 'DZ', ratio: Math.min(0.2, Math.max(0.01, a.ratio ?? 0.01)) } }, token);
    return { id: String(r.id) };
  }

  throw new AppError('bad_request', `Action Meta inconnue : ${action}`);
}
