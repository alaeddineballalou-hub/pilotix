// Linked accounts (Pilot AI › Comptes): a boutique links its Facebook (Meta) and TikTok accounts with one login, in a new
// tab; Pilotix keeps their tokens on the server (never in a page) and finds what each account may use: its Facebook Pages
// (with their Instagram account), its Meta ad accounts, its TikTok ad accounts. An account goes to one boutique (which
// uses its Page and its ad account at once) or to all the owner's boutiques (each boutique picks its Page and its ad
// account in one click; a Page answers for one boutique only). What a boutique uses is written where its agents already
// read it: Message AI agent and CM AI agent (the Page, its token, its Instagram account) and Publicité (the ad account and
// the account's token). The hand-pasted Page token is gone: a Page comes only from a linked account.
//
// The network part (the login's code turned into a token, the Pages and ad accounts read, the Pages subscribed to
// Pilotix's webhook) is in social-server.ts, run by the server only. In the browser preview there is no platform: a
// sample account answers, kept in the page until it is reloaded.
import { z } from 'zod';
import { Db, iso, isoOrNull, num } from '../db';
import { AppError, Ctx, proc } from '../rpc';
import { getSetting, setSetting } from '../settings';
import type { Tenancy } from '../platform/tenancy';

export const SOCIAL_PROVIDERS = ['meta', 'tiktok'] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];
export const ASSET_KINDS = ['page', 'ad_account', 'advertiser'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const SOCIAL = {
  /** the login tab has this long to come back */
  stateMinutes: 20,
  /** a token that ends in less than this is shown « to link again soon » */
  soonDays: 7,
  graph: 'https://graph.facebook.com/v25.0',
  dialog: 'https://www.facebook.com/v25.0/dialog/oauth',
  tiktokAuth: 'https://business-api.tiktok.com/portal/auth',
  tiktokApi: 'https://business-api.tiktok.com/open_api/v1.3',
  /** asked by the classic Facebook login (without a Facebook Login for Business configuration) */
  metaScopes: [
    'pages_show_list',
    'pages_messaging',
    'pages_manage_metadata',
    'pages_read_engagement',
    'pages_manage_engagement',
    'pages_read_user_content',
    'instagram_basic',
    'instagram_manage_messages',
    'instagram_manage_comments',
    'business_management',
    'ads_read',
  ],
  /** what each Page sends to Pilotix's webhook */
  pageFields: 'messages,messaging_postbacks,messaging_referrals,feed',
} as const;

/** The shop settings a use writes (the agents read them there). */
export const SOCIAL_KEYS = {
  page: 'social_page',
  ads: 'social_ads',
  tiktokAds: 'social_tiktok_ads',
  pageToken: 'secret_dellal_page_token',
  adsToken: 'secret_meta_token',
  tiktokAdsToken: 'secret_tiktok_ads_token',
} as const;

export const SOCIAL_PLATFORM_SQL = `
-- a linked Facebook / TikTok account: its token stays here (the server only)
CREATE TABLE IF NOT EXISTS platform.social_links (
  id          serial PRIMARY KEY,
  provider    text        NOT NULL CHECK (provider IN ('meta', 'tiktok')),
  -- the boutiques' owner (platform.accounts; 0: a boutique without one), « all boutiques » = all of the owner's
  owner_id    integer     NOT NULL DEFAULT 0,
  -- null: all the owner's boutiques
  shop_id     integer     REFERENCES platform.shops(id) ON DELETE CASCADE,
  ext_id      text        NOT NULL,
  name        text        NOT NULL DEFAULT '',
  picture     text        NOT NULL DEFAULT '',
  token       text        NOT NULL,
  token_kind  text        NOT NULL DEFAULT 'user',
  expires_at  timestamptz,
  status      text        NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error')),
  error       text,
  by_name     text        NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS social_links_owner ON platform.social_links (owner_id);
CREATE INDEX IF NOT EXISTS social_links_shop ON platform.social_links (shop_id);
-- what a linked account may use: a Page (with its Instagram account), an ad account, a TikTok ad account
CREATE TABLE IF NOT EXISTS platform.social_assets (
  id       serial PRIMARY KEY,
  link_id  integer NOT NULL REFERENCES platform.social_links(id) ON DELETE CASCADE,
  kind     text    NOT NULL CHECK (kind IN ('page', 'ad_account', 'advertiser')),
  ext_id   text    NOT NULL,
  name     text    NOT NULL DEFAULT '',
  extra    jsonb   NOT NULL DEFAULT '{}',
  -- a Page's own token (the server only)
  token    text,
  UNIQUE (link_id, kind, ext_id)
);
-- what each boutique uses: one Page, one ad account, one TikTok ad account; a Page answers for one boutique only
CREATE TABLE IF NOT EXISTS platform.social_uses (
  shop_id    integer     NOT NULL REFERENCES platform.shops(id) ON DELETE CASCADE,
  kind       text        NOT NULL CHECK (kind IN ('page', 'ad_account', 'advertiser')),
  asset_id   integer     NOT NULL REFERENCES platform.social_assets(id) ON DELETE CASCADE,
  ext_id     text        NOT NULL,
  ig_id      text,
  by_name    text        NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, kind)
);
CREATE UNIQUE INDEX IF NOT EXISTS social_uses_page ON platform.social_uses (ext_id) WHERE kind = 'page';
CREATE INDEX IF NOT EXISTS social_uses_ig ON platform.social_uses (ig_id) WHERE ig_id IS NOT NULL;
-- a login started in a boutique: its tab comes back with this state (once, within 20 minutes)
CREATE TABLE IF NOT EXISTS platform.social_states (
  state      text        PRIMARY KEY,
  provider   text        NOT NULL,
  owner_id   integer     NOT NULL DEFAULT 0,
  -- the account's boutique: null = all the owner's boutiques
  shop_id    integer,
  from_shop  integer     NOT NULL,
  by_name    text        NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  done_at    timestamptz,
  link_id    integer,
  error      text
);
`;

// ---------------------------------------------------------------- Pilotix's own apps (the control room)
/** Pilotix's Meta and TikTok apps: what the control room shows (never the secrets). */
export interface SocialApps {
  meta: { appId: string; configId: string; hasSecret: boolean };
  tiktok: { appId: string; hasSecret: boolean };
  /** the webhook's verify token (Meta asks for it once) */
  verifyToken: string;
}
const APPS_ROW = 'social_apps';
const SECRETS_ROW = 'social_secrets';
const json = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);
const clean = (v: unknown, max = 200) => String(v ?? '').trim().slice(0, max);
const randomToken = () => {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(32));
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function platformRow(t: Tenancy, key: string): Promise<any> {
  const r = await t.platform.query('SELECT value FROM platform.settings WHERE key = $1', [key]);
  return r[0] ? json(r[0].value) ?? {} : {};
}
async function savePlatformRow(t: Tenancy, key: string, value: unknown) {
  await t.platform.query(
    `INSERT INTO platform.settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

export async function socialApps(t: Tenancy): Promise<SocialApps> {
  const a = await platformRow(t, APPS_ROW);
  const s = await platformRow(t, SECRETS_ROW);
  return {
    meta: { appId: clean(a.meta?.appId, 40), configId: clean(a.meta?.configId, 40), hasSecret: !!clean(s.meta) },
    tiktok: { appId: clean(a.tiktok?.appId, 40), hasSecret: !!clean(s.tiktok) },
    verifyToken: clean(a.verifyToken, 100),
  };
}
/** An app's secret, for the server's token calls only. */
export async function socialSecret(t: Tenancy, p: SocialProvider): Promise<string> {
  return clean((await platformRow(t, SECRETS_ROW))[p], 300);
}
export const appReady = (a: SocialApps, p: SocialProvider) => (p === 'meta' ? !!(a.meta.appId && a.meta.hasSecret) : !!(a.tiktok.appId && a.tiktok.hasSecret));
/** Where the login tab comes back, and where Meta sends the Pages' messages and comments. */
export const socialUrls = (publicUrl: string) => ({
  metaRedirect: `${publicUrl}/api/oauth/meta/callback`,
  tiktokRedirect: `${publicUrl}/api/oauth/tiktok/callback`,
  metaWebhook: `${publicUrl}/api/hooks/meta-app`,
});

export const SocialAppsInput = z.object({
  meta: z.object({
    appId: z.string().trim().max(40).regex(/^\d*$/, 'ID de l’app Meta (chiffres)'),
    configId: z.string().trim().max(40).regex(/^\d*$/, 'ID de configuration (chiffres)').default(''),
    /** a value replaces, '' keeps, null removes */
    secret: z.string().trim().max(300).nullable().default(''),
  }),
  tiktok: z.object({
    appId: z.string().trim().max(40).regex(/^\d*$/, 'App ID TikTok (chiffres)'),
    secret: z.string().trim().max(300).nullable().default(''),
  }),
});
export async function saveSocialApps(t: Tenancy, i: z.output<typeof SocialAppsInput>): Promise<SocialApps> {
  const cur = await platformRow(t, APPS_ROW);
  await savePlatformRow(t, APPS_ROW, { meta: { appId: i.meta.appId, configId: i.meta.configId }, tiktok: { appId: i.tiktok.appId }, verifyToken: clean(cur.verifyToken, 100) || randomToken() });
  const sec = await platformRow(t, SECRETS_ROW);
  for (const p of SOCIAL_PROVIDERS) {
    const v = i[p].secret;
    if (v === null) delete sec[p];
    else if (v) sec[p] = v;
  }
  await savePlatformRow(t, SECRETS_ROW, sec);
  return socialApps(t);
}
/** How many accounts are linked, and for how many boutiques (the control room). */
export async function socialCounts(t: Tenancy): Promise<{ meta: number; tiktok: number; shops: number }> {
  const r = await t.platform.query(`SELECT provider, count(*)::int AS n FROM platform.social_links GROUP BY provider`);
  const k = Object.fromEntries(r.map((x: any) => [String(x.provider), num(x.n)]));
  const s = await t.platform.query(`SELECT count(DISTINCT shop_id)::int AS n FROM platform.social_uses`);
  return { meta: k.meta ?? 0, tiktok: k.tiktok ?? 0, shops: num(s[0]?.n) };
}

// ---------------------------------------------------------------- the login, from a boutique
/** The address of the login page (Facebook or TikTok) for this state. */
export function loginUrl(apps: SocialApps, p: SocialProvider, state: string, publicUrl: string): string {
  const u = socialUrls(publicUrl);
  const enc = encodeURIComponent;
  if (p === 'tiktok') return `${SOCIAL.tiktokAuth}?app_id=${enc(apps.tiktok.appId)}&state=${enc(state)}&redirect_uri=${enc(u.tiktokRedirect)}`;
  const base = `${SOCIAL.dialog}?client_id=${enc(apps.meta.appId)}&redirect_uri=${enc(u.metaRedirect)}&state=${enc(state)}&response_type=code`;
  // Facebook Login for Business: a token that does not expire (a configuration made in Pilotix's Meta app)
  return apps.meta.configId ? `${base}&config_id=${enc(apps.meta.configId)}&override_default_response_type=true` : `${base}&scope=${enc(SOCIAL.metaScopes.join(','))}`;
}

export interface StateRow {
  state: string;
  provider: SocialProvider;
  ownerId: number;
  shopId: number | null;
  fromShop: number;
  by: string;
  expired: boolean;
  done: boolean;
}
/** The login tab is back: its state, once (null: unknown, used or too old). */
export async function takeState(t: Tenancy, state: string): Promise<StateRow | null> {
  if (!state || state.length > 100) return null;
  const r = (await t.platform.query(`SELECT *, expires_at < now() AS expired FROM platform.social_states WHERE state = $1`, [state]))[0];
  if (!r) return null;
  return { state, provider: r.provider, ownerId: num(r.owner_id), shopId: r.shop_id === null ? null : num(r.shop_id), fromShop: num(r.from_shop), by: String(r.by_name ?? ''), expired: !!r.expired, done: !!r.done_at };
}
export async function endState(t: Tenancy, state: string, o: { linkId?: number | null; error?: string | null }) {
  await t.platform.query(`UPDATE platform.social_states SET done_at = now(), link_id = $2, error = $3 WHERE state = $1`, [state, o.linkId ?? null, o.error ? o.error.slice(0, 300) : null]);
}

// ---------------------------------------------------------------- what a login brought back
export interface FoundAsset {
  kind: AssetKind;
  extId: string;
  name: string;
  /** page: { picture?, ig?: { id, username } }; ad account: { currency?, status? } */
  extra?: Record<string, unknown>;
  token?: string | null;
}
export interface FoundAccount {
  provider: SocialProvider;
  extId: string;
  name: string;
  picture?: string;
  token: string;
  tokenKind: 'user' | 'system' | 'advertiser';
  expiresAt: string | null;
  assets: FoundAsset[];
}

const schemaOfShop = async (t: Tenancy, shopId: number): Promise<string | null> => {
  const r = (await t.platform.query(`SELECT schema_name FROM platform.shops WHERE id = $1 AND status NOT IN ('archived', 'deleted')`, [shopId]))[0];
  return r ? String(r.schema_name) : null;
};

/**
 * Keeps the account a login brought back (the same Facebook / TikTok person linked again for the same boutiques: its row is
 * updated), its Pages and ad accounts (those gone are taken away from the boutiques that used them, the others keep their
 * new token), and, for an account linked to one boutique, uses its first free Page and ad account there at once.
 */
export async function saveLink(t: Tenancy, st: StateRow, f: FoundAccount): Promise<number> {
  const linkId = await t.platform.tx(async (db) => {
    const same = (
      await db.query(`SELECT id FROM platform.social_links WHERE provider = $1 AND owner_id = $2 AND ext_id = $3 AND coalesce(shop_id, 0) = $4`, [f.provider, st.ownerId, f.extId, st.shopId ?? 0])
    )[0];
    const vals = [f.name.slice(0, 200), (f.picture ?? '').slice(0, 1000), f.token, f.tokenKind, f.expiresAt, st.by.slice(0, 120)];
    if (same) {
      await db.query(`UPDATE platform.social_links SET name = $2, picture = $3, token = $4, token_kind = $5, expires_at = $6, by_name = $7, status = 'ok', error = NULL, updated_at = now() WHERE id = $1`, [num(same.id), ...vals]);
      return num(same.id);
    }
    const r = await db.query(
      `INSERT INTO platform.social_links (provider, owner_id, shop_id, ext_id, name, picture, token, token_kind, expires_at, by_name) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [f.provider, st.ownerId, st.shopId, f.extId, ...vals],
    );
    return num(r[0].id);
  });
  const keep = new Set(f.assets.map((a) => `${a.kind}:${a.extId}`));
  // the Pages and ad accounts no longer shared with Pilotix: the boutiques that used them stop
  for (const a of await t.platform.query(`SELECT id, kind, ext_id FROM platform.social_assets WHERE link_id = $1`, [linkId])) {
    if (keep.has(`${a.kind}:${a.ext_id}`)) continue;
    for (const u of await t.platform.query(`SELECT shop_id FROM platform.social_uses WHERE asset_id = $1`, [num(a.id)])) await stopUse(t, num(u.shop_id), a.kind);
    await t.platform.query(`DELETE FROM platform.social_assets WHERE id = $1`, [num(a.id)]);
  }
  for (const a of f.assets)
    await t.platform.query(
      `INSERT INTO platform.social_assets (link_id, kind, ext_id, name, extra, token) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (link_id, kind, ext_id) DO UPDATE SET name = EXCLUDED.name, extra = EXCLUDED.extra, token = EXCLUDED.token`,
      [linkId, a.kind, a.extId, a.name.slice(0, 200), JSON.stringify(a.extra ?? {}), a.token ?? null],
    );
  // the boutiques using them get the new tokens
  for (const u of await t.platform.query(`SELECT u.shop_id, u.asset_id FROM platform.social_uses u JOIN platform.social_assets a ON a.id = u.asset_id WHERE a.link_id = $1`, [linkId]))
    await writeUse(t, num(u.shop_id), num(u.asset_id));
  if (st.shopId) await autoUse(t, st.shopId, linkId, st.by);
  return linkId;
}

/** An account linked to one boutique: its first free Page, ad account and TikTok ad account, used there (if none yet). */
export async function autoUse(t: Tenancy, shopId: number, linkId: number, by: string) {
  const used = new Set((await t.platform.query(`SELECT kind FROM platform.social_uses WHERE shop_id = $1`, [shopId])).map((r: any) => String(r.kind)));
  const assets = await t.platform.query(
    `SELECT a.id, a.kind, (a.extra->'ig'->>'id') AS ig,
            EXISTS (SELECT 1 FROM platform.social_uses u WHERE u.asset_id = a.id AND a.kind = 'page') AS taken
       FROM platform.social_assets a WHERE a.link_id = $1 ORDER BY a.id`,
    [linkId],
  );
  for (const kind of ASSET_KINDS) {
    if (used.has(kind)) continue;
    // a Page with its Instagram account first: the agents answer on both
    const free = assets.filter((a: any) => a.kind === kind && !a.taken).sort((a: any, b: any) => Number(!!b.ig) - Number(!!a.ig));
    if (free[0]) await useAsset(t, shopId, num(free[0].id), by);
  }
}

/** This boutique uses this Page / ad account (a Page answers for one boutique only). */
export async function useAsset(t: Tenancy, shopId: number, assetId: number, by: string) {
  const a = (await t.platform.query(`SELECT a.*, l.shop_id AS link_shop, l.owner_id FROM platform.social_assets a JOIN platform.social_links l ON l.id = a.link_id WHERE a.id = $1`, [assetId]))[0];
  if (!a) throw new AppError('not_found', 'Introuvable');
  const owner = await ownerOf(t, shopId);
  if (!(a.link_shop === null ? num(a.owner_id) > 0 && num(a.owner_id) === owner : num(a.link_shop) === shopId)) throw new AppError('forbidden', 'Ce compte n’est pas lié à cette boutique.');
  if (a.kind === 'page') {
    const other = (await t.platform.query(`SELECT u.shop_id, s.name FROM platform.social_uses u JOIN platform.shops s ON s.id = u.shop_id WHERE u.kind = 'page' AND u.ext_id = $1 AND u.shop_id <> $2`, [a.ext_id, shopId]))[0];
    if (other) throw new AppError('conflict', `Cette page répond déjà pour « ${other.name} ». Retirez-la là-bas d’abord.`);
  }
  const ig = a.kind === 'page' ? (json(a.extra)?.ig?.id ? String(json(a.extra).ig.id) : null) : null;
  await t.platform.query(
    `INSERT INTO platform.social_uses (shop_id, kind, asset_id, ext_id, ig_id, by_name) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (shop_id, kind) DO UPDATE SET asset_id = EXCLUDED.asset_id, ext_id = EXCLUDED.ext_id, ig_id = EXCLUDED.ig_id, by_name = EXCLUDED.by_name, created_at = now()`,
    [shopId, a.kind, assetId, a.ext_id, ig, by.slice(0, 120)],
  );
  await writeUse(t, shopId, assetId);
}

/** This boutique stops using its Page / ad account: its agents no longer have it. */
export async function stopUse(t: Tenancy, shopId: number, kind: AssetKind) {
  await t.platform.query(`DELETE FROM platform.social_uses WHERE shop_id = $1 AND kind = $2`, [shopId, kind]);
  const schema = await schemaOfShop(t, shopId);
  if (schema) await clearShop(t.shop(schema), kind);
}

/** Writes what a boutique uses where its agents read it (its schema's settings). */
async function writeUse(t: Tenancy, shopId: number, assetId: number) {
  const schema = await schemaOfShop(t, shopId);
  if (!schema) return;
  const a = (await t.platform.query(`SELECT a.*, l.name AS account, l.token AS link_token, l.provider FROM platform.social_assets a JOIN platform.social_links l ON l.id = a.link_id WHERE a.id = $1`, [assetId]))[0];
  if (!a) return;
  await applyShop(t.shop(schema), {
    kind: a.kind,
    linkId: num(a.link_id),
    assetId,
    extId: String(a.ext_id),
    name: String(a.name ?? ''),
    extra: json(a.extra) ?? {},
    account: String(a.account ?? ''),
    token: String((a.kind === 'page' ? a.token : a.link_token) ?? ''),
  });
}

interface Applied {
  kind: AssetKind;
  linkId: number;
  assetId: number;
  extId: string;
  name: string;
  extra: any;
  account: string;
  token: string;
}
const raw = async (db: Db, key: string): Promise<any> => (await db.query('SELECT value FROM settings WHERE key = $1', [key]))[0]?.value ?? null;
const put = (db: Db, key: string, value: unknown) =>
  db.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, JSON.stringify(value)]);
const drop = (db: Db, keys: string[]) => db.query('DELETE FROM settings WHERE key = ANY($1)', [keys]);

async function applyShop(db: Db, a: Applied) {
  const at = new Date().toISOString();
  if (a.kind === 'page') {
    const ig = a.extra?.ig?.id ? { id: String(a.extra.ig.id), username: String(a.extra.ig.username ?? '') } : null;
    await put(db, SOCIAL_KEYS.pageToken, a.token);
    const d = (await raw(db, 'dellal')) ?? {};
    await put(db, 'dellal', { ...d, messengerPageId: a.extId, instagramId: ig?.id ?? '' });
    await put(db, SOCIAL_KEYS.page, { linkId: a.linkId, assetId: a.assetId, pageId: a.extId, name: a.name, igId: ig?.id ?? null, igUsername: ig?.username || null, picture: a.extra?.picture ?? null, account: a.account, at });
  } else if (a.kind === 'ad_account') {
    const id = a.extId.replace(/^act_/, '');
    await put(db, SOCIAL_KEYS.adsToken, a.token);
    await setSetting(db, 'meta', { ...(await getSetting(db, 'meta')), adAccountId: id, hasToken: true });
    await put(db, SOCIAL_KEYS.ads, { linkId: a.linkId, assetId: a.assetId, adAccountId: id, name: a.name, currency: a.extra?.currency ?? null, account: a.account, at });
  } else {
    await put(db, SOCIAL_KEYS.tiktokAdsToken, a.token);
    await put(db, SOCIAL_KEYS.tiktokAds, { linkId: a.linkId, assetId: a.assetId, advertiserId: a.extId, name: a.name, account: a.account, at });
  }
}
async function clearShop(db: Db, kind: AssetKind) {
  if (kind === 'page') {
    await drop(db, [SOCIAL_KEYS.pageToken, SOCIAL_KEYS.page]);
    const d = await raw(db, 'dellal');
    if (d) await put(db, 'dellal', { ...d, messengerPageId: '', instagramId: '' });
  } else if (kind === 'ad_account') {
    await drop(db, [SOCIAL_KEYS.adsToken, SOCIAL_KEYS.ads]);
    await setSetting(db, 'meta', { ...(await getSetting(db, 'meta')), adAccountId: '', hasToken: false });
  } else await drop(db, [SOCIAL_KEYS.tiktokAdsToken, SOCIAL_KEYS.tiktokAds]);
}

/** The Page this boutique answers on (Message AI agent and CM AI agent show it), from its linked account. */
export interface LinkedPage {
  pageId: string;
  name: string;
  igId: string | null;
  igUsername: string | null;
  account: string;
}
export async function linkedPage(db: Db): Promise<LinkedPage | null> {
  const v = await raw(db, SOCIAL_KEYS.page);
  return v?.pageId ? { pageId: String(v.pageId), name: String(v.name ?? ''), igId: v.igId ? String(v.igId) : null, igUsername: v.igUsername ? String(v.igUsername) : null, account: String(v.account ?? '') } : null;
}
export async function linkedAds(db: Db): Promise<{ adAccountId: string; name: string; account: string } | null> {
  const v = await raw(db, SOCIAL_KEYS.ads);
  return v?.adAccountId ? { adAccountId: String(v.adAccountId), name: String(v.name ?? ''), account: String(v.account ?? '') } : null;
}

// ---------------------------------------------------------------- Meta's webhook: each Page's events to its boutique
/**
 * Meta sends every Page's messages and comments to one address (Pilotix's app): each entry goes to the boutique that uses
 * its Page (an Instagram entry: the boutique whose Page has this Instagram account). Entries of a Page nobody uses are
 * dropped.
 */
export async function routeMeta(t: Tenancy, body: any): Promise<{ shopId: number; body: any }[]> {
  const obj = body?.object;
  if (obj !== 'page' && obj !== 'instagram') return [];
  const byShop = new Map<number, any[]>();
  for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
    const id = entry?.id ? String(entry.id) : '';
    if (!id) continue;
    const r = (await t.platform.query(obj === 'page' ? `SELECT shop_id FROM platform.social_uses WHERE kind = 'page' AND ext_id = $1` : `SELECT shop_id FROM platform.social_uses WHERE kind = 'page' AND ig_id = $1`, [id]))[0];
    if (!r) continue;
    const s = num(r.shop_id);
    byShop.set(s, [...(byShop.get(s) ?? []), entry]);
  }
  return [...byShop].map(([shopId, entry]) => ({ shopId, body: { object: obj, entry } }));
}

// ---------------------------------------------------------------- the boutique's page (Pilot AI › Comptes)
async function ownerOf(t: Tenancy, shopId: number): Promise<number> {
  return num((await t.platform.query(`SELECT owner_account_id FROM platform.shops WHERE id = $1`, [shopId]))[0]?.owner_account_id);
}
interface Who {
  t: Tenancy;
  shopId: number;
  ownerId: number;
  isOwner: boolean;
  sisters: { id: number; name: string }[];
  by: string;
}
async function who(ctx: Ctx): Promise<Who> {
  const t = ctx.t!;
  const shopId = ctx.shop!.id;
  const r = (await t.platform.query(`SELECT s.owner_account_id, a.email FROM platform.shops s LEFT JOIN platform.accounts a ON a.id = s.owner_account_id WHERE s.id = $1`, [shopId]))[0];
  const ownerId = num(r?.owner_account_id);
  const isOwner = !!r?.email && String(r.email).toLowerCase() === String(ctx.session.profile.email ?? '').toLowerCase();
  const sisters = ownerId
    ? (await t.platform.query(`SELECT id, name FROM platform.shops WHERE kind = 'store' AND status NOT IN ('archived', 'deleted') AND owner_account_id = $1 ORDER BY id`, [ownerId])).map((x: any) => ({ id: num(x.id), name: String(x.name) }))
    : [];
  return { t, shopId, ownerId, isOwner, sisters: sisters.length > 1 ? sisters : [], by: String(ctx.session.profile.name || ctx.session.profile.email || '') };
}
const canAll = (w: Who) => w.isOwner && w.sisters.length > 1;

export interface AssetView {
  id: number;
  kind: AssetKind;
  extId: string;
  name: string;
  picture: string | null;
  igUsername: string | null;
  currency: string | null;
  /** a Page Pilotix could not subscribe to its webhook (its messages do not come yet) */
  noHook: boolean;
  usedHere: boolean;
  usedBy: { id: number; name: string }[];
}
export interface LinkView {
  id: number;
  provider: SocialProvider;
  name: string;
  picture: string | null;
  scope: 'here' | 'all';
  shopName: string | null;
  status: 'ok' | 'soon' | 'expired' | 'error';
  error: string | null;
  expiresAt: string | null;
  by: string;
  createdAt: string;
  updatedAt: string;
  assets: AssetView[];
}
export interface HereView {
  page: { name: string; igUsername: string | null; account: string } | null;
  ad_account: { name: string; account: string } | null;
  advertiser: { name: string; account: string } | null;
}
export interface SocialListView {
  apps: Record<SocialProvider, boolean>;
  canAll: boolean;
  isOwner: boolean;
  shop: { id: number; name: string };
  sisters: { id: number; name: string }[];
  links: LinkView[];
  here: HereView;
  preview: boolean;
}

const linkStatus = (status: string, expiresAt: string | null, now: number): LinkView['status'] => {
  if (status === 'error') return 'error';
  if (!expiresAt) return 'ok';
  const left = Date.parse(expiresAt) - now;
  return left <= 0 ? 'expired' : left < SOCIAL.soonDays * 86_400_000 ? 'soon' : 'ok';
};
const assetView = (a: any, shopId: number, users: { id: number; name: string }[]): AssetView => {
  const x = json(a.extra) ?? {};
  return {
    id: num(a.id),
    kind: a.kind,
    extId: String(a.ext_id),
    name: String(a.name ?? ''),
    picture: x.picture ? String(x.picture) : null,
    igUsername: x.ig?.username ? String(x.ig.username) : null,
    currency: x.currency ? String(x.currency) : null,
    noHook: a.kind === 'page' && x.hook === false,
    usedHere: users.some((u) => u.id === shopId),
    usedBy: users.filter((u) => u.id !== shopId),
  };
};

async function listFor(ctx: Ctx): Promise<SocialListView> {
  if (!ctx.t || !ctx.shop) return demoList(ctx);
  const w = await who(ctx);
  const apps = await socialApps(w.t);
  const links = await w.t.platform.query(
    `SELECT l.*, s.name AS shop_name FROM platform.social_links l LEFT JOIN platform.shops s ON s.id = l.shop_id
      WHERE l.shop_id = $1 OR (l.shop_id IS NULL AND l.owner_id = $2 AND $2 > 0) ORDER BY l.created_at, l.id`,
    [w.shopId, w.ownerId],
  );
  const ids = links.map((l: any) => num(l.id));
  const assets = ids.length ? await w.t.platform.query(`SELECT * FROM platform.social_assets WHERE link_id = ANY($1) ORDER BY kind, name, id`, [ids]) : [];
  const uses = assets.length
    ? await w.t.platform.query(`SELECT u.asset_id, u.shop_id, s.name FROM platform.social_uses u JOIN platform.shops s ON s.id = u.shop_id WHERE u.asset_id = ANY($1) ORDER BY s.id`, [assets.map((a: any) => num(a.id))])
    : [];
  const usersOf = (id: number) => uses.filter((u: any) => num(u.asset_id) === id).map((u: any) => ({ id: num(u.shop_id), name: String(u.name) }));
  const now = ctx.now();
  const view: LinkView[] = links.map((l: any) => ({
    id: num(l.id),
    provider: l.provider,
    name: String(l.name ?? ''),
    picture: l.picture ? String(l.picture) : null,
    scope: l.shop_id === null ? 'all' : 'here',
    shopName: l.shop_name ? String(l.shop_name) : null,
    status: linkStatus(String(l.status), isoOrNull(l.expires_at), now),
    error: l.error ? String(l.error) : null,
    expiresAt: isoOrNull(l.expires_at),
    by: String(l.by_name ?? ''),
    createdAt: iso(l.created_at),
    updatedAt: iso(l.updated_at),
    assets: assets.filter((a: any) => num(a.link_id) === num(l.id)).map((a: any) => assetView(a, w.shopId, usersOf(num(a.id)))),
  }));
  const name = String((await w.t.platform.query(`SELECT name FROM platform.shops WHERE id = $1`, [w.shopId]))[0]?.name ?? '');
  return { apps: { meta: appReady(apps, 'meta'), tiktok: appReady(apps, 'tiktok') }, canAll: canAll(w), isOwner: w.isOwner, shop: { id: w.shopId, name }, sisters: w.sisters, links: view, here: hereOf(view), preview: false };
}
function hereOf(links: LinkView[]): HereView {
  const find = (kind: AssetKind) => {
    for (const l of links) for (const a of l.assets) if (a.kind === kind && a.usedHere) return { a, l };
    return null;
  };
  const p = find('page');
  const ad = find('ad_account');
  const tt = find('advertiser');
  return {
    page: p ? { name: p.a.name, igUsername: p.a.igUsername, account: p.l.name } : null,
    ad_account: ad ? { name: ad.a.name, account: ad.l.name } : null,
    advertiser: tt ? { name: tt.a.name, account: tt.l.name } : null,
  };
}

/** A link of this boutique, or of all the owner's boutiques. */
async function visibleLink(w: Who, linkId: number) {
  const l = (await w.t.platform.query(`SELECT * FROM platform.social_links WHERE id = $1`, [linkId]))[0];
  if (!l || !(num(l.shop_id) === w.shopId || (l.shop_id === null && w.ownerId > 0 && num(l.owner_id) === w.ownerId))) throw new AppError('not_found', 'Compte introuvable');
  return l;
}

const id = z.number().int().positive();
export const socialProcs = {
  /** The boutique's linked accounts, what each may use, what this boutique uses. */
  'social.list': proc([], z.object({}), (ctx) => listFor(ctx)),

  /** A login starts: its address (opened in a new tab) and its state (the page asks it until the tab is back). */
  'social.start': proc([], z.object({ provider: z.enum(SOCIAL_PROVIDERS), scope: z.enum(['here', 'all']).default('here') }), async (ctx, i) => {
    if (!ctx.t || !ctx.shop) return demoStart(ctx, i.provider, i.scope);
    const w = await who(ctx);
    if (i.scope === 'all' && !canAll(w)) throw new AppError('forbidden', 'Seul le propriétaire des boutiques lie un compte pour toutes ses boutiques.');
    const apps = await socialApps(w.t);
    if (!appReady(apps, i.provider)) throw new AppError('bad_request', i.provider === 'meta' ? 'La connexion Facebook n’est pas encore prête : Pilotix doit d’abord ajouter son app Meta.' : 'La connexion TikTok n’est pas encore prête : Pilotix doit d’abord ajouter son app TikTok.');
    const publicUrl = ctx.server?.publicUrl;
    if (!publicUrl) throw new AppError('bad_request', 'L’adresse publique du serveur manque (PUBLIC_URL).');
    const state = randomToken();
    await w.t.platform.query(`DELETE FROM platform.social_states WHERE expires_at < now() - interval '1 day'`);
    await w.t.platform.query(
      `INSERT INTO platform.social_states (state, provider, owner_id, shop_id, from_shop, by_name, expires_at) VALUES ($1, $2, $3, $4, $5, $6, now() + interval '${SOCIAL.stateMinutes} minutes')`,
      [state, i.provider, w.ownerId, i.scope === 'all' ? null : w.shopId, w.shopId, w.by.slice(0, 120)],
    );
    return { state, url: loginUrl(apps, i.provider, state, publicUrl) as string | null };
  }),

  /** Where a login is: waiting for its tab, done (its account is in the list), failed or too old. */
  'social.state': proc([], z.object({ state: z.string().min(8).max(100) }), async (ctx, i) => {
    if (!ctx.t || !ctx.shop) return demoState(ctx, i.state);
    const r = (await ctx.t.platform.query(`SELECT done_at, error, link_id, expires_at < now() AS expired FROM platform.social_states WHERE state = $1 AND from_shop = $2`, [i.state, ctx.shop.id]))[0];
    if (!r) throw new AppError('not_found', 'Connexion introuvable');
    const status: 'waiting' | 'done' | 'error' | 'expired' = r.done_at ? (r.error ? 'error' : 'done') : r.expired ? 'expired' : 'waiting';
    return { status, error: r.error ? String(r.error) : null, linkId: r.link_id === null ? null : num(r.link_id) };
  }),

  /** This boutique answers on this Page / counts this ad account (one click). */
  'social.use': proc([], z.object({ assetId: id }), async (ctx, i) => {
    if (!ctx.t || !ctx.shop) return demoUse(ctx, i.assetId);
    const w = await who(ctx);
    await useAsset(w.t, w.shopId, i.assetId, w.by);
    ctx.emit({ type: 'settings' });
    return listFor(ctx);
  }),

  /** This boutique stops using its Page / ad account / TikTok ad account. */
  'social.unuse': proc([], z.object({ kind: z.enum(ASSET_KINDS) }), async (ctx, i) => {
    if (!ctx.t || !ctx.shop) return demoUnuse(ctx, i.kind);
    await stopUse(ctx.t, ctx.shop.id, i.kind);
    ctx.emit({ type: 'settings' });
    return listFor(ctx);
  }),

  /** For this boutique only, or for all the owner's boutiques (the owner only). */
  'social.scope': proc([], z.object({ linkId: id, scope: z.enum(['here', 'all']) }), async (ctx, i) => {
    if (!ctx.t || !ctx.shop) return demoScope(ctx, i.linkId, i.scope);
    const w = await who(ctx);
    const l = await visibleLink(w, i.linkId);
    if (!canAll(w)) throw new AppError('forbidden', 'Seul le propriétaire des boutiques change cela.');
    const to = i.scope === 'all' ? null : w.shopId;
    if ((l.shop_id === null ? null : num(l.shop_id)) === to) return listFor(ctx);
    const twin = (await w.t.platform.query(`SELECT 1 FROM platform.social_links WHERE provider = $1 AND owner_id = $2 AND ext_id = $3 AND coalesce(shop_id, 0) = $4 AND id <> $5`, [l.provider, num(l.owner_id), l.ext_id, to ?? 0, i.linkId]))[0];
    if (twin) throw new AppError('conflict', 'Ce compte est déjà lié ainsi : retirez l’autre d’abord.');
    if (to !== null) {
      // only this boutique now: the others stop using it
      for (const u of await w.t.platform.query(`SELECT u.shop_id, u.kind FROM platform.social_uses u JOIN platform.social_assets a ON a.id = u.asset_id WHERE a.link_id = $1 AND u.shop_id <> $2`, [i.linkId, to]))
        await stopUse(w.t, num(u.shop_id), u.kind);
    }
    await w.t.platform.query(`UPDATE platform.social_links SET shop_id = $2, updated_at = now() WHERE id = $1`, [i.linkId, to]);
    if (to !== null) await autoUse(w.t, to, i.linkId, w.by);
    ctx.emit({ type: 'settings' });
    return listFor(ctx);
  }),

  /** The account is no longer linked: every boutique that used its Pages or ad accounts stops (its token is forgotten). */
  'social.remove': proc([], z.object({ linkId: id }), async (ctx, i) => {
    if (!ctx.t || !ctx.shop) return demoRemove(ctx, i.linkId);
    const w = await who(ctx);
    const l = await visibleLink(w, i.linkId);
    if (l.shop_id === null && !w.isOwner) throw new AppError('forbidden', 'Ce compte sert à toutes les boutiques : seul leur propriétaire le retire.');
    for (const u of await w.t.platform.query(`SELECT u.shop_id, u.kind FROM platform.social_uses u JOIN platform.social_assets a ON a.id = u.asset_id WHERE a.link_id = $1`, [i.linkId]))
      await stopUse(w.t, num(u.shop_id), u.kind);
    await w.t.platform.query(`DELETE FROM platform.social_links WHERE id = $1`, [i.linkId]);
    ctx.emit({ type: 'settings' });
    return listFor(ctx);
  }),
};

// ---------------------------------------------------------------- the browser preview: a sample account, kept in the page
interface DemoLink {
  id: number;
  provider: SocialProvider;
  name: string;
  scope: 'here' | 'all';
  createdAt: string;
  assets: { id: number; kind: AssetKind; extId: string; name: string; igUsername: string | null; currency: string | null; usedBy: number[] }[];
}
const DEMO_SISTER = { id: 902, name: 'Boutique Oran' };
let demo: { links: DemoLink[]; next: number; states: Map<string, { at: number; provider: SocialProvider; scope: 'here' | 'all'; linkId: number | null }> } | null = null;
const demoShop = (ctx: Ctx) => ctx.shop?.id ?? 1;
function demoData(ctx: Ctx) {
  if (demo) return demo;
  const me = demoShop(ctx);
  demo = {
    next: 100,
    states: new Map(),
    links: [
      {
        id: 1,
        provider: 'meta',
        name: 'Alaeddine Benali',
        scope: 'all',
        createdAt: new Date(ctx.now() - 9 * 86_400_000).toISOString(),
        assets: [
          { id: 11, kind: 'page', extId: '104920331', name: 'Bébé Confort DZ', igUsername: 'bebeconfort.dz', currency: null, usedBy: [me] },
          { id: 12, kind: 'page', extId: '104920332', name: 'Bébé Confort Oran', igUsername: null, currency: null, usedBy: [DEMO_SISTER.id] },
          { id: 13, kind: 'ad_account', extId: '120211887', name: 'Bébé Confort — publicité', igUsername: null, currency: 'USD', usedBy: [me, DEMO_SISTER.id] },
        ],
      },
    ],
  };
  return demo;
}
async function demoName(ctx: Ctx) {
  const s = (await ctx.db.query(`SELECT value FROM settings WHERE key = 'shop'`))[0]?.value;
  return String(json(s)?.name || 'Ma boutique');
}
async function demoList(ctx: Ctx): Promise<SocialListView> {
  const d = demoData(ctx);
  const me = demoShop(ctx);
  const name = await demoName(ctx);
  const shops = [{ id: me, name }, DEMO_SISTER];
  const nameOf = (id: number) => shops.find((s) => s.id === id)?.name ?? '';
  const links: LinkView[] = d.links.map((l) => ({
    id: l.id,
    provider: l.provider,
    name: l.name,
    picture: null,
    scope: l.scope,
    shopName: l.scope === 'here' ? name : null,
    status: 'ok',
    error: null,
    expiresAt: null,
    by: name,
    createdAt: l.createdAt,
    updatedAt: l.createdAt,
    assets: l.assets.map((a) => ({
      id: a.id,
      kind: a.kind,
      extId: a.extId,
      name: a.name,
      picture: null,
      igUsername: a.igUsername,
      currency: a.currency,
      noHook: false,
      usedHere: a.usedBy.includes(me),
      usedBy: a.usedBy.filter((x) => x !== me).map((x) => ({ id: x, name: nameOf(x) })),
    })),
  }));
  return { apps: { meta: true, tiktok: true }, canAll: true, isOwner: true, shop: { id: me, name }, sisters: shops, links, here: hereOf(links), preview: true };
}
async function demoStart(ctx: Ctx, provider: SocialProvider, scope: 'here' | 'all') {
  const d = demoData(ctx);
  const state = `demo-${d.next++}`;
  d.states.set(state, { at: ctx.now(), provider, scope, linkId: null });
  return { state, url: null as string | null };
}
/** In the preview the « login » takes two seconds, then a sample account is linked. */
async function demoState(ctx: Ctx, state: string) {
  const d = demoData(ctx);
  const s = d.states.get(state);
  if (!s) throw new AppError('not_found', 'Connexion introuvable');
  if (s.linkId === null && ctx.now() - s.at < 2000) return { status: 'waiting' as const, error: null, linkId: null };
  if (s.linkId === null) {
    const me = demoShop(ctx);
    const n = d.next++;
    const tiktok = s.provider === 'tiktok';
    const link: DemoLink = {
      id: n,
      provider: s.provider,
      name: tiktok ? 'Bébé Confort Ads' : 'Sara Benali',
      scope: s.scope,
      createdAt: new Date(ctx.now()).toISOString(),
      assets: tiktok
        ? [{ id: n * 10 + 1, kind: 'advertiser', extId: '7311021845', name: 'Bébé Confort TikTok', igUsername: null, currency: 'USD', usedBy: [] }]
        : [
            { id: n * 10 + 1, kind: 'page', extId: `2049${n}`, name: 'Bébé Confort Alger', igUsername: 'bebeconfort.alger', currency: null, usedBy: [] },
            { id: n * 10 + 2, kind: 'ad_account', extId: `9930${n}`, name: 'Sara — publicité', igUsername: null, currency: 'USD', usedBy: [] },
          ],
    };
    d.links.push(link);
    s.linkId = n;
    // one boutique: what it can use, used at once (the first free of each kind)
    if (s.scope === 'here')
      for (const kind of ASSET_KINDS) {
        const usedAlready = d.links.some((l) => l.assets.some((a) => a.kind === kind && a.usedBy.includes(me)));
        const free = link.assets.find((a) => a.kind === kind);
        if (!usedAlready && free) await demoUseOne(ctx, d, me, free.id);
      }
  }
  return { status: 'done' as const, error: null, linkId: s.linkId };
}
async function demoUseOne(ctx: Ctx, d: NonNullable<typeof demo>, me: number, assetId: number) {
  let found: { l: DemoLink; a: DemoLink['assets'][number] } | null = null;
  for (const l of d.links) for (const a of l.assets) if (a.id === assetId) found = { l, a };
  if (!found) throw new AppError('not_found', 'Introuvable');
  const { l, a } = found;
  if (a.kind === 'page' && a.usedBy.some((x) => x !== me)) throw new AppError('conflict', `Cette page répond déjà pour « ${DEMO_SISTER.name} ». Retirez-la là-bas d’abord.`);
  for (const ll of d.links) for (const aa of ll.assets) if (aa.kind === a.kind) aa.usedBy = aa.usedBy.filter((x) => x !== me);
  a.usedBy.push(me);
  await applyShop(ctx.db, { kind: a.kind, linkId: l.id, assetId: a.id, extId: a.extId, name: a.name, extra: a.igUsername ? { ig: { id: `1784${a.extId}`, username: a.igUsername } } : a.currency ? { currency: a.currency } : {}, account: l.name, token: 'preview' });
}
async function demoUse(ctx: Ctx, assetId: number) {
  await demoUseOne(ctx, demoData(ctx), demoShop(ctx), assetId);
  return demoList(ctx);
}
async function demoUnuse(ctx: Ctx, kind: AssetKind) {
  const me = demoShop(ctx);
  for (const l of demoData(ctx).links) for (const a of l.assets) if (a.kind === kind) a.usedBy = a.usedBy.filter((x) => x !== me);
  await clearShop(ctx.db, kind);
  return demoList(ctx);
}
async function demoScope(ctx: Ctx, linkId: number, scope: 'here' | 'all') {
  const l = demoData(ctx).links.find((x) => x.id === linkId);
  if (!l) throw new AppError('not_found', 'Compte introuvable');
  l.scope = scope;
  if (scope === 'here') for (const a of l.assets) a.usedBy = a.usedBy.filter((x) => x === demoShop(ctx));
  return demoList(ctx);
}
async function demoRemove(ctx: Ctx, linkId: number) {
  const d = demoData(ctx);
  const l = d.links.find((x) => x.id === linkId);
  if (!l) throw new AppError('not_found', 'Compte introuvable');
  for (const a of l.assets) if (a.usedBy.includes(demoShop(ctx))) await clearShop(ctx.db, a.kind);
  d.links = d.links.filter((x) => x.id !== linkId);
  return demoList(ctx);
}
/** Tests: the preview's sample account from scratch. */
export const resetSocialDemo = () => {
  demo = null;
};
