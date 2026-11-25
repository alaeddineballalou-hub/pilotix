// Phone / computer notifications (Web Push). A person accepts them on a device (« Activer les notifications »): the
// device is kept; the server sends a notification there even when the app is closed or the phone is locked.
// The Pilotix Android app has no Web Push (its WebView has none): its phones are told through Firebase (server.fcm),
// each saved as « fcm:<token> » in the same table, so its bell, its tests and « Bloquer jusqu'à l'appel » work alike.
import { z } from 'zod';
import type { Language } from '@pilotix/shared';
import { Db, num } from '../db';
import { membershipsOf } from '../platform/accounts';
import { bad, Ctx, proc, publicApi, ServerHooks } from '../rpc';
import { getSetting } from '../settings';
import { kindOfTag, ringBell } from './bell';

function notificationBrand(slug: string | undefined, payload: Record<string, unknown>) {
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) return payload;
  return { ...payload, workspace: slug };
}

/** A shop's key pair (made once, when the server can). */
async function keysOf(db: Db, server: ServerHooks | undefined) {
  const k = (await db.query('SELECT public_key, private_key FROM push_keys WHERE id = 1'))[0];
  if (k) return { publicKey: k.public_key as string, privateKey: k.private_key as string };
  if (!server?.pushKeys) return null;
  const made = server.pushKeys();
  await db.query('INSERT INTO push_keys (id, public_key, private_key) VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING', [made.publicKey, made.privateKey]);
  const again = (await db.query('SELECT public_key, private_key FROM push_keys WHERE id = 1'))[0];
  return { publicKey: again.public_key as string, privateKey: again.private_key as string };
}
const keys = (ctx: Ctx) => keysOf(ctx.db, ctx.server);

type Sub = { endpoint: string; p256dh: string; auth: string };
type Keys = { publicKey: string; privateKey: string };

// ---------------------------------------------------------------- the Pilotix Android app (Firebase)
/** An app phone's address: « fcm: » and the token Firebase gave the app (mobile/…/PilotixPushPlugin.java). */
export const APP_PREFIX = 'fcm:';
const APP_TOKEN = /^fcm:[A-Za-z0-9_:-]{20,900}$/;
export const appEndpoint = (endpoint: string) => APP_TOKEN.test(endpoint);
/** what an app phone keeps in the browser keys' places (the table needs them; Firebase has none) */
const APP_KEY = 'pilotix-app';

/**
 * The Firebase message for one app phone: data only, so the app draws the notification itself (the ring of « alarm », the
 * order's page on a tap, nothing on top of Pilotix open on its screen for « conf »); high priority, so it wakes a sleeping
 * phone; kept 2 minutes, like the browsers' (TTL 120). Every value is text, as Firebase wants.
 */
export function fcmMessage(token: string, payload: Record<string, unknown>) {
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined || v === null || v === false || v === '') continue;
    data[k] = typeof v === 'string' ? v : v === true ? '1' : typeof v === 'number' ? String(v) : JSON.stringify(v);
  }
  return { message: { token, data, android: { priority: 'HIGH', ttl: '120s' } } };
}

/**
 * Firebase's answer for one phone: gone (the app was removed or its token changed: the phone is forgotten), or kept
 * (Firebase or Google busy, the server's key refused or from another project: the next message tries again — a wrong key
 * on the server never makes every phone forgotten).
 */
export function fcmGone(status: number, body: unknown): boolean {
  const err = (body as { error?: { status?: unknown; message?: unknown; details?: unknown } } | null)?.error;
  const codes = [err?.status, ...(Array.isArray(err?.details) ? err.details.map((d: { errorCode?: unknown }) => d?.errorCode) : [])].map(String);
  if (codes.includes('SENDER_ID_MISMATCH')) return false;
  if (status === 404 || codes.includes('UNREGISTERED')) return true;
  // a token Firebase does not know at all (not a message it refused for its content)
  return status === 400 && codes.includes('INVALID_ARGUMENT') && /registration token/i.test(String(err?.message ?? ''));
}

/**
 * Sends to these devices of one shop: browsers with the shop's keys (Web Push), the app's phones through Firebase; forgets
 * the ones that are gone. `seen`: sent already.
 */
async function deliver(db: Db, server: ServerHooks, k: Keys | null, subs: Sub[], payload: Record<string, unknown>, seen: Set<string>) {
  // only a browser's push service or an app phone (a device saved before that rule with another address is skipped)
  const web = (x: Sub) => !!k && !!server.push && pushServiceUrl(x.endpoint);
  const app = (x: Sub) => !!server.fcm && appEndpoint(x.endpoint);
  const fresh = subs.filter((x) => !seen.has(x.endpoint) && (web(x) || app(x)));
  if (!fresh.length) return 0;
  fresh.forEach((x) => seen.add(x.endpoint));
  const browsers = fresh.filter(web);
  const phones = fresh.filter(app);
  const r = [
    ...(browsers.length ? await server.push!(k!, browsers.map((x) => ({ endpoint: x.endpoint, p256dh: x.p256dh, auth: x.auth })), payload) : []),
    ...(phones.length
      ? (await server.fcm!(phones.map((x) => x.endpoint.slice(APP_PREFIX.length)), payload)).map((x) => ({ endpoint: APP_PREFIX + x.token, ok: x.ok, gone: x.gone }))
      : []),
  ];
  const gone = r.filter((x) => x.gone).map((x) => x.endpoint);
  const ok = r.filter((x) => x.ok).map((x) => x.endpoint);
  if (gone.length) await db.query('DELETE FROM push_subs WHERE endpoint = ANY($1)', [gone]);
  if (ok.length) await db.query('UPDATE push_subs SET last_ok_at = now() WHERE endpoint = ANY($1)', [ok]);
  return ok.length;
}

/**
 * The same people's devices turned on in their other boutiques (a device signs up in one boutique, with its keys):
 * told too, the name of the boutique first — someone working in two boutiques misses nothing of either.
 */
async function pushElsewhere(ctx: Ctx, profileIds: number[], payload: Record<string, unknown>, seen: Set<string>, o: { phones?: boolean } = {}) {
  const t = ctx.t!;
  const mails = [...new Set((await ctx.db.query('SELECT lower(email) AS e FROM profiles WHERE id = ANY($1) AND active', [profileIds])).map((r: any) => String(r.e ?? '')).filter(Boolean))];
  if (!mails.length) return 0;
  const name = String((await getSetting(ctx.db, 'shop')).name ?? '').trim();
  const tagged = { ...payload, title: name ? `${name} · ${String(payload.title ?? '')}` : payload.title };
  let sent = 0;
  for (const e of mails)
    for (const m of await membershipsOf(t, e)) {
      if (m.shopId === ctx.shop!.id || m.agencyId) continue;
      const db = t.shop(m.schema);
      // no keys there: its app phones are still told (Firebase needs none)
      const k = await keysOf(db, ctx.server);
      const subs = await db.query(`SELECT endpoint, p256dh, auth FROM push_subs WHERE profile_id = $1${o.phones ? ` AND ${phoneSql()}` : ''}`, [m.profileId]);
      sent += await deliver(db, ctx.server!, k, subs as Sub[], notificationBrand(ctx.shop?.slug, tagged), seen);
    }
  return sent;
}

/**
 * Sends a notification to every device of these people and writes it in their bell (the evening report, the slow queue,
 * the depot's red alerts… are also at the top of their pages). Returns how many devices got it.
 */
export async function sendPush(ctx: Ctx, profileIds: number[], payload: Record<string, unknown>) {
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  await ringBell(
    ctx,
    profileIds,
    () => ({ kind: kindOfTag(payload.tag), title: text(payload.title) || 'Pilotix', body: text(payload.body), url: text(payload.url) || null, important: !!payload.alarm }),
    { tag: text(payload.tag) || null },
  ).catch(() => []);
  return pushOnly(ctx, profileIds, payload);
}

/**
 * Without a line in the bell (the bell's own notifications write their line themselves: inbox.ts). `phones`: only the
 * person's phones and tablets (« Bloquer jusqu'à l'appel » rings the phone, never the computer). Forgets the devices that
 * unsubscribed.
 */
export async function pushOnly(ctx: Ctx, profileIds: number[], payload: Record<string, unknown>, o: { phones?: boolean } = {}) {
  if (!profileIds.length || !canPush(ctx.server)) return 0;
  const people = (await ctx.db.query('SELECT id FROM profiles WHERE active AND agency_id IS NULL AND id = ANY($1)', [profileIds])).map((p) => num(p.id));
  if (!people.length) return 0;
  const seen = new Set<string>();
  const store = ctx.t && ctx.shop && (ctx.shop.kind ?? 'store') === 'store' ? ctx.shop : null;
  let sent = 0;
  const k = await keys(ctx);
  const subs = await ctx.db.query(`SELECT endpoint, p256dh, auth FROM push_subs WHERE profile_id = ANY($1)${o.phones ? ` AND ${phoneSql()}` : ''}`, [people]);
  sent += await deliver(ctx.db, ctx.server!, k, subs as Sub[], notificationBrand(ctx.shop?.slug, payload), seen);
  // a store on a server with several shops: the same people in their other boutiques
  if (store) sent += await pushElsewhere(ctx, people, payload, seen, o).catch(() => 0);
  return sent;
}

/**
 * A phone or a tablet: the browser that turned notifications on said so in its user agent (push_subs.ua, saved by
 * « Activer les notifications »: Android, iPhone, iPad…). The same test as the web app's lib/push.ts › phoneDevice.
 */
export const phoneSql = (col = 'ua') => `${col} ~* '(android|iphone|ipad|ipod|mobile)'`;

/** This server can send notifications: to browsers (Web Push), to the app's phones (Firebase), or both. */
export const canPush = (server: Pick<ServerHooks, 'push' | 'fcm'> | undefined) => !!(server?.push || server?.fcm);

/** A one-time code (32 hex): the phone's worker sends it back when the notification arrives. */
const ackCode = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * « Bloquer jusqu'à l'appel »: rings these phones (push_subs rows of phones), each notification with the address its
 * worker (sw.js) calls back on arrival — /api[/s/<shop>]/push/ack/<code>. While one is not answered, its code stays the
 * same and `asked_at` keeps the time of the first one: unanswered for minutes, the phone does not ring (off, no internet,
 * notifications turned off). Returns how many phones got it from their push service.
 */
export async function ringPhones(ctx: Ctx, subs: { id: unknown; endpoint: string; p256dh: string; auth: string; ack_code: string | null }[], payload: Record<string, unknown>) {
  if (!subs.length || !canPush(ctx.server)) return 0;
  const k = await keys(ctx);
  const base = publicApi(ctx);
  let sent = 0;
  for (const x of subs) {
    let code = x.ack_code;
    if (!code) {
      code = ackCode();
      await ctx.db.query('UPDATE push_subs SET ack_code = $2, asked_at = now() WHERE id = $1', [x.id, code]);
    }
    sent += await deliver(ctx.db, ctx.server!, k, [x], notificationBrand(ctx.shop?.slug, base ? { ...payload, ack: `${base}/push/ack/${code}` } : payload), new Set());
  }
  return sent;
}

/** The push services of the browsers (Chrome, Edge, Firefox, Safari, Samsung, Opera…): https on their own hosts. */
const PUSH_HOSTS = /^(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)$/;
export function pushServiceUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && PUSH_HOSTS.test(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export const pushProcs = {
  /** The shop's public key (null: no notifications here — the browser preview). And whether this account has a device. */
  'push.key': proc(null, z.object({ endpoint: z.string().max(1000).optional() }), async (ctx, i) => {
    const k = await keys(ctx);
    const n = num((await ctx.db.query('SELECT count(*) AS n FROM push_subs WHERE profile_id = $1', [ctx.session.profile.id]))[0].n);
    const subscribed = !!i.endpoint && !!(await ctx.db.query('SELECT 1 FROM push_subs WHERE profile_id = $1 AND endpoint = $2', [ctx.session.profile.id, i.endpoint]))[0];
    return { key: k?.publicKey ?? null, devices: n, subscribed };
  }),
  'push.subscribe': proc(
    null,
    z.union([
      // the Pilotix Android app: its Firebase token (no browser keys)
      z.object({ endpoint: z.string().regex(APP_TOKEN), p256dh: z.string().max(300).optional(), auth: z.string().max(100).optional(), ua: z.string().max(300).nullable().optional() }),
      z.object({ endpoint: z.string().url().max(1000), p256dh: z.string().min(10).max(300), auth: z.string().min(8).max(100), ua: z.string().max(300).nullable().optional() }),
    ]),
    async (ctx, i) => {
      // the server sends to this address: only a browser's push service (never an address of its own network), or an app
      // phone (sent through Firebase's own address)
      const app = appEndpoint(i.endpoint);
      if (!app && !pushServiceUrl(i.endpoint)) throw bad('Adresse de notification refusée');
      await ctx.db.query(
        `INSERT INTO push_subs (profile_id, endpoint, p256dh, auth, ua) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (endpoint) DO UPDATE SET profile_id = $1, p256dh = $3, auth = $4, ua = $5,
           ack_at = CASE WHEN push_subs.profile_id = $1 THEN push_subs.ack_at END, heard_at = CASE WHEN push_subs.profile_id = $1 THEN push_subs.heard_at END`,
        [ctx.session.profile.id, i.endpoint, app ? APP_KEY : String(i.p256dh), app ? APP_KEY : String(i.auth), i.ua ?? null],
      );
      return { ok: true };
    },
  ),
  'push.test': proc(null, z.object({ endpoint: z.string().max(1000) }), async (ctx, { endpoint }) => {
    if (!canPush(ctx.server)) return { sent: false };
    const sub = (await ctx.db.query('SELECT endpoint, p256dh, auth FROM push_subs WHERE profile_id = $1 AND endpoint = $2', [ctx.session.profile.id, endpoint]))[0];
    if (!sub) return { sent: false };
    const keys = await keysOf(ctx.db, ctx.server);
    if (!keys && !appEndpoint(endpoint)) return { sent: false };
    const words: Record<Language, { title: string; body: string }> = {
      en: { title: 'Test notification', body: 'This device can receive your notifications.' },
      fr: { title: 'Notification de test', body: 'Cet appareil peut recevoir vos notifications.' },
      ar: { title: 'إشعار تجريبي', body: 'يمكن لهذا الجهاز استقبال إشعاراتك.' },
    };
    const payload = notificationBrand(ctx.shop?.slug, { ...words[ctx.session.profile.language ?? 'fr'], tag: 'device-test' });
    return { sent: (await deliver(ctx.db, ctx.server!, keys, [sub as Sub], payload, new Set())) > 0 };
  }),
  'push.unsubscribe': proc(null, z.object({ endpoint: z.string().max(1000) }), async (ctx, i) => {
    await ctx.db.query('DELETE FROM push_subs WHERE endpoint = $1 AND profile_id = $2', [i.endpoint, ctx.session.profile.id]);
    return { ok: true };
  }),
  /** A phone's worker says a notification arrived (the server's public /push/ack/<code>, sw.js): this phone rings. */
  'push.ack': proc([], z.object({ code: z.string().regex(/^[a-f0-9]{32}$/) }), async (ctx, i) => {
    const r = await ctx.db.query('UPDATE push_subs SET ack_at = now(), asked_at = NULL, ack_code = NULL WHERE ack_code = $1 RETURNING profile_id', [i.code]);
    return { ok: r.length > 0 };
  }),
};

/**
 * From the platform (no shop session: a sign-up, a payment in the control room): a notification to the administrators
 * of one boutique (Referral: « a friend signed up », « your free months were added »). Never fails the caller.
 */
export async function pushShopAdmins(t: import('../platform/tenancy').Tenancy, server: Pick<ServerHooks, 'push' | 'pushKeys' | 'fcm'>, shopId: number, payload: Record<string, unknown>): Promise<number> {
  try {
    if (!canPush(server)) return 0;
    const s = (await t.platform.query('SELECT schema_name, slug FROM platform.shops WHERE id = $1', [shopId]))[0];
    if (!s?.schema_name) return 0;
    const db = t.shop(String(s.schema_name));
    const k = await keysOf(db, server as ServerHooks);
    const subs = await db.query(`SELECT s.endpoint, s.p256dh, s.auth FROM push_subs s JOIN profiles p ON p.id = s.profile_id WHERE p.active AND 'admin' = ANY(p.roles)`);
    return await deliver(db, server as ServerHooks, k, subs as Sub[], notificationBrand(String(s.slug ?? ''), payload), new Set());
  } catch {
    return 0;
  }
}
