// Meta Ads (Graph API v21.0) — SERVER ONLY. Loaded by the server as '@pilotix/core/dist/meta' and called through
// ctx.server.meta(action, args, ctx). Never imported by the app: the browser demo uses the seeded tables instead.
// The access token is read from the settings table (written by admin.meta.save) and never leaves the server.
import { getSetting } from './settings';
import { getRaw, META_TOKEN_KEY } from './modules/admin';
import { AppError, Ctx } from './rpc';

const GRAPH = 'https://graph.facebook.com/v21.0';

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
}

export interface MetaInsights {
  adsets: { id: string; name: string; campaign: string; status: string | null }[];
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

const toDay = (r: any, level: 'adset' | 'ad'): MetaDay => ({
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

/**
 * Runs one Meta action with the stored connection.
 *  - 'test'      → { name, currency } of the ad account (checks the token)
 *  - 'insights'  → { from, to } (YYYY-MM-DD): daily results at ad set AND ad level, plus the ad sets / ads (status, video or not)
 */
export async function runMeta(action: string, args: unknown, ctx: Ctx): Promise<unknown> {
  const meta = await getSetting(ctx.db, 'meta');
  const token = await getRaw<string>(ctx.db, META_TOKEN_KEY, '');
  if (!meta.adAccountId || !token) throw new AppError('bad_request', 'Meta n’est pas connecté : ajoutez le compte pub et le jeton dans Réglages.');
  const act = `act_${meta.adAccountId.replace(/^act_/, '')}`;

  if (action === 'test') {
    const r = await graph(act, { fields: 'name,currency,account_status' }, token);
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
    const [adsetRows, adRows, adsets, ads] = await Promise.all([
      all(`${act}/insights`, { ...base, level: 'adset' }, token),
      all(`${act}/insights`, { ...base, level: 'ad' }, token),
      all(`${act}/adsets`, { fields: 'id,name,effective_status,campaign{name}', limit: '200' }, token, 20),
      all(`${act}/ads`, { fields: 'id,name,adset_id,effective_status,creative{object_type,video_id}', limit: '200' }, token, 20),
    ]);
    const out: MetaInsights = {
      adsets: adsets.map((s: any) => ({ id: String(s.id), name: String(s.name ?? ''), campaign: String(s.campaign?.name ?? ''), status: s.effective_status ?? null })),
      ads: ads.map((x: any) => ({
        id: String(x.id),
        adsetId: String(x.adset_id),
        name: String(x.name ?? ''),
        status: x.effective_status ?? null,
        isVideo: !!x.creative?.video_id || x.creative?.object_type === 'VIDEO',
      })),
      adsetDays: adsetRows.map((r) => toDay(r, 'adset')),
      adDays: adRows.map((r) => toDay(r, 'ad')),
    };
    return out;
  }

  throw new AppError('bad_request', `Action Meta inconnue : ${action}`);
}
