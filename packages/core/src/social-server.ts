// Linked accounts — SERVER ONLY (loaded by the server as '@pilotix/core/dist/social-server'). The login tab comes back
// here: its code becomes a token (Facebook: an hour's token turned into one of about 60 days, or, with a Facebook Login
// for Business configuration, a token that does not expire; TikTok: an advertiser's token), then what the account may use
// is read (Facebook Pages with their Instagram account and their own tokens, Meta ad accounts, TikTok ad accounts) and
// each Page is subscribed to Pilotix's webhook (its messages and comments come to Pilotix). Tokens never leave the server.
import { AppError } from './rpc';
import type { Tenancy } from './platform/tenancy';
import { endState, FoundAccount, FoundAsset, saveLink, SOCIAL, SocialProvider, socialApps, socialSecret, socialUrls, takeState } from './modules/social';

async function fetchJson(url: string, init: RequestInit, who: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { Accept: 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new AppError('bad_request', `${who} injoignable. Réessayez dans un moment.`);
  }
  const data: any = await res.json().catch(() => ({}));
  return { res, data };
}

/** Graph API: the token goes in the query (GET) or the form (POST), never in a log. */
async function graph(path: string, params: Record<string, string>, method: 'GET' | 'POST' = 'GET'): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const url = path.startsWith('http') ? path : `${SOCIAL.graph}/${path}`;
  const { res, data } = await fetchJson(
    method === 'GET' ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url,
    method === 'GET' ? {} : { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: qs },
    'Facebook',
  );
  if (!res.ok || data?.error) {
    const e = data?.error;
    if (e?.code === 190) throw new AppError('bad_request', 'Facebook a refusé la connexion (jeton expiré ou retiré). Recommencez.');
    if (e?.code === 4 || e?.code === 17 || e?.code === 613 || res.status === 429) throw new AppError('conflict', 'Facebook limite les demandes pour l’instant. Réessayez dans quelques minutes.');
    throw new AppError('bad_request', `Facebook : ${e?.error_user_msg ?? e?.message ?? res.statusText}`);
  }
  return data;
}
/** All the pages of a Graph list (100 at most each, 10 pages at most). */
async function graphAll(path: string, params: Record<string, string>): Promise<any[]> {
  const out: any[] = [];
  let page = await graph(path, params);
  for (let i = 0; i < 10; i++) {
    out.push(...(Array.isArray(page?.data) ? page.data : []));
    const next = page?.paging?.next;
    if (!next) break;
    page = await graph(String(next), {});
  }
  return out;
}

async function tiktok(path: string, o: { token?: string; query?: Record<string, string>; body?: unknown }): Promise<any> {
  const url = `${SOCIAL.tiktokApi}/${path}${o.query ? `?${new URLSearchParams(o.query)}` : ''}`;
  const { res, data } = await fetchJson(
    url,
    o.body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json', ...(o.token ? { 'Access-Token': o.token } : {}) }, body: JSON.stringify(o.body) } : { headers: o.token ? { 'Access-Token': o.token } : {} },
    'TikTok',
  );
  // TikTok answers 200 with its own code: 0 is OK
  if (!res.ok || (data?.code !== undefined && data.code !== 0)) {
    const code = Number(data?.code);
    if (code === 40016 || code === 51021 || res.status === 429) throw new AppError('conflict', 'TikTok limite les demandes pour l’instant. Réessayez dans quelques minutes.');
    throw new AppError('bad_request', `TikTok : ${data?.message ?? res.statusText}`);
  }
  return data?.data ?? {};
}

/** A Facebook login: the account, its Pages (each subscribed to Pilotix's webhook) and its ad accounts. */
async function metaAccount(t: Tenancy, code: string, publicUrl: string): Promise<FoundAccount> {
  const apps = await socialApps(t);
  const secret = await socialSecret(t, 'meta');
  if (!apps.meta.appId || !secret) throw new AppError('bad_request', 'L’app Meta de Pilotix n’est pas prête.');
  const tok = await graph('oauth/access_token', { client_id: apps.meta.appId, client_secret: secret, redirect_uri: socialUrls(publicUrl).metaRedirect, code });
  let token = String(tok.access_token ?? '');
  let expiresIn = Number(tok.expires_in) || 0;
  const system = !!apps.meta.configId;
  if (!token) throw new AppError('bad_request', 'Facebook n’a pas donné de jeton. Recommencez.');
  if (!system) {
    // a classic login's token lasts about an hour: Facebook turns it into one of about 60 days
    const ll = await graph('oauth/access_token', { grant_type: 'fb_exchange_token', client_id: apps.meta.appId, client_secret: secret, fb_exchange_token: token });
    token = String(ll.access_token ?? token);
    expiresIn = Number(ll.expires_in) || 60 * 86_400;
  }
  const me = await graph('me', { fields: 'id,name,picture{url}', access_token: token });
  const pages = await graphAll('me/accounts', { fields: 'id,name,access_token,picture{url},instagram_business_account{id,username}', limit: '100', access_token: token });
  // without the ads permission there are no ad accounts: the Pages still work
  const ads = await graphAll('me/adaccounts', { fields: 'id,account_id,name,currency,account_status', limit: '100', access_token: token }).catch(() => []);
  const assets: FoundAsset[] = [];
  for (const p of pages) {
    if (!p?.id || !p?.access_token) continue;
    // its messages and comments come to Pilotix's webhook
    let hook = true;
    await graph(`${p.id}/subscribed_apps`, { subscribed_fields: SOCIAL.pageFields, access_token: String(p.access_token) }, 'POST').catch(() => (hook = false));
    const ig = p.instagram_business_account?.id ? { id: String(p.instagram_business_account.id), username: String(p.instagram_business_account.username ?? '') } : undefined;
    assets.push({ kind: 'page', extId: String(p.id), name: String(p.name ?? p.id), extra: { picture: p.picture?.data?.url ?? null, ...(ig ? { ig } : {}), hook }, token: String(p.access_token) });
  }
  for (const a of ads) {
    const idOf = String(a?.account_id ?? String(a?.id ?? '').replace(/^act_/, ''));
    if (!/^\d+$/.test(idOf)) continue;
    assets.push({ kind: 'ad_account', extId: idOf, name: String(a.name ?? idOf), extra: { currency: a.currency ?? null, status: a.account_status ?? null } });
  }
  return {
    provider: 'meta',
    extId: String(me.id),
    name: String(me.name ?? 'Facebook'),
    picture: me.picture?.data?.url ? String(me.picture.data.url) : '',
    token,
    tokenKind: system ? 'system' : 'user',
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
    assets,
  };
}

/** A TikTok for Business login: the advertiser's token and the ad accounts it opened to Pilotix. */
async function tiktokAccount(t: Tenancy, code: string): Promise<FoundAccount> {
  const apps = await socialApps(t);
  const secret = await socialSecret(t, 'tiktok');
  if (!apps.tiktok.appId || !secret) throw new AppError('bad_request', 'L’app TikTok de Pilotix n’est pas prête.');
  const r = await tiktok('oauth2/access_token/', { body: { app_id: apps.tiktok.appId, secret, auth_code: code } });
  const token = String(r.access_token ?? '');
  if (!token) throw new AppError('bad_request', 'TikTok n’a pas donné de jeton. Recommencez.');
  const ids: string[] = Array.isArray(r.advertiser_ids) ? r.advertiser_ids.map(String) : [];
  const adv = await tiktok('oauth2/advertiser/get/', { token, query: { app_id: apps.tiktok.appId, secret } }).catch(() => null);
  const user = await tiktok('user/info/', { token }).catch(() => null);
  const list: any[] = Array.isArray(adv?.list) && adv.list.length ? adv.list : ids.map((x) => ({ advertiser_id: x, advertiser_name: x }));
  const assets: FoundAsset[] = list.filter((a) => a?.advertiser_id).map((a) => ({ kind: 'advertiser', extId: String(a.advertiser_id), name: String(a.advertiser_name ?? a.advertiser_id) }));
  const expiresIn = Number(r.expires_in) || 0;
  return {
    provider: 'tiktok',
    extId: String(user?.core_user_id ?? ids[0] ?? assets[0]?.extId ?? 'tiktok'),
    name: String(user?.display_name || user?.email || assets[0]?.name || 'TikTok'),
    picture: user?.avatar_url ? String(user.avatar_url) : '',
    token,
    tokenKind: 'advertiser',
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
    assets,
  };
}

export interface LoginEnd {
  ok: boolean;
  message: string;
  account?: string;
}

/**
 * The login tab is back (?code / ?auth_code and ?state): the state is checked (known, from this provider, not used, not
 * older than 20 minutes), the account kept, the boutique's page told (it asks every two seconds and turns green).
 */
export async function finishLogin(t: Tenancy, provider: SocialProvider, q: Record<string, unknown>, publicUrl: string): Promise<LoginEnd> {
  const st = await takeState(t, String(q.state ?? ''));
  if (!st || st.provider !== provider) return { ok: false, message: 'Ce lien de connexion est inconnu. Fermez cet onglet et recommencez depuis Pilotix.' };
  if (st.done) return { ok: false, message: 'Ce lien a déjà servi. Fermez cet onglet et revenez sur Pilotix.' };
  if (st.expired) {
    await endState(t, st.state, { error: 'Le temps est passé (20 minutes) : recommencez.' });
    return { ok: false, message: 'Le temps est passé (20 minutes). Fermez cet onglet et recommencez depuis Pilotix.' };
  }
  const code = String((provider === 'tiktok' ? q.auth_code ?? q.code : q.code) ?? '').trim();
  if (!code) {
    const why = q.error_reason === 'user_denied' || q.error === 'access_denied' ? 'Connexion annulée.' : `Connexion refusée${q.error_description ? ` : ${String(q.error_description).slice(0, 200)}` : '.'}`;
    await endState(t, st.state, { error: why });
    return { ok: false, message: `${why} Fermez cet onglet.` };
  }
  try {
    const found = provider === 'meta' ? await metaAccount(t, code, publicUrl) : await tiktokAccount(t, code);
    const linkId = await saveLink(t, st, found);
    await endState(t, st.state, { linkId });
    return { ok: true, message: 'Compte lié', account: found.name };
  } catch (e: any) {
    const m = String(e?.message ?? 'Erreur').slice(0, 300);
    await endState(t, st.state, { error: m });
    return { ok: false, message: m };
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** The page the login tab shows at its end (it closes itself when the browser lets it). */
export function loginPage(r: LoginEnd): string {
  const title = r.ok ? 'Compte lié' : 'Connexion non faite';
  const line = r.ok ? `${r.account ? `« ${esc(r.account)} » est lié à Pilotix. ` : ''}Vous pouvez fermer cet onglet : Pilotix est déjà à jour.` : esc(r.message);
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Pilotix</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f5f8;color:#16202e}
main{max-width:420px;margin:24px;padding:28px;border-radius:16px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.08)}h1{margin:0 0 8px;font-size:22px}
.dot{display:inline-grid;place-items:center;width:44px;height:44px;border-radius:50%;margin-bottom:14px;color:#fff;font-size:24px;background:${r.ok ? '#1f9d55' : '#c2410c'}}p{margin:0;color:#4b5563}</style></head>
<body><main><div class="dot">${r.ok ? '✓' : '!'}</div><h1>${title}</h1><p>${line}</p></main>${r.ok ? '<script>setTimeout(function(){window.close()},1500)</script>' : ''}</body></html>`;
}
