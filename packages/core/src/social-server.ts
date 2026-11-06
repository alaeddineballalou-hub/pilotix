// Linked accounts — SERVER ONLY (loaded by the server as '@pilotix/core/dist/social-server'). The login tab comes back
// here: its code becomes a token (Facebook: a person's token turned into one of about 60 days, whose Pages' tokens do not
// expire, or a configuration's « system user » token that does not expire; TikTok: an advertiser's token), then what the account may use
// is read (Facebook Pages with their Instagram account and their own tokens, Meta ad accounts, TikTok ad accounts) and
// each Page is subscribed to Pilotix's webhook (its messages and comments come to Pilotix). Tokens never leave the server.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { num } from './db';
import { AppError, Ctx } from './rpc';
import type { Tenancy } from './platform/tenancy';
import { getRaw, setRaw } from './modules/admin';
import { DELLAL_SECRETS, dellalSettings, keepIgLogin, WA_PIN_KEY } from './modules/dellal';
import { igLogin, igPeek, uniAccounts } from './dellal-server';
import {
  deletionStatus,
  endState,
  FoundAccount,
  loginKindOf,
  noteIgLogin,
  noteWaLogin,
  FoundAsset,
  holdFound,
  lastBadSignature,
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
/** Instagram's own login (graph.instagram.com, its own keys): the same, in Instagram's words. */
async function igGraph(path: string, params: Record<string, string>): Promise<any> {
  const { res, data } = await fetchJson(`https://graph.instagram.com/v23.0/${path}?${new URLSearchParams(params).toString()}`, {}, 'Instagram');
  if (!res.ok || data?.error) {
    const e = data?.error;
    if (e?.code === 190) throw new AppError('bad_request', 'Instagram a refusé la clé (expirée ou retirée). Créez-en une nouvelle dans l’app Meta, puis collez-la dans Pilot Message › Réglages.');
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

/** A Facebook login: the account, its Pages (each subscribed to Pilotix's webhook) and its ad accounts. */
async function metaAccount(t: Tenancy, code: string, publicUrl: string): Promise<FoundAccount> {
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
  const withConfig = !!apps.meta.configId;
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
  // without the ads permission there are no ad accounts: the Pages still work
  const ads = await graphAll('me/adaccounts', { fields: 'id,account_id,name,currency,account_status', limit: '100', access_token: token }).catch(() => []);
  const assets: FoundAsset[] = [];
  for (const p of pages) {
    if (!p?.id || !p?.access_token) continue;
    // its messages and comments come to Pilotix's webhook
    let hook = true;
    await subscribePage(String(p.id), String(p.access_token)).catch(() => (hook = false));
    const ig = p.instagram_business_account?.id ? { id: String(p.instagram_business_account.id), username: String(p.instagram_business_account.username ?? '') } : undefined;
    assets.push({ kind: 'page', extId: String(p.id), name: String(p.name ?? p.id), extra: { picture: p.picture?.data?.url ?? null, ...(ig ? { ig } : {}), hook }, token: String(p.access_token) });
  }
  for (const a of ads) {
    const idOf = String(a?.account_id ?? String(a?.id ?? '').replace(/^act_/, ''));
    if (!/^\d+$/.test(idOf)) continue;
    // its ads' problems (rejected, payment…) come to Pilotix's webhook, so Co-Pilot warns (needs the account's admin)
    let hook = true;
    await graph(`act_${idOf}/subscribed_apps`, { access_token: token }, 'POST').catch(() => (hook = false));
    assets.push({ kind: 'ad_account', extId: idOf, name: String(a.name ?? idOf), extra: { currency: a.currency ?? null, status: a.account_status ?? null, hook } });
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

/**
 * « Connecter Instagram » (Pilot Message › Réglages): Facebook's login with the Instagram-only configuration. Its key and
 * the Instagram account it reaches wait for « Oui, c'est ma boutique »; nothing goes to the accounts list.
 */
async function instagramAccount(
  t: Tenancy,
  code: string,
  publicUrl: string,
): Promise<FoundAccount> {
  const apps = await socialApps(t);
  const secret = await socialSecret(t, "meta");
  if (!apps.meta.appId || !secret)
    throw new AppError("bad_request", "L’app Meta de Pilotix n’est pas prête.");
  const tok = await graph("oauth/access_token", {
    client_id: apps.meta.appId,
    client_secret: secret,
    redirect_uri: socialUrls(publicUrl).metaRedirect,
    code,
  });
  let token = String(tok.access_token ?? "");
  let expiresIn = Number(tok.expires_in) || 0;
  if (!token)
    throw new AppError(
      "bad_request",
      "Meta n’a pas donné de clé. Recommencez.",
    );
  // a person's key becomes one of about 60 days; a system user's key (that does not end) is kept as it is
  const ll = await graph("oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: apps.meta.appId,
    client_secret: secret,
    fb_exchange_token: token,
  }).catch(() => null);
  if (ll?.access_token) {
    token = String(ll.access_token);
    expiresIn = Number(ll.expires_in) || 60 * 86_400;
  }
  const ig = await igPeek(token);
  if (!ig)
    throw new AppError(
      "bad_request",
      "Aucun compte Instagram professionnel trouvé avec cette connexion. Choisissez votre compte Instagram dans la fenêtre de Meta, puis recommencez.",
    );
  return {
    provider: "meta",
    extId: ig.id,
    name: ig.username ? `@${ig.username}` : "Instagram",
    token,
    tokenKind: "user",
    expiresAt: expiresIn
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : null,
    assets: [],
    instagram: ig,
  };
}

/** « Oui, c'est ma boutique » for « Connecter Instagram »: the key goes to the boutique's Pilot Message, its DMs to Pilotix. */
async function linkInstagram(
  t: Tenancy,
  shopId: number | null,
  f: FoundAccount,
): Promise<{ ok: boolean; message: string; account?: string }> {
  if (!shopId || !f.instagram)
    return {
      ok: false,
      message:
        "Boutique introuvable. Recommencez depuis Pilot Message › Réglages.",
    };
  const r = (
    await t.platform.query(
      `SELECT schema_name FROM platform.shops WHERE id = $1 AND status NOT IN ('archived', 'deleted')`,
      [shopId],
    )
  )[0];
  if (!r) return { ok: false, message: "Boutique introuvable." };
  const db = t.shop(String(r.schema_name));
  // the account is read again with the key and subscribed to Pilotix's webhook (its DMs come to Pilotix)
  const got = await igLogin(f.token, f.instagram.id);
  await setRaw(db, DELLAL_SECRETS.igToken, f.token);
  await keepIgLogin(db, got, new Date().toISOString());
  await noteIgLogin(t, shopId, String(got.userId), String(got.username ?? ""));
  const name = got.username ? `@${got.username}` : f.name;
  return {
    ok: true,
    message: got.subscribeError
      ? `Instagram connecté, mais Meta a refusé l’abonnement aux messages : ${got.subscribeError}`
      : "Instagram connecté",
    account: name,
  };
}

/**
 * « Connecter WhatsApp » (Pilot Message › Réglages): Meta's Embedded Signup with the WhatsApp configuration. In Meta's
 * window the shop picks (or makes) its WhatsApp Business account and its number; Pilotix reads which account the key was
 * given (debug_token's granular scopes), then its number. Its key and number wait for « Oui, c'est ma boutique ».
 */
async function whatsappAccount(t: Tenancy, code: string, publicUrl: string): Promise<FoundAccount> {
  const apps = await socialApps(t);
  const secret = await socialSecret(t, 'meta');
  if (!apps.meta.appId || !secret) throw new AppError('bad_request', 'L’app Meta de Pilotix n’est pas prête.');
  const tok = await graph('oauth/access_token', { client_id: apps.meta.appId, client_secret: secret, redirect_uri: socialUrls(publicUrl).metaRedirect, code });
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
  for (const id of wabas) {
    const waba = await graph(id, { fields: 'id,name', access_token: token }).catch(() => null);
    const nums = await graph(`${id}/phone_numbers`, { fields: 'id,display_phone_number,verified_name', access_token: token }).catch(() => null);
    const n = (Array.isArray(nums?.data) ? nums.data : []).find((x: any) => /^\d{1,30}$/.test(String(x?.id ?? '')));
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
  if (!shopId || !f.whatsapp) return { ok: false, message: 'Boutique introuvable. Recommencez depuis Pilot Message › Réglages.' };
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
    const found =
      provider === 'meta'
        ? kind === 'instagram'
          ? await instagramAccount(t, code, publicUrl)
          : kind === 'whatsapp'
            ? await whatsappAccount(t, code, publicUrl)
            : await metaAccount(t, code, publicUrl)
        : await tiktokAccount(t, code);
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
  // « Connecter Instagram »: to Pilot Message, not to the accounts list
  if (st.found.instagram) {
    const r = await linkInstagram(t, st.shopId, st.found).catch((e: any) => ({
      ok: false,
      message: String(e?.message ?? 'Erreur').slice(0, 300),
      account: undefined,
    }));
    await endState(t, st.state, r.ok ? { linkId: null } : { error: r.message });
    return r;
  }
  // « Connecter WhatsApp »: to Pilot Message too
  if (st.found.whatsapp) {
    const r = await linkWhatsapp(t, st.shopId, st.found).catch((e: any) => ({ ok: false, message: String(e?.message ?? 'Erreur').slice(0, 300), account: undefined }));
    await endState(t, st.state, r.ok ? { linkId: null } : { error: r.message });
    return r;
  }
  const linkId = await saveLink(t, st, st.found);
  await endState(t, st.state, { linkId });
  return { ok: true, message: 'Compte lié', account: st.found.name };
}

// ---------------------------------------------------------------- « Tester » (Pilot AI › Comptes)
/** The server's hook: 'test' (one linked account, for one boutique); 'ttCatalog…' (Marketing › Catalogue on TikTok). */
export async function runSocial(action: string, args: any, ctx: Ctx): Promise<unknown> {
  if (action === 'test') return testLink(ctx.t!, num(args?.shopId), num(args?.linkId), ctx.server?.publicUrl ?? '');
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

/** What the agents need, by what they do (a missing one is named on the test's line). */
const NEEDED = [
  'pages_show_list',
  'pages_messaging',
  'pages_manage_metadata',
  'pages_read_engagement',
  'pages_manage_engagement',
  'pages_read_user_content',
  'instagram_basic',
  'instagram_manage_messages',
  'instagram_manage_comments',
  'ads_read',
];
const jsonOf = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v ?? {});
const why = (e: unknown) => String((e as any)?.message ?? e).slice(0, 240);

/**
 * Tries a linked account now, for this boutique, one line per thing (none stops the others): the account's key, its
 * permissions, the Page this boutique uses (its key; subscribed to Pilotix's webhook again when its messages would not
 * come), its Instagram account (its inbox, and when Meta last sent its messages), Pilotix's Meta app webhook (Facebook
 * and Instagram: its address and fields), that the
 * webhook's address answers from the Internet (Cloudflare can block it), the ad accounts this boutique counts. A key
 * Facebook refuses turns the account red; a key that works again turns it green.
 */
/** When Meta last sent Pilotix a customer's comment for a Page / an Instagram account (routeMeta writes it down). */
async function lastComment(t: Tenancy, object: 'page' | 'instagram', extId: string): Promise<{ at: string; routed: boolean } | null> {
  const r = (await t.platform.query(`SELECT comment_at, routed FROM platform.social_hooks WHERE object = $1 AND ext_id = $2 AND comment_at IS NOT NULL`, [object, extId]).catch(() => []))[0];
  return r ? { at: new Date(r.comment_at).toISOString(), routed: !!r.routed } : null;
}

export async function testLink(t: Tenancy, shopId: number, linkId: number, publicUrl: string): Promise<SocialTest> {
  const l = (await t.platform.query(`SELECT * FROM platform.social_links WHERE id = $1`, [linkId]))[0];
  if (!l) throw new AppError('not_found', 'Compte introuvable');
  const checks: SocialCheck[] = [];
  const add = (key: string, state: SocialCheck['state'], params?: SocialCheck['params'], detail?: string | null) => checks.push({ key, state, ...(params ? { params } : {}), detail: detail ?? null });
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
      add('token', 'ok', { name: String(l.name ?? 'TikTok'), count: n });
      if (l.status === 'error') await setStatus(true);
    } catch (e) {
      add('token', 'bad', undefined, why(e));
      if (keyRefused(e)) await setStatus(false, why(e));
    }
    if (counts('advertiser')) add('ads', 'ok', { count: assets.filter((a: any) => a.kind === 'advertiser').length, bad: 0 });
    return { at: new Date().toISOString(), checks };
  }

  // the account's key, and what it was allowed
  let keyOk = false;
  try {
    const me = await graph('me', { fields: 'id,name', access_token: token });
    keyOk = true;
    add('token', 'ok', { name: String(me.name ?? l.name ?? '') });
    if (l.status === 'error') await setStatus(true);
  } catch (e) {
    add('token', 'bad', undefined, why(e));
    if (keyRefused(e)) await setStatus(false, why(e));
  }
  if (keyOk) {
    try {
      const granted = new Set((await graphAll('me/permissions', { access_token: token })).filter((p) => p?.status === 'granted').map((p) => String(p.permission)));
      const missing = NEEDED.filter((p) => !granted.has(p));
      add('perms', missing.length ? 'warn' : 'ok', missing.length ? { list: missing.join(', ') } : undefined);
    } catch (e) {
      add('perms', 'warn', undefined, why(e));
    }
  }

  // the Page this boutique answers on (from this account): its key, its webhook subscription, its Instagram account
  const apps = await socialApps(t);
  const pageUse = uses.find((u: any) => u.kind === 'page');
  const page = pageUse ? assets.find((a: any) => num(a.id) === num(pageUse.asset_id)) : null;
  if (page) {
    const ptoken = String(page.token ?? '');
    const name = String(page.name ?? '');
    let pageOk = false;
    try {
      await graph(String(page.ext_id), { fields: 'id,name', access_token: ptoken });
      pageOk = true;
      add('page', 'ok', { name });
    } catch (e) {
      add('page', 'bad', { name }, why(e));
    }
    if (pageOk) {
      const extra = jsonOf(page.extra);
      let hook = false;
      try {
        const subs = await graphAll(`${page.ext_id}/subscribed_apps`, { access_token: ptoken });
        const mine = subs.find((s) => String(s?.id) === apps.meta.appId);
        const have = new Set<string>((mine?.subscribed_fields ?? []).map(String));
        // the ads' lead forms (Marketing › Formulaires): asked again when missing, if the account gave their permission
        let leads = have.has(SOCIAL.leadFields);
        if (mine && SOCIAL.pageFields.split(',').every((f) => have.has(f)) && leads) add('pageHook', 'ok');
        else {
          const r = await subscribePage(String(page.ext_id), ptoken);
          if (mine && SOCIAL.pageFields.split(',').every((f) => have.has(f))) add('pageHook', 'ok');
          else add('pageHook', 'ok', { fixed: 1 });
          if (r.leads && !leads) add('leadHook', 'ok', { fixed: 1 });
          leads = r.leads;
        }
        if (leads && !checks.some((c) => c.key === 'leadHook')) add('leadHook', 'ok');
        else if (!leads) add('leadHook', 'warn');
        hook = true;
      } catch (e) {
        add('pageHook', 'bad', undefined, why(e));
      }
      if (extra.hook !== hook) await t.platform.query(`UPDATE platform.social_assets SET extra = $2 WHERE id = $1`, [num(page.id), JSON.stringify({ ...extra, hook })]);
      // the Page's comments: when a customer's last came (Pilot Comments answers them)
      const fbc = await lastComment(t, 'page', String(page.ext_id));
      add('fbComment', fbc?.routed ? 'ok' : 'warn', { name, ...(fbc ? { at: fbc.at } : {}), ...(fbc && !fbc.routed ? { lost: 1 } : {}) });
      if (extra.ig?.id) {
        let username = String(extra.ig.username ?? '');
        try {
          const r = await graph(String(extra.ig.id), { fields: 'id,username', access_token: ptoken });
          username = String(r.username ?? username);
          add('ig', 'ok', { username });
        } catch (e) {
          add('ig', 'bad', undefined, why(e));
        }
        // its inbox through the Page: when Meta will not give Instagram's messages, it says why here (no role on the
        // Instagram account, « Allow access to messages » off, the app's access…); a creator account's first read also
        // starts its messages' webhook
        try {
          await graph(`${page.ext_id}/conversations`, { platform: 'instagram', fields: 'id', limit: '1', access_token: ptoken });
          add('igInbox', 'ok', { username });
        } catch (e) {
          add('igInbox', 'bad', { username }, why(e));
        }
        // when Meta last sent Pilotix a customer's message from this Instagram account (routeMeta writes it down); only
        // other things (« standby »: another app has the conversations; an echo, a read…); or nothing for it, but an
        // Instagram message for an account no boutique uses (Meta gave it another number)
        const iso = (v: unknown) => new Date(v as string).toISOString();
        const seen = (await t.platform.query(`SELECT at, routed, what, message_at FROM platform.social_hooks WHERE object = 'instagram' AND ext_id = $1`, [String(extra.ig.id)]).catch(() => []))[0];
        if (seen?.message_at) add('igSeen', seen.routed ? 'ok' : 'warn', { username, at: iso(seen.message_at), ...(seen.routed ? {} : { lost: 1 }) });
        else if (seen) add('igSeen', 'warn', { username, at: iso(seen.at), why: seen.what === 'standby' ? 'standby' : 'other' });
        else {
          const stray = (await t.platform.query(`SELECT max(at) AS at FROM platform.social_hooks WHERE object = 'instagram' AND NOT routed AND at > now() - interval '1 day'`).catch(() => []))[0];
          add('igSeen', 'warn', { username, ...(stray?.at ? { at: iso(stray.at), why: 'unknown' } : {}) });
        }
        // its comments: when a customer's last came
        const igc = await lastComment(t, 'instagram', String(extra.ig.id));
        add('igComment', igc?.routed ? 'ok' : 'warn', { username, ...(igc ? { at: igc.at } : {}), ...(igc && !igc.routed ? { lost: 1 } : {}) });
      } else add('igNone', 'warn', { name });
      // the safety net (dellal.catchUp, every 3 minutes): when it last read this Page's chats again, and what it caught
      const schema = (await t.platform.query(`SELECT schema_name FROM platform.shops WHERE id = $1`, [shopId]).catch(() => []))[0]?.schema_name;
      const run = schema ? (await t.shop(String(schema)).query(`SELECT value FROM settings WHERE key = 'dellal_catchup'`).catch(() => []))[0]?.value : null;
      if (!run?.at) add('catchUp', 'warn');
      else if (run.error) add('catchUp', 'warn', { at: String(run.at), why: 'error' }, String(run.error).slice(0, 240));
      else add('catchUp', 'ok', { at: String(run.at), count: num(run.found) });
      // Instagram's own login (Pilot Message › Réglages): with it, Dellal answers every customer of this account
      const igKey = schema ? (await t.shop(String(schema)).query(`SELECT value FROM settings WHERE key = 'secret_dellal_ig_token'`).catch(() => []))[0]?.value : null;
      const dset = schema ? (await t.shop(String(schema)).query(`SELECT value FROM settings WHERE key = 'dellal'`).catch(() => []))[0]?.value : null;
      if (igKey) {
        try {
          if (dset?.igLoginKind === 'unified') {
            // Meta's Unified login (newer apps): the key's Instagram accounts (a system user's /me is not the account)
            // (a system user's key lists them as assigned accounts; « Connecter Instagram »'s key, through its Pages)
            const list = await uniAccounts(String(igKey));
            const acc = list.find((x) => String(x?.id) === String(dset?.instagramLoginId ?? '')) ?? list[0];
            if (!acc) throw new AppError('bad_request', 'Cette clé n’a plus accès au compte Instagram. Dans l’app Meta, donnez-lui le compte à nouveau.');
            add('igLogin', 'ok', { username: String(acc.username ?? dset?.instagramLoginUser ?? '') });
          } else {
            const me = await igGraph('me', { fields: 'user_id,username', access_token: String(igKey) });
            add('igLogin', 'ok', { username: String(me?.username ?? '') });
          }
        } catch (e) {
          add('igLogin', 'bad', undefined, why(e));
        }
      } else if (extra.ig?.id) add('igLogin', 'warn', { username: String(extra.ig.username ?? '') });
    }
  } else if (assets.some((a: any) => a.kind === 'page')) add('pageNone', 'warn');

  // Pilotix's Meta app: where Meta sends the Pages' and Instagram's messages and comments
  const secret = await socialSecret(t, 'meta');
  const webhook = socialUrls(publicUrl).metaWebhook;
  if (apps.meta.appId && secret) {
    try {
      const subs = await graphAll(`${apps.meta.appId}/subscriptions`, { access_token: `${apps.meta.appId}|${secret}` });
      const one = (object: string, want: string[], key: string) => {
        const s = subs.find((x) => x?.object === object);
        const have = new Set<string>((s?.fields ?? []).map((f: any) => String(f?.name ?? f)));
        const missing = want.filter((w) => !have.has(w));
        if (!s || missing.length) return add(key, 'warn', { list: (s ? missing : want).join(', ') });
        if (s.active === false) return add(key, 'warn', { list: want.join(', ') }, 'Abonnement en pause dans l’app Meta.');
        if (publicUrl && String(s.callback_url ?? '') !== webhook) return add(key, 'warn', { list: want.join(', ') }, `Adresse dans l’app Meta : ${String(s.callback_url ?? '—').slice(0, 160)}`);
        add(key, 'ok');
      };
      one('page', ['messages', 'feed'], 'appHook');
      one('page', ['leadgen'], 'appHookLeads');
      // edited messages and reactions (Dellal reads the new text, the team sees the ❤️)
      one('page', ['message_edits', 'message_reactions'], 'appHookEdits');
      one('instagram', ['messages', 'comments'], 'appHookIg');
      // the ad accounts' ads rejected or with a problem (Co-Pilot)
      one('ad_account', ['with_issues_ad_objects', 'in_process_ad_objects'], 'appHookAds');
    } catch (e) {
      add('appHook', 'warn', { list: 'messages, feed' }, why(e));
    }
  }
  // a webhook Pilotix refused these 2 days: its signature matched no secret (Instagram's own login signs with its own)
  const badSig = await lastBadSignature(t).catch(() => null);
  if (badSig && Date.now() - Date.parse(badSig.at) < 2 * 24 * 3_600_000) add('badSig', 'warn', { at: badSig.at, count: badSig.n });
  // the webhook's address, called from the Internet as Meta does (through Cloudflare)
  if (publicUrl && apps.verifyToken) {
    const challenge = String(Date.now());
    try {
      const res = await fetch(`${webhook}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(apps.verifyToken)}&hub.challenge=${challenge}`, { signal: AbortSignal.timeout(10_000) });
      const body = await res.text().catch(() => '');
      if (res.ok && body.trim() === challenge) add('reach', 'ok');
      else if (res.headers.get('cf-mitigated') || /Just a moment/i.test(body)) add('reach', 'bad', { why: 'cloudflare' });
      else add('reach', 'bad', { status: res.status });
    } catch (e) {
      add('reach', 'bad', { status: 0 }, why(e));
    }
  }

  // the ad accounts this boutique counts (all of this account's)
  if (counts('ad_account')) {
    const ads = assets.filter((a: any) => a.kind === 'ad_account');
    const unread: string[] = [];
    if (keyOk)
      for (const a of ads)
        await graph(`act_${String(a.ext_id).replace(/^act_/, '')}`, { fields: 'id,account_status', access_token: token }).catch(() => unread.push(String(a.name ?? a.ext_id)));
    add('ads', !keyOk || unread.length ? 'warn' : 'ok', { count: ads.length, bad: keyOk ? unread.length : ads.length }, unread.length ? unread.join(', ').slice(0, 240) : null);
    const money = [...new Set(ads.map((a: any) => jsonOf(a.extra).currency).filter(Boolean).map(String))];
    // Publicité counts a dinar account in dinars (and in dollars with the month's rate); any other money as dollars
    const other = money.filter((c) => c !== 'USD' && c !== 'DZD');
    if (other.length) add('adsCurrency', 'warn', { list: other.join(', ') });
    else if (money.includes('DZD')) add('adsCurrency', 'ok');
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
