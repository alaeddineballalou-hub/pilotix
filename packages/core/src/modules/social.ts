// Linked accounts (Pilot AI › Comptes): a boutique links its Facebook (Meta) and TikTok accounts with one login, in a new
// tab; Pilotix keeps their tokens on the server (never in a page) and finds what each account may use: its Facebook Pages
// (with their Instagram account), its Meta ad accounts, its TikTok ad accounts. An account goes to one boutique (which
// uses its Page and its ad accounts at once) or to all the owner's boutiques (each boutique picks its Page and counts the
// ad accounts or not, in one click; a Page answers for one boutique only). A boutique counts all the ad accounts of a
// linked account together: Publicité adds them up. What a boutique uses is written where its agents already read it:
// Pilot Message and Pilot Comments (the Page, its token, its Instagram account) and Publicité (the ad accounts and the
// account's token). The hand-pasted Page token is gone: a Page comes only from a linked account. « Tester » tries an
// account on the server (social-server.ts) and says, line by line, what works.
//
// The network part (the login's code turned into a token, the Pages and ad accounts read, the Pages subscribed to
// Pilotix's webhook) is in social-server.ts, run by the server only. In the browser preview there is no platform: a
// sample account answers, kept in the page until it is reloaded.
import { sealDeep, sealPlatformSetting, sealSetting, sealString } from '../secretbox';
import { z } from 'zod';
import { Db, iso, isoOrNull, num } from '../db';
import { AppError, Ctx, proc } from '../rpc';
import { getSetting, setSetting } from '../settings';
import type { Tenancy } from '../platform/tenancy';

export const SOCIAL_PROVIDERS = ['meta', 'tiktok'] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];
export const ASSET_KINDS = ['page', 'ad_account', 'advertiser'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
/**
 * Ad accounts are used all together: a boutique that counts a linked account's ads counts every ad account of it (Publicité
 * adds them up). Its use points at one of them; the others follow (a new one after a new login too).
 */
export const AD_KINDS: readonly AssetKind[] = ['ad_account', 'advertiser'];
export const isAdKind = (k: string) => (AD_KINDS as readonly string[]).includes(k);
/** The ad accounts' kind of each provider. */
export const adKindOf = (p: SocialProvider): AssetKind => (p === 'tiktok' ? 'advertiser' : 'ad_account');

/** One line of the « Tester » button: what was tried, how it went (the page words it), the platform's own words if it failed. */
export interface SocialCheck {
  key: string;
  state: 'ok' | 'warn' | 'bad';
  params?: Record<string, string | number>;
  detail?: string | null;
}
export interface SocialTest {
  at: string;
  checks: SocialCheck[];
}

export const SOCIAL = {
  /** the login tab has this long to come back */
  stateMinutes: 20,
  /** a token that ends in less than this is shown « to link again soon » */
  soonDays: 7,
  /** Meta's API version (Meta's popup is opened with it too) */
  graphVersion: 'v25.0',
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
    // a chat order that became a real sale, told to Meta (Conversions API for Business Messaging)
    'page_events',
    'instagram_manage_events',
    'business_management',
    'ads_read',
    // Marketing › Formulaires: the leads of the ads' forms (leadgen_forms, the leads, the Page's ads)
    'leads_retrieval',
    'pages_manage_ads',
    'ads_management',
    // Marketing › Catalogue: the shop's catalog and its product sets (lists)
    'catalog_management',
    // the CM plan: publish photos, videos and reels on the Page and on Instagram, delete them, read their numbers
    // (a Page video needs pages_manage_posts only: publish_video is for live videos, which Pilotix does not make)
    'pages_manage_posts',
    'instagram_content_publish',
    'instagram_manage_contents',
    'read_insights',
    'instagram_manage_insights',
    // Marketing › Influenceurs: ads in the shop's name and a creator's (partnership ads), on Instagram and on Facebook
    'instagram_branded_content_ads_brand',
    'facebook_branded_content_ads_brand',
  ],
  /** what each Page sends to Pilotix's webhook */
  pageFields: 'messages,messaging_postbacks,messaging_referrals,message_edits,message_reactions,feed',
  /** and its ads' lead forms, when the account gave Pilotix their permission (Facebook refuses the whole list without it) */
  leadFields: 'leadgen',
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

/**
 * « Oui, c'est ma boutique »: what a login brought back waits in its state (its tokens sealed) until the person in the
 * login's own tab says it is their boutique, with that tab's one-time key (nobody else has it: not even the person who
 * started the login, should someone else's account come back in it).
 */
export const SOCIAL_CONFIRM_SQL = `
ALTER TABLE platform.social_states ADD COLUMN IF NOT EXISTS found jsonb;
ALTER TABLE platform.social_states ADD COLUMN IF NOT EXISTS found_at timestamptz;
ALTER TABLE platform.social_states ADD COLUMN IF NOT EXISTS confirm_hash text;
`;

/** What Meta last sent Pilotix's webhook for each Page / Instagram account (routeMeta; « Tester » shows it). */
export const SOCIAL_HOOKS_SQL = `
-- routed: a boutique took it (its Page, or its Page's Instagram); what: the last thing (message, standby, echo, read…);
-- message_at: the last customer message; comment_at (p022): the last customer comment
CREATE TABLE IF NOT EXISTS platform.social_hooks (
  object     text        NOT NULL,
  ext_id     text        NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  routed     boolean     NOT NULL DEFAULT false,
  what       text        NOT NULL DEFAULT '',
  message_at timestamptz,
  PRIMARY KEY (object, ext_id)
);
`;

/**
 * Meta's data deletion requests (p025): the code Meta gives the person, how many linked accounts went, when. Never who
 * asked: the person's Facebook id is only used to find their accounts, then forgotten with them.
 */
export const SOCIAL_DELETIONS_SQL = `
CREATE TABLE IF NOT EXISTS platform.social_deletions (
  code     text        PRIMARY KEY,
  provider text        NOT NULL DEFAULT 'meta',
  removed  integer     NOT NULL DEFAULT 0,
  at       timestamptz NOT NULL DEFAULT now()
);
`;

// ---------------------------------------------------------------- Pilotix's own apps (the control room)
/** Pilotix's Meta and TikTok apps: what the control room shows (never the secrets). */
export interface SocialApps {
  /** hasIgSecret: the secret of the app's Instagram login (Meta signs that login's webhooks with it) */
  /** igConfigId: a second Facebook Login for Business configuration, made for Instagram alone (« Instagram API (unified
   * login) », Instagram Login Compatible): « Connecter Instagram » in Pilot Message › Réglages opens it */
  /** waConfigId: a third one, of the « WhatsApp Embedded Signup » kind: « Connecter WhatsApp » in Pilot Message › Réglages */
  meta: {
    appId: string;
    configId: string;
    igConfigId: string;
    waConfigId: string;
    hasSecret: boolean;
    hasIgSecret: boolean;
  };
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
    [key, JSON.stringify(sealPlatformSetting(key, value))],
  );
}

export async function socialApps(t: Tenancy): Promise<SocialApps> {
  const a = await platformRow(t, APPS_ROW);
  const s = await platformRow(t, SECRETS_ROW);
  return {
    meta: {
      appId: clean(a.meta?.appId, 40),
      configId: clean(a.meta?.configId, 40),
      igConfigId: clean(a.meta?.igConfigId, 40),
      waConfigId: clean(a.meta?.waConfigId, 40),
      hasSecret: !!clean(s.meta),
      hasIgSecret: !!clean(s.metaIg),
    },
    tiktok: { appId: clean(a.tiktok?.appId, 40), hasSecret: !!clean(s.tiktok) },
    verifyToken: clean(a.verifyToken, 100),
  };
}
/** An app's secret, for the server's token calls only. */
export async function socialSecret(t: Tenancy, p: SocialProvider): Promise<string> {
  return clean((await platformRow(t, SECRETS_ROW))[p], 300);
}
/** The secret of the Meta app's Instagram login (App Dashboard › Instagram › API setup with Instagram login). */
export async function socialIgSecret(t: Tenancy): Promise<string> {
  return clean((await platformRow(t, SECRETS_ROW)).metaIg, 300);
}

/** A webhook Pilotix refused (its signature matched no secret): when, and for what (« Tester » says it). */
const BADSIG_ROW = 'meta_badsig';
export async function noteBadSignature(t: Tenancy, object: unknown): Promise<void> {
  const cur = await platformRow(t, BADSIG_ROW);
  await savePlatformRow(t, BADSIG_ROW, { at: new Date().toISOString(), object: clean(object, 30), n: num(cur.n) + 1 });
}
export async function lastBadSignature(t: Tenancy): Promise<{ at: string; object: string; n: number } | null> {
  const r = await platformRow(t, BADSIG_ROW);
  return r.at ? { at: String(r.at), object: String(r.object ?? ''), n: num(r.n) } : null;
}

/**
 * Instagram accounts a boutique linked with Instagram's own login (Pilot Message › Réglages): the number Meta gives
 * them in that login's webhooks → the boutique (one account per boutique). Without Meta's approval (Advanced Access),
 * that login is the way to answer every customer of the boutique's own account.
 */
const IG_LOGINS_ROW = 'ig_logins';
export async function noteIgLogin(t: Tenancy, shopId: number, igId: string, username: string): Promise<void> {
  const all = await platformRow(t, IG_LOGINS_ROW);
  for (const [k, v] of Object.entries(all)) if (num((v as any)?.shopId) === shopId) delete all[k];
  if (igId) all[igId] = { shopId, username, at: new Date().toISOString() };
  await savePlatformRow(t, IG_LOGINS_ROW, all);
}
async function igLoginShop(t: Tenancy, igId: string): Promise<number | null> {
  const v = (await platformRow(t, IG_LOGINS_ROW))[igId];
  return v?.shopId ? num(v.shopId) : null;
}
/**
 * WhatsApp numbers a boutique connected with « Connecter WhatsApp » (Meta's Embedded Signup, Pilot Message › Réglages):
 * the number's id in Meta's webhooks (phone_number_id) → the boutique (one number per boutique). Their messages and
 * delivery statuses come to Pilotix's own app, and routeMeta gives them to that boutique.
 */
const WA_LOGINS_ROW = 'wa_logins';
export async function noteWaLogin(t: Tenancy, shopId: number, phoneId: string, phone = ''): Promise<void> {
  const all = await platformRow(t, WA_LOGINS_ROW);
  for (const [k, v] of Object.entries(all)) if (num((v as any)?.shopId) === shopId) delete all[k];
  if (phoneId) all[phoneId] = { shopId, phone, at: new Date().toISOString() };
  await savePlatformRow(t, WA_LOGINS_ROW, all);
}
async function waLoginShop(t: Tenancy, phoneId: string): Promise<number | null> {
  const v = (await platformRow(t, WA_LOGINS_ROW))[phoneId];
  return v?.shopId ? num(v.shopId) : null;
}
export const appReady = (a: SocialApps, p: SocialProvider) => (p === 'meta' ? !!(a.meta.appId && a.meta.hasSecret) : !!(a.tiktok.appId && a.tiktok.hasSecret));
/** Where the login tab comes back, where Meta sends the Pages' messages and comments, and its data deletion requests. */
export const socialUrls = (publicUrl: string) => ({
  metaRedirect: `${publicUrl}/api/oauth/meta/callback`,
  tiktokRedirect: `${publicUrl}/api/oauth/tiktok/callback`,
  metaWebhook: `${publicUrl}/api/hooks/meta-app`,
  metaDeletion: `${publicUrl}/api/hooks/meta-deletion`,
});

export const SocialAppsInput = z.object({
  meta: z.object({
    appId: z.string().trim().max(40).regex(/^\d*$/, 'ID de l’app Meta (chiffres)'),
    configId: z.string().trim().max(40).regex(/^\d*$/, 'ID de configuration (chiffres)').default(''),
    /** the Instagram-only configuration (« Connecter Instagram ») */
    igConfigId: z.string().trim().max(40).regex(/^\d*$/, 'ID de configuration Instagram (chiffres)').default(''),
    /** the WhatsApp Embedded Signup configuration (« Connecter WhatsApp ») */
    waConfigId: z.string().trim().max(40).regex(/^\d*$/, 'ID de configuration WhatsApp (chiffres)').default(''),
    /** a value replaces, '' keeps, null removes */
    secret: z.string().trim().max(300).nullable().default(''),
    /** the Instagram login's secret: the same (a value replaces, '' keeps, null removes) */
    igSecret: z.string().trim().max(300).nullable().default(''),
  }),
  tiktok: z.object({
    appId: z.string().trim().max(40).regex(/^\d*$/, 'App ID TikTok (chiffres)'),
    secret: z.string().trim().max(300).nullable().default(''),
  }),
});
export async function saveSocialApps(t: Tenancy, i: z.output<typeof SocialAppsInput>): Promise<SocialApps> {
  const cur = await platformRow(t, APPS_ROW);
  await savePlatformRow(t, APPS_ROW, {
    meta: {
      appId: i.meta.appId,
      configId: i.meta.configId,
      igConfigId: i.meta.igConfigId,
      waConfigId: i.meta.waConfigId,
    },
    tiktok: { appId: i.tiktok.appId },
    verifyToken: clean(cur.verifyToken, 100) || randomToken(),
  });
  const sec = await platformRow(t, SECRETS_ROW);
  for (const p of SOCIAL_PROVIDERS) {
    const v = i[p].secret;
    if (v === null) delete sec[p];
    else if (v) sec[p] = v;
  }
  if (i.meta.igSecret === null) delete sec.metaIg;
  else if (i.meta.igSecret) sec.metaIg = i.meta.igSecret;
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
export function loginUrl(apps: SocialApps, p: SocialProvider, state: string, publicUrl: string, kind: LoginKind = 'account'): string {
  const u = socialUrls(publicUrl);
  const enc = encodeURIComponent;
  if (p === 'tiktok') return `${SOCIAL.tiktokAuth}?app_id=${enc(apps.tiktok.appId)}&state=${enc(state)}&redirect_uri=${enc(u.tiktokRedirect)}`;
  const base = `${SOCIAL.dialog}?client_id=${enc(apps.meta.appId)}&redirect_uri=${enc(u.metaRedirect)}&state=${enc(state)}&response_type=code`;
  // « Connecter Instagram »: the Instagram-only configuration (Instagram Login Compatible)
  if (kind === 'instagram') return `${base}&config_id=${enc(apps.meta.igConfigId)}&override_default_response_type=true`;
  // « Connecter WhatsApp »: Meta's Embedded Signup (the shop picks or makes its WhatsApp Business account and number)
  if (kind === 'whatsapp') return `${base}&config_id=${enc(apps.meta.waConfigId)}&override_default_response_type=true&extras=${enc(JSON.stringify(WA_EXTRAS))}`;
  // Facebook Login for Business: a token that does not expire (a configuration made in Pilotix's Meta app)
  return apps.meta.configId ? `${base}&config_id=${enc(apps.meta.configId)}&override_default_response_type=true` : `${base}&scope=${enc(SOCIAL.metaScopes.join(','))}`;
}

/** What a login is for: an account (Pages, ad accounts), « Connecter Instagram » or « Connecter WhatsApp » (Pilot Message alone). */
export type LoginKind = "account" | "instagram" | "whatsapp";
/** « Connecter Instagram »'s states start with it (a normal state never has a dot). */
export const IG_STATE = "ig.";
/** « Connecter WhatsApp »'s states start with it. */
export const WA_STATE = 'wa.';
export const loginKindOf = (state: string): LoginKind =>
  state.startsWith(IG_STATE) ? "instagram" : state.startsWith(WA_STATE) ? 'whatsapp' : "account";
/** Embedded Signup's own settings (Meta's « extras »): its usual flow, its version 3 */
const WA_EXTRAS = { setup: {}, featureType: '', sessionInfoVersion: '3' };

export interface StateRow {
  state: string;
  provider: SocialProvider;
  ownerId: number;
  shopId: number | null;
  fromShop: number;
  by: string;
  expired: boolean;
  done: boolean;
  /** what the login brought back, waiting for « Oui, c'est ma boutique » (null: not back yet) */
  found: FoundAccount | null;
  confirmHash: string | null;
}
/** The login tab is back: its state, once (null: unknown, used or too old). */
export async function takeState(t: Tenancy, state: string): Promise<StateRow | null> {
  if (!state || state.length > 100) return null;
  const r = (await t.platform.query(`SELECT *, expires_at < now() AS expired FROM platform.social_states WHERE state = $1`, [state]))[0];
  if (!r) return null;
  return {
    state,
    provider: r.provider,
    ownerId: num(r.owner_id),
    shopId: r.shop_id === null ? null : num(r.shop_id),
    fromShop: num(r.from_shop),
    by: String(r.by_name ?? ''),
    expired: !!r.expired,
    done: !!r.done_at,
    found: r.found_at && r.found ? (typeof r.found === 'string' ? JSON.parse(r.found) : r.found) : null,
    confirmHash: r.confirm_hash ? String(r.confirm_hash) : null,
  };
}
/** The login came back: what it brought waits (its tokens sealed) for the tab's « Oui, c'est ma boutique ». */
export async function holdFound(t: Tenancy, state: string, found: FoundAccount, confirmHash: string) {
  await t.platform.query(`UPDATE platform.social_states SET found = $2, found_at = now(), confirm_hash = $3 WHERE state = $1 AND done_at IS NULL`, [state, JSON.stringify(sealDeep(found)), confirmHash]);
}
export async function endState(t: Tenancy, state: string, o: { linkId?: number | null; error?: string | null }) {
  // what the login brought goes with it: kept only while it waited for its « oui »
  await t.platform.query(`UPDATE platform.social_states SET done_at = now(), link_id = $2, error = $3, found = NULL, confirm_hash = NULL WHERE state = $1`, [state, o.linkId ?? null, o.error ? o.error.slice(0, 300) : null]);
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
  /** « Connecter Instagram »: the Instagram account the login brought (it goes to Pilot Message, not to the accounts list) */
  instagram?: { id: string; username: string };
  /** « Connecter WhatsApp »: the WhatsApp Business account, its number's id, the number as Meta shows it, its name */
  whatsapp?: { wabaId: string; phoneId: string; phone: string; name: string };
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
    const vals = [f.name.slice(0, 200), (f.picture ?? '').slice(0, 1000), sealString(f.token), f.tokenKind, f.expiresAt, st.by.slice(0, 120)];
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
  for (const a of f.assets)
    await t.platform.query(
      `INSERT INTO platform.social_assets (link_id, kind, ext_id, name, extra, token) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (link_id, kind, ext_id) DO UPDATE SET name = EXCLUDED.name, extra = EXCLUDED.extra, token = EXCLUDED.token`,
      [linkId, a.kind, a.extId, a.name.slice(0, 200), JSON.stringify(a.extra ?? {}), a.token ? sealString(a.token) : null],
    );
  // The Pages and ad accounts no longer shared with Pilotix: a boutique that used such a Page stops; one that counted this
  // account's ad accounts keeps counting the others (its use moves to one of them), and stops only when none is left.
  const now = await t.platform.query(`SELECT id, kind, ext_id FROM platform.social_assets WHERE link_id = $1 ORDER BY id`, [linkId]);
  for (const a of now) {
    if (keep.has(`${a.kind}:${a.ext_id}`)) continue;
    const heir = isAdKind(a.kind) ? now.find((x: any) => x.kind === a.kind && keep.has(`${x.kind}:${x.ext_id}`)) : undefined;
    for (const u of await t.platform.query(`SELECT shop_id FROM platform.social_uses WHERE asset_id = $1`, [num(a.id)])) {
      if (heir) await t.platform.query(`UPDATE platform.social_uses SET asset_id = $3, ext_id = $4 WHERE shop_id = $1 AND kind = $2`, [num(u.shop_id), a.kind, num(heir.id), String(heir.ext_id)]);
      else await stopUse(t, num(u.shop_id), a.kind);
    }
    await t.platform.query(`DELETE FROM platform.social_assets WHERE id = $1`, [num(a.id)]);
  }
  // the boutiques using them get the new tokens (and the ad accounts' new list)
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

/** A linked account goes: every boutique that used its Pages or ad accounts stops, its tokens and assets go with it. */
export async function removeLink(t: Tenancy, linkId: number) {
  for (const u of await t.platform.query(`SELECT u.shop_id, u.kind FROM platform.social_uses u JOIN platform.social_assets a ON a.id = u.asset_id WHERE a.link_id = $1`, [linkId]))
    await stopUse(t, num(u.shop_id), u.kind);
  await t.platform.query(`DELETE FROM platform.social_links WHERE id = $1`, [linkId]);
}

/** A data deletion request Meta sent, by its code: when, and how many linked accounts went (nothing about who). */
export async function deletionStatus(t: Tenancy, code: string): Promise<{ code: string; at: string; removed: number } | null> {
  if (!/^[A-Z0-9]{8,40}$/.test(String(code ?? ''))) return null;
  const r = (await t.platform.query(`SELECT code, removed, at FROM platform.social_deletions WHERE code = $1`, [code]))[0];
  return r ? { code: String(r.code), at: iso(r.at), removed: num(r.removed) } : null;
}

/** Writes what a boutique uses where its agents read it (its schema's settings). */
async function writeUse(t: Tenancy, shopId: number, assetId: number) {
  const schema = await schemaOfShop(t, shopId);
  if (!schema) return;
  const a = (await t.platform.query(`SELECT a.*, l.name AS account, l.token AS link_token, l.provider FROM platform.social_assets a JOIN platform.social_links l ON l.id = a.link_id WHERE a.id = $1`, [assetId]))[0];
  if (!a) return;
  // a Page's Instagram as Facebook shows it now (a new login with Instagram's permissions shows one that was hidden):
  // Instagram's messages find the boutique by it (routeMeta)
  if (a.kind === 'page') {
    const ig = json(a.extra)?.ig?.id ? String(json(a.extra).ig.id) : null;
    await t.platform.query(`UPDATE platform.social_uses SET ig_id = $3::text WHERE shop_id = $1 AND kind = 'page' AND asset_id = $2 AND ig_id IS DISTINCT FROM $3::text`, [shopId, assetId, ig]);
  }
  // ad accounts: all of the account's, in the order they came
  const accounts = isAdKind(a.kind)
    ? (await t.platform.query(`SELECT ext_id, name, extra FROM platform.social_assets WHERE link_id = $1 AND kind = $2 ORDER BY id`, [num(a.link_id), a.kind])).map((x: any) => ({
        extId: String(x.ext_id),
        name: String(x.name ?? ''),
        currency: json(x.extra)?.currency ? String(json(x.extra).currency) : null,
      }))
    : undefined;
  await applyShop(t.shop(schema), {
    kind: a.kind,
    linkId: num(a.link_id),
    assetId,
    extId: String(a.ext_id),
    name: String(a.name ?? ''),
    extra: json(a.extra) ?? {},
    account: String(a.account ?? ''),
    token: String((a.kind === 'page' ? a.token : a.link_token) ?? ''),
    accounts,
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
  /** ad accounts: every ad account of the linked account (the use's own one when missing) */
  accounts?: { extId: string; name: string; currency: string | null }[];
}
const raw = async (db: Db, key: string): Promise<any> => (await db.query('SELECT value FROM settings WHERE key = $1', [key]))[0]?.value ?? null;
const put = (db: Db, key: string, value: unknown) =>
  db.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, JSON.stringify(sealSetting(key, value))]);
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
    // Publicité reads every one of them (meta.ts) and adds them up
    const list = (a.accounts?.length ? a.accounts : [{ extId: a.extId, name: a.name, currency: a.extra?.currency ?? null }]).map((x) => ({ adAccountId: x.extId.replace(/^act_/, ''), name: x.name, currency: x.currency }));
    await put(db, SOCIAL_KEYS.adsToken, a.token);
    await setSetting(db, 'meta', { ...(await getSetting(db, 'meta')), adAccountId: list[0].adAccountId, adAccountIds: list.map((x) => x.adAccountId), hasToken: true });
    await put(db, SOCIAL_KEYS.ads, { linkId: a.linkId, assetId: a.assetId, adAccountId: list[0].adAccountId, name: list[0].name, currency: list[0].currency, accounts: list, account: a.account, at });
  } else {
    const list = (a.accounts?.length ? a.accounts : [{ extId: a.extId, name: a.name, currency: null }]).map((x) => ({ advertiserId: x.extId, name: x.name }));
    await put(db, SOCIAL_KEYS.tiktokAdsToken, a.token);
    await put(db, SOCIAL_KEYS.tiktokAds, { linkId: a.linkId, assetId: a.assetId, advertiserId: list[0].advertiserId, name: list[0].name, advertisers: list, account: a.account, at });
  }
}
async function clearShop(db: Db, kind: AssetKind) {
  if (kind === 'page') {
    await drop(db, [SOCIAL_KEYS.pageToken, SOCIAL_KEYS.page]);
    const d = await raw(db, 'dellal');
    if (d) await put(db, 'dellal', { ...d, messengerPageId: '', instagramId: '' });
  } else if (kind === 'ad_account') {
    await drop(db, [SOCIAL_KEYS.adsToken, SOCIAL_KEYS.ads]);
    await setSetting(db, 'meta', { ...(await getSetting(db, 'meta')), adAccountId: '', adAccountIds: [], hasToken: false });
  } else await drop(db, [SOCIAL_KEYS.tiktokAdsToken, SOCIAL_KEYS.tiktokAds]);
}

/** The Page this boutique answers on (Pilot Message and Pilot Comments show it), from its linked account. */
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
/** The ad accounts this boutique counts, from its linked account (Réglages › Meta shows them): the first, and how many. */
export async function linkedAds(db: Db): Promise<{ adAccountId: string; name: string; account: string; count: number } | null> {
  const v = await raw(db, SOCIAL_KEYS.ads);
  return v?.adAccountId ? { adAccountId: String(v.adAccountId), name: String(v.name ?? ''), account: String(v.account ?? ''), count: Array.isArray(v.accounts) && v.accounts.length ? v.accounts.length : 1 } : null;
}

// ---------------------------------------------------------------- Meta's webhook: each Page's events to its boutique
/**
 * Meta sends every Page's messages and comments to one address (Pilotix's app): each entry goes to the boutique that uses
 * its Page (an Instagram entry: the boutique whose Page has this Instagram account). Entries of a Page nobody uses are
 * dropped.
 */
/** A customer's new comment in a webhook entry: a Page post's comment (feed) or an Instagram comment, not the account's own. */
function customerComment(obj: string, entry: any, id: string): boolean {
  const ch: any[] = Array.isArray(entry?.changes) ? entry.changes : [];
  return ch.some((c) => {
    const v = c?.value ?? {};
    const from = String(v.from?.id ?? '');
    if (obj === 'page') return c?.field === 'feed' && v.item === 'comment' && v.verb === 'add' && from !== id;
    return c?.field === 'comments' && from !== id;
  });
}

/** What one webhook entry was: a customer's message, « standby » (another app has the conversation), an echo, a read… */
function hookWhat(entry: any): string {
  const ms: any[] = Array.isArray(entry?.messaging) ? entry.messaging : [];
  if (ms.some((m) => m?.message && !m.message.is_echo)) return 'message';
  if (Array.isArray(entry?.standby) && entry.standby.length) return 'standby';
  const m = ms[0];
  if (m) return m.message?.is_echo ? 'echo' : m.read ? 'read' : m.reaction ? 'reaction' : m.postback ? 'postback' : 'event';
  if (Array.isArray(entry?.changes) && entry.changes[0]) return `change:${String(entry.changes[0].field ?? '')}`.slice(0, 40);
  return 'event';
}

/** When Meta last sent something for a Page / Instagram account / WhatsApp number, what it was, and whether a boutique took it (« Tester »). */
async function noteHook(t: Tenancy, obj: string, id: string, routed: boolean, what: string, comment: boolean) {
  await t.platform
    .query(
      `INSERT INTO platform.social_hooks (object, ext_id, at, routed, what, message_at, comment_at)
         VALUES ($1, $2, now(), $3, $4, CASE WHEN $5::boolean THEN now() END, CASE WHEN $6::boolean THEN now() END)
       ON CONFLICT (object, ext_id) DO UPDATE SET at = now(), routed = EXCLUDED.routed, what = EXCLUDED.what,
         message_at = coalesce(EXCLUDED.message_at, platform.social_hooks.message_at), comment_at = coalesce(EXCLUDED.comment_at, platform.social_hooks.comment_at)`,
      [obj, id, routed, what, what === 'message', comment],
    )
    .catch(() => undefined);
}

export async function routeMeta(t: Tenancy, body: any): Promise<{ shopId: number; body: any }[]> {
  const obj = body?.object;
  // WhatsApp (« Connecter WhatsApp »): each number's messages and delivery statuses go to the boutique that connected it
  if (obj === 'whatsapp_business_account') {
    const byShop = new Map<number, any[]>();
    for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
      const mine = new Map<number, any[]>();
      for (const ch of Array.isArray(entry?.changes) ? entry.changes : []) {
        const v = ch?.value ?? {};
        const phoneId = String(v.metadata?.phone_number_id ?? '');
        if (!/^\d{1,30}$/.test(phoneId)) continue;
        const shop = await waLoginShop(t, phoneId);
        const what = Array.isArray(v.messages) && v.messages.length ? 'message' : Array.isArray(v.statuses) && v.statuses.length ? 'status' : `change:${String(ch?.field ?? '')}`.slice(0, 40);
        await noteHook(t, obj, phoneId, !!shop, what, false);
        if (shop) mine.set(shop, [...(mine.get(shop) ?? []), ch]);
      }
      // a boutique gets only its own number's changes
      for (const [shop, changes] of mine) byShop.set(shop, [...(byShop.get(shop) ?? []), { ...entry, changes }]);
    }
    return [...byShop].map(([shopId, entry]) => ({ shopId, body: { object: obj, entry } }));
  }
  // an ad account's webhook (ad rejected, problem…): the boutique that uses this ad account (Co-Pilot warns there)
  if (obj === 'ad_account') {
    const byShop = new Map<number, any[]>();
    for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
      const id = String(entry?.id ?? '').replace(/^act_/, '');
      if (!/^\d{1,30}$/.test(id)) continue;
      for (const r of await t.platform.query(`SELECT shop_id FROM platform.social_uses WHERE kind = 'ad_account' AND ext_id = $1`, [id])) {
        const s = num(r.shop_id);
        byShop.set(s, [...(byShop.get(s) ?? []), entry]);
      }
    }
    return [...byShop].map(([shopId, entry]) => ({ shopId, body: { object: obj, entry } }));
  }
  if (obj !== 'page' && obj !== 'instagram') return [];
  const byShop = new Map<number, any[]>();
  for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
    const id = entry?.id ? String(entry.id) : '';
    if (!id) continue;
    let r = (await t.platform.query(obj === 'page' ? `SELECT shop_id FROM platform.social_uses WHERE kind = 'page' AND ext_id = $1` : `SELECT shop_id FROM platform.social_uses WHERE kind = 'page' AND ig_id = $1`, [id]))[0];
    // an Instagram account linked with Instagram's own login (its webhooks may give it another number)
    if (!r && obj === 'instagram') {
      const shop = await igLoginShop(t, id);
      if (shop) r = { shop_id: shop };
    }
    // when Meta last sent something for this Page / Instagram account, what it was, and whether a boutique took it (« Tester »)
    await noteHook(t, obj, id, !!r, hookWhat(entry), customerComment(obj, entry, id));
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
  /** all the ad accounts of one linked account: the first one's name, how many */
  ad_account: { name: string; account: string; count: number } | null;
  advertiser: { name: string; account: string; count: number } | null;
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
  if (!live(ctx)) return demoList(ctx);
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
  // ad accounts go together: a boutique counting one of an account's ad accounts counts them all
  const usersOfAds = (linkId: number, kind: string) => {
    const ids = new Set(assets.filter((a: any) => num(a.link_id) === linkId && a.kind === kind).map((a: any) => num(a.id)));
    const byShop = new Map<number, { id: number; name: string }>();
    for (const u of uses) if (ids.has(num(u.asset_id))) byShop.set(num(u.shop_id), { id: num(u.shop_id), name: String(u.name) });
    return [...byShop.values()];
  };
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
    assets: assets.filter((a: any) => num(a.link_id) === num(l.id)).map((a: any) => assetView(a, w.shopId, isAdKind(a.kind) ? usersOfAds(num(l.id), a.kind) : usersOf(num(a.id)))),
  }));
  // A boutique that counted one ad account before they all went together: written again with all of its account's (once,
  // when this page opens), so Publicité adds them up as the page says.
  for (const kind of AD_KINDS) {
    const mine = uses.find((u: any) => num(u.shop_id) === w.shopId && assets.find((a: any) => num(a.id) === num(u.asset_id))?.kind === kind);
    if (!mine) continue;
    const linkId = num(assets.find((a: any) => num(a.id) === num(mine.asset_id)).link_id);
    const all = assets.filter((a: any) => num(a.link_id) === linkId && a.kind === kind).length;
    const written = kind === 'ad_account' ? ((await getSetting(ctx.db, 'meta')).adAccountIds?.length ?? 0) : (((await raw(ctx.db, SOCIAL_KEYS.tiktokAds)) as any)?.advertisers?.length ?? 0);
    if (written !== all) await writeUse(w.t, w.shopId, num(mine.asset_id));
  }
  const name = String((await w.t.platform.query(`SELECT name FROM platform.shops WHERE id = $1`, [w.shopId]))[0]?.name ?? '');
  return { apps: { meta: appReady(apps, 'meta'), tiktok: appReady(apps, 'tiktok') }, canAll: canAll(w), isOwner: w.isOwner, shop: { id: w.shopId, name }, sisters: w.sisters, links: view, here: hereOf(view), preview: false };
}
function hereOf(links: LinkView[]): HereView {
  const find = (kind: AssetKind) => {
    for (const l of links) for (const a of l.assets) if (a.kind === kind && a.usedHere) return { a, l };
    return null;
  };
  const p = find('page');
  const ads = (kind: AssetKind) => {
    const f = find(kind);
    return f ? { name: f.a.name, account: f.l.name, count: f.l.assets.filter((a) => a.kind === kind && a.usedHere).length } : null;
  };
  return {
    page: p ? { name: p.a.name, igUsername: p.a.igUsername, account: p.l.name } : null,
    ad_account: ads('ad_account'),
    advertiser: ads('advertiser'),
  };
}

/** A link of this boutique, or of all the owner's boutiques. */
async function visibleLink(w: Who, linkId: number) {
  const l = (await w.t.platform.query(`SELECT * FROM platform.social_links WHERE id = $1`, [linkId]))[0];
  if (!l || !(num(l.shop_id) === w.shopId || (l.shop_id === null && w.ownerId > 0 && num(l.owner_id) === w.ownerId))) throw new AppError('not_found', 'Compte introuvable');
  return l;
}

/**
 * The browser preview (no server): a sample account, kept in the page. Its demo boutiques have a platform too (« Mes
 * boutiques »), so the server's hooks tell them apart, as in the other modules.
 */
type LiveCtx = Ctx & { t: Tenancy; shop: NonNullable<Ctx['shop']>; server: NonNullable<Ctx['server']> };
const live = (ctx: Ctx): ctx is LiveCtx => !!ctx.server && !!ctx.t && !!ctx.shop;
const id = z.number().int().positive();
export const socialProcs = {
  /** The boutique's linked accounts, what each may use, what this boutique uses. */
  'social.list': proc([], z.object({}), (ctx) => listFor(ctx)),

  /** A login starts: its address (opened in a new tab) and its state (the page asks it until the tab is back). */
  'social.start': proc(
    [],
    z.object({
      provider: z.enum(SOCIAL_PROVIDERS),
      scope: z.enum(['here', 'all']).default('here'),
      kind: z.enum(['account', 'instagram', 'whatsapp']).default('account'),
    }),
    async (ctx, i) => {
      if (!live(ctx)) return demoStart(ctx, i.provider, i.scope, i.kind);
      // « Connecter Instagram » / « Connecter WhatsApp »: Facebook's login with their own configuration, for this boutique only
      const ig = i.kind === 'instagram';
      const wa = i.kind === 'whatsapp';
      if (ig && i.provider !== 'meta') throw new AppError('bad_request', 'Seul Meta connecte Instagram.');
      if (wa && i.provider !== 'meta') throw new AppError('bad_request', 'Seul Meta connecte WhatsApp.');
      const w = await who(ctx);
      if (i.scope === 'all' && !canAll(w)) throw new AppError('forbidden', 'Seul le propriétaire des boutiques lie un compte pour toutes ses boutiques.');
      const apps = await socialApps(w.t);
      if (ig && !apps.meta.igConfigId)
        throw new AppError('bad_request', 'La connexion Instagram n’est pas encore prête : Pilotix doit d’abord ajouter l’ID de configuration Instagram (Pilot AI › Réglages).');
      if (wa && !apps.meta.waConfigId)
        throw new AppError('bad_request', 'La connexion WhatsApp n’est pas encore prête : Pilotix doit d’abord ajouter l’ID de configuration WhatsApp (Pilot AI › Réglages).');
      if (!appReady(apps, i.provider))
        throw new AppError(
          'bad_request',
          i.provider === 'meta'
            ? 'La connexion Facebook n’est pas encore prête : Pilotix doit d’abord ajouter son app Meta.'
            : 'La connexion TikTok n’est pas encore prête : Pilotix doit d’abord ajouter son app TikTok.',
        );
      const publicUrl = ctx.server?.publicUrl;
      if (!publicUrl) throw new AppError('bad_request', 'L’adresse publique du serveur manque (PUBLIC_URL).');
      const state = (ig ? IG_STATE : wa ? WA_STATE : '') + randomToken();
      await w.t.platform.query(`DELETE FROM platform.social_states WHERE expires_at < now() - interval '1 day'`);
      await w.t.platform.query(
        `INSERT INTO platform.social_states (state, provider, owner_id, shop_id, from_shop, by_name, expires_at) VALUES ($1, $2, $3, $4, $5, $6, now() + interval '${SOCIAL.stateMinutes} minutes')`,
        [state, i.provider, w.ownerId, i.scope === 'all' && !ig && !wa ? null : w.shopId, w.shopId, w.by.slice(0, 120)],
      );
      return {
        state,
        url: loginUrl(apps, i.provider, state, publicUrl, i.kind) as string | null,
      };
    },
  ),

  /**
   * What Meta's popup needs for « Connecter WhatsApp » (JavaScript SDK, the way Meta asks Embedded Signup to open):
   * read before the click, so the popup opens on the click itself (a popup opened later is blocked by browsers).
   * Null while Pilotix's WhatsApp configuration is not ready (the button then says why, as before).
   */
  'social.waSdk': proc([], z.object({}), async (ctx) => {
    if (!live(ctx)) return null;
    const apps = await socialApps(ctx.t);
    if (!apps.meta.appId || !apps.meta.waConfigId) return null;
    return { appId: apps.meta.appId, configId: apps.meta.waConfigId, version: SOCIAL.graphVersion, extras: WA_EXTRAS };
  }),

  /**
   * « Connecter WhatsApp » came back in Meta's popup: its code and what Meta's window said (the WhatsApp Business account
   * and the number). The server checks them against what the key was given and links the number to this boutique.
   */
  'social.waFinish': proc(
    [],
    z.object({
      state: z.string().min(8).max(100),
      code: z.string().trim().min(10).max(2000),
      wabaId: z.string().regex(/^\d{1,30}$/).nullish(),
      phoneId: z.string().regex(/^\d{1,30}$/).nullish(),
    }),
    async (ctx, i) => {
      if (!live(ctx)) return { ok: true, message: 'WhatsApp connecté', account: '+213 550 11 22 33' };
      if (!ctx.server.social) throw new AppError('bad_request', 'La connexion WhatsApp se fait sur le serveur de Pilotix.');
      const r = (await ctx.server.social('waFinish', { ...i, shopId: ctx.shop.id }, ctx)) as { ok: boolean; message: string; account?: string; warn?: string };
      if (!r.ok) throw new AppError('bad_request', r.message);
      ctx.emit({ type: 'settings' });
      return r;
    },
  ),

  /** Where a login is: waiting for its tab, done (its account is in the list), failed or too old. */
  'social.state': proc([], z.object({ state: z.string().min(8).max(100) }), async (ctx, i) => {
    if (!live(ctx)) return demoState(ctx, i.state);
    const r = (await ctx.t.platform.query(`SELECT done_at, error, link_id, found_at, expires_at < now() AS expired FROM platform.social_states WHERE state = $1 AND from_shop = $2`, [i.state, ctx.shop.id]))[0];
    if (!r) throw new AppError('not_found', 'Connexion introuvable');
    // confirm: the account is back, its tab asks « Oui, c'est ma boutique ? »
    const status: 'waiting' | 'confirm' | 'done' | 'error' | 'expired' = r.done_at ? (r.error ? 'error' : 'done') : r.expired ? 'expired' : r.found_at ? 'confirm' : 'waiting';
    return { status, error: r.error ? String(r.error) : null, linkId: r.link_id === null ? null : num(r.link_id) };
  }),

  /** This boutique answers on this Page / counts this ad account's linked account, all its ad accounts (one click). */
  'social.use': proc([], z.object({ assetId: id }), async (ctx, i) => {
    if (!live(ctx)) return demoUse(ctx, i.assetId);
    const w = await who(ctx);
    await useAsset(w.t, w.shopId, i.assetId, w.by);
    ctx.emit({ type: 'settings' });
    return listFor(ctx);
  }),

  /** This boutique stops using its Page / ad account / TikTok ad account. */
  'social.unuse': proc([], z.object({ kind: z.enum(ASSET_KINDS) }), async (ctx, i) => {
    if (!live(ctx)) return demoUnuse(ctx, i.kind);
    await stopUse(ctx.t, ctx.shop.id, i.kind);
    ctx.emit({ type: 'settings' });
    return listFor(ctx);
  }),

  /** This boutique counts every ad account of this linked account (Publicité adds them up), or stops counting them. */
  'social.ads': proc([], z.object({ linkId: id, on: z.boolean() }), async (ctx, i) => {
    if (!live(ctx)) return demoAds(ctx, i.linkId, i.on);
    const w = await who(ctx);
    const l = await visibleLink(w, i.linkId);
    const kind = adKindOf(l.provider);
    if (i.on) {
      const first = (await w.t.platform.query(`SELECT id FROM platform.social_assets WHERE link_id = $1 AND kind = $2 ORDER BY id LIMIT 1`, [i.linkId, kind]))[0];
      if (!first) throw new AppError('bad_request', 'Ce compte n’a pas de compte pub.');
      await useAsset(w.t, w.shopId, num(first.id), w.by);
    } else {
      const mine = (await w.t.platform.query(`SELECT 1 FROM platform.social_uses u JOIN platform.social_assets a ON a.id = u.asset_id WHERE u.shop_id = $1 AND u.kind = $2 AND a.link_id = $3`, [w.shopId, kind, i.linkId]))[0];
      if (mine) await stopUse(w.t, w.shopId, kind);
    }
    ctx.emit({ type: 'settings' });
    return listFor(ctx);
  }),

  /**
   * « Tester »: tries the account now, on the server — its key, its permissions, the Page this boutique uses (subscribed
   * again when its messages no longer come), its Instagram account, Pilotix's Meta webhook (its address and fields, and
   * that it answers from the Internet), the ad accounts this boutique counts. Each line says how it went.
   */
  'social.test': proc([], z.object({ linkId: id }), async (ctx, i): Promise<SocialTest> => {
    if (!live(ctx)) return demoTest(ctx, i.linkId);
    const w = await who(ctx);
    await visibleLink(w, i.linkId);
    if (!ctx.server?.social) throw new AppError('bad_request', 'Le test se fait sur le serveur de Pilotix.');
    const r = (await ctx.server.social('test', { linkId: i.linkId, shopId: w.shopId }, ctx)) as SocialTest;
    // a Page subscribed again, a key refused: the list shows it
    ctx.emit({ type: 'settings' });
    return r;
  }),

  /** For this boutique only, or for all the owner's boutiques (the owner only). */
  'social.scope': proc([], z.object({ linkId: id, scope: z.enum(['here', 'all']) }), async (ctx, i) => {
    if (!live(ctx)) return demoScope(ctx, i.linkId, i.scope);
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
    if (!live(ctx)) return demoRemove(ctx, i.linkId);
    const w = await who(ctx);
    const l = await visibleLink(w, i.linkId);
    if (l.shop_id === null && !w.isOwner) throw new AppError('forbidden', 'Ce compte sert à toutes les boutiques : seul leur propriétaire le retire.');
    await removeLink(w.t, i.linkId);
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
let demo: { links: DemoLink[]; next: number; states: Map<string, { at: number; provider: SocialProvider; scope: 'here' | 'all'; kind?: LoginKind; linkId: number | null }> } | null = null;
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
        // a real account often manages many Pages (each boutique picks one) and several ad accounts (all counted)
        assets: [
          { id: 11, kind: 'page', extId: '104920331', name: 'Bébé Confort DZ', igUsername: 'bebeconfort.dz', currency: null, usedBy: [me] },
          { id: 12, kind: 'page', extId: '104920332', name: 'Bébé Confort Oran', igUsername: null, currency: null, usedBy: [DEMO_SISTER.id] },
          { id: 14, kind: 'page', extId: '104920334', name: 'Bébé Confort Annaba', igUsername: null, currency: null, usedBy: [] },
          { id: 15, kind: 'page', extId: '104920335', name: 'Jouets Kids DZ', igUsername: 'jouetskids.dz', currency: null, usedBy: [] },
          { id: 16, kind: 'page', extId: '104920336', name: 'Maman & Bébé Alger', igUsername: null, currency: null, usedBy: [] },
          { id: 17, kind: 'page', extId: '104920337', name: 'Poussettes Pro', igUsername: null, currency: null, usedBy: [] },
          { id: 18, kind: 'page', extId: '104920338', name: 'Le coin des mamans', igUsername: 'lecoindesmamans', currency: null, usedBy: [] },
          { id: 19, kind: 'page', extId: '104920339', name: 'Petits Pas DZ', igUsername: null, currency: null, usedBy: [] },
          { id: 20, kind: 'page', extId: '104920340', name: 'Doudou Store', igUsername: null, currency: null, usedBy: [] },
          { id: 21, kind: 'page', extId: '104920341', name: 'Bébé Shop Sétif', igUsername: null, currency: null, usedBy: [] },
          { id: 13, kind: 'ad_account', extId: '120211887', name: 'Bébé Confort — publicité', igUsername: null, currency: 'USD', usedBy: [me, DEMO_SISTER.id] },
          { id: 22, kind: 'ad_account', extId: '120211888', name: 'Bébé Confort — tests', igUsername: null, currency: 'USD', usedBy: [me, DEMO_SISTER.id] },
          { id: 23, kind: 'ad_account', extId: '120211889', name: 'Promo Ramadan', igUsername: null, currency: 'USD', usedBy: [me, DEMO_SISTER.id] },
          { id: 24, kind: 'ad_account', extId: '120211890', name: 'Ancien compte (lecture seule)', igUsername: null, currency: 'USD', usedBy: [me, DEMO_SISTER.id] },
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
async function demoStart(ctx: Ctx, provider: SocialProvider, scope: 'here' | 'all', kind: LoginKind = 'account') {
  const d = demoData(ctx);
  const state = `demo-${d.next++}`;
  d.states.set(state, { at: ctx.now(), provider, scope, kind, linkId: null });
  return { state, url: null as string | null };
}
/** In the preview the « login » takes two seconds, then a sample account is linked. */
async function demoState(ctx: Ctx, state: string) {
  const d = demoData(ctx);
  const s = d.states.get(state);
  if (!s) throw new AppError('not_found', 'Connexion introuvable');
  if (s.linkId === null && ctx.now() - s.at < 2000) return { status: 'waiting' as const, error: null, linkId: null };
  // « Connecter WhatsApp »: a sample number, connected to Pilot Message (a preview sends nothing)
  if (s.kind === 'whatsapp') {
    const cur = (await raw(ctx.db, 'dellal')) ?? {};
    await put(ctx.db, 'secret_dellal_wa_token', 'preview');
    await put(ctx.db, 'dellal', { ...cur, whatsappPhoneId: '106540352242922', whatsappPhone: '+213 550 11 22 33' });
    return { status: 'done' as const, error: null, linkId: null };
  }
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
  // a Page alone; ad accounts all together (those of the same linked account)
  const together = isAdKind(a.kind) ? l.assets.filter((x) => x.kind === a.kind) : [a];
  for (const x of together) x.usedBy.push(me);
  await applyShop(ctx.db, {
    kind: a.kind,
    linkId: l.id,
    assetId: a.id,
    extId: a.extId,
    name: a.name,
    extra: a.igUsername ? { ig: { id: `1784${a.extId}`, username: a.igUsername } } : a.currency ? { currency: a.currency } : {},
    account: l.name,
    token: 'preview',
    accounts: isAdKind(a.kind) ? together.map((x) => ({ extId: x.extId, name: x.name, currency: x.currency })) : undefined,
  });
}
async function demoAds(ctx: Ctx, linkId: number, on: boolean) {
  const d = demoData(ctx);
  const me = demoShop(ctx);
  const l = d.links.find((x) => x.id === linkId);
  if (!l) throw new AppError('not_found', 'Compte introuvable');
  const kind = adKindOf(l.provider);
  const mine = l.assets.filter((a) => a.kind === kind);
  if (on) {
    if (!mine[0]) throw new AppError('bad_request', 'Ce compte n’a pas de compte pub.');
    await demoUseOne(ctx, d, me, mine[0].id);
  } else if (mine.some((a) => a.usedBy.includes(me))) {
    for (const a of mine) a.usedBy = a.usedBy.filter((x) => x !== me);
    await clearShop(ctx.db, kind);
  }
  return demoList(ctx);
}
/** The preview's « Tester »: what a working account answers (its Instagram webhook still to subscribe, as often at first). */
async function demoTest(ctx: Ctx, linkId: number): Promise<SocialTest> {
  const me = demoShop(ctx);
  const l = demoData(ctx).links.find((x) => x.id === linkId);
  if (!l) throw new AppError('not_found', 'Compte introuvable');
  const checks: SocialCheck[] = [{ key: 'token', state: 'ok', params: { name: l.name } }];
  const kind = adKindOf(l.provider);
  if (l.provider === 'meta') {
    checks.push({ key: 'perms', state: 'ok' });
    const page = l.assets.find((a) => a.kind === 'page' && a.usedBy.includes(me));
    if (page) {
      const ago = (min: number) => new Date(ctx.now() - min * 60_000).toISOString();
      checks.push({ key: 'page', state: 'ok', params: { name: page.name } }, { key: 'pageHook', state: 'ok' }, { key: 'fbComment', state: 'ok', params: { name: page.name, at: ago(40) } });
      if (page.igUsername)
        checks.push(
          { key: 'ig', state: 'ok', params: { username: page.igUsername } },
          { key: 'igInbox', state: 'ok', params: { username: page.igUsername } },
          { key: 'igSeen', state: 'ok', params: { username: page.igUsername, at: ago(25) } },
          { key: 'igComment', state: 'ok', params: { username: page.igUsername, at: ago(120) } },
          { key: 'catchUp', state: 'ok', params: { at: ago(2), count: 1 } },
          { key: 'igLogin', state: 'ok', params: { username: page.igUsername } },
        );
      else checks.push({ key: 'igNone', state: 'warn', params: { name: page.name } });
    } else if (l.assets.some((a) => a.kind === 'page')) checks.push({ key: 'pageNone', state: 'warn' });
    checks.push({ key: 'appHook', state: 'ok' }, { key: 'appHookIg', state: 'warn', params: { list: 'messages, comments' } }, { key: 'reach', state: 'ok' });
  }
  const ads = l.assets.filter((a) => a.kind === kind);
  if (ads.some((a) => a.usedBy.includes(me))) checks.push({ key: 'ads', state: 'ok', params: { count: ads.length, bad: 0 } });
  return { at: new Date(ctx.now()).toISOString(), checks };
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
/**
 * The browser preview's boutique uses its sample account's Page and ad account from the start (Pilot Message ›
 * Réglages shows the Page): written once by the page (lib/backend.ts), never on a server.
 */
export async function seedSocialPreview(db: Db, now = Date.now()) {
  const at = new Date(now).toISOString();
  await db.query(`INSERT INTO settings (key, value) VALUES ($1, $2), ($3, $4) ON CONFLICT (key) DO NOTHING`, [
    SOCIAL_KEYS.page,
    JSON.stringify({ linkId: 1, assetId: 11, pageId: '104920331', name: 'Bébé Confort DZ', igId: '1784104920331', igUsername: 'bebeconfort.dz', picture: null, account: 'Alaeddine Benali', at }),
    SOCIAL_KEYS.ads,
    JSON.stringify({
      linkId: 1,
      assetId: 13,
      adAccountId: '120211887',
      name: 'Bébé Confort — publicité',
      currency: 'USD',
      accounts: [
        { adAccountId: '120211887', name: 'Bébé Confort — publicité', currency: 'USD' },
        { adAccountId: '120211888', name: 'Bébé Confort — tests', currency: 'USD' },
        { adAccountId: '120211889', name: 'Promo Ramadan', currency: 'USD' },
        { adAccountId: '120211890', name: 'Ancien compte (lecture seule)', currency: 'USD' },
      ],
      account: 'Alaeddine Benali',
      at,
    }),
  ]);
}

/** Tests: the preview's sample account from scratch. */
export const resetSocialDemo = () => {
  demo = null;
};
