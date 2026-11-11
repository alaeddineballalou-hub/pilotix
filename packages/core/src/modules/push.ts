// Phone / computer notifications (Web Push). A person accepts them on a device (« Activer les notifications »): the
// device is kept; the server sends a notification there even when the app is closed or the phone is locked.
import { z } from 'zod';
import { Db, num } from '../db';
import { membershipsOf } from '../platform/accounts';
import { bad, Ctx, proc, ServerHooks } from '../rpc';
import { getSetting } from '../settings';

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
/** Sends to these devices of one shop (signed with its keys); forgets the ones that unsubscribed. `seen`: sent already. */
async function deliver(db: Db, server: ServerHooks, k: { publicKey: string; privateKey: string }, subs: Sub[], payload: Record<string, unknown>, seen: Set<string>) {
  // only a browser's push service (a device saved before that rule with another address is skipped)
  const fresh = subs.filter((x) => !seen.has(x.endpoint) && pushServiceUrl(x.endpoint));
  if (!fresh.length || !server.push) return 0;
  fresh.forEach((x) => seen.add(x.endpoint));
  const r = await server.push(k, fresh.map((x) => ({ endpoint: x.endpoint, p256dh: x.p256dh, auth: x.auth })), payload);
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
async function pushElsewhere(ctx: Ctx, profileIds: number[], payload: Record<string, unknown>, seen: Set<string>) {
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
      const k = await keysOf(db, ctx.server);
      if (!k) continue;
      const subs = await db.query('SELECT endpoint, p256dh, auth FROM push_subs WHERE profile_id = $1', [m.profileId]);
      sent += await deliver(db, ctx.server!, k, subs as Sub[], tagged, seen);
    }
  return sent;
}

/** Sends a notification to every device of these people; forgets the devices that unsubscribed. Returns how many got it. */
export async function sendPush(ctx: Ctx, profileIds: number[], payload: Record<string, unknown>) {
  if (!profileIds.length || !ctx.server?.push) return 0;
  const seen = new Set<string>();
  let sent = 0;
  const k = await keys(ctx);
  if (k) {
    const subs = await ctx.db.query('SELECT endpoint, p256dh, auth FROM push_subs WHERE profile_id = ANY($1)', [profileIds]);
    sent += await deliver(ctx.db, ctx.server, k, subs as Sub[], payload, seen);
  }
  // a store on a server with several shops: the same people in their other boutiques
  if (ctx.t && ctx.shop && (ctx.shop.kind ?? 'store') === 'store') sent += await pushElsewhere(ctx, profileIds, payload, seen).catch(() => 0);
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
  'push.key': proc(null, z.object({}), async (ctx) => {
    const k = await keys(ctx);
    const n = num((await ctx.db.query('SELECT count(*) AS n FROM push_subs WHERE profile_id = $1', [ctx.session.profile.id]))[0].n);
    return { key: k?.publicKey ?? null, devices: n };
  }),
  'push.subscribe': proc(
    null,
    z.object({ endpoint: z.string().url().max(1000), p256dh: z.string().min(10).max(300), auth: z.string().min(8).max(100), ua: z.string().max(300).nullable().optional() }),
    async (ctx, i) => {
      // the server sends to this address: only a browser's push service (never an address of its own network)
      if (!pushServiceUrl(i.endpoint)) throw bad('Adresse de notification refusée');
      await ctx.db.query(
        `INSERT INTO push_subs (profile_id, endpoint, p256dh, auth, ua) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (endpoint) DO UPDATE SET profile_id = $1, p256dh = $3, auth = $4, ua = $5`,
        [ctx.session.profile.id, i.endpoint, i.p256dh, i.auth, i.ua ?? null],
      );
      return { ok: true };
    },
  ),
  'push.unsubscribe': proc(null, z.object({ endpoint: z.string().max(1000) }), async (ctx, i) => {
    await ctx.db.query('DELETE FROM push_subs WHERE endpoint = $1 AND profile_id = $2', [i.endpoint, ctx.session.profile.id]);
    return { ok: true };
  }),
};

/**
 * From the platform (no shop session: a sign-up, a payment in the control room): a notification to the administrators
 * of one boutique (Referral: « a friend signed up », « your free months were added »). Never fails the caller.
 */
export async function pushShopAdmins(t: import('../platform/tenancy').Tenancy, server: Pick<ServerHooks, 'push' | 'pushKeys'>, shopId: number, payload: Record<string, unknown>): Promise<number> {
  try {
    if (!server.push) return 0;
    const s = (await t.platform.query('SELECT schema_name FROM platform.shops WHERE id = $1', [shopId]))[0];
    if (!s?.schema_name) return 0;
    const db = t.shop(String(s.schema_name));
    const k = await keysOf(db, server as ServerHooks);
    if (!k) return 0;
    const subs = await db.query(`SELECT s.endpoint, s.p256dh, s.auth FROM push_subs s JOIN profiles p ON p.id = s.profile_id WHERE p.active AND 'admin' = ANY(p.roles)`);
    return await deliver(db, server as ServerHooks, k, subs as Sub[], payload, new Set());
  } catch {
    return 0;
  }
}
