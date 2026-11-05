import { expandRoles, featureOn, procFeature, Role, Session } from '@pilotix/shared';
import { z, ZodTypeAny } from 'zod';
import type { Db } from './db';
import type { Tenancy } from './platform/tenancy';

/** An error the app can show as-is (in French — the app translates known codes). */
export class AppError extends Error {
  constructor(
    public code: 'bad_request' | 'forbidden' | 'not_found' | 'conflict' | 'unauthorized' | 'payment_required',
    message: string,
  ) {
    super(message);
  }
}
export const bad = (m: string) => new AppError('bad_request', m);
export const forbidden = (m = 'Accès refusé') => new AppError('forbidden', m);
export const notFound = (m = 'Introuvable') => new AppError('not_found', m);

export interface LiveEvent {
  type: 'order' | 'orders' | 'presence' | 'chat' | 'sav' | 'stock' | 'settings';
  id?: number;
  data?: unknown;
  /** the boutique it happened in (set by the server: a person with several boutiques hears of all of them) */
  shop?: number;
}

/** The shop a request works for, on a server that hosts several shops (missing = a single-shop install or the preview). */
export interface ShopCtx {
  id: number;
  /** its name on the platform, also the first part of its links (site/<store>/<page>, /api/s/<store>/…) */
  slug: string;
  /** shop #1, the server owner's (schema "public") */
  primary: boolean;
  /** null = every feature */
  features: string[] | null;
  /** unpaid or suspended: only the user's own account answers (the app shows the lock screen) */
  locked: boolean;
  /** the demo shop (fake data, nothing leaves the server) */
  demo: boolean;
  /** active accounts the plan allows (null = no limit) */
  maxUsers: number | null;
  /** active livreurs the plan allows (null = no limit) */
  maxDrivers: number | null;
  /** a store, or a partner's own space: a confirmation agency or a marketer (missing = a store) */
  kind?: 'store' | 'agency' | 'marketer';
  /** its public code (others type it to find it) */
  code?: string | null;
}

export interface Ctx {
  db: Db;
  session: Session;
  shop?: ShopCtx;
  now: () => number;
  /** Tell connected screens that something changed. */
  emit: (e: LiveEvent) => void;
  /** Server-only abilities (courier APIs, Meta). Missing in the browser preview. */
  server?: ServerHooks;
  /**
   * The whole server's data (the platform and every shop's schema), for what joins two shops (a confirmation agency and
   * the stores it works for). Missing in the browser preview and on a single-shop install.
   */
  t?: Tenancy;
  /**
   * In a confirmation agency's space: the seller (store) its person works on now — one store, or 'all' of them (the
   * picker at the top of the page). The work on orders runs in that store (modules/agencywork.ts).
   */
  seller?: number | 'all';
  /**
   * In a store, for someone with several boutiques: « Toutes les boutiques » ('all', each one answering, put together) or
   * one of their other boutiques, whose order is open on screen (its work runs there, as their account there):
   * modules/boutiquework.ts.
   */
  boutique?: number | 'all';
  /** The server's way to act inside another shop (its live updates, its couriers): that shop's ctx for one of its accounts. */
  otherShop?: (shopId: number, profileId: number) => Promise<Ctx>;
  /**
   * Dellal's AI when it runs inside the page (the Pilotix preview opened in Claude): Claude answers through the page, with
   * no API key, and runs Dellal's tools itself through `runTool` (the same tool code as on the server). Only that preview
   * sets it; on the server, Dellal uses `server.dellal`.
   */
  dellalAi?: DellalPageAi;
}

/** One answer from the page's Claude. Tools run inside the call through `runTool`, so the answer is the final text. */
export type DellalPageAi = (req: {
  model: string;
  system: string;
  messages: { role: 'user' | 'assistant'; content: any }[];
  tools: readonly { name: string; description: string; input_schema: unknown }[];
  max_tokens: number;
  runTool: (name: string, input: any) => Promise<any>;
}) => Promise<{ content: { type: 'text'; text: string }[]; stop_reason: string; usage?: { input_tokens: number; output_tokens: number } }>;

export interface ServerHooks {
  courier: (action: string, args: unknown, ctx: Ctx) => Promise<unknown>;
  meta: (action: string, args: unknown, ctx: Ctx) => Promise<unknown>;
  /** Dellal (AI sales agent): 'complete' (the AI), 'send' (a message to WhatsApp / Messenger / Instagram / TikTok), 'ping'. */
  dellal?: (action: string, args: unknown, ctx: Ctx) => Promise<unknown>;
  /** Linked accounts (Pilot AI › Comptes): 'test' (tries a linked Facebook / TikTok account now, line by line). */
  social?: (action: string, args: unknown, ctx: Ctx) => Promise<unknown>;
  /** AI Spy: 'search' (ScrapeCreators / SearchAPI.io), 'media' (a competitor's picture), 'site' (a competitor's page). */
  spy?: (action: string, args: unknown, ctx: Ctx) => Promise<unknown>;
  /** Cloudflare Turnstile: is this page token real (true / false), null when Cloudflare cannot be reached. */
  turnstile?: (secret: string, token: string, ip: string) => Promise<boolean | null>;
  /** Turnstile managed by the platform for every shop: the site key for a page on this host (null: none) */
  turnstileSite?: (host: string) => Promise<string | null>;
  /** and the check of a page's token with the secret of that site key's widget (null: cannot tell) */
  turnstileCheck?: (siteKey: string, token: string, ip: string) => Promise<boolean | null>;
  /** Google Sheets sales channel: the CSV text of a public sheet (docs.google.com only). */
  sheetCsv?: (url: string) => Promise<string>;
  hashPassword: (pw: string) => Promise<string>;
  /** Web Push: a new key pair for the shop (once), and sending one notification to devices (gone: unsubscribed, to forget) */
  pushKeys?: () => { publicKey: string; privateKey: string };
  push?: (keys: { publicKey: string; privateKey: string }, subs: { endpoint: string; p256dh: string; auth: string }[], payload: Record<string, unknown>) => Promise<{ endpoint: string; ok: boolean; gone: boolean }[]>;
  /** the server's public address (PUBLIC_URL): couriers call it back (webhooks) */
  publicUrl?: string;
  /** the landing pages' address in use (https://go.<domain> once it answers, else publicUrl) */
  pagesUrl?: () => string;
  /** the shop's public API address: PUBLIC_URL/api, or PUBLIC_URL/api/s/<shop> for a shop other than the first */
  publicApi?: string;
  /** another shop of the platform already has this name (the first part of its links) */
  storeTaken?: (store: string) => Promise<boolean>;
  /** a shop's name, link or logo changed (« Mes boutiques »): the server forgets what it keeps of the shops */
  platformChanged?: () => void;
}

/** Where links given to others (courier webhooks, landing pages) point: the shop's public API address ('' = unknown). */
export const publicApi = (ctx: Ctx) => ctx.server?.publicApi ?? (ctx.server?.publicUrl ? `${ctx.server.publicUrl}/api` : '');

export interface Procedure<S extends ZodTypeAny = ZodTypeAny, R = unknown> {
  /** null = every logged-in user; [] = admin only. Admin always passes. */
  roles: Role[] | null;
  input: S;
  run: (ctx: Ctx, input: z.infer<S>) => Promise<R>;
}

export const proc = <S extends ZodTypeAny, R>(roles: Role[] | null, input: S, run: (ctx: Ctx, input: z.infer<S>) => Promise<R>): Procedure<S, R> => ({
  roles,
  input,
  run,
});

export function hasRole(s: Session, ...roles: Role[]): boolean {
  if (s.isAdmin) return true;
  return roles.some((r) => s.roles.includes(r));
}

export function makeSession(profile: Session['profile']): Session {
  const roles = expandRoles(profile.roles);
  const isAdmin = roles.includes('admin');
  return { profile, roles, isAdmin, canManageUsers: isAdmin || !!profile.canManageUsers };
}

/** What an unpaid (locked) shop may still do: read and change the user's own account. */
const WHEN_LOCKED = new Set(['me.get', 'me.language', 'me.ui', 'me.setUi', 'me.seen', 'me.password', 'me.update', 'boutiques.list']);
export const FEATURE_OFF = 'Cette fonction n’est pas incluse dans votre formule Pilotix';
export const SHOP_LOCKED = 'Votre abonnement Pilotix n’est pas actif';

/** Can this shop run this action (its plan includes the feature, the subscription is active)? */
export function shopAllows(shop: ShopCtx | undefined, name: string): { ok: true } | { ok: false; error: AppError } {
  if (!shop) return { ok: true };
  if (shop.locked && !WHEN_LOCKED.has(name)) return { ok: false, error: new AppError('payment_required', SHOP_LOCKED) };
  const f = procFeature(name);
  if (f && !featureOn(shop.features, f)) return { ok: false, error: new AppError('forbidden', FEATURE_OFF) };
  return { ok: true };
}

/** A last check of an action with its checked input (who may call it on what), before it runs. */
export type Gate = (name: string, ctx: Ctx, input: unknown) => Promise<void>;

export async function dispatch(registry: Record<string, Procedure>, name: string, ctx: Ctx, rawInput: unknown, gate?: Gate): Promise<unknown> {
  const p = registry[name];
  if (!p) throw notFound(`Action inconnue : ${name}`);
  const allowed = shopAllows(ctx.shop, name);
  if (!allowed.ok) throw allowed.error;
  if (p.roles !== null && !hasRole(ctx.session, ...p.roles)) throw forbidden();
  const parsed = p.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    throw bad(`Champ invalide : ${i.path.join('.') || 'entrée'} (${i.message})`);
  }
  if (gate) await gate(name, ctx, parsed.data);
  return p.run(ctx, parsed.data);
}

/**
 * Runs `fn` while holding a short "in progress" mark on `key` (e.g. 'send:42'). A second call with the same key while
 * the first runs is refused with `busyMessage` instead of doing the work twice (double click, retry, the background
 * job at the same moment). A mark older than `staleSec` (a crashed run) is ignored.
 */
export async function withActionLock<T>(db: Db, key: string, userId: number | null, busyMessage: string, fn: () => Promise<T>, staleSec = 120): Promise<T> {
  const lock = await takeActionLocks(db, [key], userId, staleSec);
  if (!lock.taken.size) throw new AppError('conflict', busyMessage);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

/**
 * Takes the "in progress" marks it can among `keys` (see withActionLock); returns those taken and how to free them.
 * The marks are this run's own: renewed while it works (a long send to a slow courier is never taken for a stuck
 * one by a second run, which would send the same parcels again), and freed at the end only while still its own.
 * A run that died (the server stopped) leaves marks that a next run takes over after `staleSec`.
 */
export async function takeActionLocks(db: Db, keys: string[], userId: number | null, staleSec = 120) {
  if (!keys.length) return { taken: new Set<string>(), release: async () => {} };
  await db.query(`DELETE FROM action_locks WHERE key = ANY($1) AND created_at < now() - make_interval(secs => $2)`, [keys, staleSec]);
  const rows = await db.query<{ key: string; at: string }>(
    'INSERT INTO action_locks (key, user_id) SELECT k, $2 FROM unnest($1::text[]) AS k ON CONFLICT (key) DO NOTHING RETURNING key, created_at::text AS at',
    [keys, userId],
  );
  const taken = new Set(rows.map((x) => x.key));
  const mine = [...taken];
  // every mark of one run has the same time (one statement): it says the mark is still this run's
  let stamp: string | null = rows[0]?.at ?? null;
  let beat: Promise<unknown> = Promise.resolve();
  const timer =
    mine.length && stamp
      ? setInterval(() => {
          beat = beat
            .then(async () => {
              const r = await db.query<{ at: string }>(
                'UPDATE action_locks SET created_at = now() WHERE key = ANY($1) AND created_at = $2::timestamptz RETURNING created_at::text AS at',
                [mine, stamp],
              );
              if (r[0]) stamp = r[0].at;
            })
            .catch(() => undefined);
        }, Math.max(5, Math.floor(staleSec / 3)) * 1000)
      : null;
  (timer as { unref?: () => void } | null)?.unref?.();
  return {
    taken,
    release: async () => {
      if (timer) clearInterval(timer);
      await beat;
      if (mine.length && stamp) await db.query('DELETE FROM action_locks WHERE key = ANY($1) AND created_at = $2::timestamptz', [mine, stamp]);
    },
  };
}
