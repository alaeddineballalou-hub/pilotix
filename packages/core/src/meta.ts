// Meta Ads (Graph API v21.0) — SERVER ONLY. Loaded by the server as '@pilotix/core/dist/meta' and called through
// ctx.server.meta(action, args, ctx). Never imported by the app: the browser demo uses the seeded tables instead.
// The access token is read from the settings table (written by admin.meta.save) and never leaves the server.
import { getSetting } from './settings';
import { getRaw, META_TOKEN_KEY } from './modules/admin';
import { AppError, Ctx } from './rpc';

const GRAPH = 'https://graph.facebook.com/v21.0';
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

/**
 * Runs one Meta action with the stored connection.
 *  - 'test'      → { name, currency } of the ad account (checks the token)
 *  - 'insights'  → { from, to } (YYYY-MM-DD): daily results at ad set AND ad level, plus the ad sets / ads (status, video or not)
 *  - 'capi'      → { pixelId, token, events, testEventCode? }: Conversions API events (landing pages)
 *  - 'catalog…'  → Marketing › Catalogue (runCatalog above)
 */
export async function runMeta(action: string, args: unknown, ctx: Ctx): Promise<unknown> {
  // the Conversions API needs a pixel and its token, not the ad account
  if (action === 'capi') return sendCapi(args as Parameters<typeof sendCapi>[0]);
  if (action === 'tiktok') return sendTiktok(args as Parameters<typeof sendTiktok>[0]);
  const meta = await getSetting(ctx.db, 'meta');
  const token = await getRaw<string>(ctx.db, META_TOKEN_KEY, '');
  if (!meta.adAccountId || !token) throw new AppError('bad_request', 'Meta n’est pas connecté : ajoutez le compte pub et le jeton dans Réglages.');
  // a linked Facebook account: every one of its ad accounts, added up (Pilot AI › Comptes); pasted by hand: the one
  const acts = [...new Set((meta.adAccountIds?.length ? meta.adAccountIds : [meta.adAccountId]).map((x) => `act_${String(x).replace(/^act_/, '')}`))];

  if (action.startsWith('catalog')) return runCatalog(action, args, token, acts);

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

  throw new AppError('bad_request', `Action Meta inconnue : ${action}`);
}
