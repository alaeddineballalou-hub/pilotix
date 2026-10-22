import { expandRoles, Role, Session } from '@pilotix/shared';
import { z, ZodTypeAny } from 'zod';
import type { Db } from './db';

/** An error the app can show as-is (in French — the app translates known codes). */
export class AppError extends Error {
  constructor(
    public code: 'bad_request' | 'forbidden' | 'not_found' | 'conflict' | 'unauthorized',
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

export interface Ctx {
  db: Db;
  session: Session;
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
  hashPassword: (pw: string) => Promise<string>;
}

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
  return { profile, roles, isAdmin: roles.includes('admin') };
}

export async function dispatch(registry: Record<string, Procedure>, name: string, ctx: Ctx, rawInput: unknown): Promise<unknown> {
  const p = registry[name];
  if (!p) throw notFound(`Action inconnue : ${name}`);
  if (p.roles !== null && !hasRole(ctx.session, ...p.roles)) throw forbidden();
  const parsed = p.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    throw bad(`Champ invalide : ${i.path.join('.') || 'entrée'} (${i.message})`);
  }
  return p.run(ctx, parsed.data);
}
