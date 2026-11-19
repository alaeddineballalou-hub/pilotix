// Linked accounts — SERVER ONLY (loaded by the server as '@pilotix/core/dist/social-server'). The login tab comes back
// here: its code becomes a token (Facebook: a person's token turned into one of about 60 days, whose Pages' tokens do not
// expire, or a configuration's « system user » token that does not expire; TikTok: an advertiser's token), then what the account may use
// is read (Facebook Pages with their Instagram account and their own tokens, Meta ad accounts, TikTok ad accounts) and
// each Page is subscribed to Pilotix's webhook (its messages and comments come to Pilotix). Tokens never leave the server.
// This one Facebook login is the only way Meta is connected: Instagram's answers ride on its key (when the key reaches
// the Instagram inbox), Publicité, the catalogue and the pixels on its ad accounts. WhatsApp keeps Meta's own window
// (Embedded Signup), opened from the same card of Pilot AI › Comptes.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { num } from './db';
import { AppError, Ctx } from './rpc';
import type { Tenancy } from './platform/tenancy';
import { getRaw, setRaw } from './modules/admin';
import { DELLAL_SECRETS, dellalSettings, WA_PIN_KEY } from './modules/dellal';
import { uniAccounts } from './dellal-server';
import { getSetting } from './settings';
import {
  adoptLinkIg,
  CheckGroup,
  markIgKey,
  deletionStatus,
  endState,
  FoundAccount,
  GONE_STATE,
  loginKindOf,
  META_FEATURES,
  MetaFeature,
  noteWaLogin,
  FoundAsset,
  holdFound,
  lastBadSignature,
  LoginKind,
  removeLink,
  saveLink,
  SOCIAL,
  SOCIAL_KEYS,
  SocialCheck,
  SocialProvider,
  socialApps,
  socialSecret,
  SocialTest,
  socialUrls,
  takeState,
} from './modules/social';

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
/** A key connected before with Instagram's own login (graph.instagram.com): the same, in Instagram's words (« Tester » reads it). */
async function igGraph(path: string, params: Record<string, string>): Promise<any> {
  const { res, data } = await fetchJson(`https://graph.instagram.com/v23.0/${path}?${new URLSearchParams(params).toString()}`, {}, 'Instagram');
  if (!res.ok || data?.error) {
    const e = data?.error;
    if (e?.code === 190) throw new AppError('bad_request', 'Instagram a refusé la clé (expirée ou retirée).');
    throw new AppError('bad_request', `Instagram : ${e?.error_user_msg ?? e?.message ?? res.statusText}`);
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

/**
 * Subscribes a Page to Pilotix's webhook: its messages and comments, and its ads' lead forms when the account gave their
 * permission (without it Facebook refuses the whole list: asked again without the forms, so the messages still come).
 */
async function subscribePage(pageId: string, token: string): Promise<{ leads: boolean }> {
  try {
    await graph(`${pageId}/subscribed_apps`, { subscribed_fields: `${SOCIAL.pageFields},${SOCIAL.leadFields}`, access_token: token }, 'POST');
    return { leads: true };
  } catch {
    await graph(`${pageId}/subscribed_apps`, { subscribed_fields: SOCIAL.pageFields, access_token: token }, 'POST');
    return { leads: false };
  }
}

/** A key's ad accounts (each one's ad problems asked for Pilotix's webhook), as a login keeps them. */
async function adAccountAssets(token: string, system: boolean): Promise<FoundAsset[]> {
  // without the ads permission there are no ad accounts: the Pages still work
  const adFields = { fields: 'id,account_id,name,currency,account_status', limit: '100', access_token: token };
  let ads = await graphAll('me/adaccounts', adFields).catch(() => []);
  // a key that does not end belongs to a « system user » of the business: its ad accounts are the ones it was given
  if (!ads.length && system) ads = await graphAll('me/assigned_ad_accounts', adFields).catch(() => []);
  const assets: FoundAsset[] = [];
  for (const a of ads) {
    const idOf = String(a?.account_id ?? String(a?.id ?? '').replace(/^act_/, ''));
    if (!/^\d+$/.test(idOf)) continue;
    // its ads' problems (rejected, payment…) come to Pilotix's webhook, so Co-Pilot warns (needs the account's admin)
    let hook = true;
    await graph(`act_${idOf}/subscribed_apps`, { access_token: token }, 'POST').catch(() => (hook = false));
    assets.push({ kind: 'ad_account', extId: idOf, name: String(a.name ?? idOf), extra: { currency: a.currency ?? null, status: a.account_status ?? null, hook } });
  }
  return assets;
}

/**
 * A Facebook login: the account, its Pages (each subscribed to Pilotix's webhook) and its ad accounts. « Connecter la
 * publicité » (kind 'ads') is the same account coming back through its own Facebook window: Meta adds what that window
 * gave to what the account already gave, so the account is read the same way (its Pages keep answering).
 */
async function metaAccount(t: Tenancy, code: string, publicUrl: string, kind: LoginKind = 'account'): Promise<FoundAccount> {
  const apps = await socialApps(t);
  const secret = await socialSecret(t, 'meta');
  if (!apps.meta.appId || !secret) throw new AppError('bad_request', 'L’app Meta de Pilotix n’est pas prête.');
  const tok = await graph('oauth/access_token', { client_id: apps.meta.appId, client_secret: secret, redirect_uri: socialUrls(publicUrl).metaRedirect, code });
  let token = String(tok.access_token ?? '');
  let expiresIn = Number(tok.expires_in) || 0;
  if (!token) throw new AppError('bad_request', 'Facebook n’a pas donné de jeton. Recommencez.');
  // A person's token (the classic login, or a configuration « User access token ») lasts an hour or two: Facebook turns
  // it into one of about 60 days, and the Pages' tokens read with that one do not expire. A configuration « System-user
  // access token » gives a token that does not expire already: Facebook refuses to turn it, and it is kept as it is.
  const withConfig = !!(kind === 'ads' ? apps.meta.adsConfigId : apps.meta.configId);
  const ll = await graph('oauth/access_token', { grant_type: 'fb_exchange_token', client_id: apps.meta.appId, client_secret: secret, fb_exchange_token: token }).catch((e) => {
    if (!withConfig) throw e;
    return null;
  });
  const system = withConfig && !ll?.access_token;
  if (ll?.access_token) {
    token = String(ll.access_token);
    expiresIn = Number(ll.expires_in) || 60 * 86_400;
  }
  const me = await graph('me', { fields: 'id,name,picture{url}', access_token: token });
  const pages = await graphAll('me/accounts', { fields: 'id,name,access_token,picture{url},instagram_business_account{id,username}', limit: '100', access_token: token });
  const assets: FoundAsset[] = [];
  for (const p of pages) {
    if (!p?.id || !p?.access_token) continue;
    // its messages and comments come to Pilotix's webhook
    let hook = true;
    await subscribePage(String(p.id), String(p.access_token)).catch(() => (hook = false));
    const ig: { id: string; username: string; key?: boolean } | undefined = p.instagram_business_account?.id
      ? { id: String(p.instagram_business_account.id), username: String(p.instagram_business_account.username ?? '') }
      : undefined;
    // The account's key reaches the Instagram inbox itself: it will answer every Instagram customer of the boutique
    // that takes this Page (no second connection for Instagram); the account's messages are asked for with it too
    // (Meta may refuse that one: they still come through the Page).
    if (ig && (await igReach(token, ig.id)).ok) {
      ig.key = true;
      await graph(`${IG_UNI}/${ig.id}/subscribed_apps`, { subscribed_fields: IG_FIELDS, access_token: token }, 'POST').catch(() => null);
    }
    assets.push({ kind: 'page', extId: String(p.id), name: String(p.name ?? p.id), extra: { picture: p.picture?.data?.url ?? null, ...(ig ? { ig } : {}), hook }, token: String(p.access_token) });
  }
  assets.push(...(await adAccountAssets(token, system)));
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

/** Meta's API version of the Instagram key's own calls (dellal-server.ts answers and reads Instagram with the same). */
const IG_UNI = 'https://graph.facebook.com/v23.0';
/** What an Instagram account sends Pilotix's webhook when its key asks for it. */
const IG_FIELDS = 'messages,messaging_postbacks,messaging_referral,comments';
/**
 * Does this key reach an Instagram account's inbox itself (not only through its Page)? Then Pilotix answers every
 * customer of the account with it, and reads its chats again with it (the very question the safety net asks).
 */
export async function igReach(token: string, igId: string): Promise<{ ok: boolean; why: string | null }> {
  try {
    await graph(`${IG_UNI}/${igId}/conversations`, { platform: 'instagram', fields: 'id', limit: '1', access_token: token });
    return { ok: true, why: null };
  } catch (e) {
    return { ok: false, why: String((e as any)?.message ?? e).slice(0, 240) };
  }
}

/**
 * « Connecter WhatsApp » (Pilot AI › Comptes): Meta's Embedded Signup with the WhatsApp configuration. In Meta's
 * window the shop picks (or makes) its WhatsApp Business account and its number; Pilotix reads which account the key was
 * given (debug_token's granular scopes), then its number. Its key and number wait for « Oui, c'est ma boutique ».
 */
async function whatsappAccount(t: Tenancy, code: string, publicUrl: string | null, prefer: { wabaId?: string | null; phoneId?: string | null } = {}): Promise<FoundAccount> {
  const apps = await socialApps(t);
  const secret = await socialSecret(t, 'meta');
  if (!apps.meta.appId || !secret) throw new AppError('bad_request', 'L’app Meta de Pilotix n’est pas prête.');
  // Meta's popup (JavaScript SDK) gives a code that is exchanged without redirect_uri; the old tab gives one with it
  const tok = await graph('oauth/access_token', {
    client_id: apps.meta.appId,
    client_secret: secret,
    ...(publicUrl ? { redirect_uri: socialUrls(publicUrl).metaRedirect } : {}),
    code,
  });
  let token = String(tok.access_token ?? '');
  let expiresIn = Number(tok.expires_in) || 0;
  if (!token) throw new AppError('bad_request', 'Meta n’a pas donné de clé. Recommencez.');
  // a person's key becomes one of about 60 days; a business key (that does not end) is kept as it is
  const ll = await graph('oauth/access_token', { grant_type: 'fb_exchange_token', client_id: apps.meta.appId, client_secret: secret, fb_exchange_token: token }).catch(() => null);
  if (ll?.access_token) {
    token = String(ll.access_token);
    expiresIn = Number(ll.expires_in) || 60 * 86_400;
  }
  // the WhatsApp Business accounts the shop gave Pilotix in Meta's window
  const dbg = await graph('debug_token', { input_token: token, access_token: `${apps.meta.appId}|${secret}` });
  const scopes: any[] = Array.isArray(dbg?.data?.granular_scopes) ? dbg.data.granular_scopes : [];
  const wabas = [
    ...new Set(scopes.filter((x) => x?.scope === 'whatsapp_business_management').flatMap((x) => (Array.isArray(x.target_ids) ? x.target_ids.map(String) : []))),
  ].filter((x) => /^\d{1,30}$/.test(x));
  if (!wabas.length)
    throw new AppError('bad_request', 'Aucun compte WhatsApp Business trouvé avec cette connexion. Dans la fenêtre de Meta, choisissez (ou créez) le compte WhatsApp de la boutique et son numéro, puis recommencez.');
  // the account the popup said comes first, only if the key really was given it (never a number Pilotix may not use)
  const said = String(prefer.wabaId ?? '');
  if (said && !wabas.includes(said)) throw new AppError('bad_request', 'Meta n’a pas donné à Pilotix le compte WhatsApp choisi. Recommencez la connexion.');
  const order = said ? [said, ...wabas.filter((x) => x !== said)] : wabas;
  for (const id of order) {
    const waba = await graph(id, { fields: 'id,name', access_token: token }).catch(() => null);
    const nums = await graph(`${id}/phone_numbers`, { fields: 'id,display_phone_number,verified_name', access_token: token }).catch(() => null);
    const list: any[] = (Array.isArray(nums?.data) ? nums.data : []).filter((x: any) => /^\d{1,30}$/.test(String(x?.id ?? '')));
    const n = (id === said && prefer.phoneId ? list.find((x) => String(x.id) === String(prefer.phoneId)) : null) ?? list[0];
    if (!n) continue;
    const phone = String(n.display_phone_number ?? '').slice(0, 40);
    const name = String(n.verified_name || waba?.name || 'WhatsApp').slice(0, 200);
    return {
      provider: 'meta',
      extId: id,
      name,
      token,
      tokenKind: ll?.access_token ? 'user' : 'system',
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
      assets: [],
      whatsapp: { wabaId: id, phoneId: String(n.id), phone, name },
    };
  }
  throw new AppError('bad_request', 'Ce compte WhatsApp Business n’a pas encore de numéro. Dans la fenêtre de Meta, ajoutez le numéro de la boutique (code reçu par SMS), puis recommencez.');
}

/**
 * « Oui, c'est ma boutique » for « Connecter WhatsApp »: the account's messages come to Pilotix's app, the number is
 * registered for the Cloud API (with a two-step PIN Pilotix keeps), and the key and the number go to the boutique's
 * Pilot Message (Dellal answers on it), its delivery messages and its campaigns' templates (the account's id).
 */
async function linkWhatsapp(t: Tenancy, shopId: number | null, f: FoundAccount): Promise<{ ok: boolean; message: string; account?: string; warn?: string }> {
  if (!shopId || !f.whatsapp) return { ok: false, message: 'Boutique introuvable. Recommencez depuis Pilot AI › Comptes.' };
  const r = (await t.platform.query(`SELECT schema_name FROM platform.shops WHERE id = $1 AND status NOT IN ('archived', 'deleted')`, [shopId]))[0];
  if (!r) return { ok: false, message: 'Boutique introuvable.' };
  const db = t.shop(String(r.schema_name));
  const w = f.whatsapp;
  // without it no message comes: the link stops here, with Meta's reason
  await graph(`${w.wabaId}/subscribed_apps`, { access_token: f.token }, 'POST');
  // a number already registered (or with another PIN) says why: the link goes on, and the tab says it
  const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
  let warn = '';
  try {
    await graph(`${w.phoneId}/register`, { messaging_product: 'whatsapp', pin, access_token: f.token }, 'POST');
    await setRaw(db, WA_PIN_KEY, pin);
  } catch (e: any) {
    warn = String(e?.message ?? e).slice(0, 240);
  }
  await setRaw(db, DELLAL_SECRETS.waToken, f.token);
  await setRaw(db, 'dellal', { ...(await dellalSettings(db)), whatsappPhoneId: w.phoneId, whatsappPhone: w.phone });
  await setRaw(db, 'notify', { ...(await getRaw<Record<string, unknown>>(db, 'notify', {})), wabaId: w.wabaId });
  await noteWaLogin(t, shopId, w.phoneId, w.phone);
  return {
    ok: true,
    message: 'WhatsApp connecté',
    account: w.phone || f.name,
    ...(warn ? { warn: `Meta n’a pas enregistré le numéro pour l’envoi (${warn}). Les messages peuvent ne pas partir : écrivez à l’équipe Pilotix.` } : {}),
  };
}

/**
 * « Connecter WhatsApp » with Meta's own popup (JavaScript SDK, Meta's recommended Embedded Signup): the page sends the
 * code and what Meta's window said (WA_EMBEDDED_SIGNUP: the account and the number). The state must be this boutique's
 * « Connecter WhatsApp », unused and recent; the person is already signed in to this boutique, so no « Oui, c'est ma
 * boutique » tab: the number goes straight to its Pilot Message.
 */
export async function finishWhatsappPopup(t: Tenancy, shopId: number, a: { state: string; code: string; wabaId?: string | null; phoneId?: string | null }) {
  const st = await takeState(t, a.state);
  if (!st || st.provider !== 'meta' || loginKindOf(st.state) !== 'whatsapp' || st.fromShop !== shopId || st.shopId !== shopId)
    return { ok: false, message: 'Connexion introuvable. Recommencez depuis Pilot AI › Comptes.' };
  if (st.done) return { ok: false, message: 'Cette connexion a déjà servi. Recommencez.' };
  if (st.expired) {
    await endState(t, st.state, { error: 'Le temps est passé (20 minutes) : recommencez.' });
    return { ok: false, message: 'Le temps est passé (20 minutes) : recommencez.' };
  }
  const ok = (x: unknown) => (/^\d{1,30}$/.test(String(x ?? '')) ? String(x) : null);
  try {
    const found = await whatsappAccount(t, a.code, null, { wabaId: ok(a.wabaId), phoneId: ok(a.phoneId) });
    const r = await linkWhatsapp(t, shopId, found);
    await endState(t, st.state, r.ok ? { linkId: null } : { error: r.message });
    return r;
  } catch (e: any) {
    const m = String(e?.message ?? 'Erreur').slice(0, 300);
    await endState(t, st.state, { error: m });
    return { ok: false, message: m };
  }
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
  /** done, but something did not go (« Connecter WhatsApp »: the number not registered): the tab says it and stays open */
  warn?: string;
  /** the account is back: its tab asks « Oui, c'est ma boutique ? » (key: that page's one-time key; net: what the account is, Facebook by default) */
  confirm?: { state: string; key: string; provider: SocialProvider; account: string; shop: string | null; by: string; assets: { kind: string; name: string }[]; net?: string };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * The login tab is back (?code / ?auth_code and ?state): the state is checked (known, from this provider, not used, not
 * older than 20 minutes) and what the login brought waits there. The tab then asks « Oui, c'est ma boutique ? » with
 * the boutique and the person who asked: a login link sent to someone else (their account would go to a stranger's
 * boutique) ends here, by their « Non ». Only that tab can say yes (its one-time key).
 */
export async function finishLogin(t: Tenancy, provider: SocialProvider, q: Record<string, unknown>, publicUrl: string): Promise<LoginEnd> {
  const st = await takeState(t, String(q.state ?? ''));
  if (!st || st.provider !== provider) return { ok: false, message: 'Ce lien de connexion est inconnu. Fermez cet onglet et recommencez depuis Pilotix.' };
  if (st.done) return { ok: false, message: 'Ce lien a déjà servi. Fermez cet onglet et revenez sur Pilotix.' };
  // « Connecter Instagram » is gone (Instagram comes with the Facebook account now): a tab of it still open ends here
  if (st.state.startsWith(GONE_STATE)) {
    const gone = 'Cette connexion n’existe plus : Instagram se connecte maintenant avec « Continuer avec Facebook » (Pilot AI › Comptes).';
    await endState(t, st.state, { error: gone });
    return { ok: false, message: `${gone} Fermez cet onglet.` };
  }
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
    const kind = loginKindOf(st.state);
    const found = provider === 'meta' ? (kind === 'whatsapp' ? await whatsappAccount(t, code, publicUrl) : await metaAccount(t, code, publicUrl, kind)) : await tiktokAccount(t, code);
    const key = randomBytes(24).toString('base64url');
    await holdFound(t, st.state, found, sha256(key));
    const shop = st.shopId ? String((await t.platform.query('SELECT name FROM platform.shops WHERE id = $1', [st.shopId]))[0]?.name ?? '') : null;
    return {
      ok: true,
      message: 'À confirmer',
      account: found.name,
      confirm: found.whatsapp
        ? { state: st.state, key, provider, account: found.name, shop, by: st.by, assets: found.whatsapp.phone ? [{ kind: 'whatsapp', name: found.whatsapp.phone }] : [], net: 'WhatsApp Business' }
        : { state: st.state, key, provider, account: found.name, shop, by: st.by, assets: found.assets.slice(0, 8).map((a) => ({ kind: a.kind, name: a.name })) },
    };
  } catch (e: any) {
    const m = String(e?.message ?? 'Erreur').slice(0, 300);
    await endState(t, st.state, { error: m });
    return { ok: false, message: m };
  }
}

/** « Oui, c'est ma boutique » (or « Non ») in the login's tab: the account goes to the boutique, or nothing happens. */
export async function confirmLogin(t: Tenancy, state: string, key: string, yes: boolean): Promise<LoginEnd> {
  const st = await takeState(t, String(state ?? ''));
  if (!st || st.done || !st.found || !st.confirmHash) return { ok: false, message: 'Cette liaison est déjà faite ou n’existe plus. Fermez cet onglet.' };
  const want = Buffer.from(st.confirmHash, 'hex');
  const got = Buffer.from(sha256(String(key ?? '')), 'hex');
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, message: 'Cette page de confirmation n’est pas la bonne. Recommencez depuis Pilotix.' };
  if (st.expired) {
    await endState(t, st.state, { error: 'Le temps est passé (20 minutes) : recommencez.' });
    return { ok: false, message: 'Le temps est passé (20 minutes). Fermez cet onglet et recommencez depuis Pilotix.' };
  }
  if (!yes) {
    await endState(t, st.state, { error: 'Pas lié : « Ce n’est pas ma boutique » dans l’onglet de connexion.' });
    return { ok: false, message: 'Rien n’a été lié. Si vous n’avez rien demandé, vous pouvez retirer Pilotix de votre compte (Facebook : Paramètres › Intégrations professionnelles).' };
  }
  // « Connecter WhatsApp »: a number, not an account of the list (it goes to the boutique's Pilot Message)
  if (st.found.whatsapp) {
    const r = await linkWhatsapp(t, st.shopId, st.found).catch((e: any) => ({ ok: false, message: String(e?.message ?? 'Erreur').slice(0, 300), account: undefined }));
    await endState(t, st.state, r.ok ? { linkId: null } : { error: r.message });
    return r;
  }
  const linkId = await saveLink(t, st, st.found);
  await endState(t, st.state, { linkId });
  return { ok: true, message: 'Compte lié', account: st.found.name };
}

// ---------------------------------------------------------------- « Coller une clé Meta Ads » (Pilot AI › Comptes)
/**
 * A key the boutique made in its own Meta business (Paramètres de l'entreprise › Utilisateurs système › Générer un
 * jeton, for Pilotix's app, with the ads permissions): asked to Meta (alive, of Pilotix's app, with an ads permission),
 * its ad accounts read, then kept like a linked account of this boutique alone (its ad accounts counted at once when the
 * boutique counted none). The way to count and launch ads while Facebook's own window does not give the ads permissions.
 */
export async function pasteAdsKey(t: Tenancy, a: { token: string; shopId: number; ownerId: number; by: string }): Promise<number> {
  const apps = await socialApps(t);
  const secret = await socialSecret(t, 'meta');
  if (!apps.meta.appId || !secret) throw new AppError('bad_request', 'L’app Meta de Pilotix n’est pas prête.');
  const token = String(a.token ?? '').trim();
  const dbg = (await graph('debug_token', { input_token: token, access_token: `${apps.meta.appId}|${secret}` }).catch(() => null))?.data;
  if (!dbg?.is_valid) throw new AppError('bad_request', 'Meta refuse cette clé (fausse, retirée ou finie). Générez-en une nouvelle et collez-la en entier.');
  if (String(dbg.app_id ?? '') !== apps.meta.appId)
    throw new AppError('bad_request', 'Cette clé vient d’une autre app. Générez-la pour l’app de Pilotix (Utilisateurs système › Générer un jeton › choisir l’app).');
  const scopes = new Set((Array.isArray(dbg.scopes) ? dbg.scopes : []).map(String));
  if (!scopes.has('ads_read') && !scopes.has('ads_management'))
    throw new AppError('bad_request', 'Cette clé n’a pas la permission des publicités : cochez ads_read et ads_management en la générant.');
  const me = await graph('me', { fields: 'id,name', access_token: token });
  const system = String(dbg.type ?? '').toUpperCase() !== 'USER';
  const assets = await adAccountAssets(token, system);
  if (!assets.length)
    throw new AppError('bad_request', 'Cette clé ne voit aucun compte publicitaire : donnez d’abord le compte publicitaire à l’utilisateur système (Ajouter des ressources), puis générez la clé.');
  const ends = Number(dbg.expires_at) || 0;
  return saveLink(
    t,
    { state: '', provider: 'meta', ownerId: a.ownerId, shopId: a.shopId, fromShop: a.shopId, by: a.by, expired: false, done: false, found: null, confirmHash: null },
    { provider: 'meta', extId: String(me.id), name: String(me.name ?? 'Meta Ads'), picture: '', token, tokenKind: system ? 'system' : 'user', expiresAt: ends ? new Date(ends * 1000).toISOString() : null, assets },
  );
}

// ---------------------------------------------------------------- « Tester » (Pilot AI › Comptes)
/** The server's hook: 'test' (one linked account, for one boutique); 'ttCatalog…' (Marketing › Catalogue on TikTok). */
export async function runSocial(action: string, args: any, ctx: Ctx): Promise<unknown> {
  if (action === 'test') return testLink(ctx.t!, num(args?.shopId), num(args?.linkId), ctx.server?.publicUrl ?? '');
  if (action === 'waFinish') return finishWhatsappPopup(ctx.t!, num(args?.shopId), args ?? {});
  if (action === 'adsKey') return pasteAdsKey(ctx.t!, { token: String(args?.token ?? ''), shopId: num(args?.shopId), ownerId: num(args?.ownerId), by: String(args?.by ?? '') });
  if (action.startsWith('ttCatalog')) return runTtCatalog(action, args ?? {}, ctx);
  throw new AppError('bad_request', `Action inconnue : ${action}`);
}

// ---------------------------------------------------------------- Marketing › Catalogue on TikTok
// The shop's lists go to a TikTok catalog too: made once in the account's Business Center (targeting Algeria, in
// dinars), the shop's TikTok pixel bound to it; each list is a product set (its products' item_group_id). TikTok takes
// the products in the background: an upload gives a log id, read again a minute later for what it refused.

/** Algeria and its money: Pilotix's shops sell there. */
const TT_REGION = 'DZ';
const TT_CURRENCY = 'DZD';
export const TT_NO_REGION = 'TikTok ne propose pas encore les publicités catalogue pour l’Algérie. Vos listes restent sur Meta ; réessayez plus tard.';

/** TikTok's refusal, in plain words (its code says why). */
export function ttCatalogError(code: number, message: string, status = 200): AppError {
  if ([40102, 40104, 40105, 40106].includes(code) || status === 401)
    return new AppError('bad_request', 'TikTok a refusé la clé de votre compte. Reliez TikTok à nouveau dans Pilot AI › Comptes.');
  if (code === 40001)
    return new AppError(
      'bad_request',
      'TikTok refuse : votre compte n’a pas le droit de gérer les catalogues. Il faut être « Admin » du Business Center, et l’app TikTok de Pilotix doit avoir la permission « Catalog Management ».',
    );
  if (code === 40118) return new AppError('bad_request', 'TikTok n’ouvre pas encore les catalogues à votre compte (pays ou compte pas encore ouvert).');
  if ([40016, 40100, 40133, 51021].includes(code) || status === 429) return new AppError('conflict', 'TikTok limite les demandes pour l’instant. Réessayez dans quelques minutes.');
  return new AppError('bad_request', `TikTok : ${message || 'erreur inconnue'}`.slice(0, 300));
}

async function ttApi(path: string, token: string, o: { query?: Record<string, string>; body?: unknown } = {}): Promise<any> {
  const url = `${SOCIAL.tiktokApi}/${path}${o.query ? `?${new URLSearchParams(o.query)}` : ''}`;
  const { res, data } = await fetchJson(
    url,
    o.body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'Access-Token': token }, body: JSON.stringify(o.body) } : { headers: { 'Access-Token': token } },
    'TikTok',
  );
  const code = data?.code === undefined ? (res.ok ? 0 : -1) : Number(data.code);
  if (res.ok && code === 0) return data?.data ?? {};
  throw ttCatalogError(code, String(data?.message ?? res.statusText ?? ''), res.status);
}

/** What TikTok said about one upload: done or not, and the products it refused (TikTok lists 5 per kind of error). */
export function ttLogOf(data: any): { done: boolean; failed: boolean; errors: { id: string; message: string }[] } {
  const log = data?.product_feed_log ?? {};
  const status = String(log.process_status ?? '');
  const errors: { id: string; message: string }[] = [];
  for (const e of Array.isArray(log.feed_log_data?.error_affected_products) ? log.feed_log_data.error_affected_products : []) {
    const message = [e?.issue, e?.suggestion].filter(Boolean).map(String).join(' — ').slice(0, 300) || 'Refusé par TikTok';
    for (const it of Array.isArray(e?.affected_product_item_list) ? e.affected_product_item_list : []) if (it?.sku_id) errors.push({ id: String(it.sku_id), message });
  }
  return { done: status === 'SUCCESS' || status === 'FAILED', failed: status === 'FAILED', errors };
}

async function runTtCatalog(action: string, args: any, ctx: Ctx): Promise<unknown> {
  const token = await getRaw<string>(ctx.db, SOCIAL_KEYS.tiktokAdsToken, '');
  if (!token) throw new AppError('bad_request', 'Reliez d’abord votre compte TikTok Ads dans Pilot AI › Comptes.');
  const bc = String(args.bcId ?? '');
  const catalog = String(args.catalogId ?? '');

  if (action === 'ttCatalogSetup') {
    // the Business Center the catalog lives in: one where the account is an admin, else the first
    const r = await ttApi('bc/get/', token, { query: { page: '1', page_size: '50' } });
    const list: any[] = Array.isArray(r?.list) ? r.list : [];
    const pick = list.find((x) => x?.user_role === 'ADMIN' && x?.bc_info?.bc_id) ?? list.find((x) => x?.bc_info?.bc_id);
    if (!pick)
      throw new AppError('bad_request', 'Votre compte TikTok n’a pas de Business Center. Créez-en un (gratuit) sur business.tiktok.com, mettez-y votre compte pub, puis reliez TikTok à nouveau.');
    const bcId = String(pick.bc_info.bc_id);
    const bcName = String(pick.bc_info.name ?? '');
    let catalogId = catalog;
    if (!catalogId) {
      // TikTok's catalog ads reach only some countries: Algeria must be one of them
      const av = await ttApi('catalog/available_country/get/', token, { query: { bc_id: bcId } });
      const codes: string[] = (Array.isArray(av?.region_codes) ? av.region_codes : []).map(String);
      if (!codes.includes(TT_REGION)) throw new AppError('bad_request', TT_NO_REGION);
      const made = await ttApi('catalog/create/', token, {
        body: { bc_id: bcId, name: String(args.name ?? 'Pilotix').slice(0, 128), catalog_type: 'ECOM', catalog_conf: { region_code: TT_REGION, currency: TT_CURRENCY } },
      });
      catalogId = String(made?.catalog_id ?? '');
      if (!catalogId) throw new AppError('bad_request', 'TikTok n’a pas créé le catalogue. Réessayez dans un moment.');
    }
    // the shop's TikTok pixel, so its visitors and orders find the products again (best effort)
    let pixelBound = false;
    const ads = await getRaw<any>(ctx.db, SOCIAL_KEYS.tiktokAds, null);
    const advertiserId = String(ads?.advertiserId ?? '');
    const pixel = String(args.pixelCode ?? '');
    if (pixel && advertiserId)
      pixelBound = await ttApi('catalog/eventsource/bind/', token, { body: { bc_id: bcId, advertiser_id: advertiserId, catalog_id: catalogId, pixel_code: pixel } })
        .then(() => true)
        .catch(() => false);
    return { bcId, bcName, catalogId, pixelBound };
  }

  if (!bc || !catalog) throw new AppError('bad_request', 'Catalogue TikTok manquant');
  if (action === 'ttCatalogUpload') {
    const products = Array.isArray(args.products) ? args.products.slice(0, 5000) : [];
    const r = await ttApi('catalog/product/upload/', token, { body: { bc_id: bc, catalog_id: catalog, products } });
    return { logId: r?.feed_log_id ? String(r.feed_log_id) : null };
  }
  if (action === 'ttCatalogDelete') {
    const skuIds = (Array.isArray(args.skuIds) ? args.skuIds : []).map(String).slice(0, 5000);
    if (!skuIds.length) return { logId: null };
    const r = await ttApi('catalog/product/delete/', token, { body: { bc_id: bc, catalog_id: catalog, sku_ids: skuIds } });
    return { logId: r?.feed_log_id ? String(r.feed_log_id) : null };
  }
  if (action === 'ttCatalogLog') {
    const r = await ttApi('catalog/product/log/', token, { query: { bc_id: bc, catalog_id: catalog, feed_log_id: String(args.logId ?? ''), language: 'fr' } });
    return ttLogOf(r);
  }
  if (action === 'ttCatalogSet') {
    // a list: its products' every colour and size (item_group_id = the product); TikTok takes 1,024 values at most
    const groups = (Array.isArray(args.groupIds) ? args.groupIds : []).map(String).slice(0, 1024);
    const body = {
      bc_id: bc,
      catalog_id: catalog,
      product_set_name: String(args.name ?? 'Liste').slice(0, 27),
      conditions: { and: [{ field: 'item_group_id', operation: 'CONTAIN', value: groups.length ? groups : ['none'] }] },
    };
    if (args.setId) {
      await ttApi('catalog/set/update/', token, { body: { ...body, product_set_id: String(args.setId) } });
      return { setId: String(args.setId) };
    }
    const r = await ttApi('catalog/set/create/', token, { body });
    return { setId: String(r?.product_set_id ?? '') };
  }
  if (action === 'ttCatalogSetDelete') {
    if (args.setId) await ttApi('catalog/set/delete/', token, { body: { bc_id: bc, catalog_id: catalog, product_set_ids: [String(args.setId)] } }).catch(() => null);
    return { ok: true };
  }
  throw new AppError('bad_request', `Action TikTok inconnue : ${action}`);
}

const jsonOf = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v ?? {});
const why = (e: unknown) => String((e as any)?.message ?? e).slice(0, 240);

/** When Meta last sent Pilotix a customer's comment for a Page / an Instagram account (routeMeta writes it down). */
async function lastComment(t: Tenancy, object: 'page' | 'instagram', extId: string): Promise<{ at: string; routed: boolean } | null> {
  const r = (await t.platform.query(`SELECT comment_at, routed FROM platform.social_hooks WHERE object = $1 AND ext_id = $2 AND comment_at IS NOT NULL`, [object, extId]).catch(() => []))[0];
  return r ? { at: new Date(r.comment_at).toISOString(), routed: !!r.routed } : null;
}

/**
 * An ad account that is not simply active at Meta (account_status): the page says which case in plain words. Disabled,
 * unpaid or closed: its ads do not run (red); the others: to look at.
 */
const AD_STATES: Record<number, { why: string; state: 'warn' | 'bad' }> = {
  2: { why: 's2', state: 'bad' },
  3: { why: 's3', state: 'bad' },
  7: { why: 's7', state: 'warn' },
  8: { why: 's8', state: 'warn' },
  9: { why: 's9', state: 'warn' },
  100: { why: 's100', state: 'warn' },
  101: { why: 's101', state: 'bad' },
};
/** An ad account as its key sees it: its name, its state, and what the key may do there when Meta says it (user_tasks). */
const readAdAccount = (id: string, token: string): Promise<any> =>
  graph(`act_${id}`, { fields: 'id,name,account_status,currency,user_tasks', access_token: token }).catch(() => graph(`act_${id}`, { fields: 'id,name,account_status,currency', access_token: token }));

/**
 * Tries a linked account now, for this boutique, part by part and one line per thing (none stops the others), so the
 * person sees WHERE a problem is and what to do:
 *  - key: the account's key, how long it lasts, what Facebook gave it (how many Pages, Instagram accounts, ad accounts);
 *  - fb: the Page this boutique uses (its key; subscribed to Pilotix's webhook again when its messages would not come),
 *    its last message and comment, the safety net;
 *  - ig: its Instagram account (its inbox, its last message and comment) and the key that answers it: the account's
 *    own key when it reaches the inbox (taken at once when the boutique had none, or when the key connected before in
 *    Pilot Message no longer works);
 *  - ads: the ad accounts this boutique counts (each one read, its state at Meta, its numbers, launching), or the key
 *    pasted before that Publicité still runs on;
 *  - forms, catalog, pixels, content: the ads' forms, the catalogue and the pixels (read with the boutique's ads key),
 *    publishing;
 *  - wa: the boutique's WhatsApp number;
 *  - app: Pilotix's Meta app webhook (its address and fields), and that the address answers from the Internet.
 * Each part names the permission it misses (what the key was given comes from Meta's debug_token: the permissions, and
 * for which accounts). A key Facebook refuses turns the account red; a key that works again turns it green.
 */
export async function testLink(t: Tenancy, shopId: number, linkId: number, publicUrl: string): Promise<SocialTest> {
  const l = (await t.platform.query(`SELECT * FROM platform.social_links WHERE id = $1`, [linkId]))[0];
  if (!l) throw new AppError('not_found', 'Compte introuvable');
  const checks: SocialCheck[] = [];
  const add = (group: CheckGroup, key: string, state: SocialCheck['state'], params?: SocialCheck['params'], detail?: string | null) =>
    checks.push({ key, group, state, ...(params ? { params } : {}), detail: detail ?? null });
  const assets = await t.platform.query(`SELECT * FROM platform.social_assets WHERE link_id = $1 ORDER BY kind, name, id`, [linkId]);
  const uses = await t.platform.query(`SELECT u.kind, u.asset_id FROM platform.social_uses u JOIN platform.social_assets a ON a.id = u.asset_id WHERE u.shop_id = $1 AND a.link_id = $2`, [shopId, linkId]);
  const counts = (kind: string) => uses.some((u: any) => u.kind === kind);
  const token = String(l.token ?? '');
  const setStatus = (ok: boolean, error?: string) =>
    t.platform.query(`UPDATE platform.social_links SET status = $2, error = $3, updated_at = now() WHERE id = $1`, [linkId, ok ? 'ok' : 'error', ok ? null : (error ?? '').slice(0, 300)]);
  // a key refused (expired, removed on Facebook): red until linked again; a limit or a network problem says nothing about it
  const keyRefused = (e: unknown) => /refusé la connexion|jeton/i.test(why(e)) || /Access token|session has expired|Error validating/i.test(why(e));

  if (l.provider === 'tiktok') {
    const apps = await socialApps(t);
    const secret = await socialSecret(t, 'tiktok');
    try {
      const r = await tiktok('oauth2/advertiser/get/', { token, query: { app_id: apps.tiktok.appId, secret } });
      const n = Array.isArray(r?.list) ? r.list.length : 0;
      add('key', 'token', 'ok', { name: String(l.name ?? 'TikTok'), count: n });
      if (l.status === 'error') await setStatus(true);
    } catch (e) {
      add('key', 'token', 'bad', undefined, why(e));
      if (keyRefused(e)) await setStatus(false, why(e));
    }
    if (counts('advertiser')) add('ads', 'ads', 'ok', { count: assets.filter((a: any) => a.kind === 'advertiser').length, bad: 0 });
    return { at: new Date().toISOString(), checks };
  }

  // ------------------------------------------------------------ the key, and what Facebook gave it
  let keyOk = false;
  try {
    const me = await graph('me', { fields: 'id,name', access_token: token });
    keyOk = true;
    add('key', 'token', 'ok', { name: String(me.name ?? l.name ?? '') });
    if (l.status === 'error') await setStatus(true);
  } catch (e) {
    add('key', 'token', 'bad', undefined, why(e));
    if (keyRefused(e)) await setStatus(false, why(e));
  }
  const apps = await socialApps(t);
  const secret = await socialSecret(t, 'meta');
  // its permissions, and for which accounts each was given (Meta's debug_token); without it, the permissions alone
  let granted: Set<string> | null = null;
  let granular: any[] = [];
  let ends: number | null = l.expires_at ? new Date(l.expires_at).getTime() : null;
  if (keyOk) {
    const dbg = apps.meta.appId && secret ? (await graph('debug_token', { input_token: token, access_token: `${apps.meta.appId}|${secret}` }).catch(() => null))?.data : null;
    if (Array.isArray(dbg?.scopes)) granted = new Set(dbg.scopes.map(String));
    if (Array.isArray(dbg?.granular_scopes)) granular = dbg.granular_scopes;
    if (dbg && Number.isFinite(Number(dbg.expires_at)) && dbg.expires_at !== undefined) ends = Number(dbg.expires_at) > 0 ? Number(dbg.expires_at) * 1000 : null;
    if (!granted) {
      try {
        granted = new Set((await graphAll('me/permissions', { access_token: token })).filter((p) => p?.status === 'granted').map((p) => String(p.permission)));
      } catch (e) {
        add('key', 'perms', 'warn', undefined, why(e));
      }
    }
    if (ends === null) add('key', 'keyLife', 'ok', { why: 'never' });
    else add('key', 'keyLife', ends - Date.now() < SOCIAL.soonDays * 86_400_000 ? 'warn' : 'ok', { until: new Date(ends).toISOString() });
  }
  // reading the numbers is allowed by the permission to manage the ads too
  const has = (p: string) => !granted || granted.has(p) || (p === 'ads_read' && granted.has('ads_management'));
  /** A part's missing permissions, said on its own line (bad: the boutique uses this part now; warn: it would need it). */
  const perm = (group: CheckGroup, feat: MetaFeature, state: SocialCheck['state']) => {
    const missing = [...new Set(META_FEATURES[feat].filter((p) => !has(p)))];
    if (missing.length) add(group, 'perm', state, { why: feat, list: missing.join(', ') });
    return !missing.length;
  };
  /** Was this permission given for this very account? (null: Meta did not say; true: for it, or for all) */
  const givenFor = (scope: string, id: string): boolean | null => {
    const g = granular.find((x) => x?.scope === scope);
    if (!g) return null;
    const ids: string[] = Array.isArray(g.target_ids) ? g.target_ids.map(String) : [];
    return !ids.length || ids.includes(id);
  };
  const pagesAll = assets.filter((a: any) => a.kind === 'page');
  const adsAll = assets.filter((a: any) => a.kind === 'ad_account');
  const igsAll = pagesAll.filter((a: any) => jsonOf(a.extra).ig?.id).length;
  // what Facebook gave Pilotix at the last login: a zero says what was not ticked in Facebook's window
  if (keyOk) add('key', 'given', pagesAll.length && adsAll.length ? 'ok' : 'info', { pages: pagesAll.length, igs: igsAll, ads: adsAll.length });

  // this boutique's own settings (what its agents read)
  const schema = (await t.platform.query(`SELECT schema_name FROM platform.shops WHERE id = $1`, [shopId]).catch(() => []))[0]?.schema_name;
  const db = schema ? t.shop(String(schema)) : null;
  const iso = (v: unknown) => new Date(v as string).toISOString();

  // ------------------------------------------------------------ the Page this boutique answers on (from this account)
  const pageUse = uses.find((u: any) => u.kind === 'page');
  const page = pageUse ? assets.find((a: any) => num(a.id) === num(pageUse.asset_id)) : null;
  if (page) {
    const ptoken = String(page.token ?? '');
    const name = String(page.name ?? '');
    const pageId = String(page.ext_id);
    perm('fb', 'fbMessages', 'bad');
    perm('fb', 'fbComments', 'bad');
    let pageOk = false;
    try {
      await graph(pageId, { fields: 'id,name', access_token: ptoken });
      pageOk = true;
      add('fb', 'page', 'ok', { name });
    } catch (e) {
      add('fb', 'page', 'bad', { name }, why(e));
    }
    if (pageOk) {
      const extra = jsonOf(page.extra);
      let hook = false;
      let leadLine: [SocialCheck['state'], SocialCheck['params']?] = ['warn'];
      try {
        const subs = await graphAll(`${pageId}/subscribed_apps`, { access_token: ptoken });
        const mine = subs.find((s) => String(s?.id) === apps.meta.appId);
        const have = new Set<string>((mine?.subscribed_fields ?? []).map(String));
        // the ads' lead forms (Marketing › Formulaires): asked again when missing, if the account gave their permission
        let leads = have.has(SOCIAL.leadFields);
        const all = !!mine && SOCIAL.pageFields.split(',').every((f) => have.has(f));
        if (all && leads) add('fb', 'pageHook', 'ok');
        else {
          const r = await subscribePage(pageId, ptoken);
          add('fb', 'pageHook', 'ok', all ? undefined : { fixed: 1 });
          if (r.leads && !leads) leadLine = ['ok', { fixed: 1 }];
          leads = r.leads;
        }
        if (leads && leadLine[0] !== 'ok') leadLine = ['ok'];
        hook = true;
      } catch (e) {
        add('fb', 'pageHook', 'bad', undefined, why(e));
      }
      if (extra.hook !== hook) await t.platform.query(`UPDATE platform.social_assets SET extra = $2 WHERE id = $1`, [num(page.id), JSON.stringify({ ...extra, hook })]);
      // Messenger: when Meta last sent Pilotix a customer's message for this Page (routeMeta writes it down)
      const fbm = (await t.platform.query(`SELECT routed, message_at FROM platform.social_hooks WHERE object = 'page' AND ext_id = $1`, [pageId]).catch(() => []))[0];
      add('fb', 'fbSeen', fbm?.message_at && fbm.routed ? 'ok' : 'warn', { name, ...(fbm?.message_at ? { at: iso(fbm.message_at) } : {}), ...(fbm?.message_at && !fbm.routed ? { lost: 1 } : {}) });
      // the Page's comments: when a customer's last came (Pilot Comments answers them)
      const fbc = await lastComment(t, 'page', pageId);
      add('fb', 'fbComment', fbc?.routed ? 'ok' : 'warn', { name, ...(fbc ? { at: fbc.at } : {}), ...(fbc && !fbc.routed ? { lost: 1 } : {}) });
      // the safety net (dellal.catchUp, every 3 minutes): when it last read this Page's chats again, and what it caught
      const run = db ? (await db.query(`SELECT value FROM settings WHERE key = 'dellal_catchup'`).catch(() => []))[0]?.value : null;
      if (!run?.at) add('fb', 'catchUp', 'warn');
      else if (run.error) add('fb', 'catchUp', 'warn', { at: String(run.at), why: 'error' }, String(run.error).slice(0, 240));
      else add('fb', 'catchUp', 'ok', { at: String(run.at), count: num(run.found) });

      // ---------------------------------------------------------- its Instagram account
      if (extra.ig?.id) {
        const igId = String(extra.ig.id);
        let username = String(extra.ig.username ?? '');
        perm('ig', 'igMessages', 'bad');
        perm('ig', 'igComments', 'bad');
        try {
          const r = await graph(igId, { fields: 'id,username', access_token: ptoken });
          username = String(r.username ?? username);
          add('ig', 'ig', 'ok', { username });
        } catch (e) {
          add('ig', 'ig', 'bad', undefined, why(e));
        }
        // its inbox through the Page: when Meta will not give Instagram's messages, it says why here (no role on the
        // Instagram account, « Allow access to messages » off, the app's access…); a creator account's first read also
        // starts its messages' webhook
        try {
          await graph(`${pageId}/conversations`, { platform: 'instagram', fields: 'id', limit: '1', access_token: ptoken });
          add('ig', 'igInbox', 'ok', { username });
        } catch (e) {
          add('ig', 'igInbox', 'bad', { username }, why(e));
        }
        // when Meta last sent Pilotix a customer's message from this Instagram account (routeMeta writes it down); only
        // other things (« standby »: another app has the conversations; an echo, a read…); or nothing for it, but an
        // Instagram message for an account no boutique uses (Meta gave it another number)
        const seen = (await t.platform.query(`SELECT at, routed, what, message_at FROM platform.social_hooks WHERE object = 'instagram' AND ext_id = $1`, [igId]).catch(() => []))[0];
        if (seen?.message_at) add('ig', 'igSeen', seen.routed ? 'ok' : 'warn', { username, at: iso(seen.message_at), ...(seen.routed ? {} : { lost: 1 }) });
        else if (seen) add('ig', 'igSeen', 'warn', { username, at: iso(seen.at), why: seen.what === 'standby' ? 'standby' : 'other' });
        else {
          const stray = (await t.platform.query(`SELECT max(at) AS at FROM platform.social_hooks WHERE object = 'instagram' AND NOT routed AND at > now() - interval '1 day'`).catch(() => []))[0];
          add('ig', 'igSeen', 'warn', { username, ...(stray?.at ? { at: iso(stray.at), why: 'unknown' } : {}) });
        }
        // its comments: when a customer's last came
        const igc = await lastComment(t, 'instagram', igId);
        add('ig', 'igComment', igc?.routed ? 'ok' : 'warn', { username, ...(igc ? { at: igc.at } : {}), ...(igc && !igc.routed ? { lost: 1 } : {}) });

        // The key that answers Instagram. The account's own key when it reaches the Instagram inbox (every customer is
        // answered): taken at once when the boutique has none. A key connected before in Pilot Message keeps its place
        // while it works; when it no longer does, the account's key takes over (if it reaches the inbox).
        const own = db ? await getRaw<string>(db, DELLAL_SECRETS.igToken, '') : '';
        const fromLink = db ? !!(await getRaw<any>(db, SOCIAL_KEYS.page, null))?.igKey : false;
        const reach = keyOk ? await igReach(token, igId) : { ok: false, why: null };
        // not reached: the Instagram account was not ticked in Facebook's window (Meta says for which accounts), or Meta's reason
        const missed = givenFor('instagram_manage_messages', igId) === false ? 'tick' : 'none';
        if (own && !fromLink) {
          const dset = await dellalSettings(db!);
          let oldWhy: string | null = null;
          try {
            if (dset.igLoginKind === 'unified') {
              // a key of Meta's Unified login: its Instagram accounts (given to it, or through its Pages)
              const list = await uniAccounts(own);
              if (!(list.find((x) => String(x?.id) === String(dset.instagramLoginId ?? '')) ?? list[0])) throw new AppError('bad_request', 'Cette clé n’a plus accès au compte Instagram.');
            } else await igGraph('me', { fields: 'user_id,username', access_token: own });
          } catch (e) {
            oldWhy = why(e);
          }
          // it works: it stays. When the account's key reaches the inbox too, the boutique may remove the old one (Comptes
          // offers it then): said, and marked on the Page
          if (oldWhy === null) {
            if (reach.ok) await markIgKey(t, num(page.id));
            add('ig', 'igKey', 'ok', { username: String(dset.instagramLoginUser || username), why: reach.ok ? 'oldReady' : 'old' });
          } else if (reach.ok && (await adoptLinkIg(t, shopId, num(page.id)))) add('ig', 'igKey', 'ok', { username, fixed: 1 });
          else add('ig', 'igKey', 'bad', { username, why: 'oldBad' }, oldWhy);
        } else if (reach.ok) {
          // nothing answered every customer yet: the account's key does from now on
          if (!own && (await adoptLinkIg(t, shopId, num(page.id)))) add('ig', 'igKey', 'ok', { username, fixed: 1 });
          else add('ig', 'igKey', 'ok', { username });
        } else add('ig', 'igKey', fromLink ? 'bad' : 'warn', { username, why: missed }, reach.why);
      } else add('ig', 'igNone', 'warn', { name });

      // ---------------------------------------------------------- the ads' forms, publishing
      perm('forms', 'forms', 'warn');
      add('forms', 'leadHook', leadLine[0], leadLine[1]);
      try {
        await graph(`${pageId}/leadgen_forms`, { fields: 'id', limit: '1', access_token: ptoken });
        add('forms', 'forms', 'ok');
      } catch (e) {
        add('forms', 'forms', 'warn', undefined, why(e));
      }
      if (perm('content', 'content', 'warn')) add('content', 'content', 'ok');
    }
  } else if (pagesAll.length) add('fb', 'pageNone', 'warn');
  else if (keyOk) add('fb', 'pagesNone', 'warn');

  // ------------------------------------------------------------ Publicité: the ad accounts this boutique counts
  const shopMeta = db ? await getSetting(db, 'meta') : null;
  const adsKey = db ? await getRaw<string>(db, SOCIAL_KEYS.adsToken, '') : '';
  const adsRow = db ? await getRaw<any>(db, SOCIAL_KEYS.ads, null) : null;
  // whose key Publicité, the catalogue and the pixels run on here: this account's, a key pasted before, or another account's
  const adsMine = counts('ad_account');
  const adsOld = !!adsKey && !adsRow?.adAccountId;
  /**
   * This login brought no ad account and Facebook gave its key no right on ads at all (not even to read them): linking
   * again only helps when the ad account shows in Facebook's window. The line says to look there, and that an ad
   * account Facebook does not offer is to settle at Meta, not in Pilotix (info: Publicité runs on another key meanwhile).
   */
  const noAdsRight = (state: SocialCheck['state']) => {
    if (keyOk && !adsAll.length && granted && !granted.has('ads_read') && !granted.has('ads_management')) add('ads', 'adsRight', state, { why: 'none' });
  };
  if (adsMine) {
    perm('ads', 'adsRead', 'bad');
    perm('ads', 'adsManage', 'warn');
    const launchId = String(shopMeta?.adAccountId ?? '').replace(/^act_/, '') || String(adsAll[0]?.ext_id ?? '').replace(/^act_/, '');
    const unread: string[] = [];
    let unreadWhy: string | null = null;
    let launch: any = null;
    for (const a of adsAll) {
      const id = String(a.ext_id).replace(/^act_/, '');
      const aname = String(a.name ?? a.ext_id);
      if (!keyOk) {
        unread.push(aname);
        continue;
      }
      try {
        const r = await readAdAccount(id, token);
        if (id === launchId) launch = { ...r, name: String(r?.name ?? aname) };
        // not simply active at Meta: said in plain words (1: active; 201: active, any)
        const st = Number(r?.account_status);
        if (Number.isFinite(st) && st > 0 && st !== 1 && st !== 201) {
          const s = AD_STATES[st] ?? { why: 'sx', state: 'warn' as const };
          add('ads', 'adsState', s.state, { name: aname, why: s.why }, AD_STATES[st] ? null : `account_status ${st}`);
        }
        // its ads' problems (rejected, blocked) reach Co-Pilot only when the account is subscribed: asked again
        const x = jsonOf(a.extra);
        if (x.hook === false) {
          const again = await graph(`act_${id}/subscribed_apps`, { access_token: token }, 'POST').then(() => true).catch(() => false);
          if (again) await t.platform.query(`UPDATE platform.social_assets SET extra = $2 WHERE id = $1`, [num(a.id), JSON.stringify({ ...x, hook: true })]);
          add('ads', 'adsHook', again ? 'ok' : 'warn', { name: aname, ...(again ? { fixed: 1 } : {}) });
        }
      } catch (e) {
        unread.push(aname);
        unreadWhy ??= why(e);
      }
    }
    add('ads', 'ads', !unread.length ? 'ok' : unread.length === adsAll.length ? 'bad' : 'warn', { count: adsAll.length, bad: unread.length }, unread.length ? [unread.join(', '), unreadWhy].filter(Boolean).join(' — ').slice(0, 300) : null);
    if (launch) {
      // its numbers, as Publicité reads them
      try {
        await graph(`act_${launchId}/insights`, { fields: 'spend', date_preset: 'today', limit: '1', access_token: token });
        add('ads', 'adsRead', 'ok', { name: launch.name });
      } catch (e) {
        add('ads', 'adsRead', 'bad', { name: launch.name }, why(e));
      }
      // launching from Pilotix: the permission to manage ads, and a role that may advertise in this account
      const tasks: string[] | null = Array.isArray(launch.user_tasks) ? launch.user_tasks.map(String) : null;
      if (!has('ads_management')) add('ads', 'adsLaunch', 'warn', { name: launch.name, why: 'perm' });
      else if (tasks && !tasks.some((x) => x === 'ADVERTISE' || x === 'MANAGE')) add('ads', 'adsLaunch', 'warn', { name: launch.name, why: 'task' });
      else add('ads', 'adsLaunch', 'ok', { name: launch.name });
    }
    const money = [...new Set(adsAll.map((a: any) => jsonOf(a.extra).currency).filter(Boolean).map(String))];
    // Publicité counts a dinar account in dinars (and in dollars with the month's rate); any other money as dollars
    const other = money.filter((c) => c !== 'USD' && c !== 'DZD');
    if (other.length) add('ads', 'adsCurrency', 'warn', { list: other.join(', ') });
    else if (money.includes('DZD')) add('ads', 'adsCurrency', 'ok');
  } else if (adsOld) {
    // Publicité still runs on a key pasted before in Réglages › Meta Ads: tried too, and how to bring it here
    const id = String(shopMeta?.adAccountId ?? '').replace(/^act_/, '');
    const move = adsAll.length ? 'switch' : 'relink';
    try {
      const r = await readAdAccount(id, adsKey);
      add('ads', 'adsOld', 'info', { name: String(r?.name ?? id), why: move });
    } catch (e) {
      add('ads', 'adsOld', 'bad', { name: id, why: `${move}Bad` }, why(e));
    }
    noAdsRight('info');
  } else if (adsRow?.adAccountId) add('ads', 'adsOther', 'info', { account: String(adsRow.account ?? '') });
  else if (adsAll.length) add('ads', 'adsOff', 'warn', { count: adsAll.length });
  else if (keyOk) {
    add('ads', 'adsNone', 'warn');
    noAdsRight('warn');
  }

  // ------------------------------------------------------------ the catalogue and the pixels (with the boutique's ads key)
  if (db && adsKey && (adsMine || adsOld)) {
    const cat = await getRaw<any>(db, 'metacatalog', null);
    if (adsMine) perm('catalog', 'catalog', cat?.catalogId ? 'bad' : 'warn');
    if (cat?.catalogId) {
      const id = String(cat.catalogId);
      try {
        const r = await graph(id, { fields: 'id,name,product_count', access_token: adsKey });
        add('catalog', 'catalog', 'ok', { name: String(r?.name ?? id), count: num(r?.product_count) });
      } catch (e) {
        // refused: the catalogue was not ticked in Facebook's window (Meta says for which catalogues), or Meta's reason
        add('catalog', 'catalog', 'bad', { why: adsMine && givenFor('catalog_management', id) === false ? 'tick' : 'bad' }, why(e));
      }
    } else add('catalog', 'catalogNone', 'info');
    // the pixels of Landing pages › Réglages: one with a key of its own sends with it (not tried here); the others send
    // with the ads key, which must reach them
    const ownCapi = !!(await getRaw<string>(db, 'secret_landing_capi_token', ''));
    const pixels = await db
      .query(`SELECT p.name, p.pixel_id, EXISTS (SELECT 1 FROM settings s WHERE s.key = 'secret_pixel_' || p.id) AS own FROM tracking_pixels p WHERE p.platform = 'meta' ORDER BY p.is_default DESC, p.id LIMIT 5`)
      .catch(() => []);
    for (const p of pixels) {
      const pname = String(p.name || p.pixel_id);
      if (p.own || ownCapi) add('pixels', 'pixel', 'info', { name: pname, why: 'own' });
      else
        await graph(String(p.pixel_id), { fields: 'id,name', access_token: adsKey })
          .then(() => add('pixels', 'pixel', 'ok', { name: pname }))
          .catch((e) => add('pixels', 'pixel', 'bad', { name: pname }, why(e)));
    }
    if (!pixels.length) add('pixels', 'pixelNone', 'info');
  }

  // ------------------------------------------------------------ the boutique's WhatsApp number (« Connecter WhatsApp »)
  if (db) {
    const dset = await dellalSettings(db);
    const waKey = await getRaw<string>(db, DELLAL_SECRETS.waToken, '');
    if (waKey && dset.whatsappPhoneId) {
      const phone = dset.whatsappPhone || dset.whatsappPhoneId;
      try {
        const r = await graph(String(dset.whatsappPhoneId), { fields: 'id,display_phone_number,verified_name', access_token: waKey });
        add('wa', 'wa', 'ok', { phone: String(r?.display_phone_number || phone) });
      } catch (e) {
        add('wa', 'wa', 'bad', { phone }, why(e));
      }
      // when Meta last sent Pilotix something for this number (a number typed by hand before uses its own Meta app: not seen here)
      const seen = (await t.platform.query(`SELECT at, routed FROM platform.social_hooks WHERE object = 'whatsapp_business_account' AND ext_id = $1`, [String(dset.whatsappPhoneId)]).catch(() => []))[0];
      if (seen) add('wa', 'waSeen', seen.routed ? 'ok' : 'warn', { phone, at: iso(seen.at), ...(seen.routed ? {} : { lost: 1 }) });
      else if (dset.whatsappPhone) add('wa', 'waSeen', 'warn', { phone });
    }
  }

  // ------------------------------------------------------------ Pilotix's Meta app: where Meta sends everything
  const webhook = socialUrls(publicUrl).metaWebhook;
  if (apps.meta.appId && secret) {
    try {
      const subs = await graphAll(`${apps.meta.appId}/subscriptions`, { access_token: `${apps.meta.appId}|${secret}` });
      const one = (object: string, want: string[], key: string) => {
        const s = subs.find((x) => x?.object === object);
        const have = new Set<string>((s?.fields ?? []).map((f: any) => String(f?.name ?? f)));
        const missing = want.filter((w) => !have.has(w));
        if (!s || missing.length) return add('app', key, 'warn', { list: (s ? missing : want).join(', ') });
        if (s.active === false) return add('app', key, 'warn', { list: want.join(', ') }, 'Abonnement en pause dans l’app Meta.');
        if (publicUrl && String(s.callback_url ?? '') !== webhook) return add('app', key, 'warn', { list: want.join(', ') }, `Adresse dans l’app Meta : ${String(s.callback_url ?? '—').slice(0, 160)}`);
        add('app', key, 'ok');
      };
      one('page', ['messages', 'feed'], 'appHook');
      one('page', ['leadgen'], 'appHookLeads');
      // edited messages and reactions (Dellal reads the new text, the team sees the ❤️)
      one('page', ['message_edits', 'message_reactions'], 'appHookEdits');
      one('instagram', ['messages', 'comments'], 'appHookIg');
      // the ad accounts' ads rejected or with a problem (Co-Pilot)
      one('ad_account', ['with_issues_ad_objects', 'in_process_ad_objects'], 'appHookAds');
    } catch (e) {
      add('app', 'appHook', 'warn', { list: 'messages, feed' }, why(e));
    }
  }
  // partnership ads (Partenaires › Influenceurs): Pilotix's Facebook login does not ask for their permission yet, so
  // linking again cannot give it: said to the Pilotix team, never as the boutique's problem
  if (keyOk && page) perm('app', 'partners', 'info');
  // a webhook Pilotix refused these 2 days: its signature matched no secret (Instagram's old login signs with its own)
  const badSig = await lastBadSignature(t).catch(() => null);
  if (badSig && Date.now() - Date.parse(badSig.at) < 2 * 24 * 3_600_000) add('app', 'badSig', 'warn', { at: badSig.at, count: badSig.n });
  // the webhook's address, called from the Internet as Meta does (through Cloudflare)
  if (publicUrl && apps.verifyToken) {
    const challenge = String(Date.now());
    try {
      const res = await fetch(`${webhook}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(apps.verifyToken)}&hub.challenge=${challenge}`, { signal: AbortSignal.timeout(10_000) });
      const body = await res.text().catch(() => '');
      if (res.ok && body.trim() === challenge) add('app', 'reach', 'ok');
      else if (res.headers.get('cf-mitigated') || /Just a moment/i.test(body)) add('app', 'reach', 'bad', { why: 'cloudflare' });
      else add('app', 'reach', 'bad', { status: res.status });
    } catch (e) {
      add('app', 'reach', 'bad', { status: 0 }, why(e));
    }
  }
  return { at: new Date().toISOString(), checks };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** The page the login tab shows at its end (it closes itself when the browser lets it). */
const KIND_WORD: Record<string, string> = { page: 'Page', ad_account: 'Compte pub', advertiser: 'Compte pub TikTok', whatsapp: 'Numéro' };

export function loginPage(r: LoginEnd): string {
  if (r.confirm) return confirmPage(r.confirm);
  const title = r.ok ? 'Compte lié' : 'Connexion non faite';
  const line = r.ok ? `${r.account ? `« ${esc(r.account)} » est lié à Pilotix. ` : ''}Vous pouvez fermer cet onglet : Pilotix est déjà à jour.` : esc(r.message);
  // done, but something to read: the tab stays open
  const warn = r.ok && r.warn ? `<p class="warn">${esc(r.warn)}</p>` : '';
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Pilotix</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f5f8;color:#16202e}
main{max-width:420px;margin:24px;padding:28px;border-radius:16px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.08)}h1{margin:0 0 8px;font-size:22px}
.dot{display:inline-grid;place-items:center;width:44px;height:44px;border-radius:50%;margin-bottom:14px;color:#fff;font-size:24px;background:${r.ok ? '#1f9d55' : '#c2410c'}}p{margin:0;color:#4b5563}
.warn{margin-top:12px;padding:10px 12px;border-radius:10px;background:#fff7ed;color:#9a3412}</style></head>
<body><main><div class="dot">${r.ok ? '✓' : '!'}</div><h1>${title}</h1><p>${line}</p>${warn}</main>${r.ok && !warn ? '<script>setTimeout(function(){window.close()},1500)</script>' : ''}</body></html>`;
}

/** The tab's question: which account, which boutique, asked by whom; « Oui, c'est ma boutique » or « Non ». */
function confirmPage(c: NonNullable<LoginEnd['confirm']>): string {
  const net = c.net ?? (c.provider === 'meta' ? 'Facebook' : 'TikTok');
  // a name in « » never leaves its marks alone at the end of a line
  const q = (x: string) => `«&nbsp;<b>${esc(x)}</b>&nbsp;»`;
  const where = c.shop ? `la boutique ${q(c.shop)}` : 'toutes les boutiques de la personne qui l’a demandé';
  const list = c.assets.length ? `<ul>${c.assets.map((a) => `<li>${esc(KIND_WORD[a.kind] ?? a.kind)} : <b>${esc(a.name)}</b></li>`).join('')}</ul>` : '';
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lier ce compte ? · Pilotix</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f5f8;color:#16202e}
main{max-width:460px;margin:24px;padding:28px;border-radius:16px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.08)}h1{margin:0 0 10px;font-size:22px}p{margin:0 0 12px;color:#374151}
ul{margin:0 0 14px;padding-left:20px;color:#374151}.who{padding:12px 14px;border-radius:12px;background:#f8fafc;border:1px solid #e5e7eb;margin-bottom:16px}
.q{font-weight:600;color:#16202e}form{display:grid;gap:10px;margin-top:18px}button{font:inherit;font-weight:600;padding:12px 16px;border-radius:10px;border:1px solid #d1d5db;background:#fff;color:#16202e;cursor:pointer}
button.yes{background:#1f6feb;border-color:#1f6feb;color:#fff}small{display:block;margin-top:14px;color:#6b7280}</style></head>
<body><main><h1>Lier ce compte à Pilotix ?</h1>
<div class="who"><p>Le compte ${net} ${q(c.account)}</p>${list}<p>va être lié à ${where}${c.by ? `, à la demande de ${q(c.by)}` : ''}.</p></div>
<p class="q">Est-ce bien votre boutique ?</p>
<form method="post" action="/api/oauth/confirm"><input type="hidden" name="state" value="${esc(c.state)}"><input type="hidden" name="key" value="${esc(c.key)}">
<button class="yes" type="submit" name="choice" value="yes">Oui, c’est ma boutique</button><button type="submit" name="choice" value="no">Non, ce n’est pas moi</button></form>
<small>Si vous n’avez rien demandé à Pilotix, choisissez «&nbsp;Non&nbsp;» : rien ne sera lié.</small></main></body></html>`;
}

// ---------------------------------------------------------------- Meta's data deletion requests
/** A signed_request from Meta (« signature.payload », both base64url, HMAC-SHA256 with the app secret): its payload, or null. */
export function parseSignedRequest(signed: string, secret: string): Record<string, any> | null {
  const s = String(signed ?? '');
  const dot = s.indexOf('.');
  if (dot < 1 || !secret) return null;
  const sig = Buffer.from(s.slice(0, dot), 'base64url');
  const payload = s.slice(dot + 1);
  const want = createHmac('sha256', secret).update(payload).digest();
  if (sig.length !== want.length || !timingSafeEqual(sig, want)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data && typeof data === 'object' && String(data.algorithm ?? '').toUpperCase() === 'HMAC-SHA256' ? data : null;
  } catch {
    return null;
  }
}

/**
 * Meta's « data deletion request » (Facebook Login for Business › Settings › Data Deletion Request URL): a person removed
 * Pilotix from Facebook and asked for their data to go. Every Meta account they linked goes, like « Retirer » (its tokens,
 * Pages and ad accounts: the boutiques stop using them); Meta gets a code and the page that tells the request's state.
 */
export async function metaDeletion(t: Tenancy, signedRequest: string, publicUrl: string): Promise<{ url: string; confirmation_code: string; removed: number }> {
  const secret = await socialSecret(t, 'meta');
  if (!secret) throw new AppError('bad_request', 'App Meta de Pilotix manquante');
  const data = parseSignedRequest(signedRequest, secret);
  const userId = data?.user_id ? String(data.user_id) : '';
  if (!userId) throw new AppError('unauthorized', 'Signature Meta invalide');
  const links = await t.platform.query(`SELECT id FROM platform.social_links WHERE provider = 'meta' AND ext_id = $1`, [userId]);
  for (const l of links) await removeLink(t, num(l.id));
  const code = randomBytes(10).toString('hex').toUpperCase();
  await t.platform.query(`INSERT INTO platform.social_deletions (code, provider, removed) VALUES ($1, 'meta', $2)`, [code, links.length]);
  return { url: `${socialUrls(publicUrl).metaDeletion}/${code}`, confirmation_code: code, removed: links.length };
}

/** The page Meta gives the person for their request: its code, its state and its day, in English, French and Arabic. */
export async function deletionPage(t: Tenancy, code: string): Promise<{ found: boolean; html: string }> {
  const r = await deletionStatus(t, String(code ?? '').trim().toUpperCase());
  const c = r ? `<bdi>${esc(r.code)}</bdi>` : '';
  const day = r ? `<bdi>${r.at.slice(0, 10)}</bdi>` : '';
  const n = r?.removed ?? 0;
  const lines: [string, string, string, string][] = !r
    ? [
        ['en', 'ltr', 'Unknown request code.', 'Check the link Facebook gave you.'],
        ['fr', 'ltr', 'Code de demande inconnu.', 'Vérifiez le lien donné par Facebook.'],
        ['ar', 'rtl', 'رمز طلب غير معروف.', 'تحقّق من الرابط الذي أعطاك إياه فيسبوك.'],
      ]
    : [
        ['en', 'ltr', `Request ${c}: done on ${day}.`, n ? `Pilotix deleted the Facebook accounts you had linked (${n}), with their keys, Pages and ad accounts.` : 'Pilotix kept no Facebook data about you: there was nothing to delete.'],
        ['fr', 'ltr', `Demande ${c} : faite le ${day}.`, n ? `Pilotix a supprimé les comptes Facebook que vous aviez liés (${n}), avec leurs clés, leurs pages et leurs comptes pub.` : 'Pilotix ne gardait aucune donnée Facebook sur vous : il n’y avait rien à supprimer.'],
        ['ar', 'rtl', `الطلب ${c}: تمّ في ${day}.`, n ? `حذف Pilotix حسابات فيسبوك التي ربطتها (${n})، مع مفاتيحها وصفحاتها وحسابات إعلاناتها.` : 'لم يحتفظ Pilotix بأي بيانات فيسبوك عنك: لم يكن هناك ما يُحذف.'],
      ];
  const body = lines.map(([lang, dir, h, p]) => `<section lang="${lang}" dir="${dir}"><h2>${h}</h2><p>${p}</p></section>`).join('');
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Data deletion · Pilotix</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f5f8;color:#16202e}
main{max-width:480px;margin:24px;padding:28px;border-radius:16px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.08)}h1{margin:0 0 4px;font-size:22px}
h2{margin:18px 0 4px;font-size:17px}p{margin:0;color:#4b5563}bdi{white-space:nowrap}section+section{border-top:1px solid #eceef2;margin-top:18px}
.dot{display:inline-grid;place-items:center;width:44px;height:44px;border-radius:50%;margin-bottom:14px;color:#fff;font-size:24px;background:${r ? '#1f9d55' : '#6b7280'}}</style></head>
<body><main><div class="dot">${r ? '✓' : '?'}</div><h1>Pilotix</h1>${body}</main></body></html>`;
  return { found: !!r, html };
}
