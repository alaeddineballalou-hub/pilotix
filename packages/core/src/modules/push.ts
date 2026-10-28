// Phone / computer notifications (Web Push). A person accepts them on a device (« Activer les notifications »): the
// device is kept; the server sends a notification there even when the app is closed or the phone is locked.
import { z } from 'zod';
import { num } from '../db';
import { Ctx, proc } from '../rpc';

async function keys(ctx: Ctx) {
  const k = (await ctx.db.query('SELECT public_key, private_key FROM push_keys WHERE id = 1'))[0];
  if (k) return { publicKey: k.public_key as string, privateKey: k.private_key as string };
  if (!ctx.server?.pushKeys) return null;
  const made = ctx.server.pushKeys();
  await ctx.db.query('INSERT INTO push_keys (id, public_key, private_key) VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING', [made.publicKey, made.privateKey]);
  const again = (await ctx.db.query('SELECT public_key, private_key FROM push_keys WHERE id = 1'))[0];
  return { publicKey: again.public_key as string, privateKey: again.private_key as string };
}

/** Sends a notification to every device of these people; forgets the devices that unsubscribed. Returns how many got it. */
export async function sendPush(ctx: Ctx, profileIds: number[], payload: Record<string, unknown>) {
  if (!profileIds.length || !ctx.server?.push) return 0;
  const k = await keys(ctx);
  if (!k) return 0;
  const subs = await ctx.db.query('SELECT id, endpoint, p256dh, auth FROM push_subs WHERE profile_id = ANY($1)', [profileIds]);
  if (!subs.length) return 0;
  const r = await ctx.server.push(k, subs.map((s: any) => ({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth })), payload);
  const gone = r.filter((x) => x.gone).map((x) => x.endpoint);
  const ok = r.filter((x) => x.ok).map((x) => x.endpoint);
  if (gone.length) await ctx.db.query('DELETE FROM push_subs WHERE endpoint = ANY($1)', [gone]);
  if (ok.length) await ctx.db.query('UPDATE push_subs SET last_ok_at = now() WHERE endpoint = ANY($1)', [ok]);
  return ok.length;
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
