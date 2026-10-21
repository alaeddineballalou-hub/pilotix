// Pilotix core: every business rule, used by the real server (PostgreSQL) and by the in-browser preview (PGlite).
import { Ctx, dispatch, Procedure } from './rpc';
import { REGISTRY } from './registry';

export * from './db';
export * from './rpc';
export * from './settings';
export { seedDemo, seedBase } from './seed';
export { login, hashPassword, profileById } from './modules/users';
export { pgliteDb } from './pglite';
export type { PGliteLike } from './pglite';

export { REGISTRY };

/** Runs one named action for the logged-in user, with role checks and input validation. */
export function call(name: string, ctx: Ctx, input: unknown) {
  return dispatch(REGISTRY as unknown as Record<string, Procedure>, name, ctx, input);
}

export type ProcName = keyof typeof REGISTRY;
