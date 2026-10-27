import { expandRoles, featureOn, procFeature, Role, Session } from '@pilotix/shared';
import { z, ZodTypeAny } from 'zod';
import type { Db } from './db';

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
  /** AI Spy: 'search' (ScrapeCreators / SearchAPI.io), 'media' (a competitor's picture), 'site' (a competitor's page). */
  spy?: (action: string, args: unknown, ctx: Ctx) => Promise<unknown>;
  /** Google Sheets sales channel: the CSV text of a public sheet (docs.google.com only). */
  sheetCsv?: (url: string) => Promise<string>;
  hashPassword: (pw: string) => Promise<string>;
  /** the server's public address (PUBLIC_URL): couriers call it back (webhooks) */
  publicUrl?: string;
  /** the shop's public API address: PUBLIC_URL/api, or PUBLIC_URL/api/s/<shop> for a shop other than the first */
  publicApi?: string;
  /** another shop of the platform already has this name (the first part of its links) */
  storeTaken?: (store: string) => Promise<boolean>;
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
const WHEN_LOCKED = new Set(['me.get', 'me.language', 'me.ui', 'me.setUi', 'me.seen', 'me.password', 'me.update']);
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

export async function dispatch(registry: Record<string, Procedure>, name: string, ctx: Ctx, rawInput: unknown): Promise<unknown> {
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
  return p.run(ctx, parsed.data);
}

/**
 * Runs `fn` while holding a short "in progress" mark on `key` (e.g. 'send:42'). A second call with the same key while
 * the first runs is refused with `busyMessage` instead of doing the work twice (double click, retry, the background
 * job at the same moment). A mark older than `staleSec` (a crashed run) is ignored.
 */
export async function withActionLock<T>(db: Db, key: string, userId: number | null, busyMessage: string, fn: () => Promise<T>, staleSec = 120): Promise<T> {
  await db.query(`DELETE FROM action_locks WHERE key = $1 AND created_at < now() - make_interval(secs => $2)`, [key, staleSec]);
  const got = await db.query('INSERT INTO action_locks (key, user_id) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key', [key, userId]);
  if (!got.length) throw new AppError('conflict', busyMessage);
  try {
    return await fn();
  } finally {
    await db.query('DELETE FROM action_locks WHERE key = $1', [key]);
  }
}


/** Takes the "in progress" marks it can among `keys` (see withActionLock); returns those taken and how to free them. */
export async function takeActionLocks(db: Db, keys: string[], userId: number | null, staleSec = 120) {
  if (!keys.length) return { taken: new Set<string>(), release: async () => {} };
  await db.query(`DELETE FROM action_locks WHERE key = ANY($1) AND created_at < now() - make_interval(secs => $2)`, [keys, staleSec]);
  const rows = await db.query<{ key: string }>(
    'INSERT INTO action_locks (key, user_id) SELECT k, $2 FROM unnest($1::text[]) AS k ON CONFLICT (key) DO NOTHING RETURNING key',
    [keys, userId],
  );
  const taken = new Set(rows.map((x) => x.key));
  return { taken, release: async () => { if (taken.size) await db.query('DELETE FROM action_locks WHERE key = ANY($1)', [[...taken]]); } };
}
